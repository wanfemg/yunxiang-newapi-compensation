import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { DingTalk } from '../src/notifications.mjs';
import { rules } from './helpers.mjs';
test('钉钉配置加密存储不回显，官方域名验证、签名和队列发送',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ding-test-')),store=new Store();let sent=0;
 try {
  store.saveRules(rules({notifications:{enabled:true,events:['compensation_success']}}),1,1);
  const bot=new DingTalk(store,dir,async(url,options)=>{sent++;const u=new URL(url),ts=u.searchParams.get('timestamp');assert.equal(u.searchParams.get('sign'),createHmac('sha256','fixture-secret').update(ts+'\nfixture-secret').digest('base64'));assert.match(options.body,/补偿/);const body=JSON.parse(options.body);assert.equal(body.msgtype,'markdown');assert.equal(typeof body.markdown.title,'string');assert.equal(typeof body.markdown.text,'string');assert.equal(body.at.isAtAll,false);return {ok:true,json:async()=>({errcode:0})};});
  assert.throws(()=>bot.save({webhook:'http://127.0.0.1/robot/send',secret:'x'}));
  bot.save({webhook:'https://oapi.dingtalk.com/robot/send?access_token=fixture-token',secret:'fixture-secret'});
  assert.deepEqual(bot.status(),{configured:true,signed:true});assert.equal(readFileSync(join(dir,'dingtalk.enc'),'utf8').includes('fixture-secret'),false);
  store.notify('compensation_success','补偿成功');store.notify('application_pending','disabled');await bot.flush();assert.equal(sent,1);assert.equal(store.db.prepare('SELECT status FROM notifications').get().status,'sent');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('通知失败重试有上限；关闭事件后取消未发送队列',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ding-test-')),store=new Store();
 try{
  store.saveRules(rules({notifications:{enabled:true,events:['compensation_success']}}),1,1);const bot=new DingTalk(store,dir,async()=>{throw Error('lost');});bot.save({webhook:'https://oapi.dingtalk.com/robot/send?access_token=fixture-token',secret:'fixture-secret'});store.notify('compensation_success','success');
  for(let i=0;i<5;i++){store.db.exec('UPDATE notifications SET next_at=0');await bot.flush();}assert.equal(store.db.prepare('SELECT status FROM notifications').get().status,'failed');assert.equal(store.db.prepare('SELECT attempts FROM notifications').get().attempts,5);
  store.notify('compensation_success','second');store.saveRules({...store.rules(),notifications:{enabled:true,events:[]}},1,store.rules().version);await bot.flush();assert.equal(store.db.prepare('SELECT status FROM notifications ORDER BY id DESC').get().status,'cancelled');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
