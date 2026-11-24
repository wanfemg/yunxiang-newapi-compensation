import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bash, bashAvailable, toShell } from './deploy-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const dockerStub = `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const directory = process.env.LEGACY_FIXTURE_DIR;
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') {
  process.stdout.write(fs.readFileSync(path.join(directory, 'inspect.json')));
} else if (args[0] === 'run') {
  const sandbox = path.join(directory, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  const native = value => process.platform === 'win32' ? value.replace(/^\\/([A-Za-z])\\//, (_, letter) => letter.toUpperCase() + ':/') : value;
  const mounts = [];
  for (let i = 1; i < args.length; i++) if (args[i] === '--mount') {
    const spec = Object.fromEntries(args[++i].split(',').map(part => { const at = part.indexOf('='); return at < 0 ? [part, true] : [part.slice(0, at), part.slice(at + 1)]; }));
    if (spec.type !== 'bind' || !spec.readonly) throw Error('discovery must use read-only source mounts');
    const source = native(spec.src), destination = path.join(sandbox, '.' + spec.dst);
    if (!path.resolve(source).startsWith(path.resolve(directory, 'src') + path.sep) && path.resolve(source) !== path.resolve(directory, 'src')) throw Error('unexpected data or credential mount');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    mounts.push(spec);
  }
  const imageIndex = args.indexOf('node:24-bookworm-slim');
  if (imageIndex < 0 || args[imageIndex + 1] !== 'node') throw Error('unexpected discovery helper');
  const cwdIndex = args.indexOf('-w');
  const cwd = cwdIndex < 0 ? sandbox : path.join(sandbox, '.' + args[cwdIndex + 1]);
  const script = args[imageIndex + 2];
  const target = script.startsWith('/') ? path.join(sandbox, '.' + script) : path.resolve(cwd, script);
  const result = spawnSync(process.execPath, [target], { cwd, encoding: 'utf8', input: fs.readFileSync(0) });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
} else if (!['compose', 'info', 'ps'].includes(args[0])) throw Error('unexpected Docker command');
`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yunxiang-legacy-db-'));
  cpSync(join(root, 'deploy.sh'), join(directory, 'deploy.sh'));
  cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true });
  mkdirSync(join(directory, 'secrets'));
  writeFileSync(join(directory, '.env.docker'), 'NEWAPI_URL=http://new-api:3000\n');
  writeFileSync(join(directory, 'secrets', 'newapi_admin_token'), 'fixture-legacy-token');
  writeFileSync(join(directory, 'inspect.json'), JSON.stringify({ Name: '/new-api', Config: { WorkingDir: '/data',
    Env: ['SQL_DSN=operator:fixture-raw-db-password@tcp(mysql:3306)/newapi', 'LOG_SQL_DSN=postgres://reader:fixture-raw-log-password@postgres/logs'] } }));
  writeFileSync(join(directory, 'docker.cjs'), dockerStub);
  writeFileSync(join(directory, 'harness.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ndocker(){ "$LEGACY_NODE_EXE" "$LEGACY_DOCKER_STUB" "$@"; }\nexport -f docker\nexec bash "$LEGACY_ENTRY"\n');
  return { directory, run: () => spawnSync(bash, [toShell(join(directory, 'harness.sh'))], { cwd: directory,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', REFRESH_NEWAPI_DB: '1', LEGACY_FIXTURE_DIR: directory,
      LEGACY_NODE_EXE: process.execPath.replaceAll('\\', '/'), LEGACY_DOCKER_STUB: join(directory, 'docker.cjs').replaceAll('\\', '/'),
      LEGACY_ENTRY: toShell(join(directory, 'deploy.sh')) }, encoding: 'utf8', input: 'new-api\n', timeout: 20000 }),
    clean: () => rmSync(directory, { recursive: true, force: true }) };
}

test('legacy deployment provides discovery parser imports without exposing database credentials or mounting data', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const metadataText = readFileSync(join(f.directory, 'secrets', 'newapi_database.json'), 'utf8');
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.main.type, 'mysql');
    assert.equal(metadata.main.endpoint.database, 'newapi');
    assert.equal(metadata.logs.type, 'postgresql');
    assert.equal(metadata.logs.endpoint.database, 'logs');
    assert.equal(metadata.quotaWriteMode, 'newapi-api');
    assert.doesNotMatch(metadataText + result.stdout + result.stderr, /fixture-raw-db-password|fixture-raw-log-password|operator:|reader:|"dsn"/);
    const calls = readFileSync(join(f.directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const run = calls.find(args => args[0] === 'run');
    assert.ok(run.includes('--read-only'));
    assert.equal(run[run.indexOf('--network') + 1], 'none');
    assert.equal(run.filter(argument => argument === '--mount').length, 1);
  } finally { f.clean(); }
});

test('legacy discovery helper failure retains the original sanitized database secret', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const previous = '{"version":1,"retained":true}\n';
    writeFileSync(join(f.directory, 'secrets', 'newapi_database.json'), previous);
    rmSync(join(f.directory, 'src', 'db-endpoint.mjs'));
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.directory, 'secrets', 'newapi_database.json'), 'utf8'), previous);
    assert.match(result.stdout + result.stderr, /未替换原配置/);
    assert.equal(existsSync(join(f.directory, '.env.auto')), false);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-raw-db-password|fixture-raw-log-password/);
  } finally { f.clean(); }
});
