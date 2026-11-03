// Local fixture only. Never connects to the reference website or production NewAPI.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
mkdirSync('test-results',{recursive:true});
async function login(name){await page.locator('[name=username]').fill(name);await page.locator('[name=password]').fill('fixture-password');await page.getByRole('button',{name:'登录工作台'}).click();await page.locator('#workspace').waitFor();}
async function nav(name){await page.getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();}
async function finish(note){await page.locator('#operation-form [name=note]').fill(note);await page.locator('#operation-submit').click();await page.getByRole('heading',{name:'逐笔处理结果',exact:true}).waitFor();await page.locator('[data-close-operation]').last().click();}
try{
 await page.goto(fixture.previewOrigin);await login('fixture-user');
 await nav('可补空回日志');await page.locator('#query-empty').click();await page.locator('.model-group > summary').first().waitFor();
 await page.locator('#select-page').uncheck();
 assert.equal(await page.locator('#batch-apply').isDisabled(),true,'no selection must disable batch submit');
 await page.locator('#select-page').check();
 assert.match(await page.locator('#selection-summary').innerText(),/已选 2 笔/);
 assert.equal(await page.locator('#batch-apply').isEnabled(),true);
 await page.locator('.model-group > summary').first().click();
 await page.locator('.desktop-log-details [value="fixture-request-2"]').uncheck();
 assert.equal(await page.locator('#select-page').evaluate(el=>el.indeterminate),true);
 assert.equal(await page.locator('.mobile-log-details [value="fixture-request-2"]').isChecked(),false,'duplicate responsive controls stay synchronized');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('.mobile-log-details [value="fixture-self-service"]').isChecked(),true,'selection survives viewport changes');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'test-results/detail-selection-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#query-empty').click();await page.locator('#select-page:checked').waitFor();
 assert.match(await page.locator('#selection-summary').innerText(),/已选 2 笔/,'fresh query selects only currently eligible records');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 await page.screenshot({path:'test-results/redesign-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'切换浅色模式'}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.screenshot({path:'test-results/redesign-light.png',fullPage:true});
 await page.getByRole('button',{name:'切换深色模式'}).click();
 await page.locator('.model-group > summary').first().click();
 await page.locator('.desktop-log-details [data-apply="fixture-request-2"]').click();
 await page.locator('#operation-dialog[open]').waitFor();
 assert.equal(fixture.remote.data.credits.length,0,'opening confirmation never credits');
 await page.locator('#operation-form [name=note]').fill('保留输入验证');
 await page.route('**/api/claims',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,message:'本地模拟网络失败'})}):route.continue());
 await page.locator('#operation-submit').click();await page.locator('#operation-error').filter({hasText:'本地模拟网络失败'}).waitFor();assert.equal(await page.locator('[name=note]').inputValue(),'保留输入验证');await page.unroute('**/api/claims');
 await page.screenshot({path:'test-results/redesign-confirmation.png',fullPage:true});
 await finish('本地 UI 验证，疑似空回申请');assert.equal(fixture.remote.data.credits.length,0,'application does not credit');
 await page.getByRole('button',{name:'退出',exact:true}).click();await login('fixture-admin');
 await nav('申请审核与补偿');await page.locator('[data-detail]').first().waitFor();
 // Handle the newly-created application by its immutable original request id.
 const claim=fixture.store.byRequest('fixture-request-2');assert.ok(claim);
 await page.locator('[data-detail="'+claim.id+'"]').click();await page.locator('[data-action=approve]').click();await finish('确认原消费待逐笔核验');
 await page.locator('[data-detail="'+claim.id+'"]').click();await page.locator('[data-action=execute]').click();
 assert.equal(await page.locator('[name="amount-0"]').inputValue(),'','execution amount must not be prefilled');
 await page.locator('[name="amount-0"]').fill('240');await finish('本地模拟：扣费240，无有效输出，未返还');
 assert.equal(fixture.remote.data.credits.length,1,'one explicit execution');
 await page.getByRole('button',{name:'退出',exact:true}).click();await login('fixture-user');await nav('补偿记录');await page.locator('.history-group > summary').first().click();await page.locator('.history-item').first().waitFor();
 assert.match(await page.locator('.record-fields').innerText(),/模型数量\s+1/);
 assert.match(await page.locator('.record-fields').innerText(),/时间范围/);
 assert.match(await page.locator('.history-models').innerText(),/1次/);
 assert.match(await page.locator('.history-models').innerText(),/240 quota/);
 await page.screenshot({path:'test-results/redesign-history.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'test-results/detail-history-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await nav('可补空回日志');
 await page.locator('#query-empty').click();
 await page.setViewportSize({width:390,height:844});await page.locator('.model-group > summary').first().click();await page.locator('.mobile-log-details').first().waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile page must not overflow');
 await page.screenshot({path:'test-results/redesign-mobile.png',fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'切换导航'}).click();assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'true');
 await page.locator('#drawer-backdrop').waitFor({state:'visible'});await page.screenshot({path:'test-results/redesign-drawer.png',fullPage:true});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:'切换导航'}).click();await nav('数据统计');await page.locator('#statistics-days').waitFor();
 assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 await page.locator('#statistics-days').selectOption('7');await page.getByRole('heading',{name:'我的空回补额度趋势（近7天）'}).waitFor();
 await page.locator('#statistics-auto').check();await page.locator('#statistics-refresh').click();await page.locator('#statistics-auto').waitFor();assert.equal(await page.locator('#statistics-auto').isChecked(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'test-results/redesign-statistics-mobile.png',fullPage:true});
 await page.locator('#search-toggle').click();await page.locator('#page-search').fill('补偿规则');await page.locator('#search-results [data-nav=rules]').click();await page.getByRole('heading',{name:'补偿规则',exact:true}).waitFor();
 await page.locator('#account-toggle').click();await page.locator('#account-menu').waitFor({state:'visible'});await page.keyboard.press('Escape');assert.equal(await page.locator('#account-menu').isVisible(),false);
 assert.deepEqual(errors,[]);console.log('PASS: themes, grouping, mobile layout, input retention, application/review/execution and successful history; exactly one mock credit.');
}finally{await browser.close();fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));fixture.store.close();await fixture.remote.close();}


