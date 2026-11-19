import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIReviewer } from '../src/ai-review.mjs';
import { Store } from '../src/store.mjs';
import { UpstreamError } from '../src/newapi.mjs';
import { nextResetAt, settlementClock } from '../src/rules.mjs';
import { admin, fixture, log, user } from './helpers.mjs';

function clock(t, value = Date.parse('2026-11-20T05:00:00Z')) {
  const original = Date.now;
  let now = value;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  return value => { now = value; };
}
function batch(f, id, logs) {
  f.logs.push(...logs);
  f.store.insertQueryBatch({ id, user, from: logs[0].created_at, end: logs.at(-1).created_at, items: logs });
  return id;
}
function enableAI(f, decide = () => .99) {
  let calls = 0;
  f.service.ai = new AIReviewer({ store: f.store, env: { AI_BASE_URL: 'http://ai.test/v1', AI_API_KEY: 'fixture', AI_MODEL: 'fixture' },
    fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ empty_probability: decide(++calls), reason: '按日志核查' }) } }] })) });
  return () => calls;
}

test('准确给出本地结算恢复时间，夏令时重复小时不会将已恢复的日再次回退', () => {
  const shanghai = { timezone: 'Asia/Shanghai', dailyResetTime: '04:00' };
  assert.equal(nextResetAt(Date.parse('2026-11-19T19:00:00Z'), shanghai), Date.parse('2026-11-19T20:00:00Z'));
  const ny = { timezone: 'America/New_York', dailyResetTime: '01:30' };
  assert.equal(nextResetAt(Date.parse('2026-11-01T05:00:00Z'), ny), Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(settlementClock(Date.parse('2026-11-01T06:00:00Z'), ny).day, '2026-11-01');
  assert.equal(nextResetAt(Date.parse('2026-11-01T06:00:00Z'), ny), Date.parse('2026-11-02T06:30:00Z'));
  const spring = { timezone: 'America/New_York', dailyResetTime: '02:30' };
  assert.equal(nextResetAt(Date.parse('2026-03-08T06:59:59Z'), spring), Date.parse('2026-03-08T07:00:00Z'));
  assert.equal(settlementClock(Date.parse('2026-03-08T07:00:00Z'), spring).day, '2026-03-08');
});

test('每日三次后第四个新批次在调用 AI 前拦截并说明恢复时间', async t => {
  clock(t);
  const f = fixture({ logs: [], rules: { aiEnabled: true, userDailyCount: 3 } });
  t.after(() => f.store.close());
  const aiCalls = enableAI(f);
  for (let i = 1; i <= 3; i++) await f.service.batches.submit(user, batch(f, 'day-' + i, [log('day-' + i, { quota: 10 })]));
  const id = batch(f, 'day-4', [log('day-4', { quota: 10 })]);
  await assert.rejects(f.service.batches.submit(user, id), error => {
    assert.equal(error.code, 'USER_DAILY_COUNT_LIMIT');
    assert.equal(error.limit.used, 3);
    assert.equal(error.limit.remaining, 0);
    assert.equal(error.limit.nextResetAt, Date.parse('2026-11-20T16:00:00Z'));
    return true;
  });
  assert.equal(aiCalls(), 3);
  assert.equal(f.store.batchClaims(id).length, 0);
  assert.equal(f.calls(), 3);
});

test('已补200再需150且日限300：全额等待，次日用户本人续付不重新AI且保留申请有效期', async t => {
  const advance = clock(t);
  const f = fixture({ logs: [], rules: { aiEnabled: true, userDailyQuota: 300, applicationHours: 1 } });
  t.after(() => f.store.close());
  const aiCalls = enableAI(f);
  await f.service.batches.submit(user, batch(f, 'paid200', [log('paid200', { quota: 200 })]));
  const id = batch(f, 'await150', [log('await150', { quota: 150 })]);
  const result = await f.service.batches.submit(user, id);
  assert.equal(result.status, 'waiting_limit');
  assert.equal(result.limit.code, 'USER_DAILY_QUOTA_LIMIT');
  assert.equal(result.limit.remaining, 100);
  assert.equal(result.limit.required, 150);
  assert.equal(f.store.byRequest('await150').status, 'approved');
  const waitingClaim=f.store.byRequest('await150'),blockedClaimView=f.service.view(waitingClaim);
  assert.equal(blockedClaimView.waitingLimit,true);assert.equal(blockedClaimView.canResume,false);
  assert.equal(blockedClaimView.limit.code,'USER_DAILY_QUOTA_LIMIT');
  assert.equal(f.calls(), 1);
  await assert.rejects(f.service.batches.resume({ ...user, id: 8 }, id), /不存在|本人/);
  advance(Date.parse('2026-11-21T05:00:00Z'));
  const readyClaimView=f.service.view(f.store.get(waitingClaim.id));
  assert.equal(readyClaimView.waitingLimit,true);assert.equal(readyClaimView.canResume,true);assert.equal(readyClaimView.limit,null);
  const resumed = await f.service.batches.resume(user, id);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.paidAmount, 150);
  assert.equal(aiCalls(), 2);
  assert.equal(f.calls(), 2);
  const paidClaimView=f.service.view(f.store.get(waitingClaim.id));
  assert.equal(paidClaimView.waitingLimit,false);assert.equal(paidClaimView.canResume,false);assert.equal(paidClaimView.limit,null);
  const expired = batch(f, 'never-submitted', [log('never-submitted', { created_at: Math.floor(Date.now() / 1000) - 7200 })]);
  assert.equal((await f.service.batches.submit(user, expired)).status, 'rejected');
  assert.equal(aiCalls(), 2);
});

