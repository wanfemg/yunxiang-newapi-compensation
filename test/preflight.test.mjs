import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function runPreflight(overrides = {}, responses = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'yunxiang-preflight-'));
  const tokenFile = join(directory, 'token');
  const metadataFile = join(directory, 'database.json');
  writeFileSync(tokenFile, 'fixture-only-private-token\n');
  writeFileSync(metadataFile, JSON.stringify({ version: 1, mode: 'api', connected: false, main: { type: 'unknown' }, logs: { type: 'unknown' } }));
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ path: url.pathname, method: req.method });
    if (url.pathname !== '/api/status') {
      assert.equal(req.headers.authorization, 'Bearer fixture-only-private-token');
      assert.equal(req.headers['new-api-user'], '1');
    }
    const defaults = {
      '/api/status': {},
      '/api/user/self': { id: 1, role: 100, status: 1, username: 'fixture-root' },
      '/api/log/': { items: [], total: 0 },
      '/api/user/1': { id: 1, role: 100, status: 1, quota: 10000 },
      '/api/group/': ['default'],
      '/api/channel/': { items: [], total: 0 }
    };
    const data = Object.hasOwn(responses, url.pathname) ? responses[url.pathname] : defaults[url.pathname];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = { ...process.env, NEWAPI_URL: 'http://127.0.0.1:' + server.address().port,
      NEWAPI_ADMIN_USER_ID: '1', NEWAPI_ADMIN_TOKEN_FILE: tokenFile,
      NEWAPI_DB_CONFIG_FILE: metadataFile, ALLOW_HTTP_UPSTREAM: '0', ...overrides };
    delete env.NEWAPI_ADMIN_TOKEN;
    const child = spawn(process.execPath, ['src/preflight.mjs'], { cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const [code] = await once(child, 'close');
    return { code, output, calls };
  } finally {
    server.close(); await once(server, 'close');
    rmSync(directory, { recursive: true, force: true });
  }
}

test('preflight CLI runs actual read-only upstream checks and distinguishes API mode from database validation', async () => {
  const result = await runPreflight();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /主机或远程 API 接入/);
  assert.match(result.output, /用户组及渠道模型接口可用/);
  assert.match(result.output, /未验证写入能力/);
  assert.equal(result.calls.length, 6);
  assert.equal(result.calls.every(call => call.method === 'GET'), true);
  assert.doesNotMatch(result.output, /fixture-only-private-token|fixture-root|10000/);
});

test('preflight CLI exits unsuccessfully when quota schema or rule dependencies do not work', async () => {
  const result = await runPreflight({}, { '/api/user/1': { id: 1, quota: 'bad-private-value' }, '/api/group/': 'private-bad-group-response' });
  assert.equal(result.code, 1);
  assert.match(result.output, /\[failed\].*用户资料与额度读取/);
  assert.match(result.output, /\[failed\].*用户组读取/);
  assert.doesNotMatch(result.output, /只读接入检查通过|private-bad|bad-private|fixture-only-private-token/);
});
