import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {log,user} from './helpers.mjs';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const {store,service,remote}=fixture;
const now=Math.floor(Date.now()/1000),firstFrom=now-7200,firstEnd=now-3600;
const firstLog=log('range-paid',{id:920,created_at:firstFrom+600});
const secondLog=log('range-open',{id:921,created_at:firstEnd+600});
remote.data.logs=[firstLog,secondLog];
store.saveLogQueryProgress(user.id,{items:[],end:firstFrom-1,from:firstFrom-1800,syncedAt:(firstFrom-1)*1000,coverage:[{start:firstFrom-1800,end:firstFrom-1}],window:{start:firstFrom-1800,end:firstFrom-1}});
service.logQueries.clock=()=>firstEnd*1000;
const paid=(await service.logs(user,{refresh:true})).batches[0];
assert.equal((await service.batches.submit(user,paid.id)).status,'succeeded');
service.logQueries.clock=()=>now*1000;
const open=(await service.logs(user,{refresh:true})).batches[0];
assert.deepEqual({from:paid.from,end:paid.end},{from:firstFrom,end:firstEnd});
assert.deepEqual({from:open.from,end:open.end},{from:firstEnd+1,end:now});
const record=store.refundRecords(user.id).items[0];
assert.deepEqual(record.queryRange,{from:firstFrom,end:firstEnd});

const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:'America/New_York'});
page.setDefaultTimeout(10000);
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
mkdirSync('output/playwright',{recursive:true});
const format=seconds=>new Intl.DateTimeFormat('zh-CN',{timeZone:store.rules().timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(seconds*1000);
async function checkRange(target,from,end){
  assert.deepEqual(await target.locator('time').allTextContents(),[format(from),format(end)]);
  assert.deepEqual(await target.locator('time').evaluateAll(nodes=>nodes.map(node=>node.dateTime)),[new Date(from*1000).toISOString(),new Date(end*1000).toISOString()]);
}
try{
  await page.goto(fixture.previewOrigin);
  await page.locator('#open-login-top').click();
  await page.locator('[name=username]').fill('fixture-user');
  await page.locator('[name=password]').fill('fixture-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.getByRole('heading',{name:'我的概览',exact:true}).waitFor();
  await page.locator('#nav').getByRole('button',{name:'可补空回日志',exact:true}).click();
  const card=page.locator('[data-query-batch="'+open.id+'"]');
  await card.waitFor();
  assert.match(await card.locator('h3').innerText(),/本次查询空回的时间段为/);
  await checkRange(card.locator('.batch-query-range'),firstEnd+1,now);
  await checkRange(page.locator('.refund-record .query-time-range'),firstFrom,firstEnd);
  await card.locator('[data-submit-batch]').click();
  await page.locator('#operation-dialog[open]').waitFor();
  await checkRange(page.locator('#operation-body .batch-query-range'),firstEnd+1,now);
  await page.locator('#operation-dialog [data-close-operation]').first().click();
  await page.screenshot({path:'output/playwright/query-range-desktop.png',animations:'disabled'});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow at '+width);
    for(const time of await page.locator('.query-time-range:visible time').all()){
      const bounds=await time.boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width,'complete date remains inside mobile viewport');
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'output/playwright/query-range-mobile.png',animations:'disabled'});
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#query-empty').click();
  const progress=page.locator('.query-progress');
  await progress.getByText('已保存的查询结果',{exact:true}).waitFor();
  assert.equal(await progress.locator('.query-progress-count').count(),0,'cached results do not claim newly added records');
  service.logQueries.clock=()=>(now+1)*1000;
  await page.locator('#query-empty').click();
  await progress.getByText('查询完成',{exact:true}).waitFor();
  assert.match(await progress.locator('.query-progress-count').innerText(),/0 条新增消费/);
  remote.data.logs.push(log('range-new',{id:922,created_at:now+2}));
  service.logQueries.clock=()=>(now+3)*1000;
  await page.locator('#query-empty').click();
  await page.waitForFunction(()=>document.querySelector('.query-progress-count b')?.textContent==='1');
  assert.equal(await progress.locator('.query-progress-cutoff time').innerText(),format(now+3));
  assert.equal(await progress.locator('details').evaluate(node=>node.open),false,'coverage details start collapsed');
  assert.equal(await progress.evaluate(node=>[node,...node.querySelectorAll('*')].some(item=>getComputedStyle(item).backgroundImage!=='none')),false,'query text never receives progress-bar stripes');
  const contrast=await progress.locator('.query-progress-note').evaluate(node=>{
    const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
    const light=values=>values.map(value=>{const n=value/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    let parent=node;
    while(getComputedStyle(parent).backgroundColor==='rgba(0, 0, 0, 0)')parent=parent.parentElement;
    const text=light(rgb(getComputedStyle(node).color)),background=light(rgb(getComputedStyle(parent).backgroundColor));
    return (Math.max(text,background)+0.05)/(Math.min(text,background)+0.05);
  });
  assert.ok(contrast>=4.5,'readable query status text contrast');
  await progress.locator('summary').focus();
  await progress.locator('summary').press('Enter');
  assert.equal(await progress.locator('details').evaluate(node=>node.open),true,'keyboard opens query details');
  await progress.locator('summary').evaluate(node=>node.blur());
  await page.mouse.move(0,0);
  await progress.screenshot({path:'output/playwright/query-progress-desktop.png',animations:'disabled'});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'query details fit '+width+'px');
  }
  await page.setViewportSize({width:390,height:844});
  await progress.locator('summary').click();
  await progress.locator('summary').evaluate(node=>node.blur());
  await page.mouse.move(0,0);
  await progress.screenshot({path:'output/playwright/query-progress-mobile.png',animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log('PASS query ranges and readable status: full second precision, site timezone, saved/zero/new results, stripe-free text, contrast, keyboard details, desktop/390px/320px');
}finally{
  await browser.close();
  await fixture.drain();
  fixture.server.closeAllConnections();
  await new Promise(resolve=>fixture.server.close(resolve));
  await remote.close();
  store.close();
}
