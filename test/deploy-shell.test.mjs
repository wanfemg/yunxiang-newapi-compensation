import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployFixture, bashAvailable } from './deploy-fixture.mjs';

const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const output = result => result.stdout + result.stderr;
const initialized = fixture => ok(fixture.run());
const callsWith = (fixture, verb) => fixture.calls().filter(call => call[0] === 'compose' && call.includes(verb));
const ledger = fixture => join(fixture.volume, 'compensation.sqlite');

describe('deployment shell workflows', { concurrency: 4 }, () => {
test('fresh installation creates its own volume and persists a completed deployment', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    assert.equal(existsSync(f.volume), false);
    const result = f.run(); ok(result);
    assert.equal(existsSync(ledger(f)), true);
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /ready/);
    assert.doesNotMatch(output(result), /fixture-deploy-token/);
    assert.equal(readFileSync(join(f.directory, 'secrets/newapi_admin_token'), 'utf8'), 'fixture-deploy-token');
    const compose = JSON.parse(readFileSync(join(f.directory, 'docker-compose.yml'), 'utf8'));
    assert.equal(compose.name, 'newapi-compensation');
    assert.equal(compose.services.compensation.container_name, 'yunxiang-compensation');
    assert.equal(compose.volumes.compensation_data.name, 'newapi-compensation_compensation_data');
    assert.equal(compose.services.compensation.environment.PUBLIC_ORIGIN, 'https://refund.example.com');
  } finally { f.clean(); }
});

test('update preserves the ledger and saved upstream configuration', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f);
    const env = readFileSync(join(f.directory, '.env.auto'), 'utf8');
    const before = readFileSync(ledger(f));
    ok(f.run('install.sh', ['--update', '--non-interactive'], { NEWAPI_URL: 'https://wrong.example.com', PUBLIC_ORIGIN: 'https://wrong.example.com' }));
    assert.equal(readFileSync(join(f.directory, '.env.auto'), 'utf8'), env);
    assert.deepEqual(readFileSync(ledger(f)), before);
    const compose = JSON.parse(readFileSync(join(f.directory, 'docker-compose.yml'), 'utf8'));
    assert.equal(compose.services.compensation.environment.NEWAPI_URL, 'https://newapi.example.com');
    assert.equal(compose.services.compensation.environment.PUBLIC_ORIGIN, 'https://refund.example.com');
  } finally { f.clean(); }
});

test('first build failure can resume without being mistaken for lost migration data', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const failed = f.run('auto-deploy.sh', ['--non-interactive'], { MOCK_BUILD_FAIL: '1' });
    assert.equal(failed.status, 42, output(failed));
    assert.doesNotMatch(output(failed), /云响已启动/);
    assert.equal(existsSync(f.volume), false, 'build failure must occur before volume creation');
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /pending/);
    const retry = f.run(); ok(retry);
    assert.equal(existsSync(ledger(f)), true);
    assert.doesNotMatch(output(retry), /不会新建空账本/);
  } finally { f.clean(); }
});

test('a credential validation failure resumes initial configuration without publishing a partial deployment', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const failed = f.run('auto-deploy.sh', ['--non-interactive'], { NEWAPI_ADMIN_TOKEN: '' });
    assert.notEqual(failed.status, 0, output(failed));
    assert.equal(existsSync(join(f.directory, '.env.auto')), false);
    assert.equal(existsSync(f.volume), false);
    const retry = f.run(); ok(retry);
    assert.equal(existsSync(ledger(f)), true);
    assert.equal(readFileSync(join(f.directory, 'secrets/newapi_admin_token'), 'utf8'), 'fixture-deploy-token');
  } finally { f.clean(); }
});

test('a completed deployment with a missing ledger fails before building or creating an empty volume', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); rmSync(f.volume, { recursive: true }); rmSync(join(f.state, 'container'), { force: true }); f.clearCalls();
    const result = f.run();
    assert.notEqual(result.status, 0, output(result));
    assert.doesNotMatch(output(result), /云响已启动/);
    assert.equal(existsSync(f.volume), false);
    assert.equal(callsWith(f, 'build').length, 0);
    assert.equal(callsWith(f, 'up').length, 0);
  } finally { f.clean(); }
});

