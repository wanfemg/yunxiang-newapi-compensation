import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicOrigin, parseDeploymentEnv } from '../src/deployment-config.mjs';

test('public origin accepts bare domains and explicit loopback while retaining strict HTTPS roots', () => {
  assert.equal(normalizePublicOrigin(' yx.yzmao.cn '), 'https://yx.yzmao.cn');
  assert.equal(normalizePublicOrigin('https://YX.YZMAO.CN/'), 'https://yx.yzmao.cn');
  assert.equal(normalizePublicOrigin('yx.yzmao.cn:8443/'), 'https://yx.yzmao.cn:8443');
  assert.equal(normalizePublicOrigin('http://127.0.0.1:3210'), 'http://127.0.0.1:3210');
  assert.equal(normalizePublicOrigin('http://localhost:3210'), 'http://localhost:3210');
  for (const value of ['http://yx.yzmao.cn', 'https://yx.yzmao.cn/path', 'https://user:password@yx.yzmao.cn',
    'https://yx.yzmao.cn?token=secret', 'https://yx.yzmao.cn#login', 'yx..yzmao.cn', '$PUBLIC_ORIGIN', '']) {
    assert.throws(() => normalizePublicOrigin(value), value);
  }
});

test('saved deployment environment is parsed as data and validates required fields', () => {
  const config = 'PUBLIC_ORIGIN=https://yx.yzmao.cn\nNEWAPI_URL=http://new-api:3000\nNEWAPI_ADMIN_USER_ID=1\nALLOW_HTTP_UPSTREAM=1\n';
  assert.equal(parseDeploymentEnv(config).NEWAPI_URL, 'http://new-api:3000');
  assert.throws(() => parseDeploymentEnv(config.replace('USER_ID=1', 'USER_ID=0')));
  assert.throws(() => parseDeploymentEnv(config.replace('https://yx.yzmao.cn', 'yx.yzmao.cn')));
  assert.throws(() => parseDeploymentEnv(config + 'EVIL=$(touch secret)\n'));
  assert.throws(() => parseDeploymentEnv(config + 'source secret\n'));
});
