import assert from 'node:assert/strict';
import test from 'node:test';
import { AIReviewer, logFingerprint } from '../src/ai-review.mjs';
import { Store } from '../src/store.mjs';
import { admin, log, rules, user, fixture } from './helpers.mjs';
import {selfServiceDecision} from '../src/rules.mjs';

function enablePassingAI(f,emptyProbability=.95,decision='empty'){
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision,empty_probability:emptyProbability,reason:'根据日志综合判定'})}}]}))});
}

test('AI 达标直接补偿：不再要求旧自助条件和人工金额确认，单笔及查询批次一致',async t=>{
  for(const other of [{},{billing_source:'wallet',tool_calls:[{name:'tool'}],reasoning_tokens:5},{billing_source:'subscription',subscription_id:8}]){
    for(const batch of [false,true]){
      const source=log('ai-direct',{other:JSON.stringify(other)});
      const f=fixture({logs:[source],rules:{aiEnabled:true,aiAutoThreshold:95,selfServiceEnabled:false,selfServiceMaxQuota:1,selfServiceMinAgeSeconds:86400}});
      t.after(()=>f.store.close());enablePassingAI(f);
      if(batch){const b=(await f.service.logs(user,{refresh:true})).batches[0];const result=await f.service.batches.submit(user,b.id);assert.equal(result.status,'succeeded',result.note);}
      else{const result=await f.service.selfService(user,source.request_id);assert.equal(result.status,'succeeded',result.review_note);}
      assert.equal(f.calls(),1);assert.equal(f.store.byRequest(source.request_id).amount,120);
      await f.service.selfService(user,source.request_id);assert.equal(f.calls(),1);
    }
  }
});

test('AI 达标仍检查已退款、执行开关和每日总限额；不达标或非空回转人工',async t=>{
  for(const scenario of [
    {other:{billing_source:'wallet',refunded:true}},
    {rules:{executionEnabled:false}},
    {rules:{userDailyQuota:100}},
    {emptyProbability:.94},
    {emptyProbability:.02,decision:'not_empty'},
    {emptyProbability:.5,decision:'uncertain'}
  ]){
    const source=log('ai-guard',{other:JSON.stringify(scenario.other||{})}),f=fixture({logs:[source],rules:{aiEnabled:true,aiAutoThreshold:95,...scenario.rules}});
    t.after(()=>f.store.close());enablePassingAI(f,scenario.emptyProbability,scenario.decision);
    if(scenario.rules?.userDailyQuota){await assert.rejects(f.service.selfService(user,source.request_id),/当日额度或次数不足/);assert.equal(f.calls(),0);continue;}
    const result=await f.service.selfService(user,source.request_id);
    assert.equal(result.status,'pending');assert.equal(f.calls(),0);
  }
});

test('AI 启用后低于已保存阈值的空回不能被原规则绕过', async t => {
  const f=fixture({rules:{aiEnabled:true}});t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',aiAutoThreshold:95,rulesVersion:f.store.rules().version},admin.id);
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'empty',empty_probability:.92,reason:'疑似空回',evidence:['输出为零']})}}]}))});
  const result=await f.service.selfService(user,'fixture-request-1');
  assert.equal(result.status,'pending');
  assert.match(result.review_note,/95%/);
  assert.equal(f.calls(),0);
});

test('调低 AI 阈值实际改变路由，未达 90% 的结果按保存值自动通过',async t=>{
  const f=fixture({rules:{aiEnabled:true},logs:[log('lower-threshold',{other:JSON.stringify({billing_source:'wallet'})})]});t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',aiAutoThreshold:80,rulesVersion:f.store.rules().version},admin.id);
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({empty_probability:.85,reason:'疑似空回',evidence:['输出为零']})}}]}))});
  const result=await f.service.selfService(user,'lower-threshold');
  assert.equal(result.status,'succeeded');assert.equal(f.calls(),1);
});

test('AI 判定按日志指纹幂等，重复调用不重复请求', async () => {
  const store = new Store();
  store.saveRules(rules({ aiEnabled: true }), admin.id, 1);
  let calls = 0;
  const reviewer = new AIReviewer({
    store,
    env: { AI_BASE_URL: 'http://ai.test/v1', AI_API_KEY: 'key', AI_MODEL: 'fixture' },
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ empty_probability: 0.96, reason: '无有效输出', evidence: ['completion_tokens=0'] }) } }] }) };
    }
  });
  const source = log();
  const first = await reviewer.review(source, store.rules());
  const second = await reviewer.review({ ...source }, store.rules());
  assert.equal(first.decision, 'empty');
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
  assert.equal(store.aiReview(source.request_id, logFingerprint(source), 'empty-v1-auto-review-v3').id, first.id);
  store.close();
});

