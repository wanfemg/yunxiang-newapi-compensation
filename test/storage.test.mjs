import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
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
  for(const status of ['sent','failed','cancelled','pending'])notice.run('test','{}',status,now,now-31*DAY);
  const before=store.storageInfo();const plan=manager.preview(1,options);
  assert.equal(plan.cache,1);assert.equal(plan.notifications,3);
  const result=manager.clean(1,plan.token,'确认清理');
  assert.equal(result.cache,1);assert.equal(result.notifications,3);
  assert.equal(store.get(c.id).request_id,c.request_id);
  assert.equal(store.storageInfo().claims,before.claims);assert.ok(store.storageInfo().events>before.events);
  assert.equal(store.storageInfo().logs,1);assert.equal(store.db.prepare('SELECT status FROM notifications').get().status,'pending');
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
