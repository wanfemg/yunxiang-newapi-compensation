import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIReviewer} from '../src/ai-review.mjs';
import {Store} from '../src/store.mjs';
import {admin,user,fixture} from './helpers.mjs';

test('AI 设置保存开关和阈值，重启后仍开启；过期版本不覆盖当前规则',t=>{
  const directory=mkdtempSync(join(tmpdir(),'ai-settings-')),path=join(directory,'data.sqlite');
  let store=new Store(path);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const before=store.rules();
  store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model',aiEnabled:true,aiAutoThreshold:95,aiDailyLimit:10,rulesVersion:before.version},1);
  assert.equal(store.rules().aiEnabled,true);
  assert.equal(store.rules().aiAutoThreshold,95);
  assert.equal(store.rules().aiDailyLimit,10);
  store.close();store=new Store(path);
  assert.equal(store.rules().aiEnabled,true);
  assert.throws(()=>store.saveAIConfig({model:'stale',aiEnabled:false,rulesVersion:before.version},1),/更新|刷新/);
  assert.equal(store.aiConfig().model,'model');
  assert.equal(store.rules().aiEnabled,true);
  const current=store.rules();
  store.saveAIConfig({model:'model-two'},1);
  assert.equal(store.rules().version,current.version);
  assert.equal(store.rules().aiEnabled,true);
});

test('管理员主动 AI 辅助审核仅提供依据，并发和重复点击只调用一次模型',async t=>{
  const f=fixture({rules:{aiEnabled:true}});
  t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model'},1);
  let calls=0;
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>{
    calls++;await new Promise(resolve=>setTimeout(resolve,15));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'empty',confidence:0.97,reason:'无有效输出',evidence:['输出为零']})}}]}));
  }});
  const c=await f.service.apply(user,'fixture-request-1','人工审核');
  const results=await Promise.all([f.service.assistReview(admin,c.id),f.service.assistReview(admin,c.id)]);
  assert.equal(calls,1);
  assert.equal(results[0].aiReview.id,results[1].aiReview.id);
  assert.equal(results[0].status,'pending');
  assert.equal(f.calls(),0);
  await f.service.assistReview(admin,c.id);assert.equal(calls,1);
  await assert.rejects(()=>f.service.assistReview(user,c.id),/站长/);
  f.store.saveRules({...f.store.rules(),aiEnabled:false},1,f.store.rules().version);
  await assert.rejects(()=>f.service.assistReview(admin,c.id),/关闭|开启/);
});

test('管理员 AI 辅助审核不受每日次数限制',async t=>{
  const f=fixture({rules:{aiEnabled:true,aiDailyLimit:1}});
  t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model'},1);
  let calls=0;
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>{
    calls++;
    return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"uncertain","confidence":0.5,"reason":"需人工核对","evidence":[]}'}}]}));
  }});
  const rules=f.store.rules();
  await f.service.ai.review(f.logs[0],rules,{mode:'admin'});
  const second={...f.logs[0],request_id:'admin-unlimited-review'};
  await f.service.ai.review(second,rules,{mode:'admin'});
  assert.equal(calls,2);
  assert.equal(f.store.aiReviewCount(new Date().toISOString().slice(0,10),f.logs[0].user_id),2);
});

test('管理员二次 AI 复核综合原判定并给出明确建议，一键通过补额度仅在建议通过时执行',async t=>{
  const f=fixture({rules:{aiEnabled:true,executionEnabled:true}});
  t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model'},1);
  let calls=0;
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async(url,options)=>{
    calls++;const body=JSON.parse(options.body);
    assert.match(body.messages[0].content,/二次复核/);
    assert.match(body.messages[1].content,/previousReview/);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'empty',confidence:.98,recommendation:'approve',summary:'日志与规则一致，具备补偿条件。',reason:'输出 token 为零且无退款记录。',evidence:['completion_tokens=0','原消费存在']})}}]}));
  }});
  const c=await f.service.apply(user,'fixture-request-1','人工审核');
  const view=await f.service.assistReview(admin,c.id);
  assert.equal(view.aiReview.analysis.recommendation,'approve');
  assert.equal(view.aiReview.analysis.summary,'日志与规则一致，具备补偿条件。');
  assert.deepEqual(view.aiReview.evidence,['completion_tokens=0','原消费存在']);
  const result=await f.service.approveWithAI(admin,c.id);
  assert.equal(result.status,'succeeded');
  assert.equal(f.calls(),1);
  assert.equal(calls,1);
  await assert.rejects(()=>f.service.approveWithAI(admin,c.id),/待审核|建议|状态/);
});

test('AI 建议转人工或不通过时禁止一键补额度，订阅申请保留核实金额流程',async t=>{
  const f=fixture({rules:{aiEnabled:true,executionEnabled:true}});
  t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model'},1);
  let content=JSON.stringify({decision:'uncertain',confidence:.99,recommendation:'manual',summary:'证据不足',reason:'需核对历史退款',evidence:['账单缺少字段']});
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content}}]}))});
  const c=await f.service.apply(user,'fixture-request-1','人工审核');
  await f.service.assistReview(admin,c.id);
  await assert.rejects(()=>f.service.approveWithAI(admin,c.id),/建议|人工|通过/);
  assert.equal(f.store.get(c.id).status,'pending');
  content=JSON.stringify({decision:'empty',confidence:.99,recommendation:'approve',summary:'可补偿',reason:'证据充分',evidence:['输出为零']});
  const subscriptionLog=structuredClone(f.store.get(c.id).log);
  subscriptionLog.request_id='subscription-request';
  subscriptionLog.other=JSON.stringify({billing_source:'subscription',subscription_id:1});
  f.logs.push(subscriptionLog);
  const subscription=await f.service.apply(user,'subscription-request','人工审核');
  await f.service.assistReview(admin,subscription.id);
  await assert.rejects(()=>f.service.approveWithAI(admin,subscription.id),/订阅|核实金额/);
  assert.equal(f.store.get(subscription.id).status,'pending');
});

test('修改提示词后管理员仍能看到历史 AI 依据，并标识为旧版本',async t=>{
  const f=fixture({rules:{aiEnabled:true}});
  t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'https://ai.example/v1',apiKey:'fixture-key',model:'model'},1);
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:'{"decision":"uncertain","reason":"证据不足"}'}}]}))});
  const c=await f.service.apply(user,'fixture-request-1','人工审核');
  await f.service.assistReview(admin,c.id);
  f.store.saveAIConfig({prompt:'新的审核提示词，按规则分析。'},1);
  const view=f.service.view(f.store.get(c.id),true);
  assert.equal(view.aiReview.reason,'证据不足');
  assert.equal(view.aiReviewIsCurrent,false);
});