test('legacy failed installation requires explicit fresh-install confirmation before creating an empty ledger', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); rmSync(join(f.directory, '.yunxiang-deploy-state')); rmSync(f.volume, { recursive: true }); rmSync(join(f.state, 'container'), { force: true });
    const blocked = f.run(); assert.notEqual(blocked.status, 0, output(blocked));
    assert.equal(existsSync(f.volume), false);
    ok(f.run('install.sh', ['--install', '--non-interactive']));
    assert.equal(existsSync(ledger(f)), true);
  } finally { f.clean(); }
});

test('bare domain input is normalized and invalid interactive input can be corrected', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const result = f.run('auto-deploy.sh', ['--install'], { PUBLIC_ORIGIN: '' }, { interactive: true, input: 'bad\n3210\nbad/path\nyx.yzmao.cn\n' });
    ok(result);
    assert.match(readFileSync(join(f.directory, '.env.auto'), 'utf8'), /^PUBLIC_ORIGIN=https:\/\/yx\.yzmao\.cn$/m);
  } finally { f.clean(); }
});

test('Docker Compose discovery connects to the existing upstream bridge without modifying it', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const result = f.run('auto-deploy.sh', ['--non-interactive'], { NEWAPI_URL: '', MOCK_DISCOVER_NEWAPI: '1' }); ok(result);
    const env = readFileSync(join(f.directory, '.env.auto'), 'utf8');
    assert.match(env, /NEWAPI_URL=http:\/\/newapi-main:3000/);
    const compose = JSON.parse(readFileSync(join(f.directory, 'docker-compose.yml'), 'utf8'));
    assert.equal(compose.services.compensation.network_mode, 'baota_net');
    assert.equal(f.calls().some(call => call[0] === 'network' && call[1] !== 'inspect'), false);
  } finally { f.clean(); }
});

for (const args of [['--uninstall', '--yes'], ['--mode', 'uninstall', '--yes']]) {
  test(`install entry dispatches ${args.join(' ')} to uninstall`, { skip: !bashAvailable }, () => {
    const f = deployFixture();
    try {
      initialized(f); f.clearCalls();
      const result = f.run('install.sh', args); ok(result);
      assert.match(output(result), /云响已彻底卸载/);
      assert.equal(existsSync(f.directory), false);
      assert.equal(existsSync(f.volume), false);
      assert.equal(existsSync(join(f.state, 'container')), false);
      assert.equal(existsSync(join(f.state, 'image')), false);
      assert.equal(callsWith(f, 'up').length, 0);
    } finally { f.clean(); }
  });
}

test('command-line mode overrides the environment and selects migration once', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); f.clearCalls();
    const result = f.run('install.sh', ['--mode', 'migrate', '--non-interactive'], { YUNXIANG_DEPLOY_MODE: 'uninstall' }); ok(result);
    assert.match(output(result), /migrate|迁移/);
    assert.equal(existsSync(f.directory), true);
    assert.equal(callsWith(f, 'up').length, 1);
    assert.doesNotMatch(output(result), /选择操作|云响已彻底卸载/);
  } finally { f.clean(); }
});

test('remote menu appears once before the release archive is downloaded', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f);
    const remote = f.remote();
    const before = readFileSync(ledger(f));
    const result = f.run('install.sh', [], remote.env, { script: remote.script, interactive: true, input: '6\n' }); ok(result);
    const text = output(result);
    const menu = text.indexOf('选择操作 [');
    const download = text.indexOf('下载云响');
    assert.ok(menu >= 0 && download > menu, text);
    assert.equal((text.match(/^选择操作 \[/gm) || []).length, 1, text);
    assert.match(text, /部署模式：update/);
    assert.deepEqual(readFileSync(ledger(f)), before);
  } finally { f.clean(); }
});
test('a fresh remote bootstrap completes the menu and configuration without a pre-existing ledger', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const remote = f.remote();
    const result = f.run('install.sh', [], { ...remote.env, PUBLIC_ORIGIN: '' }, { script: remote.script, interactive: true, input: '1\n3210\nyx.yzmao.cn\n' }); ok(result);
    assert.equal(existsSync(ledger(f)), true);
    assert.match(output(result), /部署模式：install/);
    assert.match(readFileSync(join(f.directory, '.env.auto'), 'utf8'), /PUBLIC_ORIGIN=https:\/\/yx\.yzmao\.cn/);
    assert.equal((output(result).match(/^选择操作 \[/gm) || []).length, 1);
  } finally { f.clean(); }
});

