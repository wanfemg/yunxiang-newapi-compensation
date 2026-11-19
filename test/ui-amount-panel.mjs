import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {log,user,rules} from './helpers.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const reviewRules=rules({models:['fixture-model','other-model-with-a-long-name'],userDailyQuota:10000,userDailyCount:100,siteDailyQuota:50000,siteDailyCount:500,perBatchQuota:0});
fixture.store.saveRules({...reviewRules,version:fixture.store.rules().version},1,fixture.store.rules().version);
const records=[
  log('amount-wallet-large',{quota:200}),
  log('amount-wallet-small',{quota:80}),
  log('amount-unknown',{quota:120,other:'{}'}),
  log('amount-other-model-with-a-long-request-id-for-responsive-layout',{quota:130,model_name:'other-model-with-a-long-name'})
];
for(const source of records){
  fixture.remote.data.logs.push(source);
  const claim=fixture.store.create(source,user,reviewRules,'额度填写回归数据','self',user.id);
  fixture.store.transition(claim.id,['pending'],'approved',1,'本地审核通过');
}
const subscription=log('amount-subscription',{quota:90,other:JSON.stringify({billing_source:'subscription',subscription_id:17})});
fixture.remote.data.logs.push(subscription);
const subscriptionClaim=fixture.store.create(subscription,user,reviewRules,'订阅额度填写回归数据','self',user.id);
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));mkdirSync('test-results',{recursive:true});
async function nav(name){
  if(await page.locator('#menu-toggle').getAttribute('aria-expanded')==='false'&&await page.locator('#menu-toggle').isVisible())await page.locator('#menu-toggle').click();
  await page.locator('#nav').getByRole('button',{name,exact:true}).click();
  await page.getByRole('heading',{name,exact:true}).waitFor();
}
async function row(requestId){return page.locator('[data-amount-row]').filter({has:page.getByText(requestId,{exact:true})});}
async function rowInput(requestId){return (await row(requestId)).locator('[data-amount-index]');}
try{
  await page.goto(fixture.previewOrigin);
  await page.locator('#open-login-top').click();
  await page.locator('[name=username]').fill('fixture-admin');await page.locator('[name=password]').fill('fixture-password');await page.locator('#login-form button[type=submit]').click();await page.getByRole('heading',{name:'管理概览',exact:true}).waitFor();
  await nav('申请处理中心');await page.locator('[data-queue-status=approved]').click();await page.locator('#content [data-owner="7"]').click();
  const selectAll=page.locator('[data-select-all]'),fixtureModel=page.locator('[data-model-select="fixture-model"]'),otherModel=page.locator('[data-model-select="other-model-with-a-long-name"]');
  const smallClaim=page.locator('[name=claim-select][value="'+fixture.store.byRequest('amount-wallet-small').id+'"]');
  await selectAll.check();
  assert.equal(await page.locator('[data-model-select]').evaluateAll(inputs=>inputs.every(input=>input.checked&&!input.indeterminate)),true,'select all must synchronize every model checkbox');
  await smallClaim.uncheck();
  assert.deepEqual(await fixtureModel.evaluate(input=>({checked:input.checked,indeterminate:input.indeterminate})),{checked:false,indeterminate:true},'partially selected model must show mixed state');
  assert.deepEqual(await selectAll.evaluate(input=>({checked:input.checked,indeterminate:input.indeterminate})),{checked:false,indeterminate:true},'partially selected page must show mixed state');
  await fixtureModel.check();assert.equal(await selectAll.isChecked(),true,'selecting the remaining model must refresh page selection');
  assert.equal(await selectAll.evaluate(input=>input.indeterminate),false);
  await otherModel.uncheck();assert.equal(await selectAll.evaluate(input=>input.indeterminate),true);
  await otherModel.check();assert.equal(await selectAll.isChecked(),true);
  await selectAll.uncheck();await smallClaim.evaluate(input=>{input.disabled=true;});
  await selectAll.check();assert.equal(await smallClaim.isChecked(),false,'disabled records must not be selected');
  assert.equal(await fixtureModel.isChecked(),true,'disabled records must not prevent full model selection');
  assert.equal(await selectAll.isChecked(),true,'disabled records must not prevent full page selection');
  await fixtureModel.uncheck();await fixtureModel.check();assert.equal(await smallClaim.isChecked(),false,'model selection must leave disabled records unchanged');
  assert.equal(await selectAll.isChecked(),true);assert.equal(await selectAll.evaluate(input=>input.indeterminate),false);
  await smallClaim.evaluate(input=>{input.disabled=false;});await selectAll.uncheck();await selectAll.check();
  await page.locator('#detail-dialog').evaluate(dialog=>{dialog.scrollTop=0;});
  await page.screenshot({path:'test-results/admin-review-aligned-desktop.png',animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#detail-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false,'mobile review list must not overflow');
  await page.screenshot({path:'test-results/admin-review-aligned-mobile.png',animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'核验并执行所选申请',exact:true}).click();await page.locator('[data-amount-panel]').waitFor();
  const allExpected=page.locator('[data-amount-all][data-amount-action=expected]'),allClear=page.locator('[data-amount-all][data-amount-action=clear]');
  await allClear.click();
  const firstModel=page.locator('[data-amount-group]').filter({has:page.getByRole('heading',{name:'fixture-model',exact:true})});
  await firstModel.locator('[data-amount-common]').fill('1');await firstModel.locator('[data-amount-action=common]').click();
  assert.equal(await (await rowInput('amount-wallet-large')).inputValue(),'1','one invalid record must not block a legal record');
  assert.equal(await (await rowInput('amount-wallet-small')).inputValue(),'','over-limit record stays empty');
  assert.match(await (await row('amount-wallet-small')).innerText(),/最多填写.*0.8/);
  assert.equal(await (await rowInput('amount-unknown')).inputValue(),'','unverified source stays empty');
  assert.match(await (await row('amount-unknown')).innerText(),/扣费与退款核实确认/);
  await page.locator('[data-amount-verified]').check();await firstModel.locator('[data-amount-action=common]').click();
  assert.equal(await (await rowInput('amount-unknown')).inputValue(),'1');
  await allExpected.click();
  for(const source of records)assert.equal(await (await rowInput(source.request_id)).inputValue(),String(source.quota/100));
  await (await rowInput('amount-wallet-small')).fill('2');
  assert.equal(await (await rowInput('amount-wallet-small')).getAttribute('aria-invalid'),'true');
  assert.equal(await page.locator('#operation-form').evaluate(el=>el.checkValidity()),false);
  await (await rowInput('amount-wallet-small')).fill('0.8');
  await page.locator('#operation-form [name=note]').fill('已核实实际扣费、历史退款及无有效输出，按每笔预计额度返还');
  assert.equal(await page.locator('#operation-form').evaluate(el=>el.checkValidity()),true);
  assert.match(await page.locator('.amount-summary').innerText(),/4/);
  await page.locator('#operation-dialog').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:'test-results/admin-amounts-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#operation-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false,'mobile amount dialog must not overflow');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile page must not overflow');
  const modelButtons=await page.locator('.amount-model-heading>button').evaluateAll(buttons=>buttons.map(button=>{
    const text=[...button.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
    const range=document.createRange();range.selectNodeContents(text);
    return {fits:button.scrollWidth<=button.clientWidth,rightInset:button.getBoundingClientRect().right-range.getBoundingClientRect().right};
  }));
  assert.equal(modelButtons.every(button=>button.fits&&button.rightInset>=8),true,'mobile model fill buttons must show full text with inner padding');
  await page.locator('[data-amount-all][data-amount-action=expected]').scrollIntoViewIfNeeded();
  await page.screenshot({path:'test-results/admin-amounts-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#operation-submit').click();await page.locator('#operation-results .result-row').first().waitFor();
  for(const source of records){assert.equal(fixture.store.byRequest(source.request_id).status,'succeeded');assert.equal(fixture.store.byRequest(source.request_id).amount,source.quota);}
  await page.locator('[data-close-operation]').last().click();await page.locator('[data-queue-status=pending]').click();await page.locator('#content [data-owner="7"]').click();
  await page.locator('[data-detail="'+subscriptionClaim.id+'"]').click();await page.locator('[data-action=approve]').click();await page.locator('[data-amount-panel]').waitFor();
  assert.equal(await page.locator('[data-amount-index]').inputValue(),'');
  await page.locator('[data-amount-all][data-amount-action=expected]').click();assert.equal(await page.locator('[data-amount-index]').inputValue(),'');
  await page.locator('[data-amount-verified]').check();await page.locator('[data-amount-all][data-amount-action=expected]').click();
  assert.equal(await page.locator('[data-amount-index]').inputValue(),'0.9');
  await page.locator('#operation-form [name=note]').fill('已核实订阅未退款，按预计额补入钱包余额');
  await page.locator('#operation-submit').click();await page.locator('#operation-results .result-row').first().waitFor();
  assert.equal(fixture.store.get(subscriptionClaim.id).status,'succeeded');assert.equal(fixture.store.get(subscriptionClaim.id).amount,90);
  const caps=await page.evaluate(async()=>{
    const {renderAmountPanel,bindAmountPanel}=await import('/amount-panel.js');
    const items=[{id:'cap-a',batchId:'same-query',requestId:'cap-a',model:'cap-model',quota:200,expectedAmount:200,confirmAmount:true,safeDefault:true},{id:'cap-b',batchId:'same-query',requestId:'cap-b',model:'cap-model',quota:80,expectedAmount:80,confirmAmount:true,safeDefault:true}];
    const root=document.createElement('form'),display={type:'TOKENS',unit:1,rate:1,scale:1};root.innerHTML=renderAmountPanel(items,display,String);bindAmountPanel(root,items,display,{perBatchQuota:250},String);
    const exceeded=!root.checkValidity()&&root.querySelector('[data-amount-error]').textContent.includes('250');
    const first=root.querySelector('[data-amount-index]');first.value='100';first.dispatchEvent(new Event('input',{bubbles:true}));
    return {exceeded,corrected:root.checkValidity()};
  });
  assert.deepEqual(caps,{exceeded:true,corrected:true});
  assert.deepEqual(errors,[]);
  console.log('PASS administrator bulk amount fill, partial failures, source confirmation, input validation, responsive review dialog, and exact submitted credits.');
}finally{
  await browser.close();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));fixture.store.close();await fixture.remote.close();
}
