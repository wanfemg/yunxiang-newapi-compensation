import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EmailNotifications} from '../src/email-notifications.mjs';
import {Store} from '../src/store.mjs';
import {rules,log,user} from './helpers.mjs';

const config={host:'smtp.example.com',port:587,security:'starttls',username:'smtp-login',password:'secret-mail-password',fromEmail:'sender@example.com',fromName:'云响补空回',enabled:true};
function setup(t,{sender,upstream}={}){
  const directory=mkdtempSync(join(tmpdir(),'mail-test-')),store=new Store(),sent=[];store.saveRules(rules(),1,1);
  const mail=new EmailNotifications(store,directory,{sender:sender||(async(...args)=>{sent.push(args);}),upstream:upstream||{target:async()=>({...user,setting:JSON.stringify({notification_email:'notify@example.com'}),email:'account@example.com'})}});
  mail.save(config,1);
  t.after(()=>{store.close();assert.ok(directory.startsWith(join(tmpdir(),'mail-test-')));rmSync(directory,{recursive:true,force:true});});
  const claim=(id,extra={})=>({id,request_id:id,user_id:7,username:user.username,status:'approved',amount:0,log:log(id),rules:rules(),...extra});
  return {store,mail,sent,claim,rows:()=>store.db.prepare('SELECT * FROM email_notifications ORDER BY id').all()};
}
test('邮箱配置加密、空密码保留、配置与规则原子更新且检查旧版本',t=>{
  const f=setup(t);assert.equal(f.mail.status().configured,true);
  assert.ok(!JSON.stringify(f.mail.status()).includes(config.password));
  assert.ok(!f.store.db.prepare("SELECT value FROM metadata WHERE key='email_smtp'").get().value.includes(config.password));
  f.mail.save({...config,password:''},1);assert.equal(f.mail.config().password,config.password);
  const before=f.mail.config(),version=f.store.rules().version;
  assert.throws(()=>f.mail.save({...config,host:'other.example.com',events:['invalid']},1));
  assert.deepEqual(f.mail.config(),before);assert.equal(f.store.rules().version,version);
  assert.throws(()=>f.mail.save({...config,version:version-1},1),/已更新/);
  assert.throws(()=>f.mail.save({...config,fromName:'bad\r\nname'},1));
});
test('同用户多模型合一封，按申请与事件去重，账户邮箱不用作收件地址',async t=>{
  const f=setup(t),a=f.claim('a'),b=f.claim('b',{log:log('b',{model_name:'second-model'})});
  await f.mail.notifyClaims('approved',[a,b]);await f.mail.notifyClaims('approved',[a]);
  assert.equal(f.rows().length,1);await Promise.all([f.mail.flush(),f.mail.flush()]);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1],'notify@example.com');
  assert.match(f.sent[0][3],/申请数量：2 笔/);assert.match(f.sent[0][3],/等待额度补偿/);assert.match(f.sent[0][3],/预计补偿额度/);
  assert.equal(f.rows()[0].status,'sent');assert.ok(!f.rows()[0].recipient.includes('notify@example.com'));
  const c=f.claim('c');await f.mail.notifyClaims('approved',[a,c]);await f.mail.flush();assert.equal(f.sent.length,2);assert.match(f.sent[1][3],/申请数量：1 笔/);
});
test('不同用户分开发送，没有通知邮箱及无效设置明确跳过',async t=>{
  const f=setup(t,{upstream:{target:async id=>({email:'account@example.com',setting:id===7?'{}':JSON.stringify({notification_email:'other@example.com'})})}});
  await f.mail.notifyClaims('approved',[f.claim('a'),f.claim('b',{user_id:8})]);await f.mail.flush();
  assert.equal(f.rows().length,2);assert.equal(f.rows()[0].status,'skipped');assert.match(f.rows()[0].result,/未配置/);assert.equal(f.sent.length,1);assert.equal(f.sent[0][1],'other@example.com');
});
test('关闭事件取消待发送队列，重试上限五次且错误不泄漏敏感原文',async t=>{
  const f=setup(t,{sender:async()=>{throw Object.assign(new Error('secret-mail-password leaked upstream'),{code:'EAUTH'});}});
  await f.mail.notifyClaims('approved',[f.claim('a')]);for(let i=0;i<5;i++){f.store.db.exec('UPDATE email_notifications SET next_at=0');await f.mail.flush();}
  assert.equal(f.rows()[0].attempts,5);assert.equal(f.rows()[0].status,'failed');assert.ok(!f.rows()[0].result.includes(config.password));
  await f.mail.notifyClaims('approved',[f.claim('b')]);f.mail.save({...config,events:[]},1);await f.mail.flush();assert.equal(f.rows()[1].status,'cancelled');
});
test('邮箱读取失败可重试，成功邮件只报告实际补回金额',async t=>{
  let reads=0;const f=setup(t,{upstream:{target:async()=>{if(!reads++)throw Error('offline');return {setting:{notification_email:'notify@example.com'}};}}});
  await f.mail.notifyClaims('succeeded',[f.claim('a',{status:'succeeded',amount:75})]);await f.mail.flush();assert.equal(f.rows()[0].status,'pending');
  f.store.db.exec('UPDATE email_notifications SET next_at=0');await f.mail.flush();assert.equal(f.rows()[0].status,'sent');assert.match(f.sent[0][3],/已确认补回额度：75 原始额度单位/);assert.ok(!f.sent[0][3].includes('预计补偿'));
});
test('测试邮件仅发送指定地址，格式和失败原因可读',async t=>{
  const f=setup(t);await assert.rejects(f.mail.test('bad-address'),/格式无效/);
  const result=await f.mail.test('test@example.com');assert.equal(result.to,'t***@example.com');assert.equal(f.sent[0][1],'test@example.com');
});
