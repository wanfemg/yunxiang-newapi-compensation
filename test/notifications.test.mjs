import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { DingTalk } from '../src/notifications.mjs';
import {notificationMarkdown} from '../src/notification-titles.mjs';
import { rules,log,user } from './helpers.mjs';
test('批量钉钉标题直接体现待审核、审核通过、成功、失败和混合状态',t=>{
  const store=new Store();t.after(()=>store.close());
  store.saveRules(rules({notifications:{enabled:true,events:['batch_result']}}),1,1);
  const one=store.create(log('title-one'),user,store.rules(),'x','self',7,false,'title-run');
  const two=store.create(log('title-two',{model_name:'second-model'}),user,store.rules(),'x','self',7,false,'title-run');
  const set=status=>store.db.prepare('UPDATE claims SET status=?,updated_at=updated_at+1 WHERE run_id=?').run(status,'title-run');
  for(const [status,label] of [['pending','申请待审核'],['approved','审核通过'],['succeeded','补偿成功'],['failed','补偿失败'],['unknown','结果待确认'],['rejected','审核已驳回']]){
    set(status);store.notifyClaimsBatch('title-run');
    const markdown=JSON.parse(store.db.prepare('SELECT body FROM notifications ORDER BY id DESC LIMIT 1').get().body);
    assert.ok(markdown.title.includes(label),markdown.title);
    assert.ok(markdown.text.startsWith('### '+markdown.title+'\n'));
  }
  set('pending');store.db.prepare("UPDATE claims SET status='failed',updated_at=updated_at+1 WHERE id=?").run(two.id);
  store.notifyClaimsBatch('title-run');
  const mixed=JSON.parse(store.db.prepare('SELECT body FROM notifications ORDER BY id DESC LIMIT 1').get().body);
  assert.match(mixed.title,/待审核 1/);assert.match(mixed.title,/补偿失败 1/);
  store.event(one.id,7,'ai_reviewed',{decision:'uncertain'});store.notifyClaimsBatch('title-run');
  const ai=JSON.parse(store.db.prepare('SELECT body FROM notifications ORDER BY id DESC LIMIT 1').get().body);
  assert.match(ai.title,/AI/);
});

test('旧的纯文本钉钉消息按事件恢复标题，实际发送标题和正文一致',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ding-title-')),store=new Store(),messages=[];
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveRules(rules({notifications:{enabled:true,events:['application_pending','review_result','compensation_success','execution_failed','execution_unknown','ai_manual_review']}}),1,1);
  const bot=new DingTalk(store,dir,async(url,options)=>{messages.push(JSON.parse(options.body).markdown);return {ok:true,json:async()=>({errcode:0})};});
  bot.save({webhook:'https://oapi.dingtalk.com/robot/send?access_token=fixture-token',secret:'fixture-secret'});
  for(const event of store.rules().notifications.events)store.notify(event,'通知正文 '+event);
  await bot.flush();
  assert.equal(messages.length,6);
  assert.match(messages[0].title,/申请待审核/);assert.match(messages[1].title,/审核结果/);
  assert.match(messages[2].title,/补偿成功/);assert.match(messages[3].title,/补偿失败/);
  assert.match(messages[4].title,/结果待确认/);assert.match(messages[5].title,/AI.*人工审核/);
  for(const message of messages)assert.ok(message.text.startsWith('### '+message.title+'\n'));
  for(const text of ['### 旧通知\n原正文','原正文']){
    const markdown=notificationMarkdown({event:'application_pending',body:JSON.stringify({title:'补空回通知',text})});
    assert.equal(markdown.title,'申请待审核');
    assert.ok(markdown.text.startsWith('### 申请待审核\n'));
    assert.ok(markdown.text.includes('原正文'));
  }
});
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
test('批量通知按用户隔离、重复汇总不重发，事件关闭后保持关闭',()=>{
  const store=new Store();try{
    store.saveRules(rules({notifications:{enabled:true,events:['batch_result']}}),1,1);
    store.create(log('user7'),user,store.rules(),'审核','self',7,false,'shared-run');
    store.create(log('user8',{user_id:8}),{...user,id:8,username:'other-user'},store.rules(),'审核','self',8,false,'shared-run');
    store.notifyClaimsBatch('shared-run');store.notifyClaimsBatch('shared-run');
    const rows=store.db.prepare('SELECT body FROM notifications ORDER BY id').all();assert.equal(rows.length,2);
    assert.ok(!rows[0].body.includes('other-user'));assert.ok(!rows[1].body.includes(user.username));
    store.saveRules({...store.rules(),notifications:{enabled:true,events:[]}},1,store.rules().version);
    assert.deepEqual(store.rules().notifications.events,[]);store.notifyClaimsBatch('shared-run');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,2);
  }finally{store.close();}
});
