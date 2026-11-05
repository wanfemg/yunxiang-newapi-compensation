// Only the local mock upstream is used; this flow never approves or credits claims.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {log,user,rules} from './helpers.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const policy=[{attempt:1,channel_id:13,group:'default',elapsed_ms:25,decision:{action:'attempt',reason:'channel_selected',source:'routing'}},{attempt:1,channel_id:13,group:'default',elapsed_ms:89999,decision:{action:'stop',reason:'stream_not_successful',source:'system'}}];
const source=log('snapshot-visual-request',{model_name:'gemini-2.5-pro',channel:13,quota:100000,use_time:90,prompt_tokens:2480,other:JSON.stringify({billing_source:'subscription',billing_mode:'tiered_expr',billing_unit:'request',subscription_id:80,subscription_plan_title:'订阅套餐',subscription_consumed:100000,subscription_remain:1395346,admin_info:{local_count_tokens:true,request_policy:JSON.stringify(policy)},stream_status:{status:'error',end_reason:'client_gone',end_error:'context canceled'},custom_unknown:'<img src=x onerror=alert(1)>'})});
fixture.remote.data.logs.push(source);
const claim=fixture.store.create(source,user,rules(),'截图验证，不执行补偿','self',7);
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
const page=await browser.newPage({viewport:{width:1440,height:1600}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
mkdirSync('output/playwright',{recursive:true});
async function login(username){
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill('fixture-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({state:'visible'});
}
async function assertFits(){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'page has no horizontal overflow');
  assert.equal(await page.locator('#detail-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false,'dialog has no horizontal overflow');
  assert.equal(await page.locator('.snapshot-panel:visible').evaluate(el=>el.scrollWidth>el.clientWidth),false,'snapshot has no horizontal overflow');
}
try{
  await page.goto(fixture.previewOrigin);
  const resource=await page.request.get(fixture.previewOrigin+'/snapshot.js');
  assert.equal(resource.status(),200);
  assert.match(resource.headers()['content-type'],/javascript/);
  await login('fixture-admin');
  await page.locator('#content [data-detail="'+claim.id+'"]').click();
  await page.locator('.audit-snapshot>summary').click();
  await page.locator('#snapshot-panel-log').waitFor({state:'visible'});
  assert.match(await page.locator('.snapshot-metrics').first().innerText(),/额度 1,000/);
  assert.match(await page.locator('.snapshot-stream').innerText(),/context canceled/);
  assert.equal(await page.locator('.snapshot-timeline>li').count(),2);
  assert.equal(await page.locator('.snapshot-event-title>small').first().isVisible(),true,'timing stays visible when the event is collapsed');
  assert.match(await page.locator('.snapshot-event-title').first().innerText(),/25 ms/);
  await page.locator('.snapshot-event>summary').first().click();
  await page.locator('.snapshot-event').first().locator('.snapshot-node>summary').click();
  assert.match(await page.locator('.snapshot-event').first().innerText(),/routing/);
  await page.locator('.snapshot-event>summary').first().click();
  await page.getByRole('tab',{name:'规则快照',exact:true}).click();
  assert.equal(await page.locator('#snapshot-panel-log').isVisible(),false);
  assert.match(await page.locator('#snapshot-panel-rules').innerText(),/申请时生效规则/);
  await page.getByRole('tab',{name:'原始 JSON',exact:true}).click();
  const raw=JSON.parse(await page.locator('#snapshot-panel-raw pre').innerText());
  assert.equal(raw.log.other,source.other,'raw nested JSON stays byte-for-byte unchanged');
  assert.equal(await page.locator('.audit-snapshot img').count(),0,'metadata cannot become executable markup');
  await page.getByRole('tab',{name:'原始 JSON',exact:true}).press('Home');
  assert.equal(await page.getByRole('tab',{name:'原消费',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'原消费',exact:true}).press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:'规则快照',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'原消费',exact:true}).click();
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await assertFits();
    await page.locator('.audit-snapshot').screenshot({path:'output/playwright/snapshot-'+theme+'-desktop.png',animations:'disabled'});
  }
  for(const width of [390,320]){
    await page.setViewportSize({width,height:1100});
    await assertFits();
    await page.getByRole('tab',{name:'规则快照',exact:true}).click();await assertFits();
    await page.getByRole('tab',{name:'原始 JSON',exact:true}).click();await assertFits();
    await page.getByRole('tab',{name:'原消费',exact:true}).click();
    await page.screenshot({path:'output/playwright/snapshot-mobile-'+width+'.png',animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1600});
  await page.locator('#close-dialog').click();
  await page.locator('#content [data-detail="'+claim.id+'"]').click();
  await page.locator('.audit-snapshot>summary').click();
  assert.equal(await page.getByRole('tab',{name:'原消费',exact:true}).getAttribute('aria-selected'),'true','newly opened detail resets to consumption');
  await page.locator('#close-dialog').click();
  await page.locator('#account-toggle').click();await page.locator('#account-logout').click();
  await page.locator('#login-form').waitFor({state:'visible'});
  await login('fixture-user');
  await page.locator('#nav').getByRole('button',{name:'我的申请',exact:true}).click();
  await page.locator('#content [data-detail="'+claim.id+'"]').click();
  await page.locator('#detail-dialog[open]').waitFor();
  assert.equal(await page.locator('.audit-snapshot').count(),0,'administrator diagnostics remain hidden from ordinary users');
  assert.equal(fixture.remote.data.credits.length,0,'viewing diagnostics never credits balances');
  assert.deepEqual(errors,[]);
  console.log('PASS snapshot tabs, keyboard navigation, nested JSON, untouched raw data, light/dark, 320/390px mobile, administrator-only diagnostics and read-only behavior.');
}finally{
  await browser.close();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));fixture.store.close();await fixture.remote.close();
}
