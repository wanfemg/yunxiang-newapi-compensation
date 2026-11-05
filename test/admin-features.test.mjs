import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,log,user,admin,rules} from './helpers.mjs';
import {displayConfig,formatQuota,parseQuota,inputQuota} from '../public/display.js';
import {validateRules} from '../src/rules.mjs';
import {UpstreamError} from '../src/newapi.mjs';
import {compensationLabel} from '../src/rules.mjs';

test('补偿记录明确标识为空回补偿',()=>{
  assert.equal(compensationLabel(log(),'self'),'空回补偿');
  assert.equal(compensationLabel(log('subscription-label',{other:'{"billing_source":"subscription","subscription_id":17}'}),'self'),'订阅空回 · 余额补偿');
  assert.equal(compensationLabel(log(),'manual'),'人工空回补偿');
});

test('订阅审批后返还结果不明时锁定，重复处理不重发',async()=>{
  const f=fixture({logs:[log('subscription-timeout',{other:'{"billing_source":"subscription","subscription_id":17}'})],credit:async()=>{throw new UpstreamError('timeout');}});
  try{
    const c=await f.service.selfService(user,'subscription-timeout');
    assert.equal((await f.service.approveSubscription(admin,c.id,120,'核实后补入余额')).status,'unknown');assert.equal(f.calls(),1);
    await assert.rejects(f.service.approveSubscription(admin,c.id,120,'重复审批'));await assert.rejects(f.service.execute(admin,c.id,120,'重复执行'));assert.equal(f.calls(),1);
  }finally{f.store.close();}
});

test('订阅消费须人工核实金额，审批通过补入钱包且不重复发放',async()=>{
  for(const other of [{billing_source:'subscription',subscription_id:17},{billing_source:'wallet',subscription_id:17}]){
    const f=fixture({logs:[log('subscription',{other:JSON.stringify({...other,reject_reason:'empty_response'})})]});
    try{
      const source=await f.service.logs(user,{});assert.equal(source.items[0].assessment.canApply,true);assert.equal(source.items[0].assessment.route,'review');
      const c=await f.service.selfService(user,'subscription');assert.equal(c.status,'pending');assert.equal(c.fundingSource,'subscription');assert.equal(f.calls(),0);
      assert.equal((await f.service.selfService(user,'subscription')).id,c.id);
      assert.throws(()=>f.service.review(admin,c.id,'approve','缺少核实金额'),/核实金额/);
      await assert.rejects(f.service.execute(admin,c.id,120,'未经审批'),/已通过审核/);assert.equal(f.calls(),0);
      await assert.rejects(f.service.approveSubscription(user,c.id,120,'越权审批'),/站长/);
      await assert.rejects(f.service.approveSubscription(admin,c.id,121,'超原消费'),/不能超过/);assert.equal(f.store.get(c.id).status,'pending');
      assert.equal((await f.service.approveSubscription(admin,c.id,120,'核实订阅扣费且未退款，批准补入余额')).status,'succeeded');assert.equal(f.calls(),1);
      await assert.rejects(f.service.approveSubscription(admin,c.id,120,'重复审批'));await assert.rejects(f.service.execute(admin,c.id,120,'重复发放'));assert.equal(f.calls(),1);
      assert.equal((await f.service.selfService(user,'subscription')).status,'succeeded');assert.equal(f.calls(),1);
    }finally{f.store.close();}
  }
});

test('用户分组跨申请分页完整汇总，仍保留独立申请及状态筛选',()=>{
  const f=fixture();try{
    const r=rules({maxPending:100});
    for(let i=0;i<35;i++)f.store.create(log('group-'+i,{model_name:'model-'+i%3}),user,r,'x','self',user.id);
    const another={...user,id:8,username:'other'};f.store.create(log('other',{user_id:8}),another,r,'x','self',8);
    const grouped=f.store.claimGroups('pending');assert.equal(grouped.total,2);assert.equal(grouped.items.find(g=>g.user_id===7).applications,35);assert.equal(grouped.items.find(g=>g.user_id===7).models,3);
    assert.equal(grouped.items.find(g=>g.user_id===7).expectedAmount,35*120);assert.equal(f.store.list(7,'pending').items.length,30);
    const one=f.store.byRequest('group-0');f.store.transition(one.id,['pending'],'rejected',1,'不通过');
    assert.equal(f.store.claimGroups('pending',1,7).items[0].applications,34);assert.equal(f.store.claimGroups('rejected',1,7).items[0].applications,1);assert.equal(f.store.list(7).total,35);
  }finally{f.store.close();}
});

