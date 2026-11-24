import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDeploymentEnv } from './deployment-config.mjs';
import { deploymentPlan, projectMetadata, selectCandidate } from './deployment.mjs';
import { normalizeComposePaths } from './deployment-recovery.mjs';

// Only durable, precisely located database resources establish an instance identity.
// A Docker DNS name (such as "postgres") can identify unrelated databases on other networks.
function databaseIdentity(db, context = {}) {
  if (!db || db.location === 'ambiguous' || db.location === 'unresolved') return null;
  const cleanPath = value => typeof value === 'string' && value.startsWith('/') && !/[\0\r\n]/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..') ? value.replace(/\/+$/, '') || '/' : null;
  const mountedFile = (mount, file) => {
    const destination = cleanPath(mount?.destination), path = cleanPath(file);
    if (!destination || !path || !(path === destination || path.startsWith(destination === '/' ? '/' : destination + '/'))) return null;
    const source = mount.type === 'volume' && typeof mount.name === 'string' && mount.name
      ? mount.name : mount.type === 'bind' ? cleanPath(mount.source) : null;
    if (!source) return null;
    return [mount.type, source, path.slice(destination === '/' ? 0 : destination.length)];
  };
  if (db.type === 'sqlite') {
    const identity = mountedFile(db.mount, db.containerPath);
    return identity ? { comparison: ['sqlite', ...identity], proof: true } : null;
  }
  const endpoint = db.endpoint;
  const databaseContainer = db.databaseContainer;
  if (!endpoint?.database) return null;
  const address = [String(endpoint.host || '').toLowerCase(), Number(endpoint.port) || null, endpoint.database, endpoint.socket || ''];
  if (databaseContainer) {
    const defaults = { postgresql: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', clickhouse: '/var/lib/clickhouse' };
    const dataDirectory = cleanPath(databaseContainer.dataDirectory || defaults[db.type]);
    const mounts = (databaseContainer.mounts || []).filter(mount => mountedFile(mount, dataDirectory))
      .sort((left, right) => String(right.destination).length - String(left.destination).length);
    if (mounts.length) {
      // Compare the actual data mount, not a configuration/secret volume. Docker
      // container IDs change on rebuild, while the full persistent path must not.
      const persistent = mountedFile(mounts[0], dataDirectory);
      const scope = [databaseContainer.project || '', [...(databaseContainer.networks || [])].sort()];
      return { comparison: [db.type, ...address, 'persistent', persistent, scope], proof: true };
    }
    if (databaseContainer.id) return { comparison: [db.type, ...address, 'container', databaseContainer.id], proof: true };
  }
  // Addresses can be compared to detect a changed database at the same API URL,
  // but DNS (even a public hostname) is not evidence of a persistent DB identity.
  const source = context.source || context.project || {};
  const scope = [context.container || '', source.project || '', source.networkMode || '', [...(source.networks || [])].sort()];
  return { comparison: [db.type, ...address, 'endpoint', scope], proof: false };
}

export function associationDecision(previous, next, previousUrl, nextUrl) {
  const changedOrigin = new URL(previousUrl).origin !== new URL(nextUrl).origin;
  const engineIdentity = metadata => typeof metadata?.engineId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(metadata.engineId) ? metadata.engineId : '';
  const previousEngine = engineIdentity(previous), nextEngine = engineIdentity(next);
  let proven = Boolean(previousEngine && nextEngine && previousEngine === nextEngine);
  for (const key of ['main', 'logs']) {
    const old = key === 'logs' && previous?.logs?.sameAs === 'main' ? previous.main : previous?.[key];
    const current = key === 'logs' && next?.logs?.sameAs === 'main' ? next.main : next?.[key];
    const a = databaseIdentity(old, previous), b = databaseIdentity(current, next);
    if (changedOrigin && previousEngine && nextEngine && previousEngine !== nextEngine && (a?.proof || b?.proof)) {
      throw Error('检测到不同 Docker 引擎；同名挂载或容器不能证明同一数据库，已保留原配置和账本绑定');
    }
    if (a && b && JSON.stringify(a.comparison) !== JSON.stringify(b.comparison)) throw Error('重新获取指向不同的主库或日志库，已阻止切换实例并保留账本绑定');
    if (!a || !b || !a.proof || !b.proof) proven = false;
  }
  if (changedOrigin && (!previousEngine || !nextEngine)) throw Error('缺少原部署或当前部署的 Docker 引擎身份，无法证明新的接入地址使用原数据库；已保留账本实例绑定和原配置');
  if (changedOrigin && !proven) throw Error('无法证明新的接入地址使用原数据库；已保留账本实例绑定和原配置');
  return { rebind: changedOrigin, previousOrigin: new URL(previousUrl).origin, nextOrigin: new URL(nextUrl).origin, proven };
}

export function refreshedConfiguration({ compose, env, previous, plan, projectDirectory }) {
  if (typeof projectDirectory !== 'string' || !isAbsolute(projectDirectory) || /[\0\r\n]/.test(projectDirectory)) {
    throw Error('重新关联必须明确指定宿主云响项目目录');
  }
  const config = parseDeploymentEnv(env);
  const association = associationDecision(previous, plan.database, config.NEWAPI_URL, plan.url);
  const output = normalizeComposePaths(compose, projectDirectory).compose;
  const service = output.services.compensation;
  const network = plan.network;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network) || ['none', 'bridge'].includes(network)) throw Error('新原站网络无效');
  service.network_mode = network;
  delete service.networks;
  const port = Number(service.environment.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('已有云响端口无效');
  service.environment.HOST = network === 'host' ? '127.0.0.1' : '0.0.0.0';
  if (network === 'host') delete service.ports;
  else service.ports = [`127.0.0.1:${port}:${port}`];
  // Config values are always sourced from the saved file, not the invoking shell.
  service.environment.NEWAPI_URL = '${NEWAPI_URL}';
  config.NEWAPI_URL = plan.url;
  config.ALLOW_HTTP_UPSTREAM = plan.url.startsWith('http:') ? '1' : '0';
  const serialized = Object.entries(config).map(([key,value])=>`${key}=${value}`).join('\n')+'\n';
  parseDeploymentEnv(serialized);
  return { compose: output, env: serialized, database: { ...plan.database, project: plan.project }, association };
}

