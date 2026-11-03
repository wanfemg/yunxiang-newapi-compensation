import { posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Deployment metadata only: never opens a database or executes SQL.
export function discoverDatabase(container) {
  const env = Object.fromEntries((container.Config?.Env || []).map(line => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (env.SQL_DSN_FILE || env.LOG_SQL_DSN_FILE) {
    throw new Error('数据库使用文件型配置，自动识别不读取容器内的凭据文件');
  }
  function database(dsn, isLog) {
    if (!dsn || dsn.startsWith('local')) {
      const configured = env.SQLITE_PATH || 'one-api.db';
      const raw = configured.split('?')[0];
      if (raw === ':memory:' || raw.startsWith('file:')) {
        return { type: 'sqlite', configuredPath: configured, location: 'unresolved', reason: '特殊 SQLite DSN，需要人工核对' };
      }
      const containerPath = posix.resolve(container.Config?.WorkingDir || '/', raw);
      const mount = [...(container.Mounts || [])].filter(m =>
        containerPath === m.Destination || containerPath.startsWith(m.Destination.replace(/\/$/, '') + '/')
      ).sort((a, b) => b.Destination.length - a.Destination.length)[0];
      return { type: 'sqlite', configuredPath: configured, containerPath,
        location: mount ? 'mounted' : 'container-layer',
        ...(mount ? { mount: { type: mount.Type, name: mount.Name || null, source: mount.Source, destination: mount.Destination },
          hostPath: posix.join(mount.Source, posix.relative(mount.Destination, containerPath)) } : {}) };
    }
    let type = 'mysql';
    if (/^postgres(ql)?:\/\//.test(dsn)) type = 'postgresql';
    else if (/^(clickhouse|tcp|http|https):\/\//.test(dsn)) type = 'clickhouse';
    if (type === 'clickhouse' && !isLog) throw new Error('识别到不支持的 ClickHouse 主库配置');
    return { type, dsn };
  }
  const main = database(env.SQL_DSN, false);
  const logs = env.LOG_SQL_DSN ? database(env.LOG_SQL_DSN, true) : { sameAs: 'main', type: main.type };
  return { version: 1, container: (container.Name || '').replace(/^\//, ''),
    detectedAt: new Date().toISOString(), main, logs, connected: false, quotaWriteMode: 'newapi-api' };
}

export function databaseSummary(config) {
  if (!config || config.version !== 1 || !config.main?.type || !config.logs?.type) throw new Error('数据库识别配置格式无效');
  const allowed = new Set(['mysql', 'postgresql', 'sqlite', 'clickhouse']);
  if (!allowed.has(config.main.type) || !allowed.has(config.logs.type)) throw new Error('数据库类型无效');
  return `主库 ${config.main.type}；日志库 ${config.logs.sameAs === 'main' ? '与主库共用' : config.logs.type}；仅识别配置，未直连数据库，补款仍走 NewAPI 接口。`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(discoverDatabase(JSON.parse(readFileSync(0, 'utf8'))), null, 2) + '\n'); }
  catch { console.error('数据库自动识别失败；未输出容器环境或数据库凭据。检查配置后重试。'); process.exitCode = 1; }
}
