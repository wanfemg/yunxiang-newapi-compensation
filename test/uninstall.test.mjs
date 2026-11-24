import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const available = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const toShell = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : value;
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yunxiang-uninstall-'));
  const target = join(dir, 'yunxiang');
  const state = join(dir, 'docker-state');
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(target, 'package.json'), '{"name":"newapi-empty-compensation"}\n');
  writeFileSync(join(target, 'src/server.mjs'), '// fixture\n');
  writeFileSync(join(target, 'install.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(target, '.env.auto'), 'PUBLIC_ORIGIN=https://refund.example.com\n');
  writeFileSync(join(target, 'compose.generated.json'), '{"name":"newapi-compensation","services":{"compensation":{}}}\n');
  writeFileSync(join(target, 'docker.log'), 'must be deleted with installation\n');
  writeFileSync(join(state, 'docker.log'), '');
  for (const name of ['container', 'volume', 'image', 'newapi']) writeFileSync(join(state, name), name);
  t.after(() => {
    const child = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(!isAbsolute(child) && !child.startsWith('..') && child.startsWith('yunxiang-uninstall-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, target, state };
}
function run(fixture, extra = {}, args = ['--yes'], input) {
  return spawnSync(bash, [toShell(join(root, 'test/uninstall-harness.sh')), ...args], {
    cwd: fixture.dir,
    encoding: 'utf8',
    timeout: 10000,
    input,
    env: {
      ...process.env,
      MOCK_STATE: toShell(fixture.state),
      YUNXIANG_INSTALL_DIR: toShell(fixture.target),
      YUNXIANG_UNINSTALL_SCRIPT: toShell(join(root, 'uninstall.sh')),
      ...extra
    }
  });
}

test('uninstall stops before deleting files when Docker daemon is unavailable', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, { MOCK_DAEMON_DOWN: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.target, '.env.auto')), 'failed uninstall must keep configuration');
  assert.doesNotMatch(result.stdout, /云响已彻底卸载/);
});

test('uninstall removes only Yunxiang resources and all installation files', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['container', 'volume', 'image']) assert.ok(!existsSync(join(fixture.state, name)), name);
  assert.ok(existsSync(join(fixture.state, 'newapi')), 'upstream container must survive');
  assert.ok(!existsSync(fixture.target), 'installation directory including docker.log must be deleted');
  const calls = readFileSync(join(fixture.state, 'docker.log'), 'utf8');
  assert.match(calls, /label=com\.docker\.compose\.service=compensation/);
  assert.doesNotMatch(calls, /compose .*down|network rm|prune|fixture-newapi/);
});

test('failed resource removal preserves the installation directory', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, { MOCK_VOLUME_REMOVE_FAIL: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
  assert.ok(existsSync(join(fixture.state, 'newapi')));
  assert.doesNotMatch(result.stdout, /云响已彻底卸载/);
});

test('image remaining after removal prevents a false uninstall success', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, { MOCK_IMAGE_REMAINS: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
  assert.doesNotMatch(result.stdout, /云响已彻底卸载/);
});

test('same container name with an unrelated image is never removed', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, { MOCK_NAME_COLLISION: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.state, 'container')));
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
});

test('uninstall rejects dangerous paths after normalization', { skip: !available }, t => {
  const fixture = setup(t);
  for (const target of ['/', '/opt', '/opt/', '/tmp/../opt', '/home//']) {
    const result = run(fixture, { YUNXIANG_INSTALL_DIR: target });
    assert.notEqual(result.status, 0, target + '\n' + result.stdout + result.stderr);
    const calls = readFileSync(join(fixture.state, 'docker.log'), 'utf8');
    assert.doesNotMatch(calls, /rm -f|volume rm|image rm|rmi /);
  }
});

test('uninstall accepts explicit confirmation from an input descriptor', { skip: !available }, t => {
  const fixture = setup(t);
  const declined = run(fixture, { YUNXIANG_INPUT_FD: '0' }, [], 'no\n');
  assert.notEqual(declined.status, 0);
  assert.ok(existsSync(fixture.target));
  const confirmed = run(fixture, { YUNXIANG_INPUT_FD: '0' }, [], '彻底卸载\n');
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  assert.ok(!existsSync(fixture.target));
});

test('non-interactive uninstall requires explicit --yes', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, {}, ['--non-interactive']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(fixture.target));
});

test('uninstall refuses to compete with a running deployment', { skip: !available }, t => {
  const fixture = setup(t);
  const result = run(fixture, { MOCK_LOCK_BUSY: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
});

test('uninstall works from inside the installation and does not keep a log exception', { skip: !available }, t => {
  const fixture = setup(t);
  cpSync(join(root, 'uninstall.sh'), join(fixture.target, 'uninstall.sh'));
  const result = run(fixture, { MOCK_START_IN_TARGET: '1', YUNXIANG_UNINSTALL_SCRIPT: toShell(join(fixture.target, 'uninstall.sh')) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!existsSync(fixture.target));
});

test('uninstall is idempotent when its installation and resources are already gone', { skip: !available }, t => {
  const fixture = setup(t);
  const first = run(fixture);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const again = run(fixture);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(existsSync(join(fixture.state, 'newapi')));
});

test('a generic install script does not identify an unrelated directory as Yunxiang', { skip: !available }, t => {
  const fixture = setup(t);
  const other = join(fixture.dir, 'other-project');
  mkdirSync(other);
  writeFileSync(join(other, 'install.sh'), '#!/usr/bin/env bash\n');
  const result = run(fixture, { YUNXIANG_INSTALL_DIR: toShell(other) });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(other, 'install.sh')));
  assert.ok(existsSync(join(fixture.state, 'container')));
});

test('uninstall rejects a symlink or junction instead of deleting its destination', { skip: !available }, t => {
  const fixture = setup(t);
  const link = join(fixture.dir, 'installation-link');
  symlinkSync(fixture.target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(fixture, { YUNXIANG_INSTALL_DIR: toShell(link) });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
  assert.ok(existsSync(join(fixture.state, 'container')));
});

test('uninstall removes the verified legacy Yunxiang tag without forcing a shared image', { skip: !available }, t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.state, 'legacy-image'), 'legacy Yunxiang tag');
  writeFileSync(join(fixture.state, 'shared-image-id'), 'other retained image tag');
  const result = run(fixture);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!existsSync(join(fixture.state, 'legacy-image')), 'legacy tag must be removed');
  assert.ok(existsSync(join(fixture.state, 'shared-image-id')), 'other tags sharing an image ID must survive');
  const calls = readFileSync(join(fixture.state, 'docker.log'), 'utf8');
  assert.match(calls, /image rm newapi-compensation:local/);
  assert.match(calls, /run .*--network none .*--entrypoint node newapi-compensation:local/);
  assert.doesNotMatch(calls, /image rm .*--force|image rm .*-f|prune/);
});

test('an unverified legacy image tag aborts uninstall before deleting existing resources', { skip: !available }, t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.state, 'legacy-image'), 'unrelated contents');
  const result = run(fixture, { MOCK_LEGACY_NOT_YUNXIANG: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  for (const name of ['legacy-image', 'container', 'volume', 'image']) assert.ok(existsSync(join(fixture.state, name)), name);
  assert.ok(existsSync(join(fixture.target, '.env.auto')));
});