test('预计合计超额只提示，最终仅少数模型通过仍能在剩余额度内补偿', async t => {
  clock(t);
  const f = fixture({ logs: [], rules: { aiEnabled: true, userDailyQuota: 150 } });
  t.after(() => f.store.close());
  const aiCalls = enableAI(f, call => call === 1 ? .99 : .5);
  const id = batch(f, 'some-pass', [log('pass100', { quota: 100 }), log('pending100', { quota: 100, id: 101 })]);
  const before = await f.service.batches.view(user, id);
  assert.equal(before.submissionLimit, null);
  assert.equal(before.warnings[0].code, 'USER_DAILY_QUOTA_LIMIT');
  const result = await f.service.batches.submit(user, id);
  assert.equal(result.status, 'review');
  assert.equal(result.paidAmount, 100);
  assert.equal(aiCalls(), 2);
});

test('同一个批次跨日补余款终生一次，当日金额仍按付款日扣减', async t => {
  const advance = clock(t);
  const firstDay = Date.now();
  const f = fixture({ logs: [], rules: { aiEnabled: true } });
  t.after(() => f.store.close());
  enableAI(f, call => call === 1 ? .99 : .5);
  const id = batch(f, 'cross-day', [log('cross-a'), log('cross-b', { id: 101 })]);
  await f.service.batches.submit(user, id);
  advance(firstDay + 86400000);
  const remaining=f.store.batchClaims(id).find(claim=>claim.status==='pending');
  assert.ok(remaining);
  f.service.review(admin, remaining.id, 'approve', '核实空回');
  await f.service.batches.settle(admin, id);
  assert.deepEqual(f.store.overview(user.id, firstDay).today, { quota: 120, count: 1 });
  assert.deepEqual(f.store.overview(user.id).today, { quota: 120, count: 0 });
  assert.equal(f.store.refundRecords(user.id).total, 1);
});

test('并发新批次先占次数，用户和全站次数限制均阻止第二批进入AI', async t => {
  clock(t);
  for(const scope of ['user','site']){
    const f=fixture({logs:[],rules:{aiEnabled:true,userDailyCount:scope==='user'?1:5,siteDailyCount:scope==='site'?1:20}});
    t.after(()=>f.store.close());
    const secondUser=scope==='site'?{...user,id:8,username:'another-user'}:user;
    f.upstream.target=async id=>id===secondUser.id?secondUser:user;
    let calls=0,release;
    const blocked=new Promise(resolve=>{release=resolve;});
    f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'fixture',AI_MODEL:'fixture'},fetcher:async()=>{
      calls++;await blocked;return new Response(JSON.stringify({choices:[{message:{content:'{"empty_probability":0.99,"reason":"按日志核查"}'}}]}));
    }});
    const first=batch(f,'first-'+scope,[log('first-'+scope)]);
    const source=log('second-'+scope,{user_id:secondUser.id,username:secondUser.username});f.logs.push(source);
    const second='second-'+scope;f.store.insertQueryBatch({id:second,user:secondUser,from:source.created_at,end:source.created_at,items:[source]});
    const running=await f.service.batches.submitBackground(user,first);
    try{
      await assert.rejects(f.service.batches.submit(secondUser,second),error=>error.code===(scope==='user'?'USER_DAILY_COUNT_LIMIT':'SITE_DAILY_COUNT_LIMIT'));
      assert.equal(f.store.batchClaims(second).length,0);
    }finally{release();await running.completion;}
    assert.equal(calls,1);assert.equal(f.calls(),1);
    assert.equal(f.store.overview().siteToday.count,1);
  }
});

