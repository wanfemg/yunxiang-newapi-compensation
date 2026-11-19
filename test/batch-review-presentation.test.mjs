import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,log,user,admin} from './helpers.mjs';
import {renderQueryBatch} from '../public/query-batches.js';

async function enrolled(f){
  const batch=(await f.service.logs(user,{refresh:true})).batches[0];
  f.store.enrollBatch(batch.id,f.logs,user,f.store.rules(),'核实空回',user.id);
  return {batch,claim:f.store.batchClaims(batch.id)[0]};
}

test('自动核验中的批次和首次站内通知不提前写成转人工',async t=>{
  const f=fixture({rules:{aiEnabled:true}});t.after(()=>f.store.close());
  const {batch}=await enrolled(f);
  const current=await f.service.batches.view(user,batch.id);
  const html=renderQueryBatch(current);
  assert.match(html,/等待自动核验/);
  assert.ok(!html.includes('待人工审核'));
  const inbox=f.store.inbox(user.id);
  assert.equal(inbox.total,1);
  assert.match(inbox.items[0].title,/已保存|自动核验/);
  assert.match(inbox.items[0].body,/自动核验/);
  assert.ok(!inbox.items[0].body.includes('人工审核队列'));
});

test('首次自动转人工通知保留具体原因，相同结果和重复查询不会重复发',async t=>{
  const f=fixture({rules:{aiEnabled:true,notifications:{enabled:true,events:['batch_result']}}});t.after(()=>f.store.close());
  const {batch,claim}=await enrolled(f);
  const reason='转人工审核：AI 估计空回概率为 82%，低于要求的 95%；日志中仍有输出，需要管理员进一步核实。';
  f.store.transition(claim.id,['pending'],'pending',user.id,reason);
  f.store.updateBatch(batch.id,'review','自动核验结束，剩余记录转管理员审核');
  let inbox=f.store.inbox(user.id);
  assert.equal(inbox.total,2);
  assert.equal(inbox.items[0].title,'申请转人工审核');
  assert.match(inbox.items[0].body,/82%.*95%/);
  assert.match(inbox.items[0].body,/仍有输出/);
  const originalId=inbox.items[0].id;
  f.store.transition(claim.id,['pending'],'pending',user.id,reason);
  await f.service.batches.view(user,batch.id);
  await f.service.batches.submit(user,batch.id);
  inbox=f.store.inbox(user.id);
  assert.equal(inbox.total,2);assert.equal(inbox.items[0].id,originalId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,0,'分流站内通知不产生逐条钉钉通知');
  f.store.notifyClaimsBatch(batch.id);f.store.notifyClaimsBatch(batch.id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,1,'重复整批汇总继续按原有机制去重');
  const html=renderQueryBatch(await f.service.batches.view(user,batch.id));
  assert.match(html,/待人工审核/);assert.match(html,/仍有输出/);
});

test('真实 AI 概率未达标准时，站内通知从自动核验更新为带原因的人工审核',async t=>{
  const f=fixture({rules:{aiEnabled:true,aiAutoThreshold:95}});t.after(()=>f.store.close());
  const {AIReviewer}=await import('../src/ai-review.mjs');
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'fixture',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:'{"empty_probability":0.82,"reason":"日志中有输出标记，需要进一步核实是否生成了有效回答。"}'}}]}))});
  const batch=(await f.service.logs(user,{refresh:true})).batches[0];
  await f.service.batches.submit(user,batch.id);
  const inbox=f.store.inbox(user.id);
  assert.equal(inbox.total,2);assert.equal(inbox.items[0].title,'申请转人工审核');
  assert.match(inbox.items[0].body,/82%.*95%/);assert.match(inbox.items[0].body,/有效回答/);
  assert.match(inbox.items[1].title,/自动核验/);assert.equal(f.calls(),0);
  await f.service.batches.submit(user,batch.id);
  assert.equal(f.store.inbox(user.id).total,2);
});

test('人工创建申请维持进入人工审核队列的原始通知',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const claim=await f.service.apply(admin,log().request_id,'人工核实',true);
  const inbox=f.store.inbox(user.id);
  assert.equal(inbox.total,1);assert.equal(inbox.items[0].title,'申请等待审核');
  assert.match(inbox.items[0].body,/人工审核队列/);
  f.store.transition(claim.id,['pending'],'pending',admin.id,'继续等待管理员核验');
  assert.equal(f.store.inbox(user.id).total,1);
});
