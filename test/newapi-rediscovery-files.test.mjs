import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bashAvailable, deployFixture } from './deploy-fixture.mjs';

const output = result => result.stdout + result.stderr;
const ok = result => assert.equal(result.status, 0, output(result));
const mainFile = '/data/site.db';
function newapi(name = 'renamed-cloud-service') {
  return { Id: name + '-id', Name: '/' + name, State: { Running: true }, Path: '/one-api', Args: [],
    Config: { Image: 'private/custom-gateway:stable', WorkingDir: '/app', Env: ['PORT=3000', 'SQL_DSN=local', `SQLITE_PATH=${mainFile}`],
      Labels: { 'com.docker.compose.project': 'production-site', 'com.docker.compose.service': 'new-api',
        'com.docker.compose.project.working_dir': '/srv/production/newapi',
        'com.docker.compose.project.config_files': '/srv/production/newapi/compose.yml,/srv/production/newapi/override.yml' } },
    HostConfig: { NetworkMode: 'baota_net' }, NetworkSettings: { Networks: { baota_net: {} }, Ports: {} },
    Mounts: [{ Type: 'bind', Source: '/srv/production/newapi/data', Destination: '/data', RW: true }] };
}
function sources(fixture, containers, { sqlite = true, invalid = false } = {}) {
  const inspect = join(fixture.base, 'source-inspect.json');
  const files = join(fixture.base, 'source-files');
  mkdirSync(join(files, 'data'), { recursive: true });
  const database = join(files, 'data', 'site.db');
  if (sqlite) {
    if (invalid) writeFileSync(database, Buffer.alloc(150, 7));
    else {
      const db = new DatabaseSync(database);
      db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE logs(id INTEGER PRIMARY KEY)');
      db.close();
    }
  }
  writeFileSync(inspect, JSON.stringify(containers));
  return { database, files, environment: { NEWAPI_URL: '', MOCK_NEWAPI_INSPECT_FILE: inspect, MOCK_NEWAPI_FILES_DIR: files } };
}
function unpublished(fixture, result) {
  assert.notEqual(result.status, 0, output(result));
  assert.equal(existsSync(join(fixture.directory, '.env.auto')), false);
  assert.equal(existsSync(join(fixture.directory, 'compose.generated.json')), false);
  assert.equal(existsSync(fixture.volume), false);
  assert.equal(fixture.calls().some(call => call[0] === 'volume' && call[1] === 'create'), false);
  assert.equal(fixture.calls().some(call => call[0] === 'compose' && (call.includes('up') || call.includes('build'))), false);
  assert.doesNotMatch(output(result), /云响已启动|检查通过，原账本/);
}
async function listener() {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('fresh discovery identifies a renamed NewAPI project, exact Compose files and an unchanged real SQLite source', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const container = newapi(); const source = sources(f, [container]);
    const before = readFileSync(source.database);
    const result = f.run('install.sh', ['--install', '--non-interactive'], source.environment); ok(result);
    const metadata = JSON.parse(readFileSync(join(f.directory, 'secrets/newapi_database.json'), 'utf8'));
    assert.equal(metadata.container, 'renamed-cloud-service');
    assert.equal(metadata.project.project, 'production-site');
    assert.equal(metadata.project.workingDirectory, '/srv/production/newapi');
    assert.deepEqual(metadata.project.composeFiles, ['/srv/production/newapi/compose.yml', '/srv/production/newapi/override.yml']);
    assert.equal(metadata.main.type, 'sqlite');
    assert.equal(metadata.main.containerPath, mainFile);
    assert.equal(metadata.main.hostPath, '/srv/production/newapi/data/site.db');
    assert.match(readFileSync(join(f.directory, '.env.auto'), 'utf8'), /^NEWAPI_URL=http:\/\/renamed-cloud-service:3000$/m);
    assert.equal(f.calls().some(call => call[0] === 'exec' && call[1] === 'renamed-cloud-service' && call.at(-1) === mainFile && call.includes('test -f "$1" && test -r "$1" && head -c 100 -- "$1"')), true);
    assert.match(output(result), /SQLite 文件可读且文件头有效/);
    assert.deepEqual(readFileSync(source.database), before);
    assert.equal(f.calls().some(call => call[0] === 'network' && call[1] !== 'inspect'), false);
  } finally { f.clean(); }
});

