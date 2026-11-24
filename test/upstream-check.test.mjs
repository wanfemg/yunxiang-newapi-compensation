import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { checkUpstream, checkDatabaseEndpoint } from '../src/upstream-check.mjs';

const options = { url: 'https://newapi.example', adminUserId: '1', adminToken: 'private-management-token' };
const response = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
function fixture(overrides = {}) {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ path: url.pathname, query: url.search, ...request });
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    if (overrides[url.pathname]) return overrides[url.pathname](url, request);
    if (url.pathname === '/api/status') return response({ version: 'fixture' });
    if (url.pathname === '/api/user/self') return response({ id: 1, role: 100, status: 1, username: 'admin' });
    if (url.pathname === '/api/log/') return response({ items: [], total: 0 });
    if (url.pathname === '/api/user/1') return response({ id: 1, role: 100, status: 1, quota: 123456 });
    if (url.pathname === '/api/group/') return response(['default']);
    if (url.pathname === '/api/channel/') return response({ items: [], total: 0 });
    throw Error('unexpected request');
  };
  return { calls, fetcher };
}

test('preflight checks actual read paths for identity, logs, quota and rule dependencies without writes', async () => {
  const f = fixture();
  const report = await checkUpstream(options, f.fetcher);
  assert.equal(report.ok, true);
  assert.deepEqual(report.identity, { id: 1, role: 100 });
  assert.deepEqual(report.checks.filter(check => check.status === 'passed').map(check => check.name), ['status', 'identity', 'logs', 'quota', 'groups', 'channels']);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/status', '/api/user/self', '/api/log/', '/api/user/1', '/api/group/', '/api/channel/']);
  assert.doesNotMatch(JSON.stringify(report), /private-management-token|123456|admin/);
});

test('an optional status endpoint missing on a fork does not hide working required APIs', async () => {
  const f = fixture({ '/api/status': () => new Response('not found', { status: 404 }) });
  const report = await checkUpstream(options, f.fetcher);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.name === 'status').status, 'warning');
  assert.equal(report.checks.find(check => check.name === 'logs').status, 'passed');
});

test('ordinary admins use self quota and report target-user read as unverified under same-role protection', async () => {
  const f = fixture({ '/api/user/self': () => response({ id: 1, role: 10, status: 1, username: 'admin', quota: -100 }) });
  const report = await checkUpstream(options, f.fetcher);
  assert.equal(report.ok, true);
  const quota = report.checks.find(check => check.name === 'quota');
  assert.equal(quota.status, 'warning');
  assert.match(quota.message, /目标读取能力尚未验证/);
  assert.equal(f.calls.some(call => call.path === '/api/user/1'), false);
  assert.doesNotMatch(JSON.stringify(report), /-100|private-management-token/);
});

test('unrelated instance metadata and invalid credentials fail before authenticated requests', async () => {
  for (const input of [
    { ...options, metadata: { container: 'other-newapi' } },
    { ...options, adminToken: '' },
    { ...options, adminUserId: '0' }
  ]) {
    const f = fixture();
    const result = await checkUpstream(input, f.fetcher);
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test('container metadata comparison is case-insensitive because URL hostnames are normalized', async () => {
  const f = fixture();
  const result = await checkUpstream({ ...options, url: 'http://NewAPI-Main:3000', allowHttp: true,
    metadata: { container: 'NewAPI-Main' } }, f.fetcher);
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 6);
});

test('host/published loopback binding is accepted while an identity mismatch blocks remaining reads', async () => {
  const f = fixture({ '/api/user/self': () => response({ id: 2, role: 100, status: 1, username: 'other' }) });
  const result = await checkUpstream({ ...options, url: 'http://127.0.0.1:3000', metadata: { container: 'new-api' } }, f.fetcher);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.name === 'identity').status, 'failed');
  assert.deepEqual(f.calls.map(call => call.path), ['/api/status', '/api/user/self']);
});

test('malformed user quota and failures in independent log/group/channel paths are reported separately and redacted', async () => {
  const secret = 'dsn-secret private-management-token';
  const f = fixture({
    '/api/log/': () => response({ items: 'wrong', total: 0 }),
    '/api/user/1': () => response({ id: 2, quota: 40 }),
    '/api/group/': () => { throw Error(secret); },
    '/api/channel/': () => new Response(JSON.stringify({ success: false, message: secret }), { status: 403 })
  });
  const report = await checkUpstream(options, f.fetcher);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(check => check.status === 'failed').map(check => check.name), ['logs', 'quota', 'groups', 'channels']);
  assert.doesNotMatch(JSON.stringify(report), /dsn-secret|private-management-token/);
});

test('database TCP check sends no bytes and explicitly leaves authentication and tables unverified', async () => {
  let received = 0;
  const server = createServer(socket => socket.on('data', data => received += data.length));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const report = await checkDatabaseEndpoint({ main: { type: 'mysql', endpoint: { host: '127.0.0.1', port: server.address().port }, dsn: 'user:password-secret@tcp(localhost)/db' }, logs: { sameAs: 'main', type: 'mysql' } });
    assert.equal(report.ok, true);
    assert.equal(report.verified, false);
    assert.equal(report.authentication, 'unverified');
    assert.equal(report.schema, 'unverified');
    assert.equal(report.checks[0].status, 'reachable');
    assert.equal(received, 0);
    assert.doesNotMatch(JSON.stringify(report), /password-secret|user:/);
  } finally { server.close(); await once(server, 'close'); }
});

test('SQLite, unresolved and ambiguous database locations never claim a tested DB connection', async () => {
  for (const main of [
    { type: 'sqlite', containerPath: '/data/one-api.db' },
    { type: 'unknown' },
    { type: 'mysql', endpoint: { host: 'mysql', port: 3306 }, location: 'ambiguous' }
  ]) {
    const report = await checkDatabaseEndpoint({ main, logs: { sameAs: 'main' } }, { connect: () => { throw Error('must not connect'); } });
    assert.equal(report.ok, false);
    assert.equal(report.verified, false);
    assert.equal(report.checks[0].status, 'unverified');
  }
});

test('refused or timed-out database ports fail with stable redacted messages', async () => {
  const report = await checkDatabaseEndpoint({ main: { type: 'postgresql', endpoint: { host: '127.0.0.1', port: 1 }, dsn: 'postgres://user:secret@host/db' }, logs: { sameAs: 'main' } }, { connect: () => { throw Error('secret'); } });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(report), /secret|postgres:\/\//);
});
