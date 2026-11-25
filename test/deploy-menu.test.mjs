import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bash, bashAvailable, root, toShell } from './deploy-fixture.mjs';

function select(input = '', args = []) {
  const environment = { ...process.env, YUNXIANG_INPUT_FD: '0' };
  delete environment.YUNXIANG_DEPLOY_MODE;
  return spawnSync(bash, ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'shift',
    'yx_parse_args "$@"',
    'yx_select_mode',
    'printf "\\nMODE=%s\\n" "$yx_mode"'
  ].join('\n'), '--', toShell(join(root, 'deploy-runtime.sh')), ...args], {
    cwd: root, env: environment, input, encoding: 'utf8', timeout: 10000
  });
}

for (const [choice, mode] of [['1', 'install'], ['2', 'migrate'], ['3', 'reinstall'], ['4', 'uninstall'], ['5', 'refresh'], ['6', 'update'], ['', 'install']]) {
  test(`deployment menu ${choice || 'default'} selects ${mode}`, { skip: !bashAvailable }, () => {
    const result = select(choice + '\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), 'MODE=' + mode);
    assert.match(result.stderr, /1\. 安装（默认）/);
    assert.match(result.stderr, /6\. 更新：/);
    assert.doesNotMatch(result.stderr, /安装\s*\/\s*更新/);
  });
}

test('deployment menu exit and invalid input never select a deployment mode', { skip: !bashAvailable }, () => {
  for (const [choice, expected] of [['0', 0], ['7', 1]]) {
    const result = select(choice + '\n');
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /MODE=/);
  }
});

for (const [args, mode] of [[['--install'], 'install'], [['--update'], 'update'], [['--non-interactive'], 'update']]) {
  test(`deployment arguments ${args.join(' ')} keep ${mode} without reading the menu`, { skip: !bashAvailable }, () => {
    const result = select('', args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), 'MODE=' + mode);
    assert.doesNotMatch(result.stderr, /选择操作/);
  });
}
