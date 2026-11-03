import { createServer } from 'node:http';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { AppError, defaults, fundingSource } from './rules.mjs';
import { Store } from './store.mjs';
import { NewAPI } from './newapi.mjs';
import { Compensation } from './service.mjs';
import { DingTalk } from './notifications.mjs';
import { managementToken } from './config.mjs';
import {parseQuota} from '../public/display.js';
import { Branding } from './branding.mjs';
import { StorageMaintenance } from './storage.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const cleanUser = u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role });
async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new AppError('请求体过大', 413); }
  try { const value = JSON.parse(body || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; } catch { throw new AppError('JSON 请求格式错误'); }
}
function pageValue(value) { const n = Number(value || 1); if (!Number.isSafeInteger(n) || n < 1 || n > 10000) throw new AppError('页码无效'); return n; }

export function createApplication({ store, upstream, origin = 'http://127.0.0.1:3210', dingTalk = null }) {
  const branding = new Branding(upstream);
  const storage = new StorageMaintenance(store);
  const service = new Compensation(store, upstream), sessions = new Map(), challenges = new Map(), rate = new Map();
  const expectedOrigin = new URL(origin).origin, secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-comp_session' : 'comp_session';
  function setSession(res, token, user) {
    const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    sessions.set(digest(raw), { token, user, csrf, expires: Date.now() + 8 * 3600000 });
    res.setHeader('Set-Cookie', `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
    return { user: cleanUser(user), csrf };
  }
  async function finishLogin(data, res) {
    if (!data?.access_token) {
      if (data?.require_verification && data.flow_token) {
        const challengeId = randomBytes(24).toString('base64url');
        challenges.set(challengeId, { flow: data.flow_token, expires: Date.now() + 300000 });
        return { challengeId, methods: data.methods, requireVerification: true };
      }
      throw new AppError('原站登录响应不兼容或需要其他验证方式', 401);
    }
    const user = await upstream.identity(data.access_token, data.user?.id);
    return setSession(res, data.access_token, user);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true, data })); };
    try {
      const url = new URL(req.url, expectedOrigin), path = url.pathname;
      if (req.method === 'GET' && ['/','/app.js','/style.css','/glass.css','/icons.js','/display.js','/controls.js'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(readFileSync(join(publicDirectory, file))); return;
      }
      if (path === '/api/health' && req.method === 'GET') return send({ status: 'ok', configured: Boolean(upstream.adminToken) });
      if (path === '/api/brand' && req.method === 'GET') {
        try { const brand = await branding.read(); return send({ name: brand.name, logo: brand.logo }); }
        catch { return send({ name: '云响', logo: '' }); }
      }
      if (path === '/api/brand/logo' && req.method === 'GET') {
        const logo = await branding.image();
        res.setHeader('Content-Type', logo.type); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.end(logo.body); return;
      }
      if (!path.startsWith('/api/')) throw new AppError('接口不存在', 404);
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (mutating && req.headers.origin !== expectedOrigin) throw new AppError('请求来源校验失败', 403);
      if (mutating && !String(req.headers['content-type']).startsWith('application/json')) throw new AppError('仅接受 JSON 请求', 415);
      if (path.startsWith('/api/auth/') && req.method === 'POST' && path !== '/api/auth/logout') {
        const ip = req.socket.remoteAddress || '';
        const bucket = rate.get(ip) || { n: 0, until: Date.now() + 600000 };
        if (bucket.until < Date.now()) { bucket.n = 0; bucket.until = Date.now() + 600000; }
        bucket.n++; rate.set(ip, bucket);
        if (bucket.n > 20) throw new AppError('登录尝试过多，稍后重试', 429);
        const b = await readBody(req);
        if (path === '/api/auth/login') {
          if (typeof b.username !== 'string' || !b.username.trim() || b.username.length > 100 || typeof b.password !== 'string' || !b.password || b.password.length > 1024) throw new AppError('账号或密码格式错误');
          return send(await finishLogin(await upstream.login(b.username.trim(), b.password), res));
        }
        if (path === '/api/auth/verify') {
          const c = challenges.get(b.challengeId);
          if (!c || c.expires < Date.now()) throw new AppError('验证已失效，请重新登录', 401);
          if (typeof b.code !== 'string' || !/^\d{6,8}$/.test(b.code)) throw new AppError('验证码格式错误');
          // Each local challenge is single use, including failed verification.
          challenges.delete(b.challengeId);
          return send(await finishLogin(await upstream.verify(c.flow, b.code), res));
        }
        throw new AppError('登录接口不存在', 404);
      }
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')));
      const key = digest(cookies[cookieName] || ''), session = sessions.get(key);
      if (!session || session.expires < Date.now()) { sessions.delete(key); throw new AppError('请使用 NewAPI 账号登录', 401); }
      if (mutating && req.headers['x-csrf-token'] !== session.csrf) throw new AppError('请求凭据校验失败', 403);
      // Every request revalidates original identity/role; never trust browser roles.
      let user; try { user = await upstream.identity(session.token, session.user.id); } catch (e) { sessions.delete(key); throw new AppError('原站登录已失效或暂不可用，请重新登录', 401); }
      if (user.id !== session.user.id) { sessions.delete(key); throw new AppError('身份不一致', 401); }
      session.user = user;
      if (path.startsWith('/api/admin/')) service.requireAdmin(user);
      if (path === '/api/me' && req.method === 'GET') return send({ user: cleanUser(user), csrf: session.csrf });
      if (path === '/api/auth/logout' && req.method === 'POST') { sessions.delete(key); res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`); return send({}); }
      const admin = path.startsWith('/api/admin/'), base = path.replace('/api/admin/', '/api/');
      if(path==='/api/display'&&req.method==='GET'){
        const display=await upstream.display();store.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('display',?)").run(JSON.stringify(display));return send({...display,revision:digest(JSON.stringify(display))});
      }
      if(path==='/api/admin/catalog'&&req.method==='GET')return send(await upstream.catalog());
      if(path==='/api/admin/groups'&&req.method==='GET')return send(await upstream.groups());
      if(path==='/api/admin/storage'&&req.method==='GET')return send(storage.info());
      if(path==='/api/admin/storage/preview'&&req.method==='POST')return send(storage.preview(user.id,await readBody(req)));
      if(path==='/api/admin/storage/cleanup'&&req.method==='POST'){
        const body=await readBody(req);return send(storage.clean(user.id,body.token,body.confirmation));
      }
      if(path==='/api/admin/claim-groups'&&req.method==='GET'){
        const owner=url.searchParams.get('owner');
        if(owner!==null&&(!/^\d+$/.test(owner)||!Number.isSafeInteger(Number(owner))||Number(owner)<=0))throw new AppError('用户 ID 无效');
        return send(store.claimGroups(url.searchParams.get('status')||'',pageValue(url.searchParams.get('page')),owner===null?null:Number(owner)));
      }
      if(base==='/api/claim-counts'&&req.method==='GET')return send(store.statusCounts(admin?null:user.id));
      if (base === '/api/overview' && req.method === 'GET') return send(store.overview(admin ? null : user.id));
      if (path === '/api/statistics' && req.method === 'GET') return send(store.personalStatistics(user.id, Number(url.searchParams.get('days') || 30)));
      if(path==='/api/refund-records'&&req.method==='GET'){
        const data=store.refundRecords(user.id,pageValue(url.searchParams.get('page')));
        return send({...data,items:data.items.map(group=>({...group,claims:group.claims.map(c=>service.view(c))}))});
      }
      if (base === '/api/logs' && req.method === 'GET') {
        const query = { page: pageValue(url.searchParams.get('page')), model: url.searchParams.get('model') || '', requestId: url.searchParams.get('requestId') || '', channel: url.searchParams.get('channel') || '', start: Number(url.searchParams.get('start')) || undefined, end: Number(url.searchParams.get('end')) || undefined };
        return send(await service.logs(user, query, admin));
      }
      if (base === '/api/claims' && req.method === 'GET') {
        const data = store.list(admin ? null : user.id, url.searchParams.get('status') || '', pageValue(url.searchParams.get('page')),admin?Object.fromEntries(['owner','model','channel'].map(k=>[k,url.searchParams.get(k)||''])):{});
        return send({ ...data, items: data.items.map(c => service.view(c, admin)) });
      }
      if (base === '/api/claims' && req.method === 'POST') {
        const b = await readBody(req);
        if (!Array.isArray(b.requestIds) || !b.requestIds.length || b.requestIds.length > 30) throw new AppError('每批提交 1–30 条消费');
        const result = [],runId=randomUUID();
        for (const id of [...new Set(b.requestIds)]) { try { const claim=admin?await service.apply(user,id,b.reason,true,false,runId):await service.selfService(user,id,b.reason,runId);result.push({ requestId: id, success: true, status:claim.status, claim }); } catch (e) { result.push({ requestId: id, success: false, message: e instanceof AppError ? e.message : '处理失败' }); } }
        return send(result);
      }
      const detail = base.match(/^\/api\/claims\/([a-f0-9-]{36})$/);
      if (detail && req.method === 'GET') {
        const c = service.claimFor(user, detail[1]);
        const events = store.db.prepare('SELECT actor_id,action,detail,created_at FROM events WHERE claim_id=? ORDER BY id').all(c.id).map(e => admin ? e : { action: e.action, created_at: e.created_at });
        return send({ ...service.view(c, admin), events });
      }
      if (admin && base === '/api/actions' && req.method === 'POST') {
        const b = await readBody(req);
        if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw new AppError('每批操作 1–30 条申请');
        let display;
        if(['execute','approve'].includes(b.action)&&b.items.some(item=>item.displayedAmount!==undefined)){
          display=await upstream.display();
          if(b.displayRevision!==digest(JSON.stringify(display)))throw new AppError('原站额度显示设置已变化，请关闭窗口并重新核对金额',409);
          store.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('display',?)").run(JSON.stringify(display));
        }
        const result = [];
        for (const item of b.items) {
          try {
            let c,verified=item.verifiedAmount;
            if(item.displayedAmount!==undefined){try{verified=parseQuota(item.displayedAmount,display);}catch(error){throw new AppError(error.message);}}
            if(b.action==='approve'&&fundingSource(service.claimFor(user,item.id).log)==='subscription')c=await service.approveSubscription(user,item.id,verified,item.note||b.note);
            else if (b.action === 'approve' || b.action === 'reject') c = service.review(user, item.id, b.action, b.note);
            else if (b.action === 'execute') {
              c = await service.execute(user, item.id, verified, item.note || b.note);
            }
            else if (b.action === 'reconcile') c = service.reconcile(user, item.id, item.outcome, item.note || b.note);
            else if (b.action === 'reopen') c = service.reopen(user, item.id, b.note);
            else throw new AppError('动作无效');
            result.push({ id: item.id, success: true, status: c.status });
          } catch (e) { result.push({ id: item.id, success: false, message: e instanceof AppError ? e.message : '处理失败，请检查服务端记录' }); }
        }
        return send(result);
      }
      if (base === '/api/rules' && req.method === 'GET') {
        const r = store.rules();
        return send(admin ? r : { version: r.version, applicationsEnabled: r.applicationsEnabled, executionEnabled: r.executionEnabled, selfServiceEnabled:r.selfServiceEnabled,selfServiceMaxQuota:r.selfServiceMaxQuota,selfServiceMinAgeSeconds:r.selfServiceMinAgeSeconds,timezone: r.timezone, dailyResetTime:r.dailyResetTime, models: r.models,restrictModels:r.restrictModels, refundBasisPoints: r.refundBasisPoints, perRecordQuota: r.perRecordQuota, userDailyQuota: r.userDailyQuota, userDailyCount: r.userDailyCount, maxPending: r.maxPending, applicationHours: r.applicationHours, lookbackDays:Math.ceil(r.applicationHours/24), openStart: r.openStart, openEnd: r.openEnd, consumptionStart: null, consumptionEnd: null });
      }
      if (admin && base === '/api/rules' && req.method === 'PUT') {
        const body=await readBody(req);
        if(body.displayRevision||body.displayedQuotas){
          const current=await upstream.display();
          if(body.displayRevision!==digest(JSON.stringify(current)))throw new AppError('原站额度显示设置已变化，请刷新规则页面后重新填写额度',409);
          if(body.displayedQuotas){
            for(const key of ['perRecordQuota','selfServiceMaxQuota','userDailyQuota','siteDailyQuota']){
              try{body[key]=parseQuota(body.displayedQuotas[key],current);}catch(e){throw new AppError(e.message);}
            }
          }
        }
        if(body.userGroups?.length){const available=await upstream.groups();if(body.userGroups.some(group=>!available.groups.includes(group)))throw new AppError('用户组已变更，请刷新原站用户组后重新选择',409);}
        if(body.lookbackDays!==undefined){
          if(!Number.isSafeInteger(body.lookbackDays)||body.lookbackDays<1||body.lookbackDays>3650)throw new AppError('日志读取天数须为 1–3650 的整数');
          body.applicationHours=body.lookbackDays*24;
          body.consumptionStart=null;body.consumptionEnd=null;body.openStart='00:00';body.openEnd='00:00';
        }
        return send(service.saveRules(user,body));
      }
      if (admin && base === '/api/stats' && req.method === 'GET') return send(store.adminStatistics(url.searchParams.get('kind') || 'users',pageValue(url.searchParams.get('page'))));
      if (admin && base === '/api/audit' && req.method === 'GET') return send(store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all());
      if (admin && base === '/api/notifications' && req.method === 'GET') return send({ config: dingTalk?.status() || { configured: false }, items: store.db.prepare('SELECT id,event,status,attempts,result,created_at FROM notifications ORDER BY id DESC LIMIT 100').all() });
      if (admin && base === '/api/notifications' && req.method === 'PUT') {
        if (!dingTalk) throw new AppError('通知存储不可用', 503);
        const result = dingTalk.save(await readBody(req)); store.event(null, user.id, 'notification_config_updated', result); return send(result);
      }
      if (admin && base === '/api/notifications/test' && req.method === 'POST') {
        if (!dingTalk?.status().configured || !store.rules().notifications.enabled) throw new AppError('先配置机器人并开启通知');
        store.notify('notification_test', '机器人连接测试'); return send({ queued: true });
      }
      throw new AppError('接口不存在', 404);
    } catch (e) {
      res.statusCode = e instanceof AppError ? e.status : 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, message: e instanceof AppError ? e.message : '服务内部错误，操作结果请查看处理记录' }));
      if (!(e instanceof AppError)) console.error('Request failed:', e.name);
    }
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
    for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
    for (const [key, value] of rate) if (value.until < now) rate.delete(key);
    dingTalk?.flush().catch(() => console.error('Notification worker failed'));
  }, 15000);
  timer.unref(); server.on('close', () => clearInterval(timer));
  return { server, service };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const data = resolve(process.env.DATA_DIR || './data'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const store = new Store(join(data, 'compensation.sqlite'));
  const upstream = new NewAPI({ url: process.env.NEWAPI_URL || 'http://127.0.0.1:3000', adminToken: managementToken(), adminUserId: process.env.NEWAPI_ADMIN_USER_ID, allowHttp: process.env.ALLOW_HTTP_UPSTREAM === '1' });
  if (process.env.NEWAPI_URL) store.bindInstance(upstream.url);
  const port = Number(process.env.PORT || 3210), host = process.env.HOST || '127.0.0.1';
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  if (new URL(origin).protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('公网访问的 PUBLIC_ORIGIN 必须为 HTTPS');
  const dingTalk = new DingTalk(store, data);
  const { server } = createApplication({ store, upstream, origin, dingTalk });
  server.listen(port, host, () => console.log(`NewAPI 补空回已启动：${origin}（未配置上游时仅显示登录入口）`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
