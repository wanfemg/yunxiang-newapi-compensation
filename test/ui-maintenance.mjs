import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {user,log} from './helpers.mjs';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const {store,service,remote}=fixture;
const now=Math.floor(Date.now()/1000),errors=[];
service.logQueries.clock=()=>(now-60)*1000;
store.saveRules({...store.rules(),userDailyQuota:300,userDailyCount:3},1,store.rules().version);
const first=log('ui-paid-200',{id:901,quota:200,created_at:now-180});
const second=log('ui-limit-wait',{id:902,quota:150,created_at:now-120});
remote.data.logs=[first,second];
async function pay(source){
  const id=randomUUID();
  store.insertQueryBatch({id,user,from:source.created_at,end:source.created_at,items:[source]});
  return service.batches.submit(user,id,'UI regression');
}
assert.equal((await pay(first)).status,'succeeded');
remote.data.logs=[second];
mkdirSync('output/playwright',{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage({viewport:{width:1280,height:900}});
page.setDefaultTimeout(10000);
page.on('pageerror',error=>errors.push(error.message));
async function nav(target,title=target){
  if(page.viewportSize().width<768)await page.locator('#menu-toggle').click();
  await page.locator('#nav').getByRole('button',{name:target,exact:true}).click();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
}
async function login(target,name){
  await target.goto(fixture.previewOrigin);
  await target.locator('#open-login-top').click();
  await target.locator('[name=username]').fill(name);
  await target.locator('[name=password]').fill('fixture-password');
  await target.locator('#login-form button[type=submit]').click();
  await target.getByRole('heading',{name:name==='fixture-admin'?'管理概览':'我的概览',exact:true}).waitFor();
}
try{
  await login(page,'fixture-user');
  await nav('可补空回日志');
  await page.locator('#query-empty').click();
  const card=page.locator('.query-batch').filter({hasText:'ui-limit-wait'});
  await card.locator('[data-submit-batch]').click();
  await page.locator('#operation-submit').click();
  await page.locator('#operation-results').getByText('审核通过 · 等待限额恢复',{exact:true}).waitFor();
  assert.match(await page.locator('#operation-results .batch-limit').innerText(),/剩余|本次需要/);
  assert.match(await page.locator('#operation-results .batch-limit').innerText(),/下次恢复/);
  assert.deepEqual(remote.data.credits.map(item=>item.value),[200]);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'output/playwright/maintenance-waiting-mobile.png'});
  await Promise.all([page.waitForResponse(response=>response.url().endsWith('/resume')),page.locator('#operation-results [data-resume-batch]').click()]);
  await page.waitForFunction(()=>!document.querySelector('#operation-results [data-resume-batch]')?.disabled);
  assert.equal(remote.data.credits.length,1);
  await page.locator('#operation-dialog [data-close-operation]').first().click();
  await page.setViewportSize({width:1280,height:900});
  await nav('我的申请');
  await page.locator('tbody tr').filter({hasText:'ui-limit-wait'}).locator('[data-detail]').click();
  await page.locator('#detail-body .detail-status').getByText('审核通过 · 等待限额恢复',{exact:true}).waitFor();
  store.saveRules({...store.rules(),userDailyQuota:500},1,store.rules().version);
  await page.locator('#detail-body [data-resume-batch]').click();
  await page.locator('#detail-body .detail-status').getByText('补偿成功',{exact:true}).waitFor();
  assert.deepEqual(remote.data.credits.map(item=>item.value),[200,150]);
  await page.locator('#close-dialog').click();
  await nav('可补空回日志');
  const third=log('ui-paid-third',{id:903,quota:10,created_at:now-180});
  remote.data.logs.push(third);
  assert.equal((await pay(third)).status,'succeeded');
  const fourth=log('ui-fourth-blocked',{id:904,quota:10,created_at:now-30});
  remote.data.logs.push(fourth);
  service.logQueries.clock=()=>now*1000;
  await page.locator('#query-empty').click();
  const blocked=page.locator('.query-batch').filter({hasText:'ui-fourth-blocked'});
  await blocked.getByText('暂时无法提交新批次',{exact:true}).waitFor();
  assert.equal(await blocked.locator('[data-submit-batch]').isDisabled(),true);
  assert.match(await blocked.locator('.batch-limit').innerText(),/3 次|3\/3/);
  assert.match(await page.locator('.query-progress').innerText(),/已覆盖|当前可补范围/);
  assert.equal(remote.data.credits.length,3);
  await page.screenshot({path:'output/playwright/maintenance-limit-desktop.png'});

  const adminPage=await browser.newPage({viewport:{width:1280,height:900}});
  adminPage.on('pageerror',error=>errors.push(error.message));
  await login(adminPage,'fixture-admin');
  await adminPage.locator('#nav').getByRole('button',{name:'原始消费查询',exact:true}).click();
  await adminPage.locator('#backfill-form').waitFor();
  const cutoff=store.logQueryProgress(user.id).end;
  remote.data.logs.push(log('ui-late-log',{id:905,created_at:now-90}));
  const localInput=value=>new Date(value*1000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);
  await adminPage.locator('#backfill-form [name=userId]').fill(String(user.id));
  await adminPage.locator('#backfill-form [name=start]').fill(localInput(now-100));
  await adminPage.locator('#backfill-form [name=end]').fill(localInput(now-80));
  await adminPage.locator('#backfill-form button[type=submit]').click();
  await adminPage.locator('[data-form-feedback]').filter({hasText:'新增 1 条遗漏日志'}).waitFor();
  assert.equal(store.logQueryProgress(user.id).end,cutoff);
  await adminPage.locator('#backfill-form button[type=submit]').click();
  await adminPage.locator('[data-form-feedback]').filter({hasText:'新增 0 条遗漏日志'}).waitFor();
  assert.equal(remote.data.credits.length,3);
  await adminPage.setViewportSize({width:390,height:844});
  assert.equal(await adminPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS maintenance UI: full deferral/resume, fourth-batch block, query coverage, idempotent backfill, desktop/mobile');
}finally{
  await browser.close();
  await fixture.drain();
  fixture.server.closeAllConnections();
  await new Promise(resolve=>fixture.server.close(resolve));
  await remote.close();store.close();
}
