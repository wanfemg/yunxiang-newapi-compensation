import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLog, validateRules, expectedQuota, isOpen, localClock, settlementClock, defaults, selfServiceDecision } from '../src/rules.mjs';
import { log, user, rules } from './helpers.mjs';

test('默认关闭申请执行，空白名单不放行', () => {
  const a=assessLog(log(),user,defaults); assert.equal(a.eligible,false); assert.ok(a.reasons.includes('渠道未开放补偿')); assert.equal(defaults.executionEnabled,false);
});
test('已收费零输出为候选，直接标记与证据不足分开', () => {
  const a=assessLog(log(),user,rules()); assert.equal(a.eligible,true); assert.equal(a.evidence,'empty_marked'); assert.equal(a.expectedQuota,120);
  assert.equal(assessLog(log('x',{other:'{}'}),user,rules()).evidence,'pending');
});
test('免费、正常输出、错误日志和他人消费不是候选', () => {
  for(const change of [{quota:0},{completion_tokens:1},{type:5},{user_id:8}])assert.equal(assessLog(log('x',change),user,rules()).candidate,false);
});
test('订阅消费需人工审批；拦截和工具调用不视为明确空回', () => {
  assert.equal(assessLog(log('x',{other:'{"billing_source":"subscription"}'}),user,rules()).eligible,true);
  assert.equal(selfServiceDecision(log('x',{other:'{"billing_source":"subscription"}'}),user,rules()).automatic,false);
  assert.equal(assessLog(log('x',{other:'{"tool_surcharges":[{"count":1}]}'}),user,rules()).evidence,'special');
  assert.equal(assessLog(log('x',{other:'{"admin_info":{"reject_reason":"prompt_blocked"}}'}),user,rules()).evidence,'special');
});
test('缺失唯一标识、过期、未来消费、禁用用户均拒绝', () => {
  for(const change of [{request_id:''},{created_at:1},{created_at:Math.floor(Date.now()/1000)+3600}])assert.equal(assessLog(log('x',change),user,rules()).eligible,false);
  assert.equal(assessLog(log(),user,rules({blockedUsers:[7]})).eligible,false);
});
test('整数基点计算不使用浮点比例；配置安全边界', () => {
  assert.equal(expectedQuota(log('x',{quota:101}),rules({refundBasisPoints:3333})),33);
  assert.equal(expectedQuota(log(),rules({perRecordQuota:80})),80);
  for(const change of [{models:[]},{userDailyQuota:0},{refundBasisPoints:10001},{openStart:'25:00'},{maxPending:-1}])assert.throws(()=>validateRules(rules(change)));
});
test('时区日界与跨午夜开放时段', () => {
  assert.equal(localClock(Date.parse('2026-11-01T16:00:00Z'),'Asia/Shanghai').day,'2026-11-02');
  const r=rules({openStart:'22:00',openEnd:'06:00'});
  assert.equal(isOpen(r,Date.parse('2026-11-01T15:00:00Z')),true);
  assert.equal(isOpen(r,Date.parse('2026-11-01T04:00:00Z')),false);
});
test('每日重置时间按本地时区计算，零点前仍归入上一结算日', () => {
  const r=rules({timezone:'Asia/Shanghai',dailyResetTime:'04:00'});
  assert.equal(settlementClock(Date.parse('2026-11-01T19:00:00Z'),r).day,'2026-11-01');
  assert.equal(settlementClock(Date.parse('2026-11-01T20:00:00Z'),r).day,'2026-11-02');
});

test('自助判定仅允许稳定、明确空回的余额消费，异常转审批',()=>{
  const now=Date.now(),base=log('auto',{created_at:Math.floor(now/1000)-120});
  assert.equal(selfServiceDecision(base,user,rules(),now).automatic,true);
  for(const change of [{other:'{}'},{other:'bad json'},{other:JSON.stringify({billing_source:'wallet',reject_reason:'not_empty_response'})},{other:JSON.stringify({billing_source:'wallet',reject_reason:'empty_response',refunded:true})},{other:JSON.stringify({billing_source:'wallet',reject_reason:'empty_response',tool_calls:[{}]})},{created_at:Math.floor(now/1000)}])assert.equal(selfServiceDecision({...base,...change},user,rules(),now).automatic,false);
  for(const change of [{selfServiceEnabled:false},{executionEnabled:false},{selfServiceMaxQuota:100}])assert.equal(selfServiceDecision(base,user,rules(change),now).automatic,false);
  for(const change of [{selfServiceMinAgeSeconds:0},{selfServiceMinAgeSeconds:29},{selfServiceMaxQuota:0},{selfServiceEnabled:'true'}])assert.throws(()=>validateRules(rules(change)));
});
