import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDatabase, databaseSummary, sanitizedDatabase } from '../src/db-discovery.mjs';

const inspect = env => ({ Name: '/new-api', Config: { Env: env, WorkingDir: '/data' }, Mounts: [{ Type: 'volume', Name: 'newapi_data', Source: '/var/lib/docker/volumes/newapi_data/_data', Destination: '/data' }] });
test('自动识别 MySQL 主库和独立 PostgreSQL 日志库，只保留所需配置', () => {
  const result = discoverDatabase(inspect(['SQL_DSN=user:secret@tcp(mysql:3306)/newapi?x=a=b', 'LOG_SQL_DSN=postgres://user:password@pg/logs', 'SESSION_SECRET=not-exported']));
  assert.equal(result.main.type, 'mysql'); assert.equal(result.logs.type, 'postgresql');
  assert.match(result.main.dsn, /x=a=b$/);
  assert.ok(!JSON.stringify(result).includes('not-exported'));
  assert.ok(!databaseSummary(result).includes('password'));
  assert.equal(result.connected, false); assert.equal(result.quotaWriteMode, 'newapi-api');
});
test('SQLite 默认路径映射到现有卷，日志默认共用主库', () => {
  const result = discoverDatabase(inspect([]));
  assert.equal(result.main.containerPath, '/data/one-api.db');
  assert.equal(result.main.hostPath, '/var/lib/docker/volumes/newapi_data/_data/one-api.db');
  assert.equal(result.logs.sameAs, 'main');
});
test('SQLite 显式路径、最长挂载匹配以及无挂载均准确标记', () => {
  const input = inspect(['SQL_DSN=local', 'SQLITE_PATH=/data/db/main.db?mode=rwc']);
  input.Mounts.push({ Type: 'bind', Source: '/srv/db', Destination: '/data/db' });
  assert.equal(discoverDatabase(input).main.hostPath, '/srv/db/main.db');
  input.Mounts = []; assert.equal(discoverDatabase(input).main.location, 'container-layer');
});
test('独立 ClickHouse 日志库、特殊 SQLite DSN 与文件配置明确区分', () => {
  assert.equal(discoverDatabase(inspect(['LOG_SQL_DSN=clickhouse://host/logs'])).logs.type, 'clickhouse');
  assert.equal(discoverDatabase(inspect(['SQLITE_PATH=file:data.db'])).main.location, 'unresolved');
  assert.equal(discoverDatabase(inspect(['SQL_DSN_FILE=/run/secrets/db'])).main.location, 'unresolved');
  assert.throws(() => databaseSummary({}), /格式无效/);
});

test('PostgreSQL keyword DSN preserves quoted spaces, escaped quotes and equals without persisting credentials', () => {
  const config = discoverDatabase(inspect(["SQL_DSN=host=pg port=5433 user=admin password='secret = it\\'s' dbname='new api' sslmode=disable"]));
  assert.equal(config.main.type, 'postgresql');
  assert.deepEqual(config.main.endpoint, { host: 'pg', port: 5433, database: 'new api' });
  assert.doesNotMatch(JSON.stringify(sanitizedDatabase(config)), /secret|admin|password|dsn/i);
});

test('DSN aliases, file-backed secrets, explicit priority and unresolved missing files', () => {
  for (const alias of ['DATABASE_URL', 'DB_DSN']) {
    const config = discoverDatabase(inspect([`${alias}=mysql://user:pwd@db:3307/newapi?charset=utf8mb4`]));
    assert.equal(config.main.type, 'mysql');
    assert.deepEqual(config.main.endpoint, { host: 'db', port: 3307, database: 'newapi' });
  }
  const config = discoverDatabase(inspect(['SQL_DSN_FILE=/run/secrets/db', 'LOG_SQL_DSN_FILE=/run/secrets/logs']), {
    fileValues: { '/run/secrets/db': 'postgres://u:p@pg/main\n', '/run/secrets/logs': 'clickhouse://u:p@ch/logs' }
  });
  assert.equal(config.main.endpoint.database, 'main');
  assert.equal(config.logs.type, 'clickhouse');
  assert.equal(discoverDatabase(inspect(['SQL_DSN=local', 'DATABASE_URL=mysql://u:p@wrong/db'])).main.type, 'sqlite');
  assert.equal(discoverDatabase(inspect(['SQL_DSN_FILE=/missing'])).main.type, 'unknown');
});

