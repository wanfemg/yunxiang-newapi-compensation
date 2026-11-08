import test from 'node:test';
import assert from 'node:assert/strict';
import {describeAuditEvent,renderAuditLog} from '../public/audit-log.js';
import {fixture,log,user,admin} from './helpers.mjs';
test('常见操作直接显示中文结果、AI结论和补偿金额',()=>{
  const formatQuota=n=>'额度 '+n;
  assert.match(describeAuditEvent({action:'succeeded',amount:120,detail:'{}'},{formatQuota}).summary,/120/);
  assert.equal(describeAuditEvent({action:'execution_reserved',detail:'{}'}).title,'开始补偿执行');
  const ai=describeAuditEvent({action:'ai_reviewed',detail:JSON.stringify({decision:'empty',confidence:0.97,reason:'输出为空'})});
  assert.match(ai.summary,/空回.*97%.*输出为空/);
  assert.match(describeAuditEvent({action:'rejected',detail:'{"note":"已正常输出"}'}).summary,/已正常输出/);
  assert.match(describeAuditEvent({action:'self_service_routed',detail:'{"route":"review","reasons":["额度超限"]}'}).summary,/人工审核.*额度超限/);
});
test('原始详情容错，未知事件保留，所有动态内容转义',()=>{
  const html=renderAuditLog([{id:1,action:'<script>bad</script>',actor_id:9,detail:'bad json',model:'<img src=x onerror=bad>',targetUsername:'<b>用户</b>',claim_id:'" onclick=bad',created_at:Date.now()}]);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<b>用户'));
  assert.match(html,/其他操作/);assert.match(html,/bad json/);assert.match(html,/原始记录/);
});
test('操作记录关联模型用户原请求，仍保留原始字段',t=>{
  const f=fixture();t.after(()=>f.store.close());const claim=f.store.create(log(),user,f.store.rules(),'申请理由','self',user.id);
  f.store.event(claim.id,admin.id,'rejected',{note:'需进一步核实'});
  const events=f.store.auditEvents();const e=events.find(e=>e.action==='rejected');
  assert.equal(e.model,'fixture-model');assert.equal(e.targetUsername,user.username);assert.equal(e.requestId,claim.request_id);assert.equal(e.claim_id,claim.id);assert.equal(JSON.parse(e.detail).note,'需进一步核实');
  const html=renderAuditLog(events);assert.match(html,/审核未通过/);assert.match(html,/fixture-model/);assert.match(html,/fixture-user/);assert.match(html,/查看申请/);
});
