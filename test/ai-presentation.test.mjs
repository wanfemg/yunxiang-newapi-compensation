import test from 'node:test';
import assert from 'node:assert/strict';
import {aiDecisionForThreshold,aiResultLabel,formatAIProbability} from '../public/ai-result.js';
import {selfServiceDecision} from '../src/rules.mjs';
import {log,rules,user} from './helpers.mjs';

test('自动初审没有二次复核建议时，不得统一显示建议不明确',()=>{
  assert.equal(aiResultLabel({decision:'empty',confidence:.95,status:'completed'}),'初审结论：疑似空回');
  assert.match(aiResultLabel({decision:'not_empty',confidence:.95,status:'completed'}),/非空回/);
  assert.match(aiResultLabel({decision:'uncertain',confidence:.95,status:'completed'}),/未返回有效空回概率/);
  assert.match(aiResultLabel({status:'failed'}),/请求失败/);
  assert.match(aiResultLabel({status:'completed',analysis:{recommendation:'approve'}},'admin'),/建议通过/);
});
test('自动初审展示根据当前阈值和空回概率实时计算，不能沿用旧 uncertain 标签',()=>{
  const review={status:'completed',decision:'uncertain',confidence:.96,analysis:{emptyProbability:.96}};
  assert.equal(aiDecisionForThreshold(review,95),'empty');
  assert.match(aiResultLabel(review,'automatic',95),/达到 AI 自动补偿标准/);
  assert.doesNotMatch(aiResultLabel(review,'automatic',95),/已补偿|已到账|自动补偿完成/);
  assert.equal(aiDecisionForThreshold(review,98),'uncertain');
  assert.match(aiResultLabel(review,'automatic',98),/未达到阈值，转人工审核/);
});
test('95% 置信度仅对空回结论满足 95% 阈值；非空回和不明确均转人工',()=>{
  for(const decision of ['empty','not_empty','uncertain']){
    const result=selfServiceDecision(log(),user,rules({aiEnabled:true,aiAutoThreshold:95}),Date.now(),{status:'completed',decision,confidence:.95});
    assert.equal(result.automatic,decision==='empty');
    if(decision!=='empty')assert.match(result.reasons.join('；'),decision==='not_empty'?/有效回答/:/概率未达到/);
  }
});

test('二次复核、历史建议及调用异常不宣称已经补偿',()=>{
  const passed={status:'completed',decision:'empty',confidence:.99,analysis:{emptyProbability:.99,recommendation:'approve'}};
  assert.match(aiResultLabel(passed,'admin',95),/建议通过/);
  assert.doesNotMatch(aiResultLabel(passed,'admin',95),/已到账|自动补偿/);
  assert.doesNotMatch(aiResultLabel(passed,'historical',95),/已到账|已补偿|自动补偿完成/);
  assert.match(aiResultLabel({status:'failed',analysis:{emptyProbability:1}}),/请求失败/);
});

test('概率显示保留真实小数，不会将低于95%的结果显示成95%',()=>{
  assert.equal(formatAIProbability(.949),'94.9');
  assert.equal(formatAIProbability(.94999),'94.999');
  assert.equal(formatAIProbability(.94999999),'94.9999');
  assert.equal(formatAIProbability(.95),'95');
  assert.equal(formatAIProbability(0),'0');
  assert.equal(formatAIProbability(1),'100');
  for(const value of [null,false,'0.95',NaN,Infinity,-.1,1.01])assert.equal(formatAIProbability(value),null);
});