export function configFileRequests(container) {
  const env = Object.fromEntries((container.Config?.Env || []).filter(value => value.indexOf('=') > 0).map(value => {
    const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
  }));
  const activeFile = keys => {
    for (const key of keys) {
      if (env[key]?.trim()) return null;
      if (env[key + '_FILE']?.trim()) return key + '_FILE';
    }
    return null;
  };
  return [activeFile(['SQL_DSN','DATABASE_URL','DB_DSN']), activeFile(['LOG_SQL_DSN'])].filter(Boolean).map(key => {
    const path = env[key];
    if (!path.startsWith('/') || /[\r\n\0]/.test(path) || path.split('/').includes('..') || path.length > 4096) throw Error('数据库配置文件路径无效');
    return { key, path };
  });
}

export function sqliteFiles(metadata) {
  return [...new Set(['main','logs'].map(key => metadata[key]).filter(db => db?.type === 'sqlite' && db.sameAs !== 'main').map(db => {
    if (!db.containerPath?.startsWith('/') || /[\r\n\0]/.test(db.containerPath) || db.location === 'unresolved') throw Error('SQLite 文件位置尚未解析，未验证数据库');
    return db.containerPath;
  }))];
}

export function linkSummary(plan) {
  const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ');
  const project = plan.project || {}, lines = [
    `NewAPI 主体：${safe(project.container || '主机 / 远程 API')}；Compose 项目：${safe(project.project || '未使用或未获取')}`,
    `项目目录：${safe(project.workingDirectory || '未获取')}；容器工作目录：${safe(project.containerWorkingDirectory || '未获取')}`,
    `接入地址：${safe(plan.url)}；云响网络：${safe(plan.network)}`
  ];
  for (const path of project.composeFiles || []) lines.push(`Compose 文件（容器标签声明）：${safe(path)}`);
  for (const [key,label] of [['main','主库'],['logs','日志库']]) {
    const database = plan.database[key] || {};
    if (database.sameAs === 'main') { lines.push(`${label}：与主库共用`); continue; }
    lines.push(`${label}：${safe(database.type || 'unknown')}；定位：${safe(database.location || '未验证')}`);
    if (database.containerPath) lines.push(`  原站文件：${safe(database.containerPath)}${database.hostPath ? '；宿主路径：'+safe(database.hostPath) : ''}`);
    if (database.endpoint) lines.push(`  端点：${safe(database.endpoint.host || database.endpoint.socket)}:${safe(database.endpoint.port)}；库名：${safe(database.endpoint.database)}`);
    if (database.databaseContainer) {
      lines.push(`  数据库容器：${safe(database.databaseContainer.name)}；数据目录：${safe(database.databaseContainer.dataDirectory)}`);
      for (const mount of database.databaseContainer.mounts || []) lines.push(`  挂载：${safe(mount.name || mount.source)} → ${safe(mount.destination)}`);
    }
    if (database.reason) lines.push(`  说明：${safe(database.reason)}`);
  }
  return lines.join('\n');
}

