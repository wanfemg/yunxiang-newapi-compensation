import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { composePlan } from '../src/deployment.mjs';
import { normalizeComposePaths, recoverNetwork, setNetwork } from '../src/deployment-recovery.mjs';

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const root = resolve(import.meta.dirname, '..');
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yunxiang-recovery-'));
  for (const item of ['auto-deploy.sh', 'install.sh', 'migrate.sh', 'status.sh', 'src', 'test']) {
    cpSync(join(root, item), join(dir, item), { recursive: true });
  }
  return dir;
};
const run = (dir, extra = {}) => spawnSync(bash, [join(import.meta.dirname, 'deploy-harness.sh').replaceAll('\\', '/')], {
  cwd: dir,
  encoding: 'utf8',
  timeout: 30000,
  env: {
    ...process.env,
    NODE_EXE: process.execPath.replaceAll('\\', '/'),
    NEWAPI_URL: 'https://newapi.example.com',
    NEWAPI_ADMIN_USER_ID: '1',
    NEWAPI_ADMIN_TOKEN: 'fixture-deploy-token',
    PUBLIC_ORIGIN: 'https://refund.example.com',
    COMPENSATION_PORT: '3210',
    ...extra
  }
});

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

test('migration helpers read compose from stdin instead of the container filesystem', { skip: !bashAvailable }, () => {
  const dir = setup();
  try {
    const compose = composePlan({ network: 'host', port: 3210 });
    const script = spawnSync(bash, ['-lc', 'node "$@"', process.execPath, join(root, 'src', 'deployment-recovery.mjs').replaceAll('\\', '/'), 'normalize', dir.replaceAll('\\', '/')], {
      cwd: '/',
      encoding: 'utf8',
      input: JSON.stringify(compose)
    });
    assert.equal(script.status, 0, script.stdout + script.stderr);
    const output = JSON.parse(script.stdout);
    assert.equal(output.compose.name, 'newapi-compensation');
    assert.equal(output.compose.services.compensation.network_mode, 'host');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrated compose regenerates the panel file without stale absolute paths', { skip: !bashAvailable }, () => {
  const dir = setup();
  try {
    assert.equal(run(dir).status, 0);
    const file = join(dir, 'compose.generated.json');
    const oldDir = '/old/server/yunxiang';
    const old = JSON.parse(readFileSync(file, 'utf8'));
    old.services.compensation.build.context = oldDir;
    old.services.compensation.network_mode = 'old-server_net';
    writeFileSync(file, JSON.stringify(old));
    const result = run(dir, { MOCK_NETWORK_MISSING: 'old-server_net', NEWAPI_NETWORK: 'new-server_net' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const fixed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(fixed.services.compensation.network_mode, 'new-server_net');
    const exported = JSON.parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'));
    assert.equal(exported.services.compensation.build.context.replaceAll('\\', '/'), dir.replaceAll('\\', '/'));
    assert.match(result.stdout, /已修复迁移带来的绝对路径/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing ledger volume blocks deployment instead of creating an empty ledger', { skip: !bashAvailable }, () => {
  const dir = setup();
  try {
    assert.equal(run(dir).status, 0);
    const result = run(dir, { MOCK_VOLUME_MISSING: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /不会新建空账本/);
    assert.doesNotMatch(result.stdout, /云响已启动/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manually imported local ledger is restored into the missing Docker volume', { skip: !bashAvailable }, () => {
  const dir = setup();
  try {
    assert.equal(run(dir).status, 0);
    mkdirSync(join(dir, 'data'));
    const db = join(dir, 'data', 'compensation.sqlite');
    const sqlite = new DatabaseSync(db);
    sqlite.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('newapi_origin','https://newapi.example.com')");
    sqlite.close();
    assert.equal(readFileSync(db).subarray(0, 15).toString('latin1'), 'SQLite format 3');
    const result = run(dir, { MOCK_VOLUME_MISSING: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /已恢复持久账本数据卷/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
