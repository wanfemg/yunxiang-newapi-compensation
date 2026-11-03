// Run against test/preview.mjs only; uses bundled Playwright via explicit module path.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
if(!process.env.PLAYWRIGHT_MODULE_PATH)throw Error('Set PLAYWRIGHT_MODULE_PATH to the installed Playwright package');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
mkdirSync('test-results',{recursive:true});
try{
 await page.goto(fixture.previewOrigin);
 await page.getByRole('heading',{name:'登录补偿工作台'}).waitFor();
 await page.screenshot({path:'test-results/login-desktop.png',fullPage:true});
 await page.locator('[name=username]').fill('fixture-admin');await page.locator('[name=password]').fill('fixture-password');await page.getByRole('button',{name:'登录工作台'}).click();
 await page.getByRole('heading',{name:'管理概览',exact:true}).waitFor();
 await page.getByText('累计返还额度',{exact:true}).waitFor();
 await page.screenshot({path:'test-results/admin-overview.png',fullPage:true});
 for(const name of ['消费记录查询','申请审核与补偿','补偿统计','补偿规则设置','钉钉通知','操作记录']){
  await page.getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();await page.locator('#content .panel').first().waitFor();
  assert.equal(await page.locator('#content').innerText().then(t=>t.includes('服务内部错误')),false,name);
 }
 await page.getByRole('button',{name:'补偿规则设置',exact:true}).click();await page.locator('#rules-form').waitFor();await page.locator('[name=userDailyQuota]').fill('1100');await page.getByRole('button',{name:'保存规则',exact:true}).click();await page.getByRole('heading',{name:'规则配置 · v3'}).waitFor();
 await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('heading',{name:'登录补偿工作台'}).waitFor();
 await page.locator('[name=username]').fill('fixture-user');await page.locator('[name=password]').fill('fixture-password');await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('heading',{name:'我的概览',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'管理概览',exact:true}).count(),0);
 await page.getByRole('button',{name:'可补空回日志',exact:true}).click();await page.locator('#query-empty').click();await page.locator('.model-group > summary').first().click();await page.locator('tbody tr').first().waitFor();assert.ok((await page.locator('#content').innerText()).includes('fixture-request-2'));
 await page.screenshot({path:'test-results/user-logs-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/user-logs-mobile.png',fullPage:true});
 const horizontal=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(horizontal,false,'mobile document should not horizontally overflow');
 await page.getByRole('button',{name:'切换导航',exact:true}).click();await page.getByRole('button',{name:'我的申请',exact:true}).click();await page.locator('[data-detail]').first().waitFor();await page.locator('[data-detail]').first().click();await page.locator('#detail-dialog[open]').waitFor();assert.ok((await page.locator('#detail-body').innerText()).includes('处理时间线'));
 assert.deepEqual(errors,[]);console.log('Browser smoke PASS: admin pages, save rules, original-user login, user logs, mobile layout, claim detail.');
}finally{await browser.close();fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));fixture.store.close();await fixture.remote.close();}
