import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDatabase, databaseSummary } from '../src/db-discovery.mjs';

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
  assert.throws(() => discoverDatabase(inspect(['SQL_DSN_FILE=/run/secrets/db'])), /文件型/);
  assert.throws(() => databaseSummary({}), /格式无效/);
});