test('SQLite main and local log DSN map actual shared SQLITE_PATH; fork LOG_SQLITE_PATH is explicit', () => {
  const config = discoverDatabase(inspect(['SQLITE_PATH=/data/main.db', 'LOG_SQL_DSN=local']));
  assert.equal(config.main.containerPath, '/data/main.db');
  assert.equal(config.logs.containerPath, '/data/main.db');
  const fork = discoverDatabase(inspect(['SQLITE_PATH=/data/main.db', 'LOG_SQL_DSN=local', 'LOG_SQLITE_PATH=/data/logs.db']));
  assert.equal(fork.logs.containerPath, '/data/logs.db');
  assert.equal(discoverDatabase(inspect(['SQL_DSN=sqlite:///data/explicit.db'])).main.containerPath, '/data/explicit.db');
});

test('network database container selection uses DSN aliases within shared networks and exposes exact data mounts', () => {
  const input = inspect(['SQL_DSN=u:s@tcp(mysql:3306)/newapi']);
  input.Config.Labels = { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'new-api' };
  input.NetworkSettings = { Networks: { site_default: {} } };
  const db = { Id: 'db-id', Name: '/site-mysql-1', State: { Running: true },
    Config: { Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'mysql', 'com.docker.compose.project.working_dir': '/opt/newapi', 'com.docker.compose.project.config_files': '/opt/newapi/docker-compose.yml' } },
    NetworkSettings: { Networks: { site_default: { Aliases: ['mysql'], IPAddress: '172.20.0.3' } } },
    Mounts: [{ Type: 'volume', Name: 'site_mysql', Source: '/var/lib/docker/volumes/site_mysql/_data', Destination: '/var/lib/mysql' }] };
  const result = sanitizedDatabase(discoverDatabase(input), [db]);
  assert.equal(result.main.location, 'container');
  assert.equal(result.main.databaseContainer.name, 'site-mysql-1');
  assert.equal(result.main.databaseContainer.project, 'site');
  assert.equal(result.main.databaseContainer.workingDirectory, '/opt/newapi');
  assert.equal(result.main.databaseContainer.mounts[0].destination, '/var/lib/mysql');
  assert.doesNotMatch(JSON.stringify(result), /u:s|dsn|password/);
  const other = structuredClone(db); other.Name = '/other-db'; other.Id = 'other';
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db, other]).main.location, 'ambiguous');
  other.NetworkSettings.Networks = { foreign: { Aliases: ['mysql'] } };
  assert.equal(sanitizedDatabase(discoverDatabase(input), [other]).main.location, 'remote');
});

test('compose service fallback requires same project and exact unique service; ports alone never identify databases', () => {
  const input = inspect(['SQL_DSN=postgres://u:p@postgres/newapi']);
  input.Config.Labels = { 'com.docker.compose.project': 'site' };
  input.NetworkSettings = { Networks: { private: {} } };
  const db = { Name: '/custom-db', State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'postgres' }, ExposedPorts: { '5432/tcp': {} } }, NetworkSettings: { Networks: { private: {} } } };
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'remote');
  db.Config.Labels['com.docker.compose.project'] = 'site';
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'container');
});

test('database parser handles IPv6, socket endpoints and malformed inputs with safe failure metadata', () => {
  assert.deepEqual(discoverDatabase(inspect(['SQL_DSN=u:p@tcp([::1]:3308)/main'])).main.endpoint, { host: '::1', port: 3308, database: 'main' });
  assert.deepEqual(discoverDatabase(inspect(['SQL_DSN=u:p@unix(/run/mysqld/mysqld.sock)/main'])).main.endpoint, { socket: '/run/mysqld/mysqld.sock', database: 'main' });
  const bad = discoverDatabase(inspect(['SQL_DSN=postgres://user:bad-secret@host:invalid/db']));
  assert.equal(bad.main.location, 'unresolved');
  assert.doesNotMatch(JSON.stringify(bad), /bad-secret/);
  assert.equal(databaseSummary({ version: 1, mode: 'api', main: { type: 'unknown' }, logs: { type: 'unknown' } }).includes('API'), true);
});

