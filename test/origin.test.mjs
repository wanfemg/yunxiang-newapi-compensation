import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

async function setup(t) {
  const store = new Store();
  let logins = 0;
  const upstream = { login: async () => { logins++; throw Error('must not reach upstream'); } };
  const { server } = createApplication({ store, upstream, origin: 'https://yx.yzmao.cn' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return { base: 'http://127.0.0.1:' + server.address().port, logins: () => logins };
}

test('HTTPS 部署的 HTTP 页面跳转固定域名，不反射 Host、URL 或查询凭据', async t => {
  const f = await setup(t);
  for (const path of ['/', '//evil.example/path?password=secret', '/?token=secret']) {
    const response = await fetch(f.base + path, { redirect: 'manual', headers: { Host: 'evil.example', 'X-Forwarded-Proto': 'http' } });
    assert.equal(response.status, 308);
    assert.equal(new URL(response.headers.get('location')).origin, 'https://yx.yzmao.cn');
    assert.ok(!response.headers.get('location').includes('secret'));
  }
});

test('HTML 固定登录入口供手机浏览器升级 HTTPS，HTTPS 代理不产生跳转循环', async t => {
  const f = await setup(t);
  for (const headers of [{}, { 'X-Forwarded-Proto': 'https' }]) {
    const response = await fetch(f.base, { headers, redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="application-origin" content="https:\/\/yx\.yzmao\.cn"/);
  }
});

test('HTTP、跨站、null 与缺失来源均拒绝，不重放登录，错误提示正确入口', async t => {
  const f = await setup(t);
  for (const origin of ['http://yx.yzmao.cn', 'https://evil.example', 'null', undefined]) {
    const response = await fetch(f.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: '{}' });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.code, 'ORIGIN_MISMATCH');
    assert.equal(result.canonicalOrigin, 'https://yx.yzmao.cn');
    assert.match(result.message, /https:\/\/yx\.yzmao\.cn/);
  }
  const valid = await fetch(f.base + '/api/auth/login', { method: 'POST', headers: { Origin: 'https://yx.yzmao.cn', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(valid.status, 400);
  assert.equal(f.logins(), 0);
});
