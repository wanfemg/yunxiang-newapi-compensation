import test from 'node:test';
import assert from 'node:assert/strict';
import {aiResultLabel} from '../public/ai-result.js';
import {selfServiceDecision} from '../src/rules.mjs';
import {log,rules,user} from './helpers.mjs';

test('自动初审没有二次复核建议时，不得统一显示建议不明确',()=>{
  assert.equal(aiResultLabel({decision:'empty',confidence:.95,status:'completed'}),'初审结论：疑似空回');
  assert.match(aiResultLabel({decision:'not_empty',confidence:.95,status:'completed'}),/非空回/);
  assert.match(aiResultLabel({decision:'uncertain',confidence:.95,status:'completed'}),/证据不足/);
  assert.match(aiResultLabel({status:'failed'}),/请求失败/);
  assert.match(aiResultLabel({status:'completed',analysis:{recommendation:'approve'}},'admin'),/建议通过/);
});
test('95% 置信度仅对空回结论满足 95% 阈值；非空回和不明确均转人工',()=>{
  for(const decision of ['empty','not_empty','uncertain']){
    const result=selfServiceDecision(log(),user,rules({aiEnabled:true,aiAutoThreshold:95}),Date.now(),{status:'completed',decision,confidence:.95});
    assert.equal(result.automatic,decision==='empty');
    if(decision!=='empty')assert.match(result.reasons.join('；'),decision==='not_empty'?/非空回/:/证据不足/);
  }
});
