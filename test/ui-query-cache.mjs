// Local mock upstream only; no external balances are changed.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { log } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH);
const fixture = await import('./preview.mjs');
let queries = 0;
fixture.remote.server.on('request', req => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/log/' && !url.searchParams.has('request_id')) queries++;
});
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function query() {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/logs');
  await page.locator('#query-empty').click();
  await response;
  await page.locator('#query-empty:not([disabled])').waitFor();
  await page.locator('#batch-apply').waitFor();
}
try {
  await page.goto(fixture.previewOrigin);
  await page.locator('[name=username]').fill('fixture-user');
  await page.locator('[name=password]').fill('fixture-password');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('heading', { name: '我的概览', exact: true }).waitFor();
  await page.getByRole('button', { name: '可补空回日志', exact: true }).click();
  await query();
  assert.equal(queries, 1);
  await query();
  assert.equal(queries, 1, 'repeated list queries reuse the snapshot');
  await page.locator('.model-group>summary').first().click();
  await page.locator('.desktop-log-details [data-apply="fixture-self-service"]').click();
  await page.locator('#operation-submit').click();
  await page.getByRole('heading', { name: '逐笔处理结果' }).waitFor();
  assert.equal(fixture.store.byRequest('fixture-self-service').status, 'succeeded');
  await page.locator('[data-close-operation]').last().click();
  await query();
  assert.equal(queries, 1);
  assert.equal(await page.locator('[data-apply="fixture-self-service"]').count(), 0);
  assert.equal(await page.locator('.desktop-log-details [data-apply="fixture-request-2"]').count(), 1, 'unclaimed candidates remain');
  const existing = fixture.store.byRequest('fixture-request-1');
  assert.ok(await page.locator('.desktop-log-details [data-detail="' + existing.id + '"]').count(), 'existing claim links to progress');
  fixture.remote.data.logs.push(log('incremental-new', { id: 105, quota: 60 }));
  await new Promise(resolve => setTimeout(resolve, 16_000));
  await query();
  assert.equal(queries, 2);
  assert.equal(await page.locator('.desktop-log-details [data-apply="incremental-new"]').count(), 1);
  assert.equal(await page.locator('[data-apply="fixture-self-service"]').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/query-cache-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: cached repeat queries, successful claims removed, pending progress, retained unclaimed logs, incremental discovery and mobile layout.');
} finally {
  await browser.close();
  fixture.server.closeAllConnections();
  await new Promise(resolve => fixture.server.close(resolve));
  fixture.store.close();
  await fixture.remote.close();
}
