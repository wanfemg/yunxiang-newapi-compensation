import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import nodemailer from 'nodemailer';
import {AppError,expectedQuota,validateRules} from './rules.mjs';
import {formatQuota} from '../public/display.js';

const subjects={approved:'你的空回补偿申请已审核通过',succeeded:'你的空回补偿已处理完成',failed:'你的空回补偿处理失败',unknown:'你的空回补偿结果待确认'};
const labels={approved:'审核通过，等待额度补偿',succeeded:'补偿成功',failed:'补偿失败',unknown:'结果待确认'};
const emailAddress=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
function encrypt(key,value){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(String(value)),cipher.final()]);
  return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
function decrypt(key,value){
  const [iv,tag,data]=String(value).split('.'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));decipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString();
}
function failure(error){
  return ({EAUTH:'SMTP 认证失败，请检查账号与密码或授权码',ETIMEDOUT:'SMTP 连接超时，请检查服务器、端口和网络',ECONNECTION:'SMTP 连接失败，请检查服务器与端口',ESOCKET:'SMTP 连接或 TLS 证书校验失败',EENVELOPE:'发件或收件地址被 SMTP 服务器拒绝',EMESSAGE:'SMTP 服务器拒绝邮件内容'})[error?.code]||'邮件发送失败，请检查 SMTP 配置与邮件服务状态';
}
export async function sendSMTP(config,to,subject,text,messageId){
  const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.security==='ssl',requireTLS:config.security==='starttls',auth:{user:config.username,pass:config.password},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true});
  try{await transport.sendMail({from:{name:config.fromName,address:config.fromEmail},to,subject,text,messageId});}finally{transport.close();}
}
export class EmailNotifications{
  constructor(store,directory,{sender=sendSMTP,upstream=null}={}){
    this.store=store;this.sender=sender;this.upstream=upstream;this.running=false;
    const keyFile=join(directory,'secrets.key');if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
    this.key=readFileSync(keyFile);if(this.key.length!==32)throw new Error('通知密钥文件无效');
    store.db.exec('CREATE TABLE IF NOT EXISTS email_notification_claims(event TEXT NOT NULL,claim_id TEXT NOT NULL,notification_id INTEGER NOT NULL,PRIMARY KEY(event,claim_id))');
  }
  config(){
    const row=this.store.db.prepare("SELECT value FROM metadata WHERE key='email_smtp'").get();if(!row)return {};
    try{return JSON.parse(decrypt(this.key,row.value));}catch{throw new AppError('SMTP 配置无法解密，请检查数据目录密钥',503);}
  }
  status(){
    const c=this.config();return {configured:Boolean(c.host&&c.username&&c.password&&c.fromEmail),enabled:this.store.rules().emailNotifications.enabled,host:c.host||'',port:c.port||587,security:c.security||'starttls',fromEmail:c.fromEmail||'',fromName:c.fromName||'云响补空回',username:c.username||'',passwordConfigured:Boolean(c.password)};
  }
  save(input,actor=0){
    const previous=this.config(),current=this.store.rules();
    if(input.version!==undefined&&input.version!==current.version)throw new AppError('通知设置已更新，请刷新后重试',409);
    const next={host:String(input.host??previous.host??'').trim(),port:Number(input.port??previous.port??587),security:String(input.security??previous.security??'starttls'),username:String(input.username??previous.username??'').trim(),password:input.password?String(input.password):previous.password,fromEmail:String(input.fromEmail??previous.fromEmail??'').trim(),fromName:String(input.fromName??previous.fromName??'云响补空回').trim()};
    const updated=validateRules({...current,emailNotifications:{enabled:input.enabled===true,events:input.events??current.emailNotifications.events}});
    if(!/^[a-zA-Z0-9.-]{1,253}$/.test(next.host)||!Number.isInteger(next.port)||next.port<1||next.port>65535)throw new AppError('SMTP 服务器或端口无效');
    if(!['ssl','starttls'].includes(next.security))throw new AppError('加密方式无效');
    if(!emailAddress(next.fromEmail)||!next.username||next.username.length>254||/[\r\n]/.test(next.username)||!next.password||next.password.length>1000)throw new AppError('请填写有效的发件邮箱、SMTP 账号和密码');
    if(!next.fromName||next.fromName.length>80||/[\r\n]/.test(next.fromName))throw new AppError('发件人名称须为 1–80 字且不能换行');
    this.store.transaction(()=>{
      this.store.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('email_smtp',?)").run(encrypt(this.key,JSON.stringify(next)));
      this.store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({...updated,version:current.version+1}));
      this.store.event(null,actor,'email_notification_config_updated',{host:next.host,port:next.port,security:next.security,enabled:updated.emailNotifications.enabled,events:updated.emailNotifications.events});
    });return this.status();
  }
  maskRecipient(value){if(!value)return '';try{const [local,domain]=decrypt(this.key,value).split('@');return local.slice(0,1)+'***@'+domain;}catch{return '邮箱不可读';}}
  async test(to){
    if(!this.status().configured)throw new AppError('请先保存 SMTP 配置');if(!emailAddress(to))throw new AppError('测试收件邮箱格式无效');
    try{await this.sender(this.config(),to,'【云响补空回】邮件通知测试','这是一封 SMTP 测试邮件。连接已成功，正式通知将按启用的审核与补偿事件发送。');}catch(error){throw new AppError(failure(error),502);}
    return {sent:true,to:to.split('@')[0].slice(0,1)+'***@'+to.split('@')[1]};
  }
  async notifyClaims(event,claims,upstream){
    if(upstream)this.upstream=upstream;const rules=this.store.rules();
    if(!subjects[event]||!rules.emailNotifications.enabled||!rules.emailNotifications.events.includes(event)||!this.status().configured)return;
    const groups=new Map();for(const claim of claims){if(claim.status!==event)continue;if(!groups.has(claim.user_id))groups.set(claim.user_id,[]);groups.get(claim.user_id).push(claim);}
    this.store.transaction(()=>{for(const [userId,group] of groups){
      const items=group.filter(c=>!this.store.db.prepare('SELECT 1 FROM email_notification_claims WHERE event=? AND claim_id=?').get(event,c.id));if(!items.length)continue;
      let display;try{display=JSON.parse(this.store.db.prepare("SELECT value FROM metadata WHERE key='display'").get()?.value);}catch{}
      const money=value=>display?formatQuota(value,display):`${value} 原始额度单位`;
      const actual=event==='succeeded'?items.reduce((sum,c)=>sum+c.amount,0):0;
      const summary=event==='approved'?'管理员已完成审核，申请已通过，等待额度补偿执行。':event==='succeeded'?`已确认补回额度：${money(actual)}`:event==='failed'?'补偿未成功，请登录工作台查看失败原因与处理进度。':'补偿结果尚未确认，管理员正在核对，请勿重复申请。';
      const lines=items.map((c,index)=>`${index+1}. ${c.log.model_name}\n   请求标识：${c.request_id}\n   原消费额度：${money(c.log.quota)}\n   ${event==='approved'?'预计补偿额度':'已确认补回额度'}：${money(event==='approved'?expectedQuota(c.log,c.rules):event==='succeeded'?c.amount:0)}\n   状态：${labels[event]}`).join('\n\n');
      const text=`你好，${items[0].username}：\n\n${summary}\n\n申请数量：${items.length} 笔\n涉及模型：${new Set(items.map(c=>c.log.model_name)).size} 个\n\n申请明细：\n\n${lines}\n\n处理时间：${new Date().toLocaleString('zh-CN',{timeZone:rules.timezone,hour12:false})}\n\n登录云响补空回工作台查看处理进度。实际到账以 云中猫API小站 账户余额和补偿记录为准。\n\n云响补空回系统`;
      const now=Date.now(),body=JSON.stringify({userId,subject:'【云响补空回】'+subjects[event],text});
      const inserted=this.store.db.prepare('INSERT INTO email_notifications(event,body,next_at,created_at) VALUES(?,?,?,?)').run(event,body,now,now);
      for(const c of items)this.store.db.prepare('INSERT INTO email_notification_claims(event,claim_id,notification_id) VALUES(?,?,?)').run(event,c.id,inserted.lastInsertRowid);
    }});
  }
  async flush(){
    if(this.running)return;this.running=true;
    try{const now=Date.now();
      this.store.db.prepare("UPDATE email_notifications SET status='pending',result='发送进程中断，已重新排队' WHERE status='sending' AND next_at<?").run(now);
      const rows=this.store.db.prepare("SELECT * FROM email_notifications WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 10").all(now);
      for(const row of rows){
        const rules=this.store.rules();
        if(!rules.emailNotifications.enabled||!rules.emailNotifications.events.includes(row.event)){this.store.db.prepare("UPDATE email_notifications SET status='cancelled',result='通知开关或此事件已关闭' WHERE id=? AND status='pending'").run(row.id);continue;}
        if(!this.status().configured)continue;
        const locked=this.store.db.prepare("UPDATE email_notifications SET status='sending',next_at=? WHERE id=? AND status='pending'").run(Date.now()+300000,row.id);if(!locked.changes)continue;
        let result='',status='sent',recipient=row.recipient;
        try{const body=JSON.parse(row.body);
          if(!recipient){
            if(!this.upstream)throw new Error('upstream unavailable');
            const target=await this.upstream.target(body.userId);let setting=target?.setting;try{if(typeof setting==='string')setting=JSON.parse(setting||'{}');}catch{setting={};}
            const address=String(setting?.notification_email||'').trim();
            if(!emailAddress(address)){this.store.db.prepare("UPDATE email_notifications SET status='skipped',result='云中猫API小站 用户未配置有效通知邮箱，不发送' WHERE id=?").run(row.id);continue;}
            recipient=encrypt(this.key,address);this.store.db.prepare('UPDATE email_notifications SET recipient=? WHERE id=?').run(recipient,row.id);
          }
          await this.sender(this.config(),decrypt(this.key,recipient),body.subject,body.text,`<yunxiang-${row.id}-${row.created_at}@notifications.local>`);result='SMTP 已接受邮件，最终送达以邮箱服务为准';
        }catch(error){status=row.attempts>=4?'failed':'pending';result=failure(error);}
        this.store.db.prepare('UPDATE email_notifications SET status=?,attempts=?,next_at=?,result=? WHERE id=?').run(status,row.attempts+1,Date.now()+Math.min(3600000,30000*2**(row.attempts+1)),result,row.id);
      }
    }finally{this.running=false;}
  }
}
