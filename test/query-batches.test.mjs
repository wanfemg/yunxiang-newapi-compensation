import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,log,user,admin,rules} from './helpers.mjs';
import {Store} from '../src/store.mjs';
import {Compensation} from '../src/service.mjs';
import {UpstreamError} from '../src/newapi.mjs';
import {renderQueryBatch} from '../public/query-batches.js';
import {groupAuditEvents,renderAuditLog} from '../public/audit-log.js';

async function queried(f){return (await f.service.logs(user,{refresh:true})).batches[0];}
test('一次查询跨多个模型和分页：全部判定结束，只向原站合计加额度一次',async t=>{
  const credits=[],f=fixture({logs:Array.from({length:35},(_,i)=>log('multi-'+i,{id:i,quota:2,model_name:i%2?'a':'b'})),rules:{models:['a','b'],userDailyCount:1,maxPending:1},credit:(...args)=>credits.push(args)});t.after(()=>f.store.close());
  const batch=await queried(f);assert.equal(batch.records,35);
  const result=await f.service.batches.submit(user,batch.id);
  assert.equal(result.status,'succeeded');assert.equal(result.amount,70);
  assert.deepEqual(credits,[[user.id,70]]);assert.equal(f.store.overview(user.id).today.count,1);assert.equal(f.store.overview(user.id).today.quota,70);
  assert.equal(f.store.personalStatistics(user.id).count,1);assert.equal(f.store.batchClaims(batch.id).length,35);
  assert.ok(f.store.batchClaims(batch.id).every(c=>c.status==='succeeded'));
  assert.equal(f.store.refundRecords(user.id).total,1);
});
test('自动通过和待人工审核混合：先不补，最后审核完合并通过部分',async t=>{
  const f=fixture({logs:[log('auto'),log('manual',{id:101,other:'{}'}),log('reject',{id:102,other:'{}'})]});t.after(()=>f.store.close());
  const batch=await queried(f),out=await f.service.batches.submit(user,batch.id);
  assert.equal(out.status,'review');assert.equal(out.pending,2);assert.equal(f.calls(),0);assert.equal(f.store.overview(user.id).today.count,0);
  f.service.review(admin,f.store.byRequest('manual').id,'approve','人工核实');
  await f.service.batches.settle(admin,batch.id);assert.equal(f.calls(),0);
  f.service.review(admin,f.store.byRequest('reject').id,'reject','有正常输出');
  await f.service.batches.settle(admin,batch.id);
  assert.equal(f.calls(),1);assert.equal(f.store.queryBatch(batch.id).amount,240);
  assert.equal(f.store.byRequest('reject').status,'rejected');assert.equal(f.store.overview(user.id).today.count,1);
  assert.throws(()=>f.service.reopen(admin,f.store.byRequest('reject').id,'试图再次补'),/已经补偿/);
});
test('整批均未通过不发放、不占次数',async t=>{
  const f=fixture({logs:[log('manual',{other:'{}'})]});t.after(()=>f.store.close());
  const b=await queried(f);await f.service.batches.submit(user,b.id);
  f.service.review(admin,f.store.byRequest('manual').id,'reject','审核未通过');await f.service.batches.settle(admin,b.id);
  assert.equal(f.store.queryBatch(b.id).status,'rejected');assert.equal(f.calls(),0);assert.equal(f.store.overview(user.id).today.count,0);
});
test('整批总额上限和每日额度不静默拆分或截断，保留处理原因',async t=>{
  for(const cap of [{perBatchQuota:200},{userDailyQuota:200},{siteDailyQuota:200}]){
    const f=fixture({logs:[log('a'),log('b',{id:101})],rules:cap});
    try{const b=await queried(f),out=await f.service.batches.submit(user,b.id);assert.equal(out.status,'review');assert.match(out.note,/上限|额度或次数不足/);assert.equal(f.calls(),0);assert.equal(f.store.overview(user.id).today.count,0);}
    finally{f.store.close();}
  }
});
test('新查询生成新批次，旧查询翻页/刷新/重复提交和旧接口均不能重复补',async t=>{
  const f=fixture();t.after(()=>f.store.close());let now=Date.now()-5000;f.service.logQueries.clock=()=>now;
  const b=await queried(f);await Promise.all(Array.from({length:4},()=>f.service.batches.submit(user,b.id)));assert.equal(f.calls(),1);
  await f.service.selfService(user,'fixture-request-1');assert.equal(f.calls(),1);
  f.logs.push(log('next',{id:101,created_at:Math.floor(now/1000)+1}));now+=3000;
  const next=await queried(f);assert.notEqual(next.id,b.id);
  await f.service.batches.submit(user,next.id);assert.equal(f.calls(),1,'settlement wait keeps new log for manual review');
  assert.equal(f.store.byRequest('next').batch_id,next.id);
  assert.equal(f.store.batchClaims(b.id).length,1);
});
test('超时整批冻结、只对账不重发、明确拒绝释放整批占用',async t=>{
  for(const [error,status]of [[Error('lost'),'unknown'],[new UpstreamError('refused',true),'failed']]){
    const f=fixture({logs:[log('a'),log('b',{id:101})],credit:()=>{throw error;}});
    try{
      const b=await queried(f),out=await f.service.batches.submit(user,b.id);assert.equal(out.status,status);
      assert.ok(f.store.batchClaims(b.id).every(c=>c.status===status));
      assert.equal(f.store.overview(user.id).today.count,status==='unknown'?1:0);
      await f.service.batches.submit(user,b.id);await f.service.batches.settle(admin,b.id);assert.equal(f.calls(),1);
      if(status==='unknown'){
        f.service.reconcile(admin,f.store.byRequest('a').id,'received','整笔流水到账');
        assert.ok(f.store.batchClaims(b.id).every(c=>c.status==='succeeded'));assert.equal(f.store.overview(user.id).today.count,1);
      }else{
        f.service.reopen(admin,f.store.byRequest('a').id,'已核实未到账，重新审核');
        assert.ok(f.store.batchClaims(b.id).every(c=>c.status==='pending'));
      }
    }finally{f.store.close();}
  }
});
test('AI 全部结束后才合并发放，单条模型审核不重复请求',async t=>{
  const f=fixture({logs:[log('a'),log('b',{id:101})],rules:{aiEnabled:true,aiDailyLimit:1}});t.after(()=>f.store.close());
  let reviews=0;
  f.service.ai={promptVersion:()=> 'batch-test',review:async (source,_,options={})=>{
    assert.equal(f.calls(),0);reviews++;
    return f.store.saveAiReview({requestId:source.request_id,userId:user.id,reviewBatchId:options.batchId,fingerprint:(await import('../src/ai-review.mjs')).logFingerprint(source),promptVersion:'batch-test',decision:'empty',confidence:0.98,reason:'空回',status:'completed',rawResponse:null});
  }};
  const b=await queried(f);await f.service.batches.submit(user,b.id);assert.equal(reviews,2);assert.equal(f.calls(),1);
  assert.equal(f.store.aiReviewCount(new Date().toISOString().slice(0,10),user.id),1);
  await f.service.batches.submit(user,b.id);assert.equal(reviews,2);assert.equal(f.calls(),1);
});
test('最终核验日志变化、AI规则改变，整批不补且保留人工处理',async t=>{
  for(const kind of ['log','rules']){
    const f=fixture({logs:[log('a'),log('b',{id:101})]});
    try{
      const b=await queried(f),read=f.upstream.log;let n=0;
      f.upstream.log=async id=>{const source=await read(id);if(++n===3){if(kind==='log')source.quota++;else f.service.saveRules(admin,{...f.store.rules(),selfServiceEnabled:false});}return source;};
      const out=await f.service.batches.submit(user,b.id);assert.equal(out.status,'review');assert.equal(f.calls(),0);assert.match(out.note,/变化|变更/);
    }finally{f.store.close();}
  }
});
test('并发不同批次不能突破每日一次；持久化重启冻结整批执行',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'batch-restart-')),path=join(dir,'db.sqlite');let store;
  try{
    store=new Store(path);store.saveRules(rules(),1,1);
    const f=fixture();t.after(()=>f.store.close());
    const service=new Compensation(store,f.upstream),b=(await service.logs(user,{refresh:true})).batches[0];
    store.enrollBatch(b.id,[log()],user,store.rules(),'x',user.id);
    const c=store.batchClaims(b.id)[0];store.transition(c.id,['pending'],'approved',1,'x');
    store.reserveBatch(b.id,1,[{id:c.id,amount:120,verifiedAmount:120,note:'x'}],store.rules());
    store.close();store=new Store(path);
    assert.equal(store.queryBatch(b.id).status,'unknown');assert.equal(store.get(c.id).status,'unknown');assert.equal(store.overview(user.id).today.count,1);
    const reopened=new Compensation(store,f.upstream);await reopened.batches.submit(user,b.id);assert.equal(f.calls(),0);
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('批次权限隔离、原始日志不暴露、操作记录按整批归组',async t=>{
  const f=fixture({logs:[log('a'),log('b',{id:101})]});t.after(()=>f.store.close());
  const b=await queried(f);
  await assert.rejects(f.service.batches.view({...user,id:8},b.id),/不存在/);
  await assert.rejects(f.service.batches.submit({...user,id:8},b.id),/不存在/);
  assert.ok(!JSON.stringify(b).includes('reject_reason'));
  await f.service.batches.submit(user,b.id);
  const events=f.store.auditEvents(),group=groupAuditEvents(events).find(g=>g[0].batchId===b.id);
  assert.ok(group.length>4);assert.equal(group[0].action,'batch_succeeded');
  const html=renderAuditLog(events);assert.match(html,/整批补偿成功/);assert.match(html,/计 1 次补偿/);
  assert.equal((html.match(/class="audit-entry /g)||[]).length,groupAuditEvents(events).length);
  assert.ok(!renderQueryBatch({...b,username:'<script>',items:[{...b.items[0],model:'<img>'}]}).includes('<img>'));
});