test('旧单条已通过申请可次日续付且重复恢复幂等，原日志或账号变化仍禁止发放', async t => {
  const advance=clock(t);
  const f=fixture({logs:[log('single-paid',{quota:200}),log('single-wait',{quota:150})],rules:{aiEnabled:true,userDailyQuota:300,applicationHours:1}});
  t.after(()=>f.store.close());const aiCalls=enableAI(f);
  await f.service.selfService(user,'single-paid');
  const waiting=await f.service.selfService(user,'single-wait');
  assert.equal(waiting.status,'approved');assert.equal(waiting.limit.required,150);
  advance(Date.now()+86400000);
  assert.equal(f.service.view(f.store.get(waiting.id)).canResume,true);
  f.logs[1].other=JSON.stringify({billing_source:'wallet',refunded:true});
  await assert.rejects(f.service.resume(user,waiting.id),/发生变化/);
  f.logs[1].other=f.store.get(waiting.id).log.other;
  f.upstream.target=async()=>({...user,status:2});
  await assert.rejects(f.service.resume(user,waiting.id),/账号状态异常/);
  f.upstream.target=async()=>user;
  const resumed=await f.service.resume(user,waiting.id);assert.equal(resumed.status,'succeeded');
  assert.equal((await f.service.resume(user,waiting.id)).status,'succeeded');
  assert.equal(aiCalls(),2);assert.equal(f.calls(),2);
  assert.equal(f.store.overview(user.id).today.quota,150);
});

test('AI请求已发出即占一次，连接失败计数，未配置与无效地址不计数', async t => {
  clock(t);
  const f=fixture({logs:[],rules:{aiEnabled:true,aiDailyLimit:5}});t.after(()=>f.store.close());
  let requests=0;
  const reviewer=env=>new AIReviewer({store:f.store,env,fetcher:async()=>{requests++;throw Error('offline');}});
  const configured={AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'fixture',AI_MODEL:'fixture'};
  assert.equal((await reviewer(configured).review(log('network-failed'),f.store.rules())).status,'failed');
  assert.equal((await reviewer({}).review(log('not-configured'),f.store.rules())).status,'fallback');
  assert.equal((await reviewer({...configured,AI_BASE_URL:'not-a-url'}).review(log('invalid-url'),f.store.rules())).status,'failed');
  const day=settlementClock(Date.now(),f.store.rules()).day;
  assert.equal(f.store.aiReviewCount(day,user.id),1);assert.equal(requests,1);
});

test('旧跨日批次迁移只记录首次补偿日，失败释放次数，重启保留未确认资金占用', async t => {
  const advance=clock(t),first=Date.now();
  const directory=mkdtempSync(join(tmpdir(),'limit-ledger-')),path=join(directory,'data.sqlite');
  let store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const f=fixture();t.after(()=>f.store.close());store.saveRules(f.store.rules(),admin.id,1);
  const logs=[log('legacy-first'),log('legacy-second',{id:101})];
  store.insertQueryBatch({id:'legacy-batch',user,from:logs[0].created_at,end:logs[0].created_at,items:logs});
  store.enrollBatch('legacy-batch',logs,user,store.rules(),'旧批次',user.id);
  const claims=store.batchClaims('legacy-batch');
  store.db.prepare("UPDATE claims SET status='succeeded',amount=120,reserved_at=?,execution_day=? WHERE id=?").run(first,settlementClock(first,store.rules()).day,claims[0].id);
  advance(first+86400000);
  store.db.prepare("UPDATE claims SET status='executing',amount=120,reserved_at=?,execution_day=? WHERE id=?").run(Date.now(),settlementClock(Date.now(),store.rules()).day,claims[1].id);
  store.db.prepare("UPDATE compensation_batches SET status='executing' WHERE id='legacy-batch'").run();
  store.db.prepare("DELETE FROM metadata WHERE key='compensation_counts_migrated'").run();
  store.close();store=new Store(path);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM compensation_counts').get().n,1);
  assert.equal(store.overview(user.id,first).today.count,1);assert.equal(store.overview(user.id).today.count,0);
  assert.equal(store.overview(user.id).today.quota,120);assert.equal(store.get(claims[1].id).status,'unknown');
  const failed=fixture({rules:{userDailyCount:1},credit:()=>{throw new UpstreamError('refused',true);}});t.after(()=>failed.store.close());
  assert.equal((await failed.service.selfService(user,'fixture-request-1')).status,'failed');
  assert.equal(failed.store.overview(user.id).today.count,0);
  assert.equal(failed.store.compensationLimit(user.id,'new-key',0,failed.store.rules(),{countsOnly:true}),null);
});

