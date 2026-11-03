import { randomBytes, publicEncrypt, createCipheriv } from 'node:crypto';
import { AppError, positiveInt } from './rules.mjs';
import {displayConfig} from '../public/display.js';

export class UpstreamError extends AppError {
  constructor(message, definitive = false) { super(message, 502); this.definitive = definitive; }
}
export class NewAPI {
  constructor({ url, adminToken, adminUserId, allowHttp = false, fetcher = fetch }) {
    this.url = new URL(url);
    if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/') throw new AppError('NEWAPI_URL 必须是无凭据的站点根地址');
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && (allowHttp || ['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname)))) throw new AppError('NewAPI 非本机地址必须使用 HTTPS');
    this.adminToken = adminToken; this.adminUserId = Number(adminUserId); this.fetcher = fetcher;
  }
  async request(path, { token, userId, body, method = 'GET', cookie } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (userId) headers['New-Api-User'] = String(userId);
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetcher(new URL(path, this.url), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new UpstreamError('NewAPI 连接失败或请求超时'); }
    let data;
    try { data = await response.json(); } catch { throw new UpstreamError('NewAPI 返回了无法确认的响应'); }
    if (!response.ok || data.success !== true) {
      // Only a parsed success:false in a 2xx response is a definitive business refusal.
      throw new UpstreamError('NewAPI 未接受操作，请在原站核查权限、配置或验证要求', response.ok && data.success === false);
    }
    return { data: data.data, cookies: response.headers.getSetCookie?.() || [] };
  }
  async login(username, password) {
    const key = (await this.request('/api/user/login/encryption-key')).data;
    let body = { username, password };
    if (key?.enabled) {
      const aes = randomBytes(32), nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', aes, nonce);
      cipher.setAAD(Buffer.from(`password-v2:${key.kid}`));
      const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const wrapped = publicEncrypt({ key: key.public_key, oaepHash: 'sha256', oaepLabel: Buffer.from('password-v2') }, aes);
      body = { username, encryption_key_id: key.kid, password_encrypted: `v2.${wrapped.toString('base64')}.${nonce.toString('base64')}.${encrypted.toString('base64')}` };
    }
    return (await this.request('/api/user/login', { method: 'POST', body })).data;
  }
  async verify(flowToken, code) { return (await this.request('/api/user/login/verify', { method: 'POST', body: { flow_token: flowToken, method: '2fa', code } })).data; }
  async identity(token, userId) {
    const u = (await this.request('/api/user/self', { token, userId })).data;
    positiveInt(u?.id, '原用户 ID');
    if (!u.username || ![1, 10, 100].includes(u.role) || u.status !== 1) throw new AppError('原站用户不可用', 401);
    return { id: u.id, username: u.username, display_name: u.display_name || u.username, role: u.role, group: u.group };
  }
  admin() {
    if (!this.adminToken || !Number.isSafeInteger(this.adminUserId) || this.adminUserId <= 0) throw new AppError('尚未配置 NewAPI 管理凭据，日志及返还暂不可用', 503);
    return { token: this.adminToken, userId: this.adminUserId };
  }
  async logs({ user, username = '', page = 1, requestId = '', model = '', start, end, channel = '' }) {
    const q = new URLSearchParams({ p: String(page), page_size: '30', type: '2' });
    if (user) q.set('username', user.username);
    else if (username) q.set('username', username);
    if (requestId) q.set('request_id', requestId);
    if (model) q.set('model_name', model);
    if (start) q.set('start_timestamp', String(start));
    if (end) q.set('end_timestamp', String(end));
    if (channel) q.set('channel', String(channel));
    const data = (await this.request(`/api/log/?${q}`, this.admin())).data;
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)) throw new UpstreamError('日志接口格式不兼容');
    const items = user ? data.items.filter(l => l.user_id === user.id) : data.items;
    return { items, total: data.total, page };
  }
  async log(requestId) {
    const data = await this.logs({ requestId });
    const exact = data.items.filter(l => l.request_id === requestId && l.type === 2);
    if (data.total !== 1 || exact.length !== 1) throw new AppError('原消费不存在或请求标识不唯一，禁止自动关联', 409);
    return exact[0];
  }
  async target(id) { return (await this.request(`/api/user/${positiveInt(id)}`, this.admin())).data; }
  async display(){return displayConfig((await this.request('/api/status')).data);}
  async groups(){
    const names=(await this.request('/api/group/',this.admin())).data;
    if(!Array.isArray(names)||names.length>1000||names.some(name=>typeof name!=='string'||!name.trim()||name.length>200))throw new UpstreamError('用户组接口格式不兼容');
    return {groups:[...new Set(names)].sort()};
  }
  async catalog(){
    const channels=[];let page=1,total=Infinity;
    while(channels.length<total){
      const data=(await this.request('/api/channel/?p='+page+'&page_size=100',this.admin())).data;
      if(!data||!Array.isArray(data.items)||!Number.isSafeInteger(data.total)||data.total<0)throw new UpstreamError('渠道接口格式不兼容');
      total=data.total;if(total>10000||(!data.items.length&&channels.length<total))throw new UpstreamError('渠道列表不完整');
      channels.push(...data.items.map(c=>({id:positiveInt(c.id),name:String(c.name||'渠道 '+c.id),status:Number(c.status),models:[...new Set(String(c.models||'').split(',').map(m=>m.trim()).filter(Boolean))]})));
      page++;if(page>1001)throw new UpstreamError('渠道分页异常');
    }
    return {channels,updatedAt:Date.now()};
  }
  async credit(userId, amount) {
    await this.request('/api/user/manage', { ...this.admin(), method: 'POST', body: { id: userId, action: 'add_quota', mode: 'add', value: amount } });
  }
}
