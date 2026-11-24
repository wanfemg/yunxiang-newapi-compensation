import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bashAvailable, deployFixture } from './deploy-fixture.mjs';

const report = result => result.stdout + result.stderr;
const ok = result => assert.equal(result.status, 0, report(result));
const savedFiles = ['.env.auto', 'compose.generated.json', 'docker-compose.yml', 'secrets/newapi_database.json', 'secrets/newapi_admin_token'];
function setup(fixture) {
  const source = join(fixture.state, 'upstream-files', 'data');
  mkdirSync(source, { recursive: true });
  const sqlite = join(source, 'one-api.db');
  const db = new DatabaseSync(sqlite); db.exec('CREATE TABLE users(id INTEGER); CREATE TABLE logs(id INTEGER)'); db.close();
  const inspect = join(fixture.base, 'newapi-containers.json');
  const container = (name, network) => ({ Id: name + '-id', Name: '/' + name, State: { Running: true }, Path: '/one-api',
    Config: { Image: 'private/site-api:latest', WorkingDir: '/app', Env: ['PORT=3000', 'SQLITE_PATH=/data/one-api.db'],
      Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'new-api' } },
    HostConfig: { NetworkMode: network }, NetworkSettings: { Networks: { [network]: {} } },
    Mounts: [{ Type: 'volume', Name: 'original_site_db', Source: '/var/lib/docker/volumes/original_site_db/_data', Destination: '/data', RW: true }] });
  const update = (name, network) => writeFileSync(inspect, JSON.stringify([container(name, network)]));
  update('original-api', 'old_network');
  const environment = { NEWAPI_URL: '', MOCK_NEWAPI_INSPECT_FILE: inspect };
  ok(fixture.run('install.sh', ['--install', '--non-interactive'], environment));
  const ledger = join(fixture.volume, 'compensation.sqlite');
  const store = new DatabaseSync(ledger); store.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('original-financial-data')"); store.close();
  return { environment, update, ledger, sqlite };
}
function readLedger(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { origin: db.prepare("SELECT value FROM metadata WHERE key='newapi_origin'").get().value, sentinel: db.prepare('SELECT value FROM sentinel').get().value }; }
  finally { db.close(); }
}

test('rediscovery safely rebinds a renamed API and network using the exact original SQLite volume', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = setup(f), bytes = readFileSync(source.sqlite), token = readFileSync(join(f.directory, 'secrets/newapi_admin_token'));
    // Imported deployments can retain absolute build/secret paths. They must be
    // normalized against the host installation directory, never helper /app.
    const generated = JSON.parse(readFileSync(join(f.directory, 'compose.generated.json'), 'utf8'));
    generated.services.compensation.build.context = '/old-server/yunxiang';
    for (const secret of Object.values(generated.secrets)) secret.file = '/old-server/yunxiang/secrets/' + basename(secret.file);
    writeFileSync(join(f.directory, 'compose.generated.json'), JSON.stringify(generated));
    source.update('renamed-api', 'new_network'); f.clearCalls();
    const result = f.run('install.sh', ['--refresh-newapi', '--non-interactive'], source.environment); ok(result);
    assert.deepEqual(readLedger(source.ledger), { origin: 'http://renamed-api:3000', sentinel: 'original-financial-data' });
    const compose = JSON.parse(readFileSync(join(f.directory, 'docker-compose.yml'), 'utf8'));
    assert.equal(compose.services.compensation.network_mode, 'new_network');
    assert.equal(compose.services.compensation.build.context, f.directory);
    assert.deepEqual(readFileSync(source.sqlite), bytes);
    assert.deepEqual(readFileSync(join(f.directory, 'secrets/newapi_admin_token')), token);
    assert.equal(f.calls().some(call => call[0] === 'volume' && ['rm', 'create'].includes(call[1])), false);
    assert.equal(existsSync(join(f.directory, '.yunxiang-link.rollback')), false);
  } finally { f.clean(); }
});

