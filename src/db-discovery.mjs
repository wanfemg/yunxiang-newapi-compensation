import { posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseDatabaseDsn } from './db-endpoint.mjs';

const labelsOf = container => container?.Config?.Labels || {};
const nameOf = container => String(container?.Name || '').replace(/^\//, '');
const envOf = container => Object.fromEntries((container?.Config?.Env || []).flatMap(line => {
  const i = line.indexOf('=');
  return i > 0 ? [[line.slice(0, i), line.slice(i + 1)]] : [];
}));
const mountInfo = mount => ({ type: mount.Type, name: mount.Name || null, source: mount.Source, destination: mount.Destination, readOnly: mount.RW === false });
const projectInfo = container => {
  const labels = labelsOf(container);
  return {
    project: labels['com.docker.compose.project'] || '',
    service: labels['com.docker.compose.service'] || '',
    workingDirectory: labels['com.docker.compose.project.working_dir'] || '',
    configFiles: String(labels['com.docker.compose.project.config_files'] || '').split(',').map(file => file.trim()).filter(Boolean),
    networkMode: String(container?.HostConfig?.NetworkMode || ''),
    networks: Object.keys(container?.NetworkSettings?.Networks || {})
  };
};

// Raw discovery is ephemeral; sanitize before persisting or printing. No SQL runs.
export function discoverDatabase(container, options = {}) {
  const env = envOf(container);
  const fileValues = options.fileValues || {};
  function configured(keys) {
    for (const key of keys) {
      if (env[key]) return { value: env[key] };
      const fileKey = `${key}_FILE`;
      if (env[fileKey]) {
        const value = fileValues[env[fileKey]] ?? fileValues[fileKey];
        return typeof value === 'string' && value.trim()
          ? { value: value.trim() }
          : { unresolved: true, reason: '数据库使用文件型配置，凭据文件尚未安全读取' };
      }
    }
    return {};
  }
  function database(setting, isLog) {
    if (setting.unresolved) return { type: 'unknown', location: 'unresolved', reason: setting.reason };
    const dsn = setting.value;
    if (!dsn || dsn.startsWith('local') || /^sqlite:/i.test(dsn)) {
      const configured = /^sqlite:/i.test(dsn || '')
        ? String(dsn).replace(/^sqlite:(?:\/\/)?/i, '')
        : (isLog && env.LOG_SQLITE_PATH) || env.SQLITE_PATH || 'one-api.db';
      const raw = configured.split('?')[0];
      if (!raw || raw === ':memory:' || raw.startsWith('file:')) {
        return { type: 'sqlite', configuredPath: configured, location: 'unresolved', reason: '特殊 SQLite 地址，需要核对容器中的实际文件' };
      }
      const containerPath = posix.resolve(container?.Config?.WorkingDir || '/', raw);
      const mount = [...(container?.Mounts || [])].filter(m => typeof m.Destination === 'string' &&
        (containerPath === m.Destination || containerPath.startsWith(m.Destination.replace(/\/$/, '') + '/'))
      ).sort((a, b) => b.Destination.length - a.Destination.length)[0];
      return { type: 'sqlite', configuredPath: configured, containerPath,
        location: mount ? 'mounted' : 'container-layer',
        ...(mount ? { mount: mountInfo(mount),
          ...(mount.Source ? { hostPath: posix.join(mount.Source, posix.relative(mount.Destination, containerPath)) } : {}) } : {}) };
    }
    if (/^(clickhouse|tcp|http|https):\/\//i.test(dsn) && !isLog) throw new Error('识别到不支持的 ClickHouse 主库配置');
    try { return { ...parseDatabaseDsn(dsn, { isLog }), dsn, location: 'unverified' }; }
    catch { return { type: 'unknown', location: 'unresolved', reason: '数据库连接串无法解析，未保存原始凭据' }; }
  }
  const mainSetting = configured(['SQL_DSN', 'DATABASE_URL', 'DB_DSN']);
  const logSetting = configured(['LOG_SQL_DSN']);
  const main = database(mainSetting, false);
  const logs = logSetting.value || logSetting.unresolved ? database(logSetting, true) : { sameAs: 'main', type: main.type };
  return { version: 1, container: nameOf(container), source: projectInfo(container),
    detectedAt: new Date().toISOString(), main, logs, connected: false, quotaWriteMode: 'newapi-api' };
}

function locateDatabase(endpoint, source, containers, type) {
  if (!endpoint?.host || endpoint.socket) return { location: 'unresolved', reason: '数据库通过本地套接字连接，须在原站内检查' };
  const host = endpoint.host.toLowerCase();
  const matches = containers.filter(container => {
    if (!container?.State?.Running) return false;
    const info = projectInfo(container);
    const shared = info.networks.filter(network => source.networks?.includes(network));
    if (source.networkMode === 'host') {
      // A host-network source resolves localhost against the Docker engine host.
      // Both the published address and published port must match; container
      // exposed ports alone never establish a database association.
      return Object.entries(container.NetworkSettings?.Ports || {}).some(([target, bindings]) =>
        /^\d+\/tcp$/.test(target) && (bindings || []).some(binding => {
          if (Number(binding.HostPort) !== Number(endpoint.port)) return false;
          const address = String(binding.HostIp || '0.0.0.0').toLowerCase();
          if (address === host) return true;
          if (host === 'localhost') return ['127.0.0.1', '0.0.0.0', '::1', '::'].includes(address);
          if (/^127(?:\.\d{1,3}){3}$/.test(host)) return address === '0.0.0.0';
          return host === '::1' && address === '::';
        }));
    }
    if (!shared.length || shared.includes('host')) return false;
    const networkMatch = shared.some(network => {
      const values = container.NetworkSettings.Networks[network] || {};
      return [values.IPAddress, values.GlobalIPv6Address, ...(values.Aliases || []), ...(values.DNSNames || [])]
        .some(value => typeof value === 'string' && value.toLowerCase() === host);
    });
    const nameMatch = nameOf(container).toLowerCase() === host;
    const serviceMatch = Boolean(source.project && info.project === source.project && info.service.toLowerCase() === host);
    return networkMatch || nameMatch || serviceMatch;
  });
  if (matches.length > 1) return { location: 'ambiguous', reason: '多个同网络数据库容器匹配连接地址，未自动选择', candidates: matches.map(nameOf) };
  if (!matches.length) return { location: 'remote', reason: '连接地址未匹配同网络数据库容器，可能为外部数据库；尚未验证连通性' };
  const container = matches[0];
  const env = envOf(container);
  const args = [...(Array.isArray(container.Args) ? container.Args : []), ...(Array.isArray(container.Config?.Cmd) ? container.Config.Cmd : [])];
  const dataAt = args.indexOf('--datadir');
  const dataArgument = args.find(value => typeof value === 'string' && value.startsWith('--datadir='))?.slice('--datadir='.length) || (dataAt >= 0 ? args[dataAt + 1] : '');
  const defaults = { postgresql: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', clickhouse: '/var/lib/clickhouse' };
  const directory = type === 'postgresql' ? env.PGDATA || defaults[type] : type === 'mysql' ? dataArgument || env.MYSQL_DATADIR || defaults[type] : defaults[type];
  const dataDirectory = typeof directory === 'string' && directory.startsWith('/') && !/[\0\r\n]/.test(directory) ? posix.normalize(directory) : '';
  return { location: 'container', databaseContainer: {
    name: nameOf(container), ...(container.Id ? { id: container.Id } : {}), ...projectInfo(container),
    ...(dataDirectory ? { dataDirectory } : {}),
    mounts: (container.Mounts || []).map(mountInfo)
  } };
}

export function sanitizedDatabase(config, containers = []) {
  if (!config || config.version !== 1 || !config.main || !config.logs) throw new Error('数据库识别配置格式无效');
  const source = config.source || {};
  function sanitized(database) {
    if (database.sameAs === 'main') return { sameAs: 'main', type: database.type };
    const result = { type: database.type };
    if (database.endpoint) {
      result.endpoint = Object.fromEntries(['host', 'port', 'database', 'socket'].filter(key => database.endpoint[key] !== undefined).map(key => [key, database.endpoint[key]]));
      Object.assign(result, locateDatabase(result.endpoint, source, containers, database.type));
    } else {
      for (const key of ['containerPath', 'hostPath', 'location', 'reason']) if (database[key] !== undefined) result[key] = database[key];
      if (database.configuredPath) result.configuredPath = database.configuredPath.split('?')[0];
      if (database.mount) result.mount = Object.fromEntries(['type', 'name', 'source', 'destination', 'readOnly'].filter(key => database.mount[key] !== undefined).map(key => [key, database.mount[key]]));
    }
    return result;
  }
  return { version: 1, ...(config.container ? { container: config.container } : {}),
    ...(config.mode ? { mode: config.mode } : {}),
    ...(config.source ? { source: { project: source.project || '', service: source.service || '', workingDirectory: source.workingDirectory || '', configFiles: Array.isArray(source.configFiles) ? source.configFiles : [], networkMode: source.networkMode || '', networks: Array.isArray(source.networks) ? source.networks : [] } } : {}),
    ...(config.detectedAt ? { detectedAt: config.detectedAt } : {}),
    main: sanitized(config.main), logs: sanitized(config.logs), connected: false, quotaWriteMode: 'newapi-api' };
}

export function databaseSummary(config) {
  if (!config || config.version !== 1 || !config.main?.type || !config.logs?.type) throw new Error('数据库识别配置格式无效');
  if (config.mode === 'api') return 'API 接入；未获取原站数据库文件，补款通过原站接口执行。';
  const allowed = new Set(['mysql', 'postgresql', 'sqlite', 'clickhouse', 'unknown']);
  if (!allowed.has(config.main.type) || !allowed.has(config.logs.type)) throw new Error('数据库类型无效');
  return `主库 ${config.main.type}；日志库 ${config.logs.sameAs === 'main' ? '与主库共用' : config.logs.type}；仅识别配置，未直连数据库，补款仍走 云中猫API小站 接口。`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(sanitizedDatabase(discoverDatabase(JSON.parse(readFileSync(0, 'utf8')))), null, 2) + '\n'); }
  catch { console.error('数据库自动识别失败；未输出容器环境或数据库凭据。检查配置后重试。'); process.exitCode = 1; }
}