test('AI只统计真正开始的模型调用批次，并按站点结算时间恢复，管理员不计数', async t => {
  const advance = clock(t, Date.parse('2026-11-19T19:00:00Z'));
  const f = fixture({ logs: [], rules: { aiEnabled: true, aiDailyLimit: 1, dailyResetTime: '04:00' } });
  t.after(() => f.store.close());
  const calls = enableAI(f);
  await f.service.ai.review(log('one'), f.store.rules(), { batchId: 'one' });
  await assert.rejects(f.service.ai.review(log('two'), f.store.rules(), { batchId: 'two' }), /AI.*上限/);
  assert.equal(f.store.aiReviewCount('2026-11-19', user.id), 1);
  await f.service.ai.review(log('admin'), f.store.rules(), { mode: 'admin' });
  assert.equal(f.store.aiReviewCount('2026-11-19', user.id), 1);
  advance(Date.parse('2026-11-19T20:00:00Z'));
  await f.service.ai.review(log('next-day'), f.store.rules(), { batchId: 'next-day' });
  assert.equal(f.store.aiReviewCount('2026-11-20', user.id), 1);
  assert.equal(calls(), 3);
});

test('单条申请也按原规则和最新规则更严的单次上限执行', async t => {
  clock(t);
  const f = fixture({ rules: { perBatchQuota: 100 } });
  t.after(() => f.store.close());
  const claim = await f.service.apply(user, 'fixture-request-1', '核实');
  f.service.review(admin, claim.id, 'approve', '核实');
  f.service.saveRules(admin, { ...f.store.rules(), perBatchQuota: 200 });
  await assert.rejects(f.service.execute(admin, claim.id, 120, '核实'), error => error.code === 'PER_BATCH_QUOTA_LIMIT');
  assert.equal(f.calls(), 0);
});

test('同一限制未变化时重复恢复不更新单条时间，也不重复发送整组钉钉通知', async t => {
  const advance=clock(t);
  for(const isBatch of [false,true]){
    const f=fixture({logs:[],rules:{aiEnabled:true,userDailyQuota:100,notifications:{enabled:true,events:['batch_result']}}});
    t.after(()=>f.store.close());enableAI(f);
    const source=log('notice-'+isBatch);let id,runId;
    if(isBatch){
      id=batch(f,'notice-batch',[source]);runId=id;
      await f.service.batches.submit(user,id);
    }else{
      f.logs.push(source);runId='notice-single';id=(await f.service.selfService(user,source.request_id,'核实空回',runId)).id;
    }
    f.store.notifyClaimsBatch(runId);
    const before=f.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
    assert.equal(before,1);
    const originalTime=isBatch?null:f.store.get(id).updated_at;
    advance(Date.now()+1000);
    for(let i=0;i<2;i++){
      if(isBatch)await f.service.batches.resume(user,id);else await f.service.resume(user,id);
      f.store.notifyClaimsBatch(runId);
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,before);
    if(!isBatch)assert.equal(f.store.get(id).updated_at,originalTime);
    else assert.match(f.store.db.prepare('SELECT body FROM notifications').get().body,/补偿暂缓|当日额度不足/);
    assert.equal(f.calls(),0);
  }
});

test('允许变更结算时区时重分桶已用AI次数和处理中占位，不因切时区获得额外调用', async t => {
  clock(t,Date.parse('2026-11-20T00:30:00Z'));
  const f=fixture({logs:[],rules:{aiEnabled:true,aiDailyLimit:1,userDailyCount:1}});t.after(()=>f.store.close());
  const calls=enableAI(f);
  await f.service.ai.review(log('timezone-start'),f.store.rules());
  f.store.holdCompensationSlot('timezone-slot',user.id,f.store.rules());
  f.service.saveRules(admin,{...f.store.rules(),timezone:'America/Los_Angeles'});
  const day=settlementClock(Date.now(),f.store.rules()).day;
  assert.equal(day,'2026-11-19');assert.equal(f.store.aiReviewCount(day,user.id),1);
  assert.equal(f.store.processingCount(day,user.id),1);
  await assert.rejects(f.service.ai.review(log('timezone-again'),f.store.rules()),error=>error.code==='AI_DAILY_COUNT_LIMIT');
  assert.throws(()=>f.store.holdCompensationSlot('timezone-new-slot',user.id,f.store.rules()),error=>error.code==='USER_DAILY_COUNT_LIMIT');
  assert.equal(calls(),1);
});

test('人工已通过的单条续付也检查账号状态，不向已禁用用户发放', async t => {
  const advance=clock(t);
  const f=fixture({logs:[log('manual-paid',{quota:200}),log('manual-wait',{quota:150})],rules:{userDailyQuota:300,applicationHours:1}});
  t.after(()=>f.store.close());
  await f.service.selfService(user,'manual-paid');
  const claim=await f.service.apply(user,'manual-wait','人工核实');
  f.service.review(admin,claim.id,'approve','核实空回');
  assert.equal((await f.service.execute(admin,claim.id,150,'核实未返还')).status,'approved');
  advance(Date.now()+86400000);
  f.upstream.target=async()=>({...user,status:2});
  await assert.rejects(f.service.resume(user,claim.id),/账号状态异常/);
  assert.equal(f.calls(),1);assert.equal(f.store.get(claim.id).status,'approved');
});
