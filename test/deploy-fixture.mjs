import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const root = resolve(import.meta.dirname, '..');
export const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
export const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
export const toShell = value => String(value).replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`);

export function deployFixture() {
  const base = mkdtempSync(join(tmpdir(), 'yunxiang-shell-'));
  const directory = join(base, 'yunxiang');
  const state = join(base, 'docker');
  mkdirSync(directory);
  mkdirSync(state);
  for (const name of readdirSync(root).filter(name => name.endsWith('.sh'))) cpSync(join(root, name), join(directory, name));
  for (const name of ['src', 'public', 'test', 'Dockerfile', '.dockerignore', '.gitattributes', 'package.json', 'package-lock.json', 'README.md']) {
    cpSync(join(root, name), join(directory, name), { recursive: true });
  }
  mkdirSync(join(directory, 'docs')); cpSync(join(root, 'docs', 'one-click.md'), join(directory, 'docs', 'one-click.md'));
  const environment = {
    ...process.env,
    NODE_EXE: process.execPath.replaceAll('\\', '/'),
    YUNXIANG_DOCKER_CLI: join(root, 'test', 'deploy-fixture-docker.mjs').replaceAll('\\', '/'),
    YUNXIANG_DOCKER_STATE: state,
    YUNXIANG_FIXTURE_SOURCE: toShell(root),
    YUNXIANG_INSTALL_DIR: toShell(directory),
    NEWAPI_URL: 'https://newapi.example.com',
    NEWAPI_ADMIN_USER_ID: '1',
    NEWAPI_ADMIN_TOKEN: 'fixture-deploy-token',
    PUBLIC_ORIGIN: 'https://refund.example.com',
    COMPENSATION_PORT: '3210',
    MSYS_NO_PATHCONV: '1'
  };
  for (const key of ['YUNXIANG_DEPLOY_MODE', 'YUNXIANG_INPUT_FD', 'YUNXIANG_TEST_PROMPTS', 'MOCK_DOCKER_LOG', 'MOCK_VOLUME_MISSING', 'MOCK_BUILD_FAIL']) delete environment[key];
  const volume = join(state, 'volumes', 'newapi-compensation_compensation_data');
  function run(entry = 'auto-deploy.sh', args = ['--non-interactive'], extra = {}, options = {}) {
    if (extra.MOCK_VOLUME_MISSING === '1') rmSync(volume, { recursive: true, force: true });
    const answer = join(base, 'answers');
    writeFileSync(answer, options.input ?? '');
    const env = { ...environment, ...extra, YUNXIANG_TEST_ENTRY: toShell(options.script || join(directory, entry)), YUNXIANG_ANSWER: toShell(answer), YUNXIANG_TEST_WORKDIR: toShell(options.cwd || directory) };
    delete env.MOCK_VOLUME_MISSING;
    if (options.interactive) env.YUNXIANG_INPUT_FD = '3';
    if (options.pipeScript) env.YUNXIANG_TEST_PIPE = '1';
    const result = spawnSync(bash, [toShell(join(root, 'test', 'deploy-harness.sh')), ...args], {
      cwd: base, env, encoding: 'utf8', timeout: 45000, input: options.stdin
    });
    const token = env.NEWAPI_ADMIN_TOKEN;
    if (token && (result.stdout + result.stderr).includes(token)) throw new Error('deployment output exposed the fixture management token');
    return result;
  }
  function remote() {
    const archive = join(base, 'release.tar.gz');
    const packed = spawnSync(bash, ['-c', 'tar -czf "$1" -C "$2" yunxiang', '--', toShell(archive), toShell(base)], { encoding: 'utf8' });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const bootstrap = join(base, 'bootstrap');
    mkdirSync(bootstrap, { recursive: true });
    cpSync(join(root, 'install.sh'), join(bootstrap, 'install.sh'));
    return { script: join(bootstrap, 'install.sh'), env: { ARCHIVE: toShell(archive) } };
  }
  return {
    base, directory, state, volume, environment, run, remote,
    calls: () => existsSync(join(state, 'calls.jsonl')) ? readFileSync(join(state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    clearCalls: () => writeFileSync(join(state, 'calls.jsonl'), ''),
    clean: () => rmSync(base, { recursive: true, force: true })
  };
}