function contextCommand(directory, command, args) {
  const read = name => JSON.parse(readFileSync(join(directory,name),'utf8'));
  if (command === 'api-input') {
    const env = parseDeploymentEnv(readFileSync(join(directory,'probe.env'),'utf8'));
    return {url:env.NEWAPI_URL,adminUserId:env.NEWAPI_ADMIN_USER_ID,
      adminToken:readFileSync(join(directory,'probe.token'),'utf8').trim(),allowHttp:env.ALLOW_HTTP_UPSTREAM==='1',
      metadata:read('plan.json').database};
  }
  if (command === 'refresh') return refreshedConfiguration({
    compose:read('previous-compose.json'),env:readFileSync(join(directory,'previous.env'),'utf8'),
    previous:read('previous-database.json'),plan:read('plan.json'),projectDirectory:args[0]
  });
  if (command === 'summary') {
    return linkSummary(read('plan.json'));
  }
  const containers = read('inspect.json');
  const choice = selectCandidate(containers, {container:args[0] || undefined});
  if (command === 'list') return choice.choices.map(projectMetadata);
  const selected = choice.selected;
  if (!selected) throw Error('无法唯一识别 NewAPI 主体，请按编号或容器名称选择');
  if (command === 'selected') return projectMetadata(selected);
  if (command === 'networks') return selected.HostConfig?.NetworkMode === 'host' ? [] : Object.keys(selected.NetworkSettings?.Networks||{}).filter(n=>!['host','none','bridge'].includes(n));
  const requests = configFileRequests(selected);
  if (command === 'files') return requests;
  const fileValues = {};
  for (const request of requests) {
    const content = readFileSync(join(directory,request.key),'utf8');
    if (!content.trim() || content.length > 65536) throw Error('数据库文件配置为空或过大');
    fileValues[request.path] = content.trim();
  }
  const plan = deploymentPlan(selected,{containers,fileValues,network:args[1]||undefined,port:args[2]||undefined});
  plan.database.project = plan.project;
  return plan;
}

export function verifyLedgerOrigin(directory, previousOrigin, nextOrigin, apply = false) {
  // Deliberately loaded only for this command, outside metadata/discovery commands.
  return import('node:sqlite').then(({ DatabaseSync }) => {
    let scratch, db;
    try {
      const source = join(directory, 'compensation.sqlite');
      if (apply) db = new DatabaseSync(source);
      else {
        // A WAL ledger may need a fresh SHM file even during SELECT. Rebuild it
        // only in private scratch space, leaving the mounted source read-only.
        scratch = mkdtempSync(join(tmpdir(), 'yunxiang-link-ledger-'));
        const snapshot = join(scratch, 'compensation.sqlite');
        copyFileSync(source, snapshot);
        if (existsSync(source + '-wal')) copyFileSync(source + '-wal', snapshot + '-wal');
        db = new DatabaseSync(snapshot);
      }
      const row = db.prepare("SELECT value FROM metadata WHERE key='newapi_origin'").get();
      if (row && ![previousOrigin,nextOrigin].includes(row.value)) throw Error('实际账本绑定与原配置不一致，已阻止重新关联');
      if (apply && row?.value === previousOrigin && previousOrigin !== nextOrigin) {
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare("UPDATE metadata SET value=? WHERE key='newapi_origin' AND value=?").run(nextOrigin,previousOrigin); db.exec('COMMIT'); }
        catch(error) { db.exec('ROLLBACK'); throw error; }
      }
    } finally {
      db?.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (command === 'ledger') {
      await verifyLedgerOrigin(process.argv[3], process.argv[4], process.argv[5], process.argv[6] === 'apply');
    } else if (command === 'context') {
      const result = contextCommand(process.argv[3],process.argv[4],process.argv.slice(5));
      if (process.argv[4] === 'summary') console.log(result);
      else console.log(JSON.stringify(result));
    } else if (command === 'sqlite-header') {
      const data = readFileSync(0);
      if (data.length < 100 || !data.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))) throw Error('原站 SQLite 文件不可读或文件头无效');
      console.log('SQLite 文件可读且文件头有效；表结构和日志读取由原站只读 API 检查。');
    } else {
      const input = JSON.parse(readFileSync(0,'utf8'));
      let output;
      if (command === 'select') {
        const choice = selectCandidate(input, { container: process.argv[3], previous: process.argv[4] });
        output = {selected:choice.selected ? projectMetadata(choice.selected) : null, choices:choice.choices.map(projectMetadata)};
      } else if (command === 'files') output = configFileRequests(input);
      else if (command === 'sqlite-files') output = sqliteFiles(input);
      else if (command === 'plan') output = deploymentPlan(input.container,input.options);
      else if (command === 'refresh') output = refreshedConfiguration(input);
      else throw Error('未知关联操作');
      console.log(JSON.stringify(output));
    }
  } catch(error) {
    console.error(error instanceof SyntaxError ? 'NewAPI 关联配置不是有效的 JSON，未输出原始内容' : error.message);
    process.exitCode = 1;
  }
}
