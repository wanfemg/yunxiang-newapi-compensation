import { readFileSync } from 'node:fs';
import { AppError } from './rules.mjs';

export function managementToken(env = process.env) {
  if (env.NEWAPI_ADMIN_TOKEN_FILE) {
    let value;
    try { value = readFileSync(env.NEWAPI_ADMIN_TOKEN_FILE, 'utf8').trim(); }
    catch { throw new AppError('管理令牌文件不可读取，检查 secret 挂载与权限', 503); }
    if (!value || /\s/.test(value)) throw new AppError('管理令牌文件为空或格式无效', 503);
    return value;
  }
  return env.NEWAPI_ADMIN_TOKEN || '';
}
