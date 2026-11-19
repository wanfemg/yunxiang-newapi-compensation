import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { StorageMaintenance } from '../src/storage.mjs';
import { log, user, rules } from './helpers.mjs';

const options={cache:true,notifications:true,backups:false,compact:false,cacheDays:7,notificationDays:30,backupDays:30};
const DAY=86400000;
function fixture(t,persistent=false){
  const directory=persistent?mkdtempSync(join(tmpdir(),'storage-test-')):null;
  const store=new Store(directory?join(directory,'compensation.sqlite'):':memory:');
  const now=Date.now();let clock=now;
  const manager=new StorageMaintenance(store,()=>clock);
  t.after(()=>{store.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  return {store,manager,now,directory,advance:ms=>clock+=ms};
}
test('仅清理过期缓存与已结束通知，所有申请和审计保留',t=>{
  const {store,manager,now}=fixture(t);
  const c=store.create(log(),user,rules(),'x','self',7);
  store.cacheLogQuery('old',{items:[]});store.cacheLogQuery('new',{items:[]});
  store.db.prepare('UPDATE log_query_cache SET created_at=? WHERE cache_key=?').run(now-8*DAY,'old');
  const notice=store.db.prepare('INSERT INTO notifications(event,body,status,next_at,created_at) VALUES(?,?,?,?,?)');
  for(const status of ['sent','failed','cancelled','pending'])notice.run('test','{"title":"历史通知","text":"请审核此申请"}',status,now,now-31*DAY);
  const before=store.storageInfo();const plan=manager.preview(1,options);
  assert.equal(plan.cache,1);assert.equal(plan.notifications,3);
  const result=manager.clean(1,plan.token,'确认清理');
  assert.equal(result.cache,1);assert.equal(result.notifications,3);
  assert.equal(store.get(c.id).request_id,c.request_id);
  assert.equal(store.storageInfo().claims,before.claims);assert.ok(store.storageInfo().events>before.events);
  assert.equal(store.storageInfo().logs,1);assert.equal(store.storageInfo().notifications,4);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE json_extract(body,'$.contentCleared')=1").get().n,3);
  assert.match(store.db.prepare("SELECT body FROM notifications WHERE status='pending'").get().body,/请审核/);
});
test('预览只读、绑定管理员、短期有效且单次使用',t=>{
  const {manager,store,advance}=fixture(t);
  const plan=manager.preview(1,options),before=store.storageInfo();
  assert.deepEqual(store.storageInfo(),before);
  assert.throws(()=>manager.clean(2,plan.token,'确认清理'),/失效/);
  assert.throws(()=>manager.clean(1,plan.token,'yes'),/确认/);
  manager.clean(1,plan.token,'确认清理');
  assert.throws(()=>manager.clean(1,plan.token,'确认清理'),/失效/);
  const expired=manager.preview(1,options);advance(300001);
  assert.throws(()=>manager.clean(1,expired.token,'确认清理'),/失效/);
});
test('预览后被刷新缓存及新数据不会被旧计划删除',t=>{
  const {manager,store,now}=fixture(t);
  store.cacheLogQuery('key',{old:true});
  store.db.prepare('UPDATE log_query_cache SET created_at=?').run(now-8*DAY);
  const plan=manager.preview(1,options);
  store.cacheLogQuery('key',{fresh:true});store.cacheLogQuery('later',{fresh:true});
  assert.equal(manager.clean(1,plan.token,'确认清理').cache,0);
  assert.equal(store.storageInfo().logs,2);
});
test('发放中禁止清理，所有清理选项必须符合边界',t=>{
  const {manager,store}=fixture(t);
  for(const input of [{...options,cacheDays:0},{...options,notificationDays:1},{...options,backups:'yes'},{...options,cache:false,notifications:false}])assert.throws(()=>manager.preview(1,input));
  const c=store.create(log(),user,rules(),'x','self',7);store.transition(c.id,['pending'],'approved',1,'x');store.reserve(c.id,1,120,120,'x',rules());
  const plan=manager.preview(1,options);
  assert.throws(()=>manager.clean(1,plan.token,'确认清理'),/正在发放/);
  assert.equal(store.get(c.id).status,'executing');
});
test('快照仅限独立目录白名单，保留最新三份并跳过预览后变化文件',t=>{
  const {manager,directory,now}=fixture(t,true);
  const backupDir=join(directory,'backups');mkdirSync(backupDir);
  const files=[];
  for(let i=1;i<=6;i++){
    const name='compensation-2026-01-0'+i+'T00-00-00-000Z.sqlite',path=join(backupDir,name);
    writeFileSync(path,'fixture');utimesSync(path,new Date(now-(40-i)*DAY),new Date(now-(40-i)*DAY));files.push(path);
  }
  writeFileSync(join(backupDir,'secrets.key'),'must keep');writeFileSync(join(directory,'dingtalk.enc'),'must keep');
  const plan=manager.preview(1,{...options,backups:true});assert.equal(plan.backups.length,3);
  writeFileSync(files[0],'changed after preview');
  const result=manager.clean(1,plan.token,'确认清理');
  assert.equal(result.backups,2);assert.equal(result.skippedBackups,1);
  assert.ok(existsSync(files[0]));assert.ok(files.slice(3).every(existsSync));
  assert.ok(existsSync(join(backupDir,'secrets.key')));assert.ok(existsSync(join(directory,'compensation.sqlite')));assert.ok(existsSync(join(directory,'dingtalk.enc')));
});
test('空间整理后唯一消费索引和未知发放冻结仍有效',t=>{
  const {manager,store}=fixture(t,true);
  const c=store.create(log(),user,rules(),'x','self',7);store.transition(c.id,['pending'],'approved',1,'x');store.reserve(c.id,1,120,120,'x',rules());store.transition(c.id,['executing'],'unknown',1,'超时');
  const plan=manager.preview(1,{...options,compact:true});
  assert.equal(manager.clean(1,plan.token,'确认清理').compacted,true);
  assert.equal(store.get(c.id).status,'unknown');assert.equal(store.overview(7).today.quota,120);
  assert.throws(()=>store.create(log(),user,rules(),'again','self',7),/已申请/);
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});

test('容量按实际数据库和WAL文件统计，分类正文使用UTF-8字节',t=>{
  const {store,manager,directory,now}=fixture(t,true);
  const payload=JSON.stringify({items:[{model:'中文模型',reason:'空回'}]});
  store.db.prepare('INSERT INTO log_query_cache VALUES(?,?,?)').run('category-cache',payload,now);
  const backupDir=join(directory,'backups');mkdirSync(backupDir);
  writeFileSync(join(backupDir,'compensation-2026-01-01T00-00-00-000Z.sqlite'),'backup');
  const data=manager.info(),file=join(directory,'compensation.sqlite');
  assert.equal(data.physical.databaseBytes,statSync(file).size);
  assert.equal(data.physical.walBytes,statSync(file+'-wal').size);
  assert.equal(data.physical.shmBytes,statSync(file+'-shm').size);
  assert.equal(data.physical.backupBytes,6);
  assert.equal(data.physical.totalBytes,data.physical.databaseBytes+data.physical.walBytes+data.physical.shmBytes+6);
  const cache=data.categories.find(row=>row.key==='cache');
  assert.equal(cache.count,1);assert.equal(cache.payloadBytes,Buffer.byteLength(payload));
  for(const key of ['snapshots','batches','claims','aiReviews','audit','dingNotifications','emailNotifications','inbox','system'])assert.ok(data.categories.some(row=>row.key===key),key);
  assert.equal(data.bytes,data.logicalBytes);
});

test('清理通知正文保留状态与去重身份，邮件队列和站内通知不受影响',t=>{
  const {store,manager,now}=fixture(t),old=now-40*DAY;
  const notice=store.db.prepare('INSERT INTO notifications(event,body,status,next_at,result,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?)');
  for(const status of ['sent','failed','cancelled','pending','sending'])notice.run('pending','{"title":"申请待审核","text":"历史正文"}',status,now,'发送结果','pending:'+createHash('sha256').update(status).digest('hex'),old);
  const email=store.db.prepare('INSERT INTO email_notifications(event,recipient,body,status,next_at,result,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?)');
  for(const status of ['sent','failed','cancelled','skipped','pending','sending'])email.run('rejected','ciphertext','{"subject":"审核结果","text":"未通过原因"}',status,now,'邮件发送结果','email-'+status,old);
  const claim=store.create(log(),user,rules(),'保留申请','self',7);
  store.db.exec('CREATE TABLE IF NOT EXISTS email_notification_claims(event TEXT NOT NULL,claim_id TEXT NOT NULL,notification_id INTEGER NOT NULL,PRIMARY KEY(event,claim_id))');
  store.db.prepare('INSERT INTO email_notification_claims VALUES(?,?,?)').run('rejected',claim.id,1);
  const emailLedger=store.db.prepare('SELECT * FROM email_notification_claims').all();
  const inbox=store.db.prepare('SELECT COUNT(*) AS n FROM user_notifications').get().n;
  const plan=manager.preview(1,options);
  assert.equal(plan.notifications,7);assert.equal(plan.breakdown.dingNotifications.count,3);assert.equal(plan.breakdown.emailNotifications.count,4);
  assert.ok(plan.payloadBytes>0);
  const result=manager.clean(1,plan.token,'确认清理');
  assert.equal(result.notifications,7);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,5);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM email_notifications').get().n,6);
  for(const table of ['notifications','email_notifications']){
    assert.match(store.db.prepare(`SELECT body FROM ${table} WHERE status='pending'`).get().body,/历史正文|未通过原因/);
    assert.match(store.db.prepare(`SELECT body FROM ${table} WHERE status='sending'`).get().body,/历史正文|未通过原因/);
    const row=store.db.prepare(`SELECT * FROM ${table} WHERE status='sent'`).get();
    assert.equal(JSON.parse(row.body).contentCleared,true);assert.equal(row.result,'历史内容已清理');assert.ok(row.dedupe_key);
    if(table==='email_notifications')assert.equal(row.recipient,null);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM user_notifications').get().n,inbox);
  assert.deepEqual(store.db.prepare('SELECT * FROM email_notification_claims').all(),emailLedger);
  assert.ok(store.get(claim.id));assert.equal(manager.preview(1,options).notifications,0);
  store.saveRules({...store.rules(),notifications:{...store.rules().notifications,enabled:true,events:['pending']}},1,store.rules().version);
  const before=store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  store.notify('pending','{}','sent');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,before,'cleared sent record still prevents duplicate notification');
});

test('只裁剪旧进度中已结案申请的日志副本，原申请、批次和秒级游标保留',t=>{
  const {store,manager,now}=fixture(t),old=now-40*DAY;
  const settled=log('settled',{created_at:Math.floor(old/1000)}),pending=log('pending',{created_at:Math.floor(old/1000)}),unsubmitted=log('unsubmitted',{created_at:Math.floor(old/1000)});
  const c=store.create(settled,user,rules(),'保留证据','self',7);store.transition(c.id,['pending'],'rejected',1,'已有结论');
  store.db.prepare('UPDATE claims SET updated_at=? WHERE id=?').run(old,c.id);
  store.create(pending,user,rules(),'待审核证据','self',7);
  const snapshot={items:[settled,pending,unsubmitted],from:100,end:200,coverageStart:80,syncedAt:now,added:0};
  store.saveLogQueryProgress(user.id,snapshot,{id:'preserved-batch',user,from:100,end:200,items:snapshot.items});
  const batches=store.db.prepare('SELECT * FROM compensation_batches').all();
  const before=store.db.prepare('SELECT * FROM claims').all();
  const plan=manager.preview(1,{...options,snapshots:true,snapshotDays:30});
  assert.equal(plan.snapshots,1);
  assert.equal(manager.clean(1,plan.token,'确认清理').snapshots,1);
  const saved=JSON.parse(store.db.prepare('SELECT payload FROM log_query_progress WHERE user_id=?').get(user.id).payload);
  assert.deepEqual(saved.items.map(row=>row.request_id),['pending','unsubmitted']);
  for(const key of ['from','end','coverageStart','syncedAt'])assert.equal(saved[key],snapshot[key]);
  assert.equal(saved.maintenance.removedSettledCopies,1);assert.notEqual(saved.itemsOmitted,true);
  assert.deepEqual(store.db.prepare('SELECT * FROM compensation_batches').all(),batches);
  assert.deepEqual(store.db.prepare('SELECT * FROM claims').all(),before);
  assert.equal(manager.preview(1,{...options,snapshots:true,snapshotDays:30}).snapshots,0);
});

test('预览后改变的通知与查询进度正文不会被旧计划覆盖',t=>{
  const {store,manager,now}=fixture(t),old=now-40*DAY;
  const source=log('stale-snapshot',{created_at:Math.floor(old/1000)}),claim=store.create(source,user,rules(),'x','self',7);
  store.transition(claim.id,['pending'],'rejected',1,'x');store.db.prepare('UPDATE claims SET updated_at=? WHERE id=?').run(old,claim.id);
  store.saveLogQueryProgress(user.id,{items:[source],from:100,end:200,coverageStart:100,syncedAt:now});
  store.db.prepare("INSERT INTO notifications(event,body,status,next_at,created_at) VALUES('test','{\"text\":\"旧正文\"}','sent',?,?)").run(now,old);
  const plan=manager.preview(1,{...options,snapshots:true,snapshotDays:30});
  store.db.prepare("UPDATE notifications SET body='{\"text\":\"已修正正文\"}'").run();
  store.db.prepare('UPDATE log_query_progress SET payload=?').run(JSON.stringify({items:[source,log('new-log')],from:100,end:201,coverageStart:100}));
  const result=manager.clean(1,plan.token,'确认清理');
  assert.equal(result.notifications,0);assert.equal(result.snapshots,0);
  assert.match(store.db.prepare('SELECT body FROM notifications').get().body,/已修正/);
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM log_query_progress').get().payload).items.length,2);
});

test('补偿次数与AI次数等持久账本计入系统分类，清理和整理后保持原样',t=>{
  const {store,manager,now}=fixture(t,true);
  const before=store.storageInfo().categories.find(row=>row.key==='system');
  const day='2026-11-20';
  const ledgers=[['compensation_counts','batch-count'],['compensation_slots','batch-slot'],['ai_review_runs','ai-run']];
  for(const [table,key] of ledgers)store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(key,user.id,now,day);
  const expected=ledgers.map(([table])=>store.db.prepare(`SELECT * FROM ${table}`).all());
  const category=store.storageInfo().categories.find(row=>row.key==='system');
  assert.equal(category.count,before.count+3);
  assert.equal(category.payloadBytes,before.payloadBytes+ledgers.reduce((sum,[,key])=>sum+Buffer.byteLength(key)+Buffer.byteLength(day),0));
  const plan=manager.preview(1,{...options,snapshots:true,snapshotDays:30,compact:true});
  manager.clean(1,plan.token,'确认清理');
  for(let index=0;index<ledgers.length;index++)assert.deepEqual(store.db.prepare(`SELECT * FROM ${ledgers[index][0]}`).all(),expected[index]);
});
