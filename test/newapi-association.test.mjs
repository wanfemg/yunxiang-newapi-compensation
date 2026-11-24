import test from 'node:test';
import assert from 'node:assert/strict';
import { associationDecision } from '../src/newapi-link.mjs';

const metadata = () => ({ version: 1, engineId: 'fixture-engine-id', container: 'new-api', source: { project: 'site', networks: ['site_default'] },
  main: { type: 'postgresql', location: 'container', endpoint: { host: 'postgres', port: 5432, database: 'newapi' },
    databaseContainer: { id: 'pg-first', name: 'site-postgres-1', project: 'site', networks: ['site_default'],
      mounts: [{ type: 'volume', name: 'site_pgdata', source: '/var/lib/docker/volumes/site_pgdata/_data', destination: '/var/lib/postgresql/data' }] } },
  logs: { sameAs: 'main', type: 'postgresql' } });
const same = 'http://new-api:3000';
const renamed = 'http://renamed-api:3000';

test('same-named postgres in another project and network is never treated as the same database', () => {
  const old = metadata(), next = metadata();
  next.source.project = 'other'; next.source.networks = ['other_default'];
  next.main.databaseContainer = { ...next.main.databaseContainer, id: 'pg-other', project: 'other', networks: ['other_default'] };
  assert.throws(() => associationDecision(old, next, same, renamed), /不同|证明|绑定/);
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('same exact database container permits a renamed NewAPI without changing financial instance', () => {
  const old = metadata(), next = metadata(); next.container = 'renamed-api';
  assert.equal(associationDecision(old, next, same, renamed).rebind, true);
});

test('a recreated database container is accepted only when its exact persisted data and host scope remain identical', () => {
  const old = metadata(), next = metadata(); next.main.databaseContainer.id = 'pg-recreated';
  assert.equal(associationDecision(old, next, same, renamed).rebind, true);
  next.main.databaseContainer.mounts[0].name = 'new-empty-volume';
  next.main.databaseContainer.mounts[0].source = '/var/lib/docker/volumes/new-empty-volume/_data';
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('a recreated container with only a configuration mount cannot prove persistence of its database', () => {
  const old = metadata(), next = metadata();
  for (const config of [old, next]) config.main.databaseContainer.mounts = [{ type: 'bind', source: '/opt/postgres/config', destination: '/etc/postgresql' }];
  next.main.databaseContainer.id = 'pg-recreated';
  assert.throws(() => associationDecision(old, next, same, renamed), /不同|证明|绑定/);
});

test('database persistent bind paths include the data directory offset and cannot collide with siblings', () => {
  const old = metadata(), next = metadata();
  for (const config of [old, next]) config.main.databaseContainer.mounts = [{ type: 'bind', source: '/srv/postgres', destination: '/var/lib/postgresql' }];
  next.main.databaseContainer.id = 'pg-recreated';
  assert.equal(associationDecision(old, next, same, renamed).proven, true);
  next.main.databaseContainer.dataDirectory = '/var/lib/postgresql/other-cluster';
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('endpoint database, port and persistent mount changes are rejected even at an unchanged API URL', () => {
  for (const mutate of [next => { next.main.endpoint.database = 'other'; }, next => { next.main.endpoint.port = 5433; },
    next => { next.main.endpoint.host = 'other-db'; }, next => { next.main.databaseContainer.mounts[0].name = 'changed-volume'; }]) {
    const old = metadata(), next = metadata(); mutate(next);
    assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
  }
});

test('unqualified endpoint metadata compares changes but never proves an API instance rename', () => {
  const old = metadata(), next = metadata();
  delete old.main.databaseContainer; delete next.main.databaseContainer;
  assert.equal(associationDecision(old, next, same, same).proven, false);
  assert.throws(() => associationDecision(old, next, same, renamed), /证明|绑定/);
  next.main.endpoint.host = 'different-postgres';
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('a public database hostname alone does not prove the same persisted database after an API rename', () => {
  const old = metadata(), next = metadata();
  for (const config of [old, next]) {
    delete config.main.databaseContainer; config.main.location = 'remote';
    config.main.endpoint.host = 'db.example.com';
  }
  assert.equal(associationDecision(old, next, same, same).proven, false);
  assert.throws(() => associationDecision(old, next, same, renamed), /证明|绑定/);
});

test('two original API containers with a shared-looking endpoint cannot be silently associated', () => {
  const old = metadata(), next = metadata();
  delete old.main.databaseContainer; delete next.main.databaseContainer;
  next.container = 'unrelated-new-api';
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('legacy sparse metadata can be enriched at the same URL but cannot authorize a rename', () => {
  const old = { version: 1, container: 'new-api', main: { type: 'postgresql' }, logs: { type: 'postgresql', sameAs: 'main' } };
  assert.equal(associationDecision(old, metadata(), same, same).rebind, false);
  assert.throws(() => associationDecision(old, metadata(), same, renamed), /证明|绑定/);
});

test('independent log databases receive the same persisted identity checks as the primary', () => {
  const old = metadata(), next = metadata();
  for (const config of [old, next]) config.logs = { ...structuredClone(config.main), endpoint: { ...config.main.endpoint, database: 'audit_logs' } };
  next.logs.endpoint.database = 'other_logs';
  assert.throws(() => associationDecision(old, next, same, same), /不同|证明|绑定/);
});

test('SQLite persistent file identity validates mount boundaries and includes the exact file offset', () => {
  const old = { version: 1, engineId: 'fixture-engine-id', container: 'api', main: { type: 'sqlite', containerPath: '/data/main.db', location: 'mounted', mount: { type: 'volume', name: 'site_sqlite', destination: '/data' } }, logs: { sameAs: 'main', type: 'sqlite' } };
  const next = structuredClone(old); next.container = 'renamed';
  assert.equal(associationDecision(old, next, same, renamed).proven, true);
  next.main.containerPath = '/database/main.db';
  assert.throws(() => associationDecision(old, next, same, renamed), /不同|证明|绑定/);
});

test('identically named persistent volumes on different Docker engines never prove the same instance', () => {
  for (const initial of [metadata(), { version: 1, engineId: 'fixture-engine-id', container: 'api',
    main: { type: 'sqlite', containerPath: '/data/one-api.db', location: 'mounted',
      mount: { type: 'volume', name: 'newapi_data', destination: '/data' } }, logs: { sameAs: 'main', type: 'sqlite' } }]) {
    const next = structuredClone(initial); next.engineId = 'different-engine-id';
    assert.throws(() => associationDecision(initial, next, same, renamed), /不同 Docker 引擎/);
    const migrated = associationDecision(initial, next, same, same);
    assert.equal(migrated.rebind, false);
    assert.equal(migrated.proven, false);
    if (next.main.type === 'sqlite') next.main.containerPath = '/data/different.db';
    else next.main.endpoint.database = 'different';
    assert.throws(() => associationDecision(initial, next, same, same), /不同.*库|绑定/);
  }
});

test('legacy metadata without an engine identity can be enriched only at its existing API origin', () => {
  for (const missing of ['previous', 'next', 'both']) {
    const old = metadata(), next = metadata();
    if (missing !== 'next') delete old.engineId;
    if (missing !== 'previous') delete next.engineId;
    const result = associationDecision(old, next, same, same);
    assert.equal(result.rebind, false);
    assert.equal(result.proven, false);
    assert.throws(() => associationDecision(old, next, same, renamed), /缺少.*Docker 引擎身份/);
  }
});

test('matching Docker engine and persistent database identity permit an API origin rename', () => {
  const old = metadata(), next = metadata(); next.container = 'renamed-api';
  const result = associationDecision(old, next, same, renamed);
  assert.equal(result.proven, true);
  assert.equal(result.rebind, true);
});