test('自动判定向模型提供结构化空回信号、当前阈值和明确二分类准则，自定义提示词仍追加自动流程规则',async t=>{
  const f=fixture({rules:{aiEnabled:true,aiAutoThreshold:95}});t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',prompt:'自定义提示词'},admin.id);
  let request;
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"uncertain","empty_probability":0.96,"reason":"日志显示已扣费且零输出"}'}}]}));}});
  const result=await f.service.ai.review(log(),f.store.rules());
  assert.equal(result.decision,'empty');assert.equal(result.confidence,.96);
  assert.equal(result.analysis.emptyProbability,.96);
  assert.match(request.messages[0].content,/empty_probability.*“该日志确属空回”的概率/);
  assert.match(request.messages[0].content,/站长设置的自动补偿阈值为 95%/);
  const evidence=JSON.parse(request.messages[1].content).knownSignals;
  assert.equal(evidence.candidate,true);assert.equal(evidence.eligible,true);assert.equal(evidence.evidence,'empty_marked');
  assert.equal(evidence.fundingSource,'wallet');assert.equal(evidence.hasRefundMarker,false);
  assert.equal(JSON.parse(request.messages[1].content).rules.aiAutoThreshold,95);
});

test('空回概率按当前阈值动态判定；高置信 uncertain 不能压过达标空回概率',async t=>{
  const f=fixture({rules:{aiEnabled:true,aiAutoThreshold:98},logs:[log('dynamic-threshold')]});t.after(()=>f.store.close());
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response('{"choices":[{"message":{"content":"{\\"decision\\":\\"uncertain\\",\\"empty_probability\\":0.96,\\"reason\\":\\"信号综合后高度疑似空回\\"}"}}]}')});
  const pending=await f.service.selfService(user,'dynamic-threshold');assert.equal(pending.status,'pending');
  const review=f.store.aiReview('dynamic-threshold',logFingerprint(f.store.byRequest('dynamic-threshold').log),f.service.ai.promptVersion());
  const lowered={...f.store.rules(),aiAutoThreshold:95};
  assert.equal(selfServiceDecision(f.store.byRequest('dynamic-threshold').log,user,lowered,Date.now(),review).automatic,true);
  assert.equal(f.calls(),0);
});

test('自动审核缺少空回概率时，不接受旧 decision/confidence 直接触发补偿',async t=>{
  const f=fixture({rules:{aiEnabled:true,aiAutoThreshold:95}});t.after(()=>f.store.close());
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:'{"decision":"empty","confidence":0.99,"reason":"模型返回旧格式"}'}}]}))});
  const result=await f.service.selfService(user,'fixture-request-1');
  assert.equal(result.status,'pending');
  assert.match(result.review_note,/概率未达到/);
  const review=f.service.view(f.store.get(result.id),true).aiReview;
  assert.equal(review.decision,'uncertain');
  assert.match(review.reason,/未返回有效空回概率/);
  assert.equal(f.calls(),0);
});

test('AI 开启时日志列表不再使用旧规则提前标记转人工，提交后才由 AI 判定',async t=>{
  const f=fixture({rules:{aiEnabled:true,selfServiceEnabled:false,selfServiceMaxQuota:1,selfServiceMinAgeSeconds:86400},logs:[log('list-ai',{other:'{}'})]});t.after(()=>f.store.close());
  const result=await f.service.logs(user,{refresh:true});
  assert.equal(result.items[0].assessment.canApply,true);
  assert.equal(result.items[0].assessment.route,'review');
  assert.match(result.items[0].assessment.reviewReasons.join('；'),/AI 按当前阈值自动判定/);
});

test('AI 未配置时只转管理员，不改变原规则路径', async () => {
  const store = new Store();
  store.saveRules(rules({ aiEnabled: true }), admin.id, 1);
  const result = await new AIReviewer({ store, env: {} }).review(log(), store.rules());
  assert.equal(result.decision, 'uncertain');
  assert.equal(result.status, 'fallback');
  store.close();
});

test('自定义提示词版本用于自动执行与管理员结果显示，重复申请不再调用 AI',async t=>{
  const f=fixture({rules:{aiEnabled:true}});t.after(()=>f.store.close());let calls=0;
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',prompt:'根据日志与规则审核，返回 JSON。'},1);
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({empty_probability:0.99,reason:'空回',evidence:['无输出']})}}]})};}});
  const result=await f.service.selfService(user,'fixture-request-1');
  assert.equal(result.status,'succeeded');assert.equal(f.calls(),1);
  assert.equal(f.service.view(f.store.get(result.id),true).aiReview.decision,'empty');
  await f.service.selfService(user,'fixture-request-1');assert.equal(calls,1);
});
