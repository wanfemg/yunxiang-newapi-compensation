import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NewAPI } from './newapi.mjs';

const messages = {
  status: '站点公开状态读取',
  identity: '管理身份与站长 ID 核验',
  logs: '消费日志读取与分页格式',
  quota: '用户资料与额度读取',
  groups: '规则关联的用户组读取',
  channels: '规则关联的渠道与模型目录读取'
};

// Report only fixed check descriptions and numeric identity, never upstream bodies or credentials.
export async function checkUpstream(options = {}, fetchImpl = fetch) {
  const checks = [];
  const report = { ok: false, scope: 'readonly-api', checks };
  let api, selfQuota;
  try {
    const id = Number(options.adminUserId);
    if (!Number.isSafeInteger(id) || id < 1 || typeof options.adminToken !== 'string' ||
        !options.adminToken || /\s/.test(options.adminToken)) throw Error('invalid credentials');
    api = new NewAPI({ url: options.url, adminToken: options.adminToken,
      adminUserId: id, allowHttp: options.allowHttp === true, fetcher: async (url, request) => {
        const response = await fetchImpl(url, request);
        if (url.pathname === '/api/user/self' && response.ok) {
          try { selfQuota = (await response.clone().json()).data?.quota; } catch { /* identity validates the original response */ }
        }
        return response;
      } });
    const metadata = options.metadata;
    const host = api.url.hostname;
    if (metadata?.container && String(metadata.container).toLowerCase() !== host.toLowerCase() &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw Error('instance metadata mismatch');
  } catch {
    checks.push({ name: 'configuration', status: 'failed', message: '接入地址、管理凭据或实例关联配置无效；未发送管理请求。' });
    return report;
  }
  const probe = async (name, action, optional = false) => {
    try {
      const result = await action();
      return result?.name === name && result.status === 'warning' ? result
        : { name, status: 'passed', message: messages[name] + '通过。' };
    } catch {
      return { name, status: optional ? 'warning' : 'failed',
        message: messages[name] + (optional ? '未验证；此项不作为核心接入成功依据。' : '失败；检查原站地址、接口兼容性和管理权限。') };
    }
  };
  const status = probe('status', () => api.request('/api/status'), true);
  const identity = await probe('identity', async () => {
    const user = await api.identity(api.adminToken, api.adminUserId);
    if (user.role < 10 || user.id !== api.adminUserId) throw Error('identity mismatch');
    report.identity = { id: user.id, role: user.role };
  });
  checks.push(await status, identity);
  if (identity.status !== 'passed') return report;
  checks.push(...await Promise.all([
    probe('logs', () => api.logs({ page: 1, start: Math.floor(Date.now() / 1000) - 3600 })),
    probe('quota', async () => {
      if (report.identity.role < 100) {
        if (!Number.isSafeInteger(selfQuota)) throw Error('incompatible self quota');
        return { name: 'quota', status: 'warning', message: '当前管理员本人额度读取通过；同级保护下未探测其他用户详情，补偿目标读取能力尚未验证。' };
      }
      const user = await api.target(api.adminUserId);
      if (user?.id !== api.adminUserId || !Number.isSafeInteger(user.quota)) throw Error('incompatible user quota');
    }),
    probe('groups', () => api.groups()),
    probe('channels', async () => {
      // The runtime follows every page; one bounded page is sufficient for a connectivity check.
      const data = (await api.request('/api/channel/?p=1&page_size=1', api.admin())).data;
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          (data.total > 0 && data.items.length === 0) || data.items.some(channel =>
            !Number.isSafeInteger(channel?.id) || channel.id < 1)) throw Error('incompatible channel catalog');
    })
  ]));
  report.ok = checks.every(check => check.status !== 'failed');
  return report;
}

function reachable(endpoint, connect, timeoutMs) {
  return new Promise(resolve => {
    let socket, timer, finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    try {
      socket = connect({ host: endpoint.host, port: Number(endpoint.port) });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch { finish(false); }
  });
}

// Run in the selected NewAPI network namespace, not the compensation network.
// Opening a TCP port is deliberately separate from SQL authentication/schema verification.
export async function checkDatabaseEndpoint(config = {}, { connect = createConnection, timeoutMs = 5000 } = {}) {
  const timeout = Math.min(30000, Math.max(100, Number(timeoutMs) || 5000));
  const checks = await Promise.all(['main', 'logs'].map(async name => {
    const database = config[name] || {};
    const type = ['mysql', 'postgresql', 'clickhouse', 'sqlite'].includes(database.type) ? database.type : 'unknown';
    if (name === 'logs' && database.sameAs === 'main') return { name, type, status: 'shared', sameAs: 'main', message: '日志库与主库共用连接。' };
    if (type === 'sqlite') return { name, type, status: 'unverified', message: 'SQLite 文件须从源容器单独进行只读文件和表结构检查。' };
    const endpoint = database.endpoint;
    if (type === 'unknown' || database.location === 'ambiguous' || database.ambiguous || !endpoint || endpoint.socket ||
        typeof endpoint.host !== 'string' || !endpoint.host || /[\s/@\\]/.test(endpoint.host) ||
        !Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
      return { name, type, status: 'unverified', message: '未唯一定位可探测的 TCP 数据库端点；未验证数据库连接。' };
    }
    const open = await reachable(endpoint, connect, timeout);
    return { name, type, status: open ? 'reachable' : 'failed',
      message: open ? '源站网络内数据库 TCP 端口可达；数据库认证与表结构尚未验证。' : '源站网络内数据库 TCP 端口不可达或超时。' };
  }));
  return { ok: checks.every(check => ['reachable', 'shared'].includes(check.status)), verified: false,
    scope: 'upstream-network-tcp-only', authentication: 'unverified', schema: 'unverified', checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const report = process.argv[2] === '--database' ? await checkDatabaseEndpoint(input)
      : process.argv[2] === '--upstream' ? await checkUpstream(input)
      : (() => { throw Error('unknown command'); })();
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('只读检查输入无效；未输出接入配置或凭据。');
    process.exitCode = 1;
  }
}
