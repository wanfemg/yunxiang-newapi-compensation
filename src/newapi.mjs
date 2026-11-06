import { randomBytes, publicEncrypt, createCipheriv } from 'node:crypto';
import { AppError, positiveInt } from './rules.mjs';
import {displayConfig} from '../public/display.js';

export class UpstreamError extends AppError {
  constructor(message, definitive = false, upstreamStatus = 0) { super(message, 502); this.definitive = definitive; this.upstreamStatus = upstreamStatus; }
}
function sessionCookie(cookies, previous = '') {
  const jar = new Map(previous.split(';').map(v => v.trim()).filter(Boolean).map(v => { const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)]; }));
  for (const line of cookies) {
    const pair=line.split(';',1)[0],i=pair.indexOf('=');
    if(i>0 && !/[\r\n]/.test(pair)) jar.set(pair.slice(0,i),pair.slice(i+1));
  }
  return [...jar].map(([k,v])=>`${k}=${v}`).join('; ');
}
export class NewAPI {
  constructor({ url, adminToken, adminUserId, allowHttp = false, fetcher = fetch }) {
    this.url = new URL(url);
    if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/') throw new AppError('NEWAPI_URL 必须是无凭据的站点根地址');
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && (allowHttp || ['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname)))) throw new AppError('云中猫API小站 非本机地址必须使用 HTTPS');
    this.adminToken = adminToken; this.adminUserId = Number(adminUserId); this.fetcher = fetcher;
  }
  async request(path, { token, userId, body, method = 'GET', cookie } = {}) {
    const headers = { Accept: 'application/json' };
    if (typeof token === 'string' && token) headers.Authorization = `Bearer ${token}`;
    else if (token?.cookie) cookie = token.cookie;
    if (userId) headers['New-Api-User'] = String(userId);
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetcher(new URL(path, this.url), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new UpstreamError('云中猫API小站 连接失败或请求超时'); }
    if ([404,405].includes(response.status)) throw new UpstreamError('云中猫API小站 接口不存在或不支持（HTTP '+response.status+'）',false,response.status);
    let data;
    try { data = await response.json(); } catch { throw new UpstreamError('云中猫API小站 返回了无法确认的响应'); }
    if (!response.ok || data.success !== true) {
      // Only a parsed success:false in a 2xx response is a definitive business refusal.
      throw new UpstreamError('云中猫API小站 未接受操作，请在原站核查权限、配置或验证要求', response.ok && data.success === false);
    }
    return { data: data.data, cookies: response.headers.getSetCookie?.() || [] };
  }
  async login(username, password) {
    let key;
    try { key = (await this.request('/api/user/login/encryption-key')).data; }
    catch (error) { if (![404,405].includes(error.upstreamStatus)) throw error; }
    let body = { username, password };
    if (key?.enabled) {
      const aes = randomBytes(32), nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', aes, nonce);
      cipher.setAAD(Buffer.from(`password-v2:${key.kid}`));
      const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const wrapped = publicEncrypt({ key: key.public_key, oaepHash: 'sha256', oaepLabel: Buffer.from('password-v2') }, aes);
      body = { username, encryption_key_id: key.kid, password_encrypted: `v2.${wrapped.toString('base64')}.${nonce.toString('base64')}.${encrypted.toString('base64')}` };
    }
    return this.loginResult(await this.request('/api/user/login', { method: 'POST', body }));
  }
  loginResult(result, previousCookie = '') {
    const data=result.data,cookie=sessionCookie(result.cookies,previousCookie);
    if(data?.access_token || data?.require_verification) return data;
    if(data?.require_2fa && cookie) return {require_verification:true,flow_token:{legacyCookie:cookie},methods:['2fa']};
    if(data?.id && cookie) return {user:data,session_cookie:cookie};
    return data;
  }
  async verify(flowToken, code) {
    if(flowToken?.legacyCookie) return this.loginResult(await this.request('/api/user/login/2fa',{method:'POST',cookie:flowToken.legacyCookie,body:{code}}),flowToken.legacyCookie);
    return (await this.request('/api/user/login/verify', { method: 'POST', body: { flow_token: flowToken, method: '2fa', code } })).data;
  }
  async identity(token, userId) {
    const result = await this.request('/api/user/self', { token, userId }),u=result.data;
    positiveInt(u?.id, '原用户 ID');
    if (userId && u.id !== Number(userId)) throw new AppError('云中猫API小站 登录身份不一致',401);
    if (!u.username || ![1, 10, 100].includes(u.role) || u.status !== 1) throw new AppError('原站用户不可用', 401);
    if(token?.cookie) token.cookie=sessionCookie(result.cookies,token.cookie);
    return { id: u.id, username: u.username, display_name: u.display_name || u.username, role: u.role, group: u.group };
  }
  admin() {
    if (!this.adminToken || !Number.isSafeInteger(this.adminUserId) || this.adminUserId <= 0) throw new AppError('尚未配置 云中猫API小站 管理凭据，日志及返还暂不可用', 503);
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
    const result=await this.request('/api/user/manage', { ...this.admin(), method: 'POST', body: { id: userId, action: 'add_quota', mode: 'add', value: amount } });
    // Older ManageUser silently ignores unknown actions and returns role/status.
    if(result.data && typeof result.data==='object' && ('role' in result.data || 'status' in result.data)) throw new UpstreamError('原站返回用户状态而非增额确认，额度接口可能不兼容；须人工核对，禁止自动重试');
  }
}