test('failed renamed-API postcheck restores the actual original ledger binding and every saved configuration', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = setup(f), before = savedFiles.map(name => readFileSync(join(f.directory, name)));
    source.update('renamed-api', 'new_network');
    const result = f.run('install.sh', ['--refresh-newapi', '--non-interactive'], { ...source.environment, MOCK_LINK_POSTCHECK_FAIL: '1' });
    assert.notEqual(result.status, 0, report(result)); assert.match(report(result), /已恢复重新获取前/);
    savedFiles.forEach((name, index) => assert.deepEqual(readFileSync(join(f.directory, name)), before[index], name));
    assert.deepEqual(readLedger(source.ledger), { origin: 'http://original-api:3000', sentinel: 'original-financial-data' });
    assert.equal(existsSync(join(f.state, 'stopped')), false);
    assert.equal(existsSync(join(f.directory, '.yunxiang-link.rollback')), false);
  } finally { f.clean(); }
});

test('startup recovers a published interrupted association before processing a new discovery request', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = setup(f), before = savedFiles.map(name => readFileSync(join(f.directory, name)));
    const backup = join(f.directory, '.yunxiang-link.rollback'); mkdirSync(join(backup, 'secrets'), { recursive: true });
    for (const name of savedFiles.filter(name => name !== 'secrets/newapi_admin_token')) cpSync(join(f.directory, name), join(backup, name));
    cpSync(join(f.directory, '.yunxiang-deploy-state'), join(backup, 'deploy-state'));
    for (const marker of ['active', 'running', 'rebound', 'published']) writeFileSync(join(backup, marker), '');
    writeFileSync(join(backup, 'manifest'), 'yunxiang-newapi-link-v1\n');
    writeFileSync(join(backup, 'previous-origin'), 'http://original-api:3000\n');
    writeFileSync(join(backup, 'next-origin'), 'http://interrupted-api:3000\n');
    const db = new DatabaseSync(source.ledger); db.prepare("UPDATE metadata SET value=? WHERE key='newapi_origin'").run('http://interrupted-api:3000'); db.close();
    writeFileSync(join(f.directory, '.env.auto'), readFileSync(join(f.directory, '.env.auto'), 'utf8').replaceAll('original-api', 'interrupted-api'));
    writeFileSync(join(f.state, 'stopped'), '1');
    const result = f.run('install.sh', ['--refresh-newapi', '--non-interactive'], { ...source.environment, MOCK_LINK_API_FAIL: '1' });
    assert.notEqual(result.status, 0, report(result)); assert.match(report(result), /先恢复上次稳定配置/);
    savedFiles.forEach((name, index) => assert.deepEqual(readFileSync(join(f.directory, name)), before[index], name));
    assert.deepEqual(readLedger(source.ledger), { origin: 'http://original-api:3000', sentinel: 'original-financial-data' });
    assert.equal(existsSync(join(f.state, 'stopped')), false);
    assert.equal(existsSync(backup), false);
  } finally { f.clean(); }
});

test('refresh after a full server migration updates engine metadata while retaining the original API and ledger binding', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = setup(f), token = readFileSync(join(f.directory, 'secrets/newapi_admin_token'));
    const result = f.run('install.sh', ['--refresh-newapi', '--non-interactive'], {
      ...source.environment, MOCK_DOCKER_ENGINE_ID: 'migrated-docker-engine'
    });
    ok(result);
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'secrets/newapi_database.json'), 'utf8')).engineId, 'migrated-docker-engine');
    assert.deepEqual(readLedger(source.ledger), { origin: 'http://original-api:3000', sentinel: 'original-financial-data' });
    assert.deepEqual(readFileSync(join(f.directory, 'secrets/newapi_admin_token')), token);
    assert.equal(existsSync(join(f.directory, '.yunxiang-link.rollback')), false);
  } finally { f.clean(); }
});
