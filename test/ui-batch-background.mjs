import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {AIReviewer} from '../src/ai-review.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const {store,service,remote}=fixture;
store.saveRules({...store.rules(),aiEnabled:true,aiAutoThreshold:95},1,store.rules().version);
const gate=Promise.withResolvers();let calls=0;
service.ai=new AIReviewer({store,env:{AI_BASE_URL:'http://fixture-ai.test/v1',AI_API_KEY:'fixture',AI_MODEL:'fixture'},fetcher:async()=>{
  const index=calls++;await gate.promise;
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({empty_probability:index===0?.98:.949,reason:index===0?'已经扣费，但没有生成有效回答':'日志没有明确记录空回信号，需要管理员核对'})}}]}));
}});
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];
page.setDefaultTimeout(10000);
page.on('pageerror',error=>errors.push(error.message));
async function nav(name){await page.locator('#nav').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();}
try{
  await page.goto(fixture.previewOrigin);
  await page.locator('#open-login-top').click();
  await page.locator('[name=username]').fill('fixture-user');await page.locator('[name=password]').fill('fixture-password');
  await page.locator('#login-form button[type=submit]').click();await page.getByRole('heading',{name:'我的概览',exact:true}).waitFor();
  await nav('可补空回日志');await page.locator('#query-empty').click();
  const batchButton=page.locator('[data-submit-batch]').first();await batchButton.waitFor();
  const id=await batchButton.getAttribute('data-submit-batch');
  await batchButton.click();await page.locator('#operation-submit').click();
  await page.getByRole('button',{name:'后台处理，关闭窗口',exact:true}).waitFor();
  assert.equal(store.queryBatch(id).status,'judging');assert.equal(remote.data.credits.length,0);
  assert.match(await page.locator('.batch-progress-note').innerText(),/申请已保存/);
  await page.getByRole('button',{name:'后台处理，关闭窗口',exact:true}).click();
  await nav('我的申请');assert.equal(await page.locator('#operation-dialog').isVisible(),false);
  await page.reload();await page.getByRole('heading',{name:'我的概览',exact:true}).waitFor();
  await nav('可补空回日志');await page.locator('[data-submit-batch="'+id+'"]').click();
  await page.getByRole('button',{name:'后台处理，关闭窗口',exact:true}).waitFor();
  assert.equal(calls,2,'关闭、刷新和重新查看进度不能重复调用 AI');
  gate.resolve();
  await page.locator('#operation-title').filter({hasText:'待人工处理'}).waitFor();
  assert.equal(store.queryBatch(id).status,'review');assert.equal(remote.data.credits.length,1);
  const pending=store.batchClaims(id).find(claim=>claim.status==='pending');
  assert.ok(pending);assert.match(pending.review_note,/94\.9%/);assert.match(pending.review_note,/95%/);
  assert.doesNotMatch(pending.review_note,/已驳回/);
  await page.locator('#operation-results .batch-models summary').first().click();
  assert.match(await page.locator('#operation-results').innerText(),/94\.9%/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS background UI: submit/close/navigate/reload/resume, partial payout and readable threshold reason');
}catch(error){console.error('Browser errors: '+JSON.stringify(errors));throw error;}finally{
  gate.resolve();await browser.close();
  await Promise.allSettled([...service.batches.jobs.values()]);
  if(fixture.drain)await fixture.drain();
  fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));
  await remote.close();store.close();
}
