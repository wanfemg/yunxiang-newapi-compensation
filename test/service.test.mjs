import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, log, user, admin, rules } from './helpers.mjs';
import { UpstreamError } from '../src/newapi.mjs';
import { Store } from '../src/store.mjs';

async function approved(f,id='fixture-request-1') {const c=await f.service.apply(user,id,'无有效输出，申请核实');f.service.review(admin,c.id,'approve','审核原消费');return c;}
test('申请→审核→返还→统计闭环，记录独立审计',async t=>{
  const f=fixture();t.after(()=>f.store.close());const c=await approved(f);const out=await f.service.execute(admin,c.id,120,'已核实未退款且无有效输出');
  assert.equal(out.status,'succeeded');assert.equal(out.amount,120);assert.equal(f.calls(),1);assert.equal(f.store.overview().compensatedQuota,120);assert.equal(f.store.overview().compensatedUsers,1);assert.equal(f.store.stats('models')[0].name,'fixture-model');
  assert.ok(f.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE claim_id=?').get(c.id).n>=4);
});
test('重复申请与重复执行都不重复到账',async t=>{
  const f=fixture();t.after(()=>f.store.close());const c=await approved(f);await assert.rejects(f.service.apply(user,c.request_id,'重复申请'),/已申请/);await f.service.execute(admin,c.id,120,'核验');await assert.rejects(f.service.execute(admin,c.id,120,'重复执行'),/仅已通过/);assert.equal(f.calls(),1);
});
test('同一提交批次的多模型申请只生成一条完整汇总通知',t=>{
  const f=fixture({rules:{notifications:{enabled:true,events:['batch_result']}}});t.after(()=>f.store.close());
  const runId='batch-fixture';
  const first=f.store.create(log('batch-a'),user,f.store.rules(),'x','self',7,false,runId);
  const second=f.store.create(log('batch-b',{model_name:'second-model',quota:80}),user,f.store.rules(),'x','self',7,false,runId);
  f.store.notifyClaimsBatch(runId);
  const notices=f.store.db.prepare('SELECT event,body FROM notifications').all();
  assert.equal(notices.length,1);assert.equal(notices[0].event,'batch_result');
  assert.match(notices[0].body,/fixture-model/);assert.match(notices[0].body,/second-model/);
  assert.match(notices[0].body,/申请笔数 \/ 模型数/);
  assert.equal(f.store.get(first.id).run_id,runId);assert.equal(f.store.get(second.id).run_id,runId);
});
test('普通用户不能审核执行或查看别人申请；返回日志不含渠道诊断',async t=>{
  const f=fixture();t.after(()=>f.store.close());const c=await f.service.apply(user,'fixture-request-1','核实');assert.throws(()=>f.service.review(user,c.id,'approve','x'),/权限/);await assert.rejects(f.service.execute(user,c.id,120,'x'),/权限/);assert.throws(()=>f.service.claimFor({...user,id:8},c.id),/不存在/);
  const view=f.service.view(f.store.get(c.id));assert.equal(view.log.channel,undefined);assert.equal(view.log.other,undefined);assert.equal(view.rules,undefined);
});
test('未知结果锁定次数额度，登记未到账后允许重新审核但不自动返还',async t=>{
  const f=fixture({credit:()=>{throw Error('network lost');}});t.after(()=>f.store.close());const c=await approved(f);const out=await f.service.execute(admin,c.id,120,'核验');assert.equal(out.status,'unknown');assert.equal(f.store.overview(7).today.quota,120);
  await assert.rejects(f.service.execute(admin,c.id,120,'retry'),/仅已通过/);f.service.reconcile(admin,c.id,'not_received','已核对原站流水未到账');assert.equal(f.store.overview(7).today.quota,0);f.service.reopen(admin,c.id,'补充凭据');assert.equal(f.store.get(c.id).status,'pending');assert.equal(f.calls(),1);
});
test('明确拒绝释放预占；成功回包才确认成功',async t=>{
  const f=fixture({credit:()=>{throw new UpstreamError('business refused',true);}});t.after(()=>f.store.close());const c=await approved(f);assert.equal((await f.service.execute(admin,c.id,120,'核验')).status,'failed');assert.equal(f.store.overview(7).today.count,0);
});
test('并发同笔执行至多发放一次',async t=>{
  const f=fixture({credit:async()=>new Promise(r=>setTimeout(r,15))});t.after(()=>f.store.close());const c=await approved(f);const outputs=await Promise.allSettled([f.service.execute(admin,c.id,120,'核验'),f.service.execute(admin,c.id,120,'核验')]);assert.equal(outputs.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls(),1);
});
test('并发不同消费不能突破每日限额，不静默部分返还',async t=>{
  const f=fixture({logs:[log('a'),log('b')],rules:{userDailyQuota:150},credit:async()=>new Promise(r=>setTimeout(r,10))});t.after(()=>f.store.close());const a=await approved(f,'a'),b=await approved(f,'b');const results=await Promise.allSettled([f.service.execute(admin,a.id,120,'核验'),f.service.execute(admin,b.id,120,'核验')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls(),1);assert.equal(f.store.overview(7).today.quota,120);assert.ok([f.store.get(a.id),f.store.get(b.id)].some(c=>c.status==='approved'));
});
test('执行采用原始和最新规则更严上限；已退款部分不再返还',async t=>{
  const f=fixture({rules:{perRecordQuota:100}});t.after(()=>f.store.close());const c=await approved(f);const r=f.store.rules();f.service.saveRules(admin,{...r,perRecordQuota:80});const out=await f.service.execute(admin,c.id,60,'已核实仅余60未返还');assert.equal(out.amount,60);
});
test('执行开关关闭、原消费变化、超额核实均不发放',async t=>{
  const f=fixture();t.after(()=>f.store.close());const c=await approved(f);await assert.rejects(f.service.execute(admin,c.id,121,'x'),/不能超过/);f.logs[0].quota=121;await assert.rejects(f.service.execute(admin,c.id,120,'x'),/发生变化/);f.logs[0].quota=120;f.service.saveRules(admin,{...f.store.rules(),executionEnabled:false});await assert.rejects(f.service.execute(admin,c.id,120,'x'),/暂未开放/);assert.equal(f.calls(),0);
});
test('规则乐观锁、防待审核堆积、拒绝后使用同一记录重新审核',async t=>{
  const f=fixture({logs:[log('a'),log('b')],rules:{maxPending:1}});t.after(()=>f.store.close());const c=await f.service.apply(user,'a','核实');await assert.rejects(f.service.apply(user,'b','核实'),/数量已达/);f.service.review(admin,c.id,'reject','缺少依据');f.service.reopen(admin,c.id,'补充材料');assert.equal(f.store.get(c.id).request_id,'a');assert.throws(()=>f.service.saveRules(admin,{...f.store.rules(),version:1}),/已更新/);
});
test('进程重启恢复执行中为待确认，不自动重放',()=>{
  const dir=mkdtempSync(join(tmpdir(),'comp-test-')),path=join(dir,'db.sqlite');let st;
  try{st=new Store(path);const r=rules();const c=st.create(log(),user,r,'x','self',7);st.transition(c.id,['pending'],'approved',1,'x');st.reserve(c.id,1,120,120,'核验',r);st.close();st=new Store(path);assert.equal(st.get(c.id).status,'unknown');assert.equal(st.overview(7).today.quota,120);}finally{st?.close();rmSync(dir,{recursive:true,force:true});}
});
test('实例绑定阻止切换上游；有执行记录后禁止切换时区重置额度',async t=>{
 const f=fixture();t.after(()=>f.store.close());f.store.bindInstance('https://one.example');f.store.bindInstance('https://one.example/');assert.throws(()=>f.store.bindInstance('https://two.example'),/其他 云中猫API小站/);
 const c=await approved(f);await f.service.execute(admin,c.id,120,'核验');assert.throws(()=>f.service.saveRules(admin,{...f.store.rules(),timezone:'UTC'}),/不允许切换/);
});
test('实际补回金额扣减每日限额，改重置时间重新归属历史且跨界恢复',t=>{
 const f=fixture({rules:{userDailyQuota:300,userDailyCount:3}});t.after(()=>f.store.close());
 const now=Date.parse('2026-11-01T18:00:00Z');
 const c=f.store.create(log('reset',{quota:2}),user,f.store.rules(),'x','self',7);
 f.store.transition(c.id,['pending'],'approved',1,'核实');
 f.store.reserve(c.id,1,2,2,'核实',f.store.rules(),now);
 f.store.transition(c.id,['executing'],'succeeded',1,'到账');
 assert.equal(f.store.overview(7,now).personalLimit.quota-f.store.overview(7,now).today.quota,298);
 f.service.saveRules(admin,{...f.store.rules(),dailyResetTime:'04:00'});
 assert.equal(f.store.get(c.id).execution_day,'2026-11-01');
 assert.equal(f.store.overview(7,now).today.quota,2);
 assert.equal(f.store.overview(7,now).today.count,1);
 assert.equal(f.store.overview(7,Date.parse('2026-11-01T20:00:00Z')).today.quota,0);
 assert.equal(f.store.overview(7,Date.parse('2026-11-01T20:00:00Z')).today.count,0);
});
