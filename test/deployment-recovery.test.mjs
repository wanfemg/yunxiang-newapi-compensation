import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { composePlan } from '../src/deployment.mjs';
import { normalizeComposePaths, recoverNetwork, setNetwork } from '../src/deployment-recovery.mjs';
import { deployFixture, bashAvailable } from './deploy-fixture.mjs';

const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
function oldBoundLedger(f) {
  const source = join(f.base, 'old-ledger');
  mkdirSync(source);
  const db = new DatabaseSync(join(source, 'compensation.sqlite'));
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE marker(value TEXT);INSERT INTO marker VALUES('old binding ledger')"); db.close();
  writeFileSync(join(source, 'secrets.key'), Buffer.alloc(32, 19));
  mkdirSync(join(f.directory, 'secrets'));
  writeFileSync(join(f.directory, 'secrets/newapi_admin_token'), 'fixture-deploy-token');
  writeFileSync(join(f.directory, 'secrets/newapi_database.json'), '{"version":1,"connected":false}');
  writeFileSync(join(f.directory, '.env.auto'), 'PUBLIC_ORIGIN=https://refund.example.com\nNEWAPI_URL=https://newapi.example.com\nNEWAPI_ADMIN_USER_ID=1\nALLOW_HTTP_UPSTREAM=0\n');
  writeFileSync(join(f.directory, 'compose.generated.json'), JSON.stringify(composePlan({ network: 'host', port: 3210 })));
  writeFileSync(join(f.directory, '.yunxiang-deploy-state'), 'ready\n');
  writeFileSync(join(f.state, 'container'), 'fixture legacy container');
  writeFileSync(join(f.state, 'image'), 'fixture image');
  return source;
}
describe('deployment recovery', { concurrency: 3 }, () => {
test('migration rewrites stale absolute build and secret paths', () => {
  const oldDir = '/old/server/yunxiang';
  const compose = structuredClone(composePlan({ network: 'newapi_default', port: 3210 }));
  compose.services.compensation.build.context = oldDir;
  compose.secrets.newapi_admin_token.file = oldDir + '/secrets/newapi_admin_token';
  compose.secrets.newapi_database.file = oldDir + '/secrets/newapi_database.json';
  const { compose: fixed, changes } = normalizeComposePaths(compose, '/new/server/yunxiang');
  assert.deepEqual(changes, ['services.compensation.build.context', 'secrets.newapi_admin_token.file', 'secrets.newapi_database.file']);
  assert.equal(fixed.services.compensation.build.context, resolve('/new/server/yunxiang'));
  assert.equal(fixed.secrets.newapi_admin_token.file, resolve('/new/server/yunxiang/secrets/newapi_admin_token'));
  assert.equal(fixed.secrets.newapi_database.file, resolve('/new/server/yunxiang/secrets/newapi_database.json'));
  assert.equal(compose.services.compensation.build.context, oldDir);
});
test('missing external network is recovered from the current NewAPI container', () => {
  const compose = composePlan({ network: 'old-server_net', port: 3210 });
  const container = { NetworkSettings: { Networks: { 'new-server_net': {} } } };
  const { compose: fixed, changes } = recoverNetwork(compose, container);
  assert.deepEqual(changes, ['services.compensation.network_mode:new-server_net']);
  assert.equal(fixed.services.compensation.network_mode, 'new-server_net');
  assert.throws(() => recoverNetwork(compose, { NetworkSettings: { Networks: { one: {}, two: {} } } }), /无法唯一识别/);
  assert.throws(() => recoverNetwork(compose, container, 'not-attached'), /指定的网络未连接/);
  assert.equal(setNetwork(compose, 'explicit-net').compose.services.compensation.network_mode, 'explicit-net');
});
test('migrated compose regenerates the panel file without stale paths', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    ok(f.run());
    const file = join(f.directory, 'compose.generated.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    old.services.compensation.build.context = '/old/server/yunxiang';
    old.services.compensation.network_mode = 'old-server_net';
    writeFileSync(file, JSON.stringify(old));
    const result = f.run('auto-deploy.sh', ['--migrate', '--non-interactive'], { MOCK_NETWORK_MISSING: 'old-server_net', NEWAPI_NETWORK: 'new-server_net' });
    ok(result);
    const fixed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(fixed.services.compensation.network_mode, 'new-server_net');
    const exported = JSON.parse(readFileSync(join(f.directory, 'docker-compose.yml'), 'utf8'));
    assert.equal(exported.services.compensation.build.context, f.directory);
    assert.doesNotMatch(JSON.stringify(exported), /old\/server/);
  } finally { f.clean(); }
});
test('migration refuses a missing ledger instead of creating an empty one', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    ok(f.run()); rmSync(f.volume, { recursive: true }); rmSync(join(f.state, 'container'), { force: true }); f.clearCalls();
    const result = f.run('auto-deploy.sh', ['--migrate', '--non-interactive']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /云响已启动/);
    assert.equal(existsSync(f.volume), false);
    assert.equal(f.calls().some(call => call[0] === 'compose' && call.includes('up')), false);
  } finally { f.clean(); }
});
test('restoring an imported ledger executes the actual copy command and preserves data and keys', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    ok(f.run()); rmSync(f.volume, { recursive: true }); rmSync(join(f.state, 'container'), { force: true });
    const imported = join(f.directory, 'data'); mkdirSync(imported);
    const db = new DatabaseSync(join(imported, 'compensation.sqlite'));
    db.exec("CREATE TABLE marker(value TEXT);INSERT INTO marker VALUES('migration sentinel')"); db.close();
    const encryptionKey = Buffer.alloc(32, 11);
    writeFileSync(join(imported, 'secrets.key'), encryptionKey);
    writeFileSync(join(imported, 'dingtalk.enc'), 'fixture-encrypted-bot');
    const source = readFileSync(join(imported, 'compensation.sqlite'));
    const result = f.run('auto-deploy.sh', ['--migrate', '--non-interactive']); ok(result);
    assert.deepEqual(readFileSync(join(f.volume, 'compensation.sqlite')), source);
    assert.deepEqual(readFileSync(join(f.volume, 'secrets.key')), encryptionKey);
    assert.equal(readFileSync(join(f.volume, 'dingtalk.enc'), 'utf8'), 'fixture-encrypted-bot');
    const restored = new DatabaseSync(join(f.volume, 'compensation.sqlite'));
    assert.equal(restored.prepare('SELECT value FROM marker').get().value, 'migration sentinel'); restored.close();
    const helper = f.calls().filter(call => call[0] === 'run' && call.some(argument => argument.includes('/restore')));
    assert.ok(helper.some(call => call.includes('restore-volume')), 'production helper must execute its real ledger restoration command');
  } finally { f.clean(); }
});
test('volume permission repair requests the capabilities required for chown', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    ok(f.run()); f.clearCalls(); ok(f.run());
    const repair = f.calls().filter(call => call[0] === 'run' && call.some(value => /\bchown\b/.test(value)));
    assert.ok(repair.length > 0);
    for (const call of repair) {
      const caps = call.flatMap((value, index) => value === '--cap-add' ? [call[index + 1]] : []);
      assert.ok(caps.includes('CHOWN'), JSON.stringify(call));
      assert.ok(caps.includes('FOWNER'), JSON.stringify(call));
      assert.ok(caps.includes('DAC_OVERRIDE'), JSON.stringify(call));
    }
  } finally { f.clean(); }
});
test('an old bind-mounted ledger resumes its source container when the new image cannot build', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = oldBoundLedger(f);
    const before = readFileSync(join(source, 'compensation.sqlite'));
    const failed = f.run('auto-deploy.sh', ['--migrate', '--non-interactive'], { MOCK_OLD_BIND_DATA: source, MOCK_BUILD_FAIL: '1' });
    assert.equal(failed.status, 42, failed.stdout + failed.stderr);
    assert.equal(existsSync(f.volume), false, 'a failed build must not publish a snapshot volume');
    assert.equal(existsSync(join(f.state, 'stopped')), false, 'the original source service must resume before handoff');
    assert.deepEqual(readFileSync(join(source, 'compensation.sqlite')), before);
    assert.equal(f.calls().some(call => call.includes('restore-volume')), false);
    assert.ok(f.calls().some(call => call[0] === 'start'));
  } finally { f.clean(); }
});
test('after ledger handoff a startup failure preserves the new ledger and leaves the old writer stopped', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = oldBoundLedger(f);
    const before = readFileSync(join(source, 'compensation.sqlite'));
    const extra = { MOCK_OLD_BIND_DATA: source };
    const failed = f.run('auto-deploy.sh', ['--migrate', '--non-interactive'], { ...extra, MOCK_UP_FAIL: '1' });
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.deepEqual(readFileSync(join(f.volume, 'compensation.sqlite')), before);
    assert.equal(existsSync(join(f.state, 'stopped')), true, failed.stdout + failed.stderr + JSON.stringify(f.calls()));
    assert.equal(f.calls().some(call => call[0] === 'start'), false);
    const buildIndex = f.calls().findIndex(call => call[0] === 'compose' && call.includes('build'));
    const restoreIndex = f.calls().findIndex(call => call.includes('restore-volume'));
    assert.ok(buildIndex >= 0 && restoreIndex > buildIndex);
    ok(f.run('auto-deploy.sh', ['--migrate', '--non-interactive'], extra));
    assert.deepEqual(readFileSync(join(f.volume, 'compensation.sqlite')), before);
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /ready/);
  } finally { f.clean(); }
});
});
