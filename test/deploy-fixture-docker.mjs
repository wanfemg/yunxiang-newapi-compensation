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
  const root=upstreamFiles();
  if(!process.env.MOCK_NEWAPI_FILES_DIR) {
    const directory=path.join(root,'data');fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,'one-api.db');
    if(!exists(file)) {const db=new DatabaseSync(file);db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE logs(id INTEGER PRIMARY KEY)');db.close();}
  }
  return { Id: 'newapi-fixture', Name: '/newapi-main', State: { Running: true }, Config: { Image: 'newapi:latest', WorkingDir:'/data', Env: ['PORT=3000'], Labels: { 'com.docker.compose.project': 'newapi' } }, Mounts:[{Type:'bind',Source:path.join(root,'data'),Destination:'/data',RW:true}], HostConfig: { NetworkMode: 'baota_net' }, NetworkSettings: { Networks: { baota_net: {} } } };
}
function upstreamFiles() {return process.env.MOCK_NEWAPI_FILES_DIR?path.resolve(nativePath(process.env.MOCK_NEWAPI_FILES_DIR)):path.join(state,'upstream-files');}
function upstreamFile(selector,containerPath) {
  if(!upstreams().some(entry=>[entry.Id,entry.Name,entry.Name?.replace(/^\//,'')].includes(selector))) abort('fixture source container missing');
  const directory=upstreamFiles();
  if(!path.posix.isAbsolute(containerPath)) abort('fixture source path must be absolute');
  const source=path.resolve(directory,'.'+containerPath);
  if(!source.startsWith(directory+path.sep)||!exists(source)) abort('fixture upstream file missing');
  return source;
}
function upstreams() {
  if (!process.env.MOCK_NEWAPI_INSPECT_FILE) return [upstream()];
  const value = JSON.parse(fs.readFileSync(nativePath(process.env.MOCK_NEWAPI_INSPECT_FILE), 'utf8'));
  const entries = Array.isArray(value) ? value : value.containers || [value];
  if (!Array.isArray(entries)) abort('fixture upstream inspect must be an array');
  return entries;
}
function formatContainer(entry, format) {
  if (format === '{{json .}}') return JSON.stringify(entry);
  if (format.includes('|')) return `${entry.Name}|${entry.Config?.Labels?.['com.docker.compose.project'] || ''}|${entry.Config?.Labels?.['com.docker.compose.service'] || ''}|${entry.Config?.Image || ''}`;
  if (format === '{{.State.Running}}') return String(entry.State?.Running === true);
  if (format === '{{.Name}}') return entry.Name;
  if (format === '{{.Id}}' || format === '{{.ID}}') return entry.Id;
  if (format === '{{.Config.Image}}') return entry.Config?.Image || '';
  if (format === '{{json .Config.Env}}') return JSON.stringify(entry.Config?.Env || []);
  if (format === '{{json .NetworkSettings.Networks}}') return JSON.stringify(entry.NetworkSettings?.Networks || {});
  if (format === '{{json .NetworkSettings.Ports}}') return JSON.stringify(entry.NetworkSettings?.Ports || {});
  if (format.includes('Mounts')) return JSON.stringify(entry.Mounts || []);
  if (format.includes('Labels')) return JSON.stringify(entry.Config?.Labels || {});
  abort('unsupported fixture inspect format');
}
function own() {
  const oldBind = process.env.MOCK_OLD_BIND_DATA && !exists(fixedMountedPath);
  return { Id: 'yunxiang-fixture', Name: '/yunxiang-compensation', State: { Running: !exists(stoppedPath) }, Config: { Image: 'yunxiang-newapi-compensation:local', Labels: { 'com.docker.compose.project': 'newapi-compensation', 'com.docker.compose.service': 'compensation' } }, Mounts: [{ Type: oldBind ? 'bind' : 'volume', Name: oldBind ? undefined : 'newapi-compensation_compensation_data', Source: oldBind ? process.env.MOCK_OLD_BIND_DATA : fixedVolume, Destination: '/app/data' }] };
}
function parseCompose() {
  const index = args.indexOf('-f');
  const file = index < 0 ? 'docker-compose.yml' : args[index + 1];
  const compose = JSON.parse(fs.readFileSync(nativePath(file), 'utf8'));
  const projectIndex = args.indexOf('--project-directory');
  const projectDirectory = projectIndex < 0 ? path.dirname(path.resolve(nativePath(file))) : path.resolve(nativePath(args[projectIndex + 1]));
  const env = { ...process.env };
  const envIndex = args.indexOf('--env-file');
  const envFile = envIndex < 0 ? path.join(projectDirectory, '.env') : nativePath(args[envIndex + 1]);
  if (exists(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (match && env[match[1]] === undefined) {
      let value = match[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
      else if(value.startsWith("'") && value.endsWith("'")) value = value.slice(1,-1);
      env[match[1]] = value;
    }
  }
  const expand = value => typeof value === 'string' ? value.replace(/\$\{([A-Z_]+)(?::-([^}]*))?\}/g, (_, key, fallback = '') => env[key] || fallback)
    : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)])) : value;
  const output = expand(compose);
  const service = output.services.compensation;
  if (typeof service.build === 'string') service.build = path.resolve(projectDirectory, nativePath(service.build));
  else if (service.build) service.build.context = path.resolve(projectDirectory, nativePath(service.build.context || '.'));
  for (const secret of Object.values(output.secrets || {})) if (secret.file) secret.file = path.resolve(projectDirectory, nativePath(secret.file));
  return output;
}

function executeComposeNode(compose) {
  const execIndex = args.indexOf('exec');
  const nodeIndex = args.indexOf('node', execIndex + 1);
  if (nodeIndex < 0) abort('unsupported fixture compose exec command');
  const projectIndex = args.indexOf('--project-directory');
  const context = compose.services.compensation.build?.context;
  const directory = projectIndex >= 0 ? path.resolve(nativePath(args[projectIndex + 1])) : typeof context === 'string' ? context : process.cwd();
  const mounts = { '/app/data': fixedVolume, '/app': directory };
  const environment = { ...process.env, ...compose.services.compensation.environment };
  for (const secret of compose.services.compensation.secrets || []) {
    const name = typeof secret === 'string' ? secret : secret.source;
    const target = typeof secret === 'string' ? secret : secret.target || secret.source;
    if (compose.secrets?.[name]?.file) mounts[target.startsWith('/') ? target : '/run/secrets/' + target] = compose.secrets[name].file;
  }
  const output = spawnSync(process.execPath, ['--require', path.join(import.meta.dirname, 'deploy-fixture-guard.cjs'), ...args.slice(nodeIndex + 1)], {
    cwd: directory, env: { ...environment, YUNXIANG_HELPER_ROOT: directory, YUNXIANG_HELPER_MOUNTS: JSON.stringify(mounts) }, stdio: 'inherit'
  });
  if (output.error) console.error(output.error.message);
  process.exit(output.status ?? 1);
}
switch (args[0]) {
  case 'info':
    if (process.env.MOCK_DOCKER_UNAVAILABLE === '1') abort('fixture daemon unavailable');
    if (args.includes('--format')) {
      if(args[args.indexOf('--format')+1]!=='{{.ID}}') abort('unsupported fixture Docker info format');
      console.log(process.env.MOCK_DOCKER_ENGINE_ID||'fixture-engine-id');
    }
    break;
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
    const discovered = process.env.MOCK_DISCOVER_NEWAPI === '1' || process.env.MOCK_NEWAPI_INSPECT_FILE;
    let entries = [...(exists(containerPath) ? [own()] : []), ...(discovered ? upstreams() : [])];
    if (!includeStopped) entries = entries.filter(entry => entry.State?.Running);
    if (lookingOwn) entries = entries.filter(entry => entry.Name === '/yunxiang-compensation');
    for (const filter of filters) {
      if(filter.startsWith('label=')) {
        const value=filter.slice(6), split=value.indexOf('=');
        const key=split<0?value:value.slice(0,split), expected=split<0?null:value.slice(split+1);
        entries=entries.filter(entry=>expected===null?Object.hasOwn(entry.Config?.Labels||{},key):entry.Config?.Labels?.[key]===expected);
      } else if(filter.startsWith('network=')) entries=entries.filter(entry=>Object.hasOwn(entry.NetworkSettings?.Networks||{},filter.slice(8)));
      else if(filter.startsWith('name=')&&!lookingOwn) entries=entries.filter(entry=>new RegExp(filter.slice(5)).test(entry.Name||''));
    }
    const formatIndex=args.indexOf('--format'), format=formatIndex<0?'':args[formatIndex+1];
    for(const entry of entries) console.log(!format?entry.Id:format==='{{.Names}}'?entry.Name.replace(/^\//,''):format==='{{.ID}}'?entry.Id:format==='{{json .}}'?JSON.stringify(entry):formatContainer(entry,format));
    break;
  }
  case 'inspect': {
    const available=[...(exists(containerPath)?[own()]:[]),...upstreams()], selectors=[];
    let format;
    for(let index=1;index<args.length;index++) {
      if(['--format','-f'].includes(args[index])) format=args[++index];
      else if(args[index]==='--type') index++;
      else if(!args[index].startsWith('-')) selectors.push(args[index]);
      else abort('unsupported fixture inspect option');
    }
    if(!selectors.length) abort('fixture inspect requires a container');
    const entries=selectors.map(selector=>{
      const matches=available.filter(entry=>entry.Name===selector||entry.Name===`/${selector}`||entry.Id===selector||String(entry.Id||'').startsWith(selector));
      if(matches.length!==1) abort('fixture container missing or ambiguous');
      return matches[0];
    });
    if(format===undefined) console.log(JSON.stringify(entries));
    else for(const entry of entries) console.log(formatContainer(entry,format));
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
  case 'cp': {
    const match=args[1]?.match(/^([^:]+):(\/.*)$/);
    if(!match) abort('unsupported fixture copy source');
    if (exists(containerPath) && ['yunxiang-compensation','yunxiang-fixture'].includes(match[1]) && match[2]==='/app/data') fs.cpSync(own().Mounts[0].Source, nativePath(args[2]), { recursive: true });
    else {
      const source=upstreamFile(match[1],match[2]);
      fs.cpSync(source,nativePath(args[2]),{recursive:true});
    }
    break;
  }
  case 'exec': {
    if(args.length!==7||args[2]!=='sh'||args[3]!=='-ec'||args[4]!=='test -f "$1" && test -r "$1" && head -c 100 -- "$1"'||args[5]!=='sh') abort('unsupported fixture source exec');
    const source=upstreamFile(args[1],args[6]);
    if(!fs.statSync(source).isFile()) abort('fixture source is not a regular file');
    fs.accessSync(source,fs.constants.R_OK);
    const descriptor=fs.openSync(source,'r');
    try{const bytes=Buffer.alloc(100),length=fs.readSync(descriptor,bytes,0,100,0);process.stdout.write(bytes.subarray(0,length));}finally{fs.closeSync(descriptor);}
    break;
  }
  case 'compose':
    if (args[1] === 'version') { console.log('Docker Compose version v2.32.0'); break; }
    if (args.includes('config')) {
      if (process.env.MOCK_CONFIG_FAIL === '1') abort('fixture invalid compose');
      const compose = parseCompose();
      if (!args.includes('--quiet')) console.log(JSON.stringify(compose));
    } else if (args.includes('build') || args.includes('up')) {
      if (process.env.MOCK_BUILD_FAIL === '1') abort('fixture build failure', 42);
      const compose = parseCompose();
      const service = compose.services.compensation;
      const context = typeof service.build === 'string' ? service.build : service.build?.context;
      if (!context || !exists(path.join(context, service.build?.dockerfile || 'Dockerfile'))) abort('fixture build context is not a host project directory', 50);
      for (const secret of Object.values(compose.secrets || {})) if (secret.file && !exists(secret.file)) abort('fixture Compose secret file is missing', 51);
      fs.writeFileSync(imagePath, 'yunxiang-newapi-compensation:local');
      if (args.includes('up')) {
        if (process.env.MOCK_UP_FAIL === '1') abort('fixture startup failure', 45);
        fs.mkdirSync(fixedVolume, { recursive: true });
        if (!exists(path.join(fixedVolume, 'compensation.sqlite'))) {
          const db = new DatabaseSync(path.join(fixedVolume, 'compensation.sqlite')); db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)'); db.close();
        }
        const origin=parseCompose().services.compensation.environment?.NEWAPI_URL;
        if(origin) {
          const db=new DatabaseSync(path.join(fixedVolume,'compensation.sqlite'));
          db.exec('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
          const normalized=new URL(origin).origin;
          const binding=db.prepare("SELECT value FROM metadata WHERE key='newapi_origin'").get();
          if(binding&&binding.value!==normalized) {db.close();abort('fixture ledger is bound to another NewAPI instance',49);}
          db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('newapi_origin',?)").run(normalized);db.close();
        }
        if (!exists(path.join(fixedVolume, 'secrets.key'))) fs.writeFileSync(path.join(fixedVolume, 'secrets.key'), Buffer.alloc(32, 7));
        fs.writeFileSync(containerPath, JSON.stringify(own()));
        fs.writeFileSync(fixedMountedPath, '1');
        fs.rmSync(stoppedPath, { force: true });
      }
    } else if (args.includes('exec')) {
      if (process.env.MOCK_PREFLIGHT_FAIL === '1') abort('fixture preflight failed', 46);
      if (process.env.MOCK_LINK_POSTCHECK_FAIL === '1' && args.some(value=>value.endsWith('preflight.mjs'))) abort('fixture link postcheck failed', 48);
      if (!exists(containerPath)) abort('fixture service is not running');
      executeComposeNode(parseCompose());
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
    if (mounts['/app/public']) fs.cpSync(mounts['/app/public'], path.join(app, 'public'), { recursive: true });
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