test('host-network source resolves an exact published host address and port without rewriting its DSN endpoint', () => {
  const input = inspect(['SQL_DSN=postgres://u:p@127.0.0.1:15432/newapi']);
  input.HostConfig = { NetworkMode: 'host' };
  input.NetworkSettings = { Networks: { host: {} } };
  const db = { Id: 'published-db', Name: '/custom-postgres', State: { Running: true }, Config: {},
    NetworkSettings: { Networks: { db_private: {} }, Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] } }, Mounts: [] };
  const result = sanitizedDatabase(discoverDatabase(input), [db]);
  assert.equal(result.main.location, 'container');
  assert.equal(result.main.databaseContainer.id, 'published-db');
  assert.deepEqual(result.main.endpoint, { host: '127.0.0.1', port: 15432, database: 'newapi' });
  const duplicate = structuredClone(db); duplicate.Id = 'second'; duplicate.Name = '/second-db';
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db, duplicate]).main.location, 'ambiguous');
  input.HostConfig.NetworkMode = 'db_private'; input.NetworkSettings.Networks = { db_private: {} };
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'remote');
});

test('published host lookup respects explicit IPs and address families and never matches by exposed port alone', () => {
  const input = inspect(['SQL_DSN=u:p@tcp(192.0.2.10:13306)/newapi']);
  input.HostConfig = { NetworkMode: 'host' };
  const db = { Name: '/mysql', State: { Running: true }, Config: { ExposedPorts: { '3306/tcp': {} } }, NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '192.0.2.10', HostPort: '13306' }] } } };
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'container');
  db.NetworkSettings.Ports['3306/tcp'][0].HostIp = '0.0.0.0';
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'remote');
  input.Config.Env = ['SQL_DSN=u:p@tcp([::1]:13306)/newapi'];
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'remote');
  db.NetworkSettings.Ports['3306/tcp'][0].HostIp = '::';
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'container');
  db.NetworkSettings.Ports = {};
  assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.location, 'remote');
});

test('file-backed aliases follow SQL_DSN then DATABASE_URL then DB_DSN priority without fallback past an unread file', () => {
  for (const alias of ['DATABASE_URL', 'DB_DSN']) {
    const config = discoverDatabase(inspect([`${alias}_FILE=/run/db`]), { fileValues: { '/run/db': 'postgres://u:p@pg/main' } });
    assert.equal(config.main.type, 'postgresql');
    assert.equal(config.main.endpoint.host, 'pg');
  }
  const config = discoverDatabase(inspect(['SQL_DSN_FILE=/run/main', 'DATABASE_URL=postgres://u:p@wrong/db']));
  assert.equal(config.main.location, 'unresolved');
  assert.equal(discoverDatabase(inspect(['SQL_DSN=local', 'SQL_DSN_FILE=/missing'])).main.type, 'sqlite');
});

test('custom PostgreSQL PGDATA and MySQL datadir identify the exact persisted storage directory', () => {
  for (const [dsn, env, args, expected] of [
    ['postgres://u:p@db/main', ['PGDATA=/custom/cluster'], [], '/custom/cluster'],
    ['u:p@tcp(db:3306)/main', [], ['--datadir=/custom/mysql'], '/custom/mysql'],
    ['u:p@tcp(db:3306)/main', [], ['mysqld'], '/var/lib/mysql']
  ]) {
    const input = inspect([`SQL_DSN=${dsn}`]); input.NetworkSettings = { Networks: { shared: {} } };
    const db = { Name: '/db', State: { Running: true }, Config: { Env: env }, Args: args, NetworkSettings: { Networks: { shared: {} } } };
    assert.equal(sanitizedDatabase(discoverDatabase(input), [db]).main.databaseContainer.dataDirectory, expected);
  }
  const pg = discoverDatabase(inspect(["SQL_DSN=application_name=api host=pg dbname=main password='not saved'"]));
  assert.equal(pg.main.endpoint.host, 'pg');
  assert.equal(discoverDatabase(inspect(['SQL_DSN=u:p?x@/main'])).main.endpoint.database, 'main');
});