test('piped bootstrap uses a separate input descriptor for the menu and confirmation', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f);
    const remote = f.remote();
    const result = f.run('install.sh', [], remote.env, { script: remote.script, interactive: true, input: '4\n彻底卸载\n', pipeScript: true }); ok(result);
    assert.match(output(result), /云响已彻底卸载/);
    assert.equal(existsSync(f.directory), false);
    const downloads = readFileSync(join(f.state, 'downloads.log'), 'utf8');
    assert.doesNotMatch(downloads, /api\.github\.com/);
  } finally { f.clean(); }
});

test('non-interactive uninstall still requires explicit destructive confirmation', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); f.clearCalls();
    const result = f.run('install.sh', ['--uninstall', '--non-interactive']);
    assert.notEqual(result.status, 0, output(result));
    assert.equal(existsSync(ledger(f)), true);
    assert.equal(f.calls().some(call => ['rm', 'rmi'].includes(call[0]) || call[0] === 'volume' && call[1] === 'rm'), false);
  } finally { f.clean(); }
});

test('reinstall builds successfully before removing the previous service and preserves the ledger', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); const before = readFileSync(ledger(f)); f.clearCalls();
    const failed = f.run('install.sh', ['--reinstall', '--non-interactive'], { MOCK_BUILD_FAIL: '1' });
    assert.equal(failed.status, 42, output(failed));
    assert.equal(existsSync(join(f.state, 'container')), true);
    assert.deepEqual(readFileSync(ledger(f)), before);
    ok(f.run('install.sh', ['--reinstall', '--non-interactive']));
    assert.deepEqual(readFileSync(ledger(f)), before);
    assert.equal(f.calls().some(call => call.includes('--volumes')), false);
  } finally { f.clean(); }
});

test('preflight failure leaves a started deployment and never reports successful completion', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const failed = f.run('auto-deploy.sh', ['--non-interactive'], { MOCK_PREFLIGHT_FAIL: '1' });
    assert.notEqual(failed.status, 0, output(failed));
    assert.doesNotMatch(output(failed), /云响已启动/);
    assert.equal(existsSync(ledger(f)), true);
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /started/);
    ok(f.run());
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /ready/);
  } finally { f.clean(); }
});

test('a startup failure before SQLite creation remains retryable and keeps an empty volume separate from a lost ledger', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    const failed = f.run('auto-deploy.sh', ['--non-interactive'], { MOCK_UP_FAIL: '1' });
    assert.notEqual(failed.status, 0, output(failed));
    assert.equal(existsSync(f.volume), true, 'permission helper prepared an empty volume');
    assert.equal(existsSync(ledger(f)), false);
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /pending/);
    const retry = f.run(); ok(retry);
    assert.equal(existsSync(ledger(f)), true);
    assert.match(readFileSync(join(f.directory, '.yunxiang-deploy-state'), 'utf8'), /ready/);
  } finally { f.clean(); }
});

test('invalid modes and unavailable Docker fail without downloads or generated deployment files', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    assert.notEqual(f.run('install.sh', ['--mode', 'wrong']).status, 0);
    assert.equal(existsSync(join(f.directory, '.env.auto')), false);
    assert.equal(existsSync(join(f.state, 'downloads.log')), false);
    const failed = f.run('auto-deploy.sh', ['--non-interactive'], { MOCK_DOCKER_UNAVAILABLE: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(join(f.directory, '.env.auto')), false);
  } finally { f.clean(); }
});
test('explicit fresh installation never replaces a lost ledger from a completed deployment', { skip: !bashAvailable }, () => {
  const f = deployFixture();
  try {
    initialized(f); rmSync(f.volume, { recursive: true }); rmSync(join(f.state, 'container'), { force: true }); f.clearCalls();
    const result = f.run('install.sh', ['--install', '--non-interactive']);
    assert.notEqual(result.status, 0, output(result));
    assert.equal(existsSync(f.volume), false);
    assert.equal(callsWith(f, 'build').length, 0);
    assert.equal(callsWith(f, 'up').length, 0);
  } finally { f.clean(); }
});
});