test('显示遵循原站单位，输入反向换算保留整数账本精度',()=>{
  const usd=displayConfig({quota_display_type:'USD',quota_per_unit:500000});
  assert.equal(formatQuota(2500000,usd),'$5.00');assert.equal(parseQuota('5',usd),2500000);
  const custom=displayConfig({quota_display_type:'CUSTOM',quota_per_unit:500000,custom_currency_symbol:'额度 ',custom_currency_exchange_rate:100});
  assert.equal(formatQuota(25000,custom),'额度 5.00');assert.equal(parseQuota('5',custom),25000);assert.equal(parseQuota(inputQuota(1,custom),custom),1);
  assert.throws(()=>parseQuota('0.000001',usd));assert.throws(()=>displayConfig({quota_display_type:'CNY',quota_per_unit:500000}));
  const cny=displayConfig({quota_display_type:'CNY',quota_per_unit:500000,usd_exchange_rate:7});assert.equal(formatQuota(500000,cny),'¥7.00');
  assert.equal(parseQuota('0.000014',cny),1);
  assert.throws(()=>parseQuota('999999.000000000001',custom),/精度/);
  assert.throws(()=>parseQuota('1.0000000000000001',displayConfig({quota_display_type:'TOKENS'})),/精度/);
  const small=displayConfig({quota_display_type:'CUSTOM',quota_per_unit:500000,custom_currency_exchange_rate:1e-8});assert.equal(inputQuota(1,small),'0.00000000000002');assert.equal(parseQuota(inputQuota(1,small),small),1);
});

test('删除模型可申请但强制人工审核，现存未选择模型仍拒绝',async()=>{
  const f=fixture({logs:[log('retired',{model_name:'removed-model'}),log('unselected',{model_name:'other-live'}),log('active')]});
  f.upstream.catalog=async()=>({channels:[{id:3,status:1,models:['fixture-model','other-live']}]});
  try{
    const list=await f.service.logs(user,{}),retired=list.items[0];assert.equal(retired.assessment.canApply,true);assert.equal(retired.assessment.route,'review');
    assert.equal(list.items[1].assessment.canApply,false);
    assert.equal((await f.service.selfService(user,'retired')).status,'pending');assert.equal(f.calls(),0);
    const claim=f.store.byRequest('retired');f.service.review(admin,claim.id,'approve','核实历史空回');
    assert.equal((await f.service.execute(admin,claim.id,120,'确认扣费未退款')).status,'succeeded');assert.equal(f.calls(),1);
    f.upstream.catalog=async()=>{throw Error('offline');};
    assert.equal((await f.service.selfService(user,'active')).status,'pending');assert.equal(f.calls(),1);
  }finally{f.store.close();}
});

test('不限制模型范围可保存；渠道限制不会因删除模型而放宽',async()=>{
  assert.doesNotThrow(()=>validateRules(rules({restrictModels:false,models:[]})));
  const f=fixture({logs:[log('wrong-channel',{channel:9,model_name:'removed'})]});f.upstream.catalog=async()=>({channels:[]});
  try{assert.equal((await f.service.logs(user,{})).items[0].assessment.canApply,false);await assert.rejects(f.service.selfService(user,'wrong-channel'));}finally{f.store.close();}
});

test('统计返回多维计数，钻取按用户、模型、渠道精确过滤',()=>{
  const f=fixture();try{
    f.store.create(log('one'),user,rules(),'x','self',7);
    f.store.create(log('two',{model_name:'another',channel:5}),{...user,id:8,username:'other'},rules(),'x','self',8);
    assert.equal(f.store.adminStatistics('users').items.length,2);
    assert.equal(f.store.adminStatistics('models').items.length,2);
    assert.equal(f.store.adminStatistics('channels').items.length,2);
    assert.equal(f.store.list(null,'',1,{owner:'8'}).total,1);
    assert.equal(f.store.list(null,'',1,{model:'another',channel:'5'}).items[0].user_id,8);
  }finally{f.store.close();}
});
