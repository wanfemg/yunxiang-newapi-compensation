import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,log,user,admin} from './helpers.mjs';
import {UpstreamError} from '../src/newapi.mjs';

test('正常自助立即返还，不需站长审批，重复点击幂等',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const c=await f.service.selfService(user,'fixture-request-1');
  assert.equal(c.status,'succeeded');assert.equal(c.amount,120);assert.equal(f.calls(),1);
  assert.equal(f.store.overview(user.id).pending,0);assert.equal(c.log.other,undefined);
  assert.equal((await f.service.selfService(user,c.request_id)).id,c.id);assert.equal(f.calls(),1);
  assert.throws(()=>f.service.review(user,c.id,'approve','伪造审批'),/权限/);
  await assert.rejects(f.service.execute(user,c.id,120,'越权'),/权限/);
});

test('证据不足、工具输出、超过自助上限、结算中仅进入审批',async t=>{
  for(const options of [{logs:[log('x',{other:'{}'})]},{logs:[log('x',{other:JSON.stringify({billing_source:'wallet',reject_reason:'empty_response',tool_calls:[{}]})})]},{logs:[log('x')],rules:{selfServiceMaxQuota:100}},{logs:[log('x',{created_at:Math.floor(Date.now()/1000)})]},{logs:[log('x')],rules:{selfServiceEnabled:false}},{logs:[log('x')],rules:{executionEnabled:false}}]){
    const f=fixture(options);try{const c=await f.service.selfService(user,'x','需核验');assert.equal(c.status,'pending');assert.match(c.review_note,/审批/);assert.equal(f.calls(),0);}finally{f.store.close();}
  }
});

test('自助异常经站长核实可执行，普通用户重复申请不会跳过审批',async t=>{
  const f=fixture({logs:[log('x',{other:'{}'})]});t.after(()=>f.store.close());
  const c=await f.service.selfService(user,'x','异常');assert.equal(c.status,'pending');
  assert.equal((await f.service.selfService(user,'x')).status,'pending');assert.equal(f.calls(),0);
  f.service.review(admin,c.id,'approve','已核实');assert.equal((await f.service.execute(admin,c.id,80,'仅余80未返还')).amount,80);assert.equal(f.calls(),1);
});

test('并发同笔自助至多一次增额，并发不同笔不能突破每日额度',async t=>{
  const f=fixture({logs:[log('a'),log('b')],rules:{userDailyQuota:150},credit:async()=>new Promise(r=>setTimeout(r,10))});t.after(()=>f.store.close());
  await Promise.all([f.service.selfService(user,'a'),f.service.selfService(user,'a'),f.service.selfService(user,'b')]);
  assert.equal(f.calls(),1);assert.equal(f.store.overview(user.id).today.quota,120);
  assert.equal(f.store.list(user.id).items.length,2);assert.equal(f.store.overview(user.id).pending,1);
});

test('自助超时冻结，不重发；原站明确拒绝记失败',async t=>{
  for(const [error,status] of [[Error('timeout'),'unknown'],[new UpstreamError('refused',true),'failed']]){
    const f=fixture({credit:()=>{throw error;}});try{const c=await f.service.selfService(user,'fixture-request-1');assert.equal(c.status,status);await f.service.selfService(user,c.request_id);assert.equal(f.calls(),1);assert.equal(f.store.overview(user.id).today.quota,status==='unknown'?120:0);}finally{f.store.close();}
  }
});

test('二次核验消费或规则变化、账号不可用转审批，禁止发放',async t=>{
  for(const kind of ['log','rules','owner','network']){
    const f=fixture();try{const read=f.upstream.log;let reads=0;f.upstream.log=async id=>{const value=await read(id);if(++reads===2){if(kind==='log')value.quota++;if(kind==='rules')f.service.saveRules(admin,{...f.store.rules(),selfServiceEnabled:false});if(kind==='network')throw Error('lookup failed');}return value;};if(kind==='owner')f.upstream.target=async()=>({...user,status:2});
      const c=await f.service.selfService(user,'fixture-request-1');assert.equal(c.status,'pending',kind);assert.equal(f.calls(),0,kind);
    }finally{f.store.close();}
  }
});

test('自助不能处理他人消费、不参与规则或超出有效期记录',async t=>{
  for(const change of [{user_id:8},{channel:99},{created_at:1}]){
    const f=fixture({logs:[log('x',change)]});try{await assert.rejects(f.service.selfService(user,'x'));assert.equal(f.calls(),0);assert.equal(f.store.list().total,0);}finally{f.store.close();}
  }
});

test('旧规则读取兼容自助配置，不重放旧待审核记录',async t=>{
  const f=fixture();t.after(()=>f.store.close());const old=f.store.rules();delete old.selfServiceEnabled;delete old.selfServiceMaxQuota;delete old.selfServiceMinAgeSeconds;
  f.store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(old));
  const c=await f.service.apply(user,'fixture-request-1','旧申请');assert.equal(f.store.rules().selfServiceEnabled,true);
  assert.equal((await f.service.selfService(user,c.request_id)).status,'pending');assert.equal(f.calls(),0);
});

test('上游成功后落库失败记待确认，重复点击不再发放',async t=>{
  const f=fixture();t.after(()=>f.store.close());const transition=f.store.transition.bind(f.store);let failed=false;
  f.store.transition=(id,from,to,...args)=>{if(to==='succeeded'&&!failed){failed=true;throw Error('disk error');}return transition(id,from,to,...args);};
  const c=await f.service.selfService(user,'fixture-request-1');assert.equal(c.status,'unknown');assert.equal(f.calls(),1);assert.equal(f.store.overview(user.id).today.quota,120);
  assert.equal((await f.service.selfService(user,c.request_id)).status,'unknown');assert.equal(f.calls(),1);
});
