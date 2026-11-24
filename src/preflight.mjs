import { managementToken } from './config.mjs';
import { readFileSync } from 'node:fs';
import { databaseSummary } from './db-discovery.mjs';
import { checkUpstream } from './upstream-check.mjs';

// Read-only: no claims, quota changes or upstream database mutations.
try {
  let metadata;
  if (process.env.NEWAPI_DB_CONFIG_FILE) {
    try { metadata = JSON.parse(readFileSync(process.env.NEWAPI_DB_CONFIG_FILE, 'utf8')); }
    catch { throw new Error('数据库识别配置无法读取或格式无效'); }
    console.log(metadata.mode==='api'?'主机或远程 API 接入；不读取原站数据库凭据。':databaseSummary(metadata));
  }
  const report = await checkUpstream({ url: process.env.NEWAPI_URL, adminToken: managementToken(),
    adminUserId: process.env.NEWAPI_ADMIN_USER_ID, allowHttp: process.env.ALLOW_HTTP_UPSTREAM === '1', metadata });
  for (const check of report.checks) console.log(`[${check.status}] ${check.message}`);
  if (!report.ok) throw Error('管理身份、日志、用户额度读取或规则关联接口检查未通过');
  console.log('只读接入检查通过：管理身份、日志、用户额度读取、用户组及渠道模型接口可用；未执行额度返还，未验证写入能力。');
  if (report.checks.some(check => check.status === 'warning')) console.log('兼容性提示：部分能力仅通过替代的只读检查或尚未验证，以上分项提示继续保留。');
} catch (error) {
  console.error('只读接入检查失败：' + error.message);
  process.exitCode = 1;
}
