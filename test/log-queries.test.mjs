// Persistent per-user query progress and local result pagination.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,log,user} from './helpers.mjs';
import {Compensation} from '../src/service.mjs';
import {LogQueries} from '../src/log-queries.mjs';
import {Store} from '../src/store.mjs';
test('并发首查及服务重启复用持久结果，账号独立',async t=>{
  const f=setup(t,[log('one'),log('other',{user_id:8})]);
  const results=await Promise.all(Array.from({length:8},()=>f.service.logs(user,{refresh:true})));
  assert.equal(f.calls.length,1);assert.ok(results.every(r=>r.items[0].assessment.canApply));
  f.advance(60000);assert.equal((await new Compensation(f.store,f.upstream,f.clock).logs(user,{})).total,1);assert.equal(f.calls.length,1);
  assert.equal((await f.service.logs({...user,id:8},{})).items[0].log.request_id,'other');
});
test('持久结果关联最新申请状态并排除已补偿，重复提交不重发',async t=>{
  const f=setup(t,[log('paid'),log('review',{id:101,other:'{}'}),log('available',{id:102})]);
  await f.service.logs(user,{});const paid=await f.service.selfService(user,'paid');await f.service.selfService(user,'review');
  const out=await f.service.logs(user,{});assert.equal(out.total,2);assert.equal(out.items.find(v=>v.log.request_id==='review').claim.status,'pending');
  assert.equal((await f.service.selfService(user,'paid')).id,paid.id);assert.equal(f.calls.length,1);
});
test('相同请求不同源行保留，缺少标识不可申请；发放重新核验',async t=>{
  const f=setup(t,[log('collision',{id:1}),log('collision',{id:2}),log(undefined,{id:3,request_id:undefined})]);
  const out=await f.service.logs(user,{});assert.equal(out.total,3);assert.equal(out.items.find(v=>!v.log.request_id).assessment.canApply,false);
  await assert.rejects(f.service.selfService(user,'collision'),/ambiguous/);assert.equal(f.store.overview().applications,0);
  f.logs.splice(1);f.logs[0].quota=0;await assert.rejects(f.service.selfService(user,'collision'),/候选条件/);
});
function setup(t,items=[]){
  const f=fixture({logs:items});t.after(()=>f.store.close());
  let now=Date.now(),fail=false;const calls=[];
  f.upstream.logs=async q=>{calls.push(q);if(fail)throw Error('unavailable');const rows=f.logs.filter(l=>l.user_id===q.user.id&&l.created_at>=q.start&&l.created_at<=q.end);return {items:structuredClone(rows.slice((q.page-1)*30,q.page*30)),total:rows.length};};
  const clock=()=>now;
  return {...f,clock,calls,advance:ms=>{now+=ms;},fail:v=>{fail=v;},service:new Compensation(f.store,f.upstream,clock)};
}
test('秒级接续：六月一日成功截止加一秒至六月七日点击时刻',async t=>{
  const f=setup(t);let now=Date.parse('2026-06-01T13:00:00+08:00');const scanner=new LogQueries(f.store,f.upstream,()=>now);
  const first=await scanner.read(user,{refresh:true},15*24);assert.equal(f.calls[0].start,now/1000-15*86400);
  now=Date.parse('2026-06-07T12:00:00+08:00');await scanner.read(user,{refresh:true},15*24);
  assert.equal(f.calls[1].start,first.end+1);assert.equal(f.calls[1].end,now/1000);
});
test('旧日志保留，已覆盖的延迟日志不重扫，翻页与同秒点击不拉取',async t=>{
  const f=setup(t,[log('old')]);const first=await f.service.logs(user,{}),end=first.queryProgress.end;
  await f.service.logs(user,{refresh:true});assert.equal(f.calls.length,1);
  f.advance(60000);await f.service.logs(user,{page:2});assert.equal(f.calls.length,1);
  f.logs.push(log('new',{id:101,created_at:end+1}),log('late',{id:102,created_at:end-20}));
  const out=await f.service.logs(user,{refresh:true});assert.equal(f.calls[1].start,end+1);
  assert.deepEqual(new Set(out.items.map(v=>v.log.request_id)),new Set(['old','new']));assert.equal(out.queryProgress.added,1);
});
test('所有模型同步，用户展示条件不改变覆盖范围；失败不推进',async t=>{
  const f=setup(t,[log('a'),log('b',{id:101,model_name:'other-model'}),log('other-user',{user_id:8})]);
  const out=await f.service.logs(user,{model:'fixture-model',requestId:'a',start:1,end:2});
  assert.equal(out.total,2);assert.equal(f.calls[0].model,undefined);assert.equal(f.calls[0].requestId,undefined);
  f.advance(2000);f.fail(true);await assert.rejects(f.service.logs(user,{refresh:true}),/unavailable/);
  assert.equal((await f.service.logs(user,{})).queryProgress.end,out.queryProgress.end);
  f.fail(false);await f.service.logs(user,{refresh:true});assert.equal(f.calls[1].start,f.calls[2].start);
});
test('固定全部分页与总数校验，不完整或重复页面不得提交',async t=>{
  const f=setup(t,Array.from({length:65},(_,i)=>log('row-'+i,{id:i+1})));const original=f.upstream.logs;
  f.upstream.logs=async q=>{const out=await original(q);f.advance(1000);return out;};
  const a=await f.service.logs(user,{}),b=await f.service.logs(user,{page:2}),c=await f.service.logs(user,{page:3});
  assert.equal(f.calls.length,3);assert.equal(new Set(f.calls.map(q=>q.end)).size,1);assert.equal(new Set([...a.items,...b.items,...c.items].map(v=>v.log.request_id)).size,65);
  for(const upstream of [
    {logs:async q=>({items:q.page===1?[log()]:[],total:2})},
    {logs:async q=>({items:[log()],total:q.page===1?2:1})},
    {logs:async()=>({items:[log()],total:2})},
    {logs:async()=>({items:[],total:10001})}
  ]){const other={...user,id:99};await assert.rejects(new LogQueries(f.store,upstream,f.clock).read(other,{},72));assert.equal(f.store.logQueryProgress(99),null);}
});
test('并发查询串行，晚点击只补尾段，空查询也推进',async t=>{
  const f=setup(t);await f.service.logs(user,{});f.advance(1000);const original=f.upstream.logs;let release,entered,block=true;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.upstream.logs=async q=>{const out=await original(q);if(block){block=false;entered();await gate;}return out;};
  const first=f.service.logs(user,{refresh:true});await started;const end=f.calls.at(-1).end;f.advance(2000);f.logs.push(log('tail',{created_at:end+1}));
  const second=f.service.logs(user,{refresh:true});release();await first;assert.equal((await second).items[0].log.request_id,'tail');assert.equal(f.calls.at(-1).start,end+1);assert.equal(f.calls.length,3);
});
test('窗口收窄跳过过期时间，扩大不回扫，进度不随缓存过期',async t=>{
  const f=setup(t);const scanner=new LogQueries(f.store,f.upstream,f.clock);await scanner.read(user,{},72);
  f.advance(4*86400000);await scanner.read(user,{refresh:true},24);assert.equal(f.calls[1].start,Math.floor(f.clock()/1000)-86400);
  f.store.db.exec('DELETE FROM log_query_cache');f.advance(1000);await scanner.read(user,{refresh:true},15*24);assert.equal(f.calls[2].start,Math.floor(f.clock()/1000));
});
test('数据库重启保留进度与日志，写入失败原子回滚',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'query-progress-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let store=new Store(join(dir,'db.sqlite'));const now=Date.now();
  try{
    await new LogQueries(store,{logs:async()=>({items:[log()],total:1})},()=>now).read(user,{},72);store.close();store=new Store(join(dir,'db.sqlite'));
    const out=await new LogQueries(store,{logs:async()=>{throw Error('must not rescan');}},()=>now+60000).read(user,{},72);assert.equal(out.items.length,1);assert.equal(out.end,Math.floor(now/1000));
    store.db.exec("CREATE TRIGGER fail_progress BEFORE UPDATE ON log_query_progress BEGIN SELECT RAISE(ABORT,'write failed'); END");
    await assert.rejects(new LogQueries(store,{logs:async()=>({items:[],total:0})},()=>now+60000).read(user,{refresh:true},72),/write failed/);assert.equal(store.logQueryProgress(user.id).end,out.end);assert.equal(store.logQueryProgress(user.id).items.length,1);
  }finally{store.close();}
});