test('interactive candidate number two selects the second renamed NewAPI rather than the first result', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const source = sources(f, [newapi('first-renamed'), newapi('second-renamed')]);
    const result = f.run('install.sh', ['--install'], source.environment, { interactive: true, input: '2\n\n\n' }); ok(result);
    const metadata = JSON.parse(readFileSync(join(f.directory, 'secrets/newapi_database.json'), 'utf8'));
    assert.equal(metadata.container, 'second-renamed');
    assert.match(readFileSync(join(f.directory, '.env.auto'), 'utf8'), /^NEWAPI_URL=http:\/\/second-renamed:3000$/m);
    assert.equal(f.calls().some(call => call[0] === 'exec' && call[1] === 'second-renamed' && call.at(-1) === mainFile), true);
    assert.equal(f.calls().some(call => call[0] === 'exec' && call[1] === 'first-renamed'), false);
  } finally { f.clean(); }
});

test('an explicit SQL_DSN_FILE containing equals signs uses a real TCP listener and never persists its credentials', { skip: !bashAvailable }, async () => {
  const f = deployFixture(), tcp = await listener();
  try {
    const container = newapi('file-configured-api');
    container.Config.Env = ['PORT=3000', 'SQL_DSN_FILE=/run/secrets/database'];
    const source = sources(f, [container], { sqlite: false });
    mkdirSync(join(source.files, 'run', 'secrets'), { recursive: true });
    const secret = 'hidden=database=password';
    writeFileSync(join(source.files, 'run', 'secrets', 'database'), `postgres://app:${secret}@127.0.0.1:${tcp.port}/newapi?sslmode=disable\n`);
    const result = f.run('install.sh', ['--install', '--non-interactive'], source.environment); ok(result);
    const metadataText = readFileSync(join(f.directory, 'secrets/newapi_database.json'), 'utf8');
    const metadata = JSON.parse(metadataText);
    assert.deepEqual(metadata.main.endpoint, { host: '127.0.0.1', port: tcp.port, database: 'newapi' });
    assert.equal(metadata.main.type, 'postgresql');
    assert.equal(f.calls().some(call => call[0] === 'cp' && call[1] === 'file-configured-api:/run/secrets/database'), true);
    assert.equal(f.calls().some(call => call[0] === 'exec'), false);
    assert.doesNotMatch(metadataText + output(result) + JSON.stringify(f.calls()), /hidden=database=password|postgres:\/\/app:|"dsn"|"password"/);
    assert.match(output(result), /TCP 端口可达/);
    assert.match(output(result), /认证与表结构尚未验证|未验证直接 SQL 认证/);
  } finally { await tcp.close(); f.clean(); }
});

for (const invalid of [false, true]) {
  test(`source SQLite ${invalid ? 'with an invalid real header' : 'missing from the selected container'} never publishes configuration or creates a ledger`, { skip: !bashAvailable }, () => {
    const f = deployFixture();
    try {
      const source = sources(f, [newapi()], { sqlite: invalid, invalid });
      const result = f.run('install.sh', ['--install', '--non-interactive'], source.environment);
      unpublished(f, result);
      assert.match(output(result), /SQLite 文件只读检查失败|文件头无效|原站 SQLite/);
    } finally { f.clean(); }
  });
}

test('a configured external database with a closed real TCP port fails before publishing any deployment', { skip: !bashAvailable }, async () => {
  const f = deployFixture(), tcp = await listener();
  const port = tcp.port; await tcp.close();
  try {
    const container = newapi('unreachable-db-api');
    container.Config.Env = ['PORT=3000', `SQL_DSN=postgres://app:not-printed@127.0.0.1:${port}/newapi`];
    const source = sources(f, [container], { sqlite: false });
    const result = f.run('install.sh', ['--install', '--non-interactive'], source.environment);
    unpublished(f, result);
    assert.match(output(result), /TCP 端口不可达|数据库端点不可达/);
    assert.doesNotMatch(output(result), /not-printed|TCP 端口可达/);
  } finally { f.clean(); }
});
