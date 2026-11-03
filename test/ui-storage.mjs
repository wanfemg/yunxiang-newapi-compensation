// Local fixture only; cleanup never contacts a real upstream or touches its files.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture=await import('./preview.mjs');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const now=Date.now();
fixture.store.cacheLogQuery('old',{items:[]});
fixture.store.db.prepare('UPDATE log_query_cache SET created_at=?').run(now-10*86400000);
fixture.store.db.prepare("INSERT INTO notifications(event,body,status,next_at,created_at) VALUES('test','{}','sent',?,?)").run(now,now-40*86400000);
const claims=fixture.store.storageInfo().claims;
try{
  await page.goto(fixture.previewOrigin);
  await page.locator('[name=username]').fill('fixture-admin');await page.locator('[name=password]').fill('fixture-password');
  await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('heading',{name:'管理概览',exact:true}).waitFor();
  await page.getByRole('button',{name:'补偿规则设置',exact:true}).click();await page.locator('#storage-form').waitFor();
  await page.locator('[name=compact]').check();
  await page.getByRole('button',{name:'预览清理',exact:true}).click();await page.locator('#storage-confirm').waitFor();
  assert.equal(fixture.store.storageInfo().logs,1,'preview is read-only');
  assert.match(await page.locator('#detail-body').innerText(),/过期查询缓存\s+1/);
  await page.screenshot({path:'test-results/storage-preview-desktop.png'});
  await page.locator('#close-dialog').click();assert.equal(fixture.store.storageInfo().logs,1,'cancel preserves data');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'预览清理',exact:true}).click();await page.locator('#storage-confirm').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.locator('#detail-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await page.screenshot({path:'test-results/storage-preview-mobile.png'});
  await page.locator('#storage-confirm').click();await page.getByText('清理完成，补偿账本与去重记录已保留。',{exact:true}).waitFor();
  assert.equal(fixture.store.storageInfo().logs,0);assert.equal(fixture.store.storageInfo().notifications,0);assert.equal(fixture.store.storageInfo().claims,claims);
  assert.ok(fixture.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='storage_cleanup_completed'").get().n);
  assert.deepEqual(errors,[]);
  console.log('PASS storage preview, cancellation, confirmed cleanup, ledger retention and desktop/mobile layouts');
}finally{
  await browser.close();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));fixture.store.close();await fixture.remote.close();
}
