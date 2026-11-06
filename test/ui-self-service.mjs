// Local mock upstream only; no real balances or external 云中猫API小站 requests.
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {log} from './helpers.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));mkdirSync('test-results',{recursive:true});
async function logs(){await page.getByRole('button',{name:'可补空回日志',exact:true}).click();await page.locator('#query-empty').click();await page.locator('.model-group>summary').first().click();}
try{
  await page.goto(fixture.previewOrigin);await page.locator('[name=username]').fill('fixture-user');await page.locator('[name=password]').fill('fixture-password');await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('heading',{name:'我的概览',exact:true}).waitFor();
  await logs();
  assert.equal(await page.locator('.desktop-log-details [data-apply="fixture-self-service"]').innerText(),'自助补额度');
  assert.equal(await page.locator('.desktop-log-details [data-apply="fixture-request-2"]').innerText(),'提交审批');
  await page.locator('.desktop-log-details [name=log-select][value="fixture-self-service"]').check();await page.locator('.desktop-log-details [name=log-select][value="fixture-request-2"]').check();await page.locator('#batch-apply').click();
  await page.getByText('预计自助 1 笔，审批 1 笔',{exact:false}).waitFor();assert.equal(fixture.remote.data.credits.length,0);
  await page.locator('#operation-form [name=note]').fill('正常自助，异常核实');await page.screenshot({path:'test-results/self-service-confirmation.png',fullPage:true});
  await page.locator('#operation-submit').click();await page.getByRole('heading',{name:'逐笔处理结果'}).waitFor();
  assert.equal(fixture.remote.data.credits.length,1);assert.equal(fixture.store.byRequest('fixture-self-service').status,'succeeded');assert.equal(fixture.store.byRequest('fixture-request-2').status,'pending');
  await page.locator('#operation-results').getByText('补偿成功',{exact:true}).waitFor();await page.locator('#operation-results').getByText('待审核',{exact:true}).waitFor();
  await page.screenshot({path:'test-results/self-service-results.png',fullPage:true});await page.locator('[data-close-operation]').last().click();
  // Simulate a lost response AFTER the server credited: UI must not offer blind replay.
  fixture.remote.data.logs.push(log('fixture-network',{quota:60}));await page.locator('#refresh').click();await page.locator('.model-group>summary').first().click();await page.locator('.desktop-log-details [data-apply="fixture-network"]').click();
  assert.equal(await page.locator('#operation-form [name=note]').getAttribute('required'),null);
  await page.route('**/api/claims',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.locator('#operation-submit').click();await page.locator('#operation-error').filter({hasText:'请求未确认'}).waitFor();assert.equal(await page.locator('#operation-submit').isVisible(),false);
  assert.equal(fixture.remote.data.credits.length,2);assert.equal(fixture.store.byRequest('fixture-network').status,'succeeded');await page.unroute('**/api/claims');
  await page.locator('[data-close-operation]').last().click();await page.locator('#refresh').click();await page.locator('.model-group>summary').first().click();assert.equal(await page.locator('[data-apply="fixture-network"]').count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'test-results/self-service-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: mixed self-service/review, confirmation before credit, correct results, optional normal note, lost-response freeze, refreshed success and mobile layout.');
}finally{await browser.close();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));fixture.store.close();await fixture.remote.close();}
