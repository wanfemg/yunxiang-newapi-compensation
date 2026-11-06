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
