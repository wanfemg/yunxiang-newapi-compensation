import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const state = process.env.YUNXIANG_DOCKER_STATE;
if (!state) throw new Error('fixture state required');
fs.mkdirSync(state, { recursive: true });
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');
const shellPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`);
const nativePath = value => process.platform === 'win32'
  ? value.replace(/^\/([A-Za-z])\//, (_, letter) => `${letter.toUpperCase()}:/`).replace(/^\/tmp\//, process.env.TEMP.replaceAll('\\', '/') + '/')
  : value;
const named = name => path.join(state, 'volumes', name);
const fixedVolume = named('newapi-compensation_compensation_data');
const imagePath = path.join(state, 'image');
const containerPath = path.join(state, 'container');
const stoppedPath = path.join(state, 'stopped');
const fixedMountedPath = path.join(state, 'fixed-mounted');
const exists = file => fs.existsSync(file);
function abort(message, code = 1) { if (message) console.error(message); process.exit(code); }
function upstream() {
  return { Id: 'newapi-fixture', Name: '/newapi-main', State: { Running: true }, Config: { Image: 'newapi:latest', Env: ['PORT=3000'], Labels: { 'com.docker.compose.project': 'newapi' } }, HostConfig: { NetworkMode: 'baota_net' }, NetworkSettings: { Networks: { baota_net: {} } } };
}
function own() {
  const oldBind = process.env.MOCK_OLD_BIND_DATA && !exists(fixedMountedPath);
  return { Id: 'yunxiang-fixture', Name: '/yunxiang-compensation', State: { Running: !exists(stoppedPath) }, Config: { Image: 'yunxiang-newapi-compensation:local', Labels: { 'com.docker.compose.project': 'newapi-compensation', 'com.docker.compose.service': 'compensation' } }, Mounts: [{ Type: oldBind ? 'bind' : 'volume', Name: oldBind ? undefined : 'newapi-compensation_compensation_data', Source: oldBind ? process.env.MOCK_OLD_BIND_DATA : fixedVolume, Destination: '/app/data' }] };
}
function parseCompose() {
  const index = args.indexOf('-f');
  const file = index < 0 ? 'docker-compose.yml' : args[index + 1];
  const compose = JSON.parse(fs.readFileSync(nativePath(file), 'utf8'));
  const env = { ...process.env };
  const envIndex = args.indexOf('--env-file');
  if (envIndex >= 0) for (const line of fs.readFileSync(nativePath(args[envIndex + 1]), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/); if (match && env[match[1]] === undefined) env[match[1]] = match[2];
  }
  const expand = value => typeof value === 'string' ? value.replace(/\$\{([A-Z_]+)(?::-([^}]*))?\}/g, (_, key, fallback = '') => env[key] || fallback)
    : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)])) : value;
  const output = expand(compose);
  const service = output.services.compensation;
  service.build.context = process.cwd();
  for (const secret of Object.values(output.secrets || {})) secret.file = path.resolve(nativePath(secret.file));
  return output;
}
switch (args[0]) {
  case 'info': if (process.env.MOCK_DOCKER_UNAVAILABLE === '1') abort('fixture daemon unavailable'); break;
  case 'context': console.log('default'); break;
  case 'volume': {
    if (args[1] === 'ls') {
      if (exists(fixedVolume)) console.log('newapi-compensation_compensation_data');
      break;
    }
    const name = args.find((value, index) => index > 1 && !value.startsWith('-') && !['{{.Mountpoint}}', '{{.Name}}'].includes(value)) || '';
    if (args[1] === 'inspect') {
      if (!exists(named(name))) abort('');
      if (args.includes('--format')) console.log(args.includes('{{.Name}}') ? name : named(name)); else console.log(JSON.stringify([{ Name: name, Mountpoint: named(name) }]));
    } else if (args[1] === 'create') { fs.mkdirSync(named(name), { recursive: true }); console.log(name); }
    else if (args[1] === 'rm') { fs.rmSync(named(name), { recursive: true, force: true }); console.log(name); }
    else abort('unsupported volume operation');
    break;
  }
  case 'image':
    if (args[1] === 'inspect') { if (!exists(imagePath)) abort(''); console.log('fixture image exists'); }
    else if (args[1] === 'ls') {
      const reference = args.find(value => value.startsWith('reference='));
      if (exists(imagePath) && (!reference || reference === 'reference=yunxiang-newapi-compensation:local')) console.log('yunxiang-newapi-compensation:local');
    }
    else if (args[1] === 'rm') fs.rmSync(imagePath, { force: true });
    else abort('unsupported image operation');
    break;
  case 'rmi': fs.rmSync(imagePath, { force: true }); break;
  case 'ps': {
    const filters = args.flatMap((value, index) => value === '--filter' ? [args[index + 1]] : []);
    const lookingOwn = filters.some(value => value.includes('yunxiang-compensation') || value.includes('newapi-compensation'));
    const includeStopped = args.includes('-a') || args.includes('--all') || args.includes('-aq');
    if (lookingOwn) { if (exists(containerPath) && (includeStopped || !exists(stoppedPath))) console.log(args.includes('--format') ? 'yunxiang-compensation' : 'yunxiang-fixture'); }
    else if (args.includes('--format')) { if (exists(containerPath)) console.log('yunxiang-compensation'); }
    else if (process.env.MOCK_DISCOVER_NEWAPI === '1') console.log('newapi-fixture');
    break;
  }
  case 'inspect': {
    const lookingOwn = args.includes('yunxiang-compensation') || args.includes('yunxiang-fixture');
    if (lookingOwn && !exists(containerPath)) abort('');
    if (!lookingOwn && !args.some(value => ['newapi-fixture', 'newapi-main'].includes(value))) abort('');
    const entry = lookingOwn ? own() : upstream();
    const formatIndex = args.indexOf('--format');
    if (formatIndex < 0) console.log(JSON.stringify([entry]));
    else {
      const format = args[formatIndex + 1];
      if (format.includes('|')) console.log(`${entry.Name}|${entry.Config.Labels['com.docker.compose.project'] || ''}|${entry.Config.Labels['com.docker.compose.service'] || ''}|${entry.Config.Image}`);
      else if (format === '{{.State.Running}}') console.log(entry.State.Running);
      else if (format === '{{.Name}}') console.log(entry.Name);
      else if (format.includes('Mounts')) console.log(JSON.stringify(entry.Mounts || []));
      else if (format.includes('Labels')) console.log(JSON.stringify(entry.Config.Labels));
      else if (format.includes('Config.Image')) console.log(entry.Config.Image);
      else console.log(JSON.stringify(entry));
    }
    break;
  }
  case 'rm': if (process.env.MOCK_REMOVE_FAIL === '1') abort('fixture remove failed'); fs.rmSync(containerPath, { force: true }); break;
  case 'stop': if (!exists(containerPath)) abort('fixture container missing'); fs.writeFileSync(stoppedPath, '1'); break;
  case 'start': if (!exists(containerPath)) abort('fixture container missing'); fs.rmSync(stoppedPath, { force: true }); break;
  case 'network':
    if (args[1] !== 'inspect') abort('deployment must not mutate upstream networks');
    if (process.env.MOCK_NETWORK_MISSING && args.includes(process.env.MOCK_NETWORK_MISSING)) abort('');
    console.log(args.includes('--format') ? 'bridge' : '[{"Driver":"bridge"}]');
    break;
  case 'cp':
    if (exists(containerPath) && args[1].endsWith(':/app/data')) fs.cpSync(own().Mounts[0].Source, nativePath(args[2]), { recursive: true }); else abort('fixture missing container data');
    break;
  case 'compose':
    if (args[1] === 'version') { console.log('Docker Compose version v2.32.0'); break; }
    if (args.includes('config')) {
      if (process.env.MOCK_CONFIG_FAIL === '1') abort('fixture invalid compose');
      const compose = parseCompose();
      if (!args.includes('--quiet')) console.log(JSON.stringify(compose));
    } else if (args.includes('build') || args.includes('up')) {
      if (process.env.MOCK_BUILD_FAIL === '1') abort('fixture build failure', 42);
      fs.writeFileSync(imagePath, 'yunxiang-newapi-compensation:local');
      if (args.includes('up')) {
        if (process.env.MOCK_UP_FAIL === '1') abort('fixture startup failure', 45);
        fs.mkdirSync(fixedVolume, { recursive: true });
        if (!exists(path.join(fixedVolume, 'compensation.sqlite'))) {
          const db = new DatabaseSync(path.join(fixedVolume, 'compensation.sqlite')); db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)'); db.close();
        }
        if (!exists(path.join(fixedVolume, 'secrets.key'))) fs.writeFileSync(path.join(fixedVolume, 'secrets.key'), Buffer.alloc(32, 7));
        fs.writeFileSync(containerPath, JSON.stringify(own()));
        fs.writeFileSync(fixedMountedPath, '1');
        fs.rmSync(stoppedPath, { force: true });
      }
    } else if (args.includes('exec')) {
      if (process.env.MOCK_PREFLIGHT_FAIL === '1') abort('fixture preflight failed', 46);
      if (!exists(containerPath)) abort('fixture service is not running');
      console.log('fixture health/preflight passed');
    } else if (args.includes('down') || args.includes('stop') || args.includes('rm')) {
      if (args.includes('down') || args.includes('rm')) fs.rmSync(containerPath, { force: true });
      if (args.includes('stop') && exists(containerPath)) fs.writeFileSync(stoppedPath, '1');
      if (args.includes('--volumes')) fs.rmSync(fixedVolume, { recursive: true, force: true });
    } else if (args.includes('start')) { if (!exists(containerPath)) abort('fixture service missing'); fs.rmSync(stoppedPath, { force: true }); }
    else if (args.includes('ps')) { if (exists(containerPath) && !(args.includes('running') && exists(stoppedPath))) console.log('yunxiang-compensation'); }
    else if (args.includes('logs')) console.log('fixture deployment log');
    else abort('unexpected compose call ' + args.join(' '));
    break;
  case 'run': {
    const imageIndex = args.findIndex(value => /^node:/.test(value));
    if (imageIndex < 0) abort('unexpected helper image');
    const command = args.slice(imageIndex + 1);
    const sandbox = fs.mkdtempSync(path.join(state, 'helper-'));
    const app = path.join(sandbox, 'app'); fs.mkdirSync(app);
    const temp = path.join(sandbox, 'tmp'); fs.mkdirSync(temp);
    const mounts = { '/app': app };
    for (let index = 1; index < imageIndex; index++) {
      if (args[index] === '-v' || args[index] === '--volume') {
        const match = args[++index].match(/^(.*):(\/[^:]*)(?::(ro|rw))?$/);
        if (!match) abort('invalid fixture mount');
        const source = match[1].startsWith('/') || /^[A-Za-z]:/.test(match[1]) ? nativePath(match[1]) : named(match[1]);
        fs.mkdirSync(source, { recursive: true }); mounts[match[2]] = source;
      } else if (args[index] === '--mount') {
        const spec = Object.fromEntries(args[++index].split(',').map(part => { const split = part.indexOf('='); return split < 0 ? [part, ''] : [part.slice(0, split), part.slice(split + 1)]; }));
        const source = spec.type === 'volume' ? named(spec.src || spec.source) : nativePath(spec.src || spec.source);
        if (spec.type === 'volume') fs.mkdirSync(source, { recursive: true });
        mounts[spec.dst || spec.target || spec.destination] = source;
      }
    }
    if (mounts['/app/src']) fs.cpSync(mounts['/app/src'], path.join(app, 'src'), { recursive: true });
    const destinations = Object.keys(mounts).sort((a, b) => b.length - a.length);
    const mountPattern = new RegExp(`(?<![A-Za-z0-9_.:/\\\\-])(${destinations.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=/|[\\s"'\\)\\],;]|$)`, 'g');
    const remap = (value, shell = false) => {
      return value.replace(mountPattern, target => shell && process.platform === 'win32' ? shellPath(mounts[target]) : mounts[target].replaceAll('\\', '/'));
    };
    const dropped = args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL';
    const capabilities = args.flatMap((value, index) => value === '--cap-add' ? [args[index + 1].toUpperCase()] : []);
    if (dropped && command.some(value => /\bchown\b/.test(value)) && !capabilities.includes('CHOWN')) abort('fixture: chown requires CAP_CHOWN', 47);
    const workIndex = args.indexOf('-w');
    const work = workIndex >= 0 ? mounts[args[workIndex + 1]] || remap(args[workIndex + 1]) : app;
    const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, YUNXIANG_HELPER_ROOT: sandbox, YUNXIANG_HELPER_MOUNTS: JSON.stringify(mounts) };
    let execution;
    if (command[0] === 'node') {
      const nodeArgs = command.slice(1).map(value => nativePath(remap(value)));
      execution = spawnSync(process.execPath, ['--require', path.join(import.meta.dirname, 'deploy-fixture-guard.cjs'), ...nodeArgs], { cwd: nativePath(work), env, stdio: 'inherit' });
    } else if (command[0] === 'sh' || command[0] === 'bash') {
      const scriptIndex = command.findIndex((value, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(value));
      if (scriptIndex < 0) abort('unexpected fixture shell helper');
      const script = 'chown(){ return 0; }; export -f chown; ' + remap(command[scriptIndex + 1], true);
      execution = spawnSync(process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'), [...command.slice(1, scriptIndex + 1), script, ...command.slice(scriptIndex + 2).map(value => remap(value, true))], { cwd: nativePath(work), env, stdio: 'inherit' });
    } else abort('unsupported helper command');
    fs.rmSync(sandbox, { recursive: true, force: true });
    if (execution.error) console.error(execution.error.message);
    process.exit(execution.status ?? 1);
  }
  default: abort('unexpected docker call ' + args.join(' '));
}
