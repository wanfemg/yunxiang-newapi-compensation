import { NewAPI } from './newapi.mjs';
import { managementToken } from './config.mjs';
import { readFileSync } from 'node:fs';
import { databaseSummary } from './db-discovery.mjs';

// Read-only: no claims, quota changes or upstream database mutations.
try {
  if (process.env.NEWAPI_DB_CONFIG_FILE) {
    let metadata;
    try { metadata = JSON.parse(readFileSync(process.env.NEWAPI_DB_CONFIG_FILE, 'utf8')); }
    catch { throw new Error('数据库识别配置无法读取或格式无效'); }
    const host = new URL(process.env.NEWAPI_URL).hostname;
    if (metadata.container && metadata.container !== host && !['127.0.0.1','localhost','[::1]'].includes(host)) throw new Error('数据库识别容器与 NewAPI 接口实例不一致');
    console.log(metadata.mode==='api'?'主机或远程 API 接入；不读取原站数据库凭据。':databaseSummary(metadata));
  }
  const api = new NewAPI({ url: process.env.NEWAPI_URL, adminToken: managementToken(), adminUserId: process.env.NEWAPI_ADMIN_USER_ID, allowHttp: process.env.ALLOW_HTTP_UPSTREAM === '1' });
  const identity = await api.identity(api.adminToken, api.adminUserId);
  if (identity.role < 10 || identity.id !== Number(process.env.NEWAPI_ADMIN_USER_ID)) throw new Error('管理身份与配置 ID 不符，或权限不足');
  await api.logs({ page: 1, start: Math.floor(Date.now() / 1000) - 3600 });
  console.log('只读接入检查通过：管理身份与日志接口可用；未执行额度返还。');
} catch (error) {
  console.error('只读接入检查失败：' + error.message);
  process.exitCode = 1;
}
