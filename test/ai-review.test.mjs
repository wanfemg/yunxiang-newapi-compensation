import assert from 'node:assert/strict';
import test from 'node:test';
import { AIReviewer, logFingerprint } from '../src/ai-review.mjs';
import { Store } from '../src/store.mjs';
import { admin, log, rules, user, fixture } from './helpers.mjs';

test('AI 启用后低于已保存阈值的空回不能被原规则绕过', async t => {
  const f=fixture({rules:{aiEnabled:true}});t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',aiAutoThreshold:95,rulesVersion:f.store.rules().version},admin.id);
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'empty',confidence:.92,reason:'疑似空回',evidence:['输出为零']})}}]}))});
  const result=await f.service.selfService(user,'fixture-request-1');
  assert.equal(result.status,'pending');
  assert.match(result.review_note,/95%/);
  assert.equal(f.calls(),0);
});

test('调低 AI 阈值实际改变路由，未达 90% 的结果按保存值自动通过',async t=>{
  const f=fixture({rules:{aiEnabled:true},logs:[log('lower-threshold',{other:JSON.stringify({billing_source:'wallet'})})]});t.after(()=>f.store.close());
  f.store.saveAIConfig({baseUrl:'http://ai.test/v1',apiKey:'key',model:'fixture',aiAutoThreshold:80,rulesVersion:f.store.rules().version},admin.id);
  f.service.ai=new AIReviewer({store:f.store,env:{AI_BASE_URL:'http://ai.test/v1',AI_API_KEY:'key',AI_MODEL:'fixture'},fetcher:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'empty',confidence:.85,reason:'疑似空回',evidence:['输出为零']})}}]}))});
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
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision: 'empty', confidence: 0.96, reason: '无有效输出', evidence: ['completion_tokens=0'] }) } }] }) };
    }
  });
  const source = log();
  const first = await reviewer.review(source, store.rules());
  const second = await reviewer.review({ ...source }, store.rules());
  assert.equal(first.decision, 'empty');
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
  assert.equal(store.aiReview(source.request_id, logFingerprint(source), 'empty-v1').id, first.id);
  store.close();
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
  f.service.ai=new AIReviewer({store:f.store,env:{},fetcher:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({decision:'empty',confidence:0.99,reason:'空回',evidence:['无输出']})}}]})};}});
  const result=await f.service.selfService(user,'fixture-request-1');
  assert.equal(result.status,'succeeded');assert.equal(f.calls(),1);
  assert.equal(f.service.view(f.store.get(result.id),true).aiReview.decision,'empty');
  await f.service.selfService(user,'fixture-request-1');assert.equal(calls,1);
});
