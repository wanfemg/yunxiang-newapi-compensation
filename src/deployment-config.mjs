import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function normalizePublicOrigin(input, port = 3210) {
  const value = String(input).trim();
  if (!value || /[\s$]/.test(value)) throw Error('域名格式无效');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('域名必须是根地址，不能包含路径、参数或凭据');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw Error('公网域名必须使用 HTTPS');
  }
  if (!url.hostname.startsWith('[') && !url.hostname.split('.').every(label =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw Error('域名格式无效');
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw Error('端口无效');
  return url.origin;
}

export function parseDeploymentEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || /[\r\n$`]/.test(match[2])) throw Error('部署配置格式无效');
    env[match[1]] = match[2];
  }
  if (!/^[1-9]\d*$/.test(env.NEWAPI_ADMIN_USER_ID || '')) throw Error('站长 ID 无效');
  if (!env.PUBLIC_ORIGIN || normalizePublicOrigin(env.PUBLIC_ORIGIN) !== env.PUBLIC_ORIGIN) {
    throw Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 根地址或本机 HTTP 地址');
  }
  const upstream = new URL(env.NEWAPI_URL);
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.pathname !== '/' || upstream.search || upstream.hash) throw Error('原站地址格式无效');
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , command, key, value] = process.argv;
    if (command === 'origin') console.log(normalizePublicOrigin(key, value));
    else {
      const env = parseDeploymentEnv(readFileSync(0, 'utf8'));
      if (command === 'get') process.stdout.write(env[key] || '');
      else if (command === 'check') process.stdout.write('ok');
      else throw Error('未知的配置操作');
    }
  } catch (error) {
    console.error(error instanceof TypeError ? '地址格式无效。' : error.message);
    process.exitCode = 1;
  }
}
