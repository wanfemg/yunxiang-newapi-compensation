import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { defaults, AppError, settlementClock, expectedQuota, fundingSource, compensationLabel, validateRules } from './rules.mjs';
import {formatQuota} from '../public/display.js';
import {notificationTitle,batchNotificationTitle} from './notification-titles.mjs';

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, username TEXT NOT NULL, source TEXT NOT NULL, log TEXT NOT NULL, rules TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, amount INTEGER NOT NULL, operator_id INTEGER, review_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, execution_day TEXT, attempt_id TEXT, confirmed_unreturned INTEGER, verification_note TEXT);
      CREATE INDEX IF NOT EXISTS claims_owner ON claims(user_id,created_at);
      CREATE INDEX IF NOT EXISTS claims_day ON claims(execution_day,status);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, claim_id TEXT, actor_id INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, result TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_notifications (id INTEGER PRIMARY KEY, event TEXT NOT NULL, recipient TEXT, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, result TEXT, dedupe_key TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, claim_id TEXT NOT NULL REFERENCES claims(id), status TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, read_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS user_notifications_owner ON user_notifications(user_id,id DESC);
      CREATE INDEX IF NOT EXISTS user_notifications_unread ON user_notifications(user_id,read_at);
      CREATE TABLE IF NOT EXISTS log_query_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS log_query_progress (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_reviews (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        log_fingerprint TEXT NOT NULL, prompt_version TEXT NOT NULL,
        decision TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL,
        evidence TEXT NOT NULL, raw_response TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(request_id, log_fingerprint, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS ai_reviews_user_day ON ai_reviews(user_id, created_at);
    `);
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='run_id'))this.db.exec('ALTER TABLE claims ADD COLUMN run_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='reserved_at')){
      this.db.exec(`ALTER TABLE claims ADD COLUMN reserved_at INTEGER;
        UPDATE claims SET reserved_at=COALESCE((SELECT MAX(created_at) FROM events WHERE claim_id=claims.id AND action='execution_reserved'),updated_at) WHERE execution_day IS NOT NULL`);
    }
    if(!this.db.prepare('PRAGMA table_info(ai_reviews)').all().some(c=>c.name==='analysis'))this.db.exec('ALTER TABLE ai_reviews ADD COLUMN analysis TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS claims_run ON claims(user_id,run_id)');
    if (!this.db.prepare('PRAGMA table_info(notifications)').all().some(c => c.name === 'dedupe_key')) {
      this.db.exec('ALTER TABLE notifications ADD COLUMN dedupe_key TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS notifications_dedupe ON notifications(dedupe_key,status,created_at)');
    this.db.exec('PRAGMA user_version=5');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify(defaults));
    if(!this.db.prepare("SELECT 1 FROM metadata WHERE key='email_rejected_event_migrated'").get()){
      this.transaction(()=>{
        const saved=JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value);
        const email={...defaults.emailNotifications,...saved.emailNotifications};
        if(!email.events.includes('rejected')){
          email.events=[...email.events,'rejected'];
          this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({...saved,emailNotifications:email,version:Number(saved.version||1)+1}));
        }
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('email_rejected_event_migrated','1')").run();
      });
    }
    // A process may have died after the remote transfer: never replay it.
    const interrupted=this.db.prepare("SELECT id FROM claims WHERE status='executing'").all();
    this.db.prepare("UPDATE claims SET status='unknown', review_note='服务重启后无法确认到账结果，等待管理员核对，禁止重复返还', updated_at=? WHERE status='executing'").run(Date.now());
    this.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM metadata WHERE key='user_notifications_migrated'").get()){
        for(const row of this.db.prepare('SELECT * FROM claims').iterate())this.notifyUserClaim(this.decode(row),'snapshot:'+row.id);
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('user_notifications_migrated','1')").run();
      }else for(const {id} of interrupted){const claim=this.get(id);this.notifyUserClaim(claim,'recovery:'+id+':'+claim.updated_at);}
    });
  }
  close() { this.db.close(); }
  storageInfo() {
    const file = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    const count = table => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { engine: 'SQLite', persistent: Boolean(file), journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      claims: count('claims'), logs: count('log_query_cache'), events: count('events'),
      notifications: count('notifications'), freeBytes: this.db.prepare('PRAGMA freelist_count').get().freelist_count * this.db.prepare('PRAGMA page_size').get().page_size,
      bytes: this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size };
  }
  bindInstance(url) {
    const normalized = new URL(url).origin;
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key='newapi_origin'").get();
    if (existing && existing.value !== normalized) throw new AppError('数据目录已绑定其他 云中猫API小站 实例，请使用独立数据目录', 409);
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('newapi_origin',?)").run(normalized);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  rules() {
    const saved=JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value);
    const result={...structuredClone(defaults),...saved,notifications:{...defaults.notifications,...saved.notifications},emailNotifications:{...defaults.emailNotifications,...saved.emailNotifications}};
    return result;
  }
  aiConfig(env = process.env) {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='ai_config'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch {}
    return {
      baseUrl: String(saved.baseUrl ?? env.AI_BASE_URL ?? '').trim(),
      apiKey: String(saved.apiKey ?? env.AI_API_KEY ?? ''),
      model: String(saved.model ?? env.AI_MODEL ?? '').trim(),
      timeoutMs: Number(saved.timeoutMs ?? env.AI_TIMEOUT_MS ?? 15000),
      prompt: String(saved.prompt ?? env.AI_PROMPT ?? '').trim()
    };
  }
  saveAIConfig(input, actor) {
    return this.transaction(() => {
      const currentRules=this.rules();
      const ruleFields=['aiEnabled','aiAutoThreshold','aiDailyLimit'];
      const changesRules=ruleFields.some(key=>Object.hasOwn(input,key));
      if(changesRules&&input.rulesVersion!==currentRules.version)throw new AppError('AI 设置已更新，请刷新后重新保存',409);
      const updatedRules=changesRules?validateRules({...currentRules,...Object.fromEntries(ruleFields.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]))}):null;
      const current = this.aiConfig();
      const next = {
        baseUrl: String(input.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, ''),
        apiKey: input.apiKey === undefined || input.apiKey === '' ? current.apiKey : String(input.apiKey),
        model: String(input.model ?? current.model).trim(),
        timeoutMs: Number(input.timeoutMs ?? current.timeoutMs),
        prompt: String(input.prompt ?? current.prompt).trim()
      };
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('ai_config',?)").run(JSON.stringify(next));
      if(updatedRules)this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({...updatedRules,version:currentRules.version+1}));
      this.event(null, actor, 'ai_config_updated', { baseUrl: next.baseUrl, model: next.model, timeoutMs: next.timeoutMs, apiKeyChanged: next.apiKey !== current.apiKey,...(updatedRules?{aiEnabled:updatedRules.aiEnabled,aiAutoThreshold:updatedRules.aiAutoThreshold,aiDailyLimit:updatedRules.aiDailyLimit}:{}) });
      return next;
    });
  }
  saveRules(rules, actor, expectedVersion) {
    return this.transaction(() => {
      const current = this.rules();
      if (current.version !== expectedVersion) throw new AppError('规则已更新，请刷新后重试', 409);
      if (rules.timezone !== current.timezone && this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status IN ('executing','unknown','succeeded')").get().n > 0) throw new AppError('已有执行记录，不允许切换每日结算时区以免限额重置', 409);
      if ((rules.dailyResetTime || '00:00') !== current.dailyResetTime) {
        const update = this.db.prepare('UPDATE claims SET execution_day=? WHERE id=?');
        for (const claim of this.db.prepare('SELECT id,reserved_at FROM claims WHERE reserved_at IS NOT NULL').all()) {
          update.run(settlementClock(claim.reserved_at, rules).day, claim.id);
        }
      }
      const next = { ...rules, version: current.version + 1 };
      this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(next));
      this.event(null, actor, 'rules_updated', { before: current, after: next });
      return next;
    });
  }
  event(claimId, actor, action, detail = {}) {
    return this.db.prepare('INSERT INTO events(claim_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(claimId, actor, action, JSON.stringify(detail), Date.now()).lastInsertRowid;
  }
  notifyUserClaim(claim,identity) {
    const title={pending:'申请等待审核',approved:'申请审核通过',rejected:'申请审核未通过',succeeded:'额度补偿成功',failed:'额度补偿失败',unknown:'额度补偿待核对'}[claim.status];
    if(!title)return;
    const note={pending:'申请已进入人工审核队列。',approved:'审核已通过，等待执行补偿。',rejected:'本次申请未通过审核。',succeeded:'原站已确认补偿成功。',failed:'本次补偿未成功，请查看申请处理说明。',unknown:'到账结果尚未确认，正在等待管理员核对，请勿重复提交。'}[claim.status];
    const body=String(claim.log.model_name||'未知模型')+' · '+(claim.review_note||note);
    this.db.prepare('INSERT OR IGNORE INTO user_notifications(user_id,claim_id,status,title,body,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?)').run(claim.user_id,claim.id,claim.status,title,body.slice(0,2400),String(identity),claim.updated_at);
  }
  inbox(userId,page=1,unreadOnly=false) {
    const where='user_id=?'+(unreadOnly?' AND read_at IS NULL':'');
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE '+where).get(userId).n;
    const unread=this.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id=? AND read_at IS NULL').get(userId).n;
    const throughId=this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM user_notifications WHERE user_id=?').get(userId).id;
    const items=this.db.prepare('SELECT id,claim_id,status,title,body,read_at,created_at FROM user_notifications WHERE '+where+' ORDER BY id DESC LIMIT 30 OFFSET ?').all(userId,(page-1)*30);
    return {items,total,unread,throughId,page};
  }
  readInbox(userId,{id,throughId}) {
    if(id!==undefined){
      if(!Number.isSafeInteger(id)||id<1)throw new AppError('通知标识无效');
      if(!this.db.prepare('SELECT id FROM user_notifications WHERE id=? AND user_id=?').get(id,userId))throw new AppError('通知不存在',404);
      this.db.prepare('UPDATE user_notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(Date.now(),id,userId);
    }else{
      if(!Number.isSafeInteger(throughId)||throughId<1)throw new AppError('通知范围无效');
      this.db.prepare('UPDATE user_notifications SET read_at=? WHERE user_id=? AND id<=? AND read_at IS NULL').run(Date.now(),userId,throughId);
    }
    return {unread:this.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id=? AND read_at IS NULL').get(userId).n};
  }
  notify(event, body, identity = null) {
    const n = this.rules().notifications;
    if (!n.enabled || (event !== 'notification_test' && !n.events.includes(event))) return;
    const now = Date.now(), dedupeKey = `${event}:${createHash('sha256').update(String(identity||body)).digest('hex')}`;
    const existing = this.db.prepare("SELECT id FROM notifications WHERE dedupe_key=? AND status IN ('pending','sending','sent') AND created_at>? LIMIT 1").get(dedupeKey, identity?0:now - 120000);
    if (existing) return existing.id;
    return this.db.prepare('INSERT INTO notifications(event,body,next_at,created_at,dedupe_key) VALUES(?,?,?,?,?)').run(event, body, now, now, dedupeKey).lastInsertRowid;
  }
  notifyClaim(event,claim,note){
    if(claim.run_id)return;
    const safe=value=>String(value??'').replace(/[\\`*_{}\[\]()<>#!|@]/g,' ').replace(/[\r\n]+/g,' ').slice(0,500);
    let display;try{display=JSON.parse(this.db.prepare("SELECT value FROM metadata WHERE key='display'").get()?.value);}catch{}
    const label={pending:'待人工审核',approved:'已通过，等待执行',succeeded:'已补回',failed:'返还失败',unknown:'待人工对账',rejected:'已驳回',executing:'执行中'}[claim.status]||claim.status;
    const amount=claim.status==='succeeded'?claim.amount:claim.amount||expectedQuota(claim.log,claim.rules);
    const title=notificationTitle(event,claim.status);
    const text='### '+title+'\n'+[
      ['申请号',claim.id],['用户',claim.username+'（ID '+claim.user_id+'）'],['类型',compensationLabel(claim.log,claim.source)],['模型',claim.log.model_name],['原请求',claim.request_id],['补回额度',display?formatQuota(amount,display):'站点显示配置待同步'],['状态',label],['处理说明',note],['时间',new Date().toLocaleString('zh-CN',{timeZone:this.rules().timezone,hour12:false})]
    ].map(([key,value])=>'- **'+key+'**：'+safe(value)).join('\n');
    this.notify(event,JSON.stringify({title,text}));
  }
  notifyClaimsBatch(runId,owner=null){
    if(owner===null){for(const row of this.db.prepare('SELECT DISTINCT user_id FROM claims WHERE run_id=?').all(runId))this.notifyClaimsBatch(runId,row.user_id);return;}
    const claims=this.db.prepare('SELECT * FROM claims WHERE run_id=? AND user_id=? ORDER BY created_at,id').all(runId,owner).map(row=>this.decode(row));
    if(!claims.length)return;
    const safe=value=>String(value??'').replace(/[\\`*_{}\[\]()<>#!|@]/g,' ').replace(/[\r\n]+/g,' ').slice(0,300);
    const labels={pending:'待人工审核',approved:'已通过 · 待执行',executing:'执行中',succeeded:'已补回',failed:'返还失败',unknown:'待人工对账',rejected:'已驳回'};
    let display;try{display=JSON.parse(this.db.prepare("SELECT value FROM metadata WHERE key='display'").get()?.value);}catch{}
    const succeeded=claims.filter(c=>c.status==='succeeded'),total=succeeded.reduce((sum,c)=>sum+c.amount,0);
    const hasAI=claims.some(claim=>this.db.prepare("SELECT 1 FROM events WHERE claim_id=? AND action IN ('ai_reviewed','admin_ai_reviewed') LIMIT 1").get(claim.id));
    const title=batchNotificationTitle(claims,hasAI);
    const rows=claims.map(c=>`- **${safe(c.log.model_name)}** · ${safe(c.request_id)} · ${labels[c.status]||safe(c.status)} · ${display?formatQuota(c.status==='succeeded'?c.amount:expectedQuota(c.log,c.rules),display):c.status==='succeeded'?c.amount:expectedQuota(c.log,c.rules)}${c.review_note?' · '+safe(c.review_note):''}`);
    const text='### '+title+'\n'+[
      `- **用户**：${safe(claims[0].username)}（ID ${claims[0].user_id}）`,
      `- **申请笔数 / 模型数**：${claims.length} / ${new Set(claims.map(c=>c.log.model_name)).size}`,
      `- **已确认补回**：${succeeded.length} 笔 · ${display?formatQuota(total,display):total}`,
      '- **逐笔结果**：',...rows,
      `- **时间**：${new Date(Math.max(...claims.map(c=>c.updated_at))).toLocaleString('zh-CN',{timeZone:this.rules().timezone,hour12:false})}`
    ].join('\n');
    this.notify('batch_result',JSON.stringify({title,text}),JSON.stringify([runId,owner,claims.map(c=>[c.id,c.status,c.amount,c.review_note,c.updated_at]),hasAI]));
  }
  decode(row) { return row ? { ...row, log: JSON.parse(row.log), rules: JSON.parse(row.rules) } : null; }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM claims WHERE id=?').get(id)); }
  byRequest(id) { return this.decode(this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)); }
  auditEvents() {
    return this.db.prepare(`SELECT e.*,c.username AS targetUsername,c.user_id AS targetUserId,c.request_id AS requestId,c.log AS claim_log,
      CASE WHEN e.action='succeeded' THEN c.amount END AS amount,
      (SELECT username FROM claims WHERE user_id=e.actor_id ORDER BY created_at DESC LIMIT 1) AS actorName
      FROM events e LEFT JOIN claims c ON c.id=e.claim_id ORDER BY e.id DESC LIMIT 100`).all().map(row => {
      const { claim_log, ...event } = row;
      let model = null;
      try { model = JSON.parse(claim_log || '{}').model_name || null; } catch {}
      return { ...event, model };
    });
  }
  cachedLogQuery(key) {
    const row = this.db.prepare('SELECT payload FROM log_query_cache WHERE cache_key=?').get(key);
    return row ? JSON.parse(row.payload) : null;
  }
  logQueryProgress(userId) {
    const row = this.db.prepare('SELECT payload FROM log_query_progress WHERE user_id=?').get(userId);
    return row ? JSON.parse(row.payload) : null;
  }
  saveLogQueryProgress(userId, snapshot) {
    // One row commits discovered logs and the successful cutoff together, outside disposable caches.
    this.transaction(() => this.db.prepare('INSERT INTO log_query_progress(user_id,payload) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload').run(userId, JSON.stringify(snapshot)));
  }
  cacheLogQuery(key, payload) {
    this.transaction(() => {
      const now = Date.now();
      this.db.prepare('DELETE FROM log_query_cache WHERE created_at<?').run(now - 86400000);
      this.db.prepare('INSERT INTO log_query_cache(cache_key,payload,created_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at').run(key, JSON.stringify(payload), now);
      this.db.exec('DELETE FROM log_query_cache WHERE cache_key NOT IN (SELECT cache_key FROM log_query_cache ORDER BY created_at DESC LIMIT 200)');
    });
  }
  aiReview(requestId, fingerprint, promptVersion) {
    const row = this.db.prepare('SELECT * FROM ai_reviews WHERE request_id=? AND log_fingerprint=? AND prompt_version=?').get(requestId, fingerprint, promptVersion);
    return row ? { ...row, evidence: JSON.parse(row.evidence),analysis:row.analysis?JSON.parse(row.analysis):null } : null;
  }
  latestAIReview(requestId, fingerprint) {
    const row=this.db.prepare('SELECT * FROM ai_reviews WHERE request_id=? AND log_fingerprint=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(requestId,fingerprint);
    return row?{...row,evidence:JSON.parse(row.evidence),analysis:row.analysis?JSON.parse(row.analysis):null}:null;
  }
  aiReviewCount(day, userId) {
    const start = Date.parse(day + 'T00:00:00.000Z'), end = start + 86400000;
    return this.db.prepare('SELECT COUNT(*) AS n FROM ai_reviews WHERE user_id=? AND created_at>=? AND created_at<?').get(userId, start, end).n;
  }
  saveAiReview(input) {
    return this.transaction(() => {
      const now = Date.now();
      const existing = this.aiReview(input.requestId, input.fingerprint, input.promptVersion);
      if (existing) return existing;
      const id = randomUUID();
      this.db.prepare('INSERT INTO ai_reviews(id,request_id,user_id,log_fingerprint,prompt_version,decision,confidence,reason,evidence,raw_response,status,created_at,updated_at,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.requestId, input.userId, input.fingerprint, input.promptVersion, input.decision, input.confidence, input.reason, JSON.stringify(input.evidence || []), input.rawResponse, input.status, now, now,input.analysis?JSON.stringify(input.analysis):null);
      return this.aiReview(input.requestId, input.fingerprint, input.promptVersion);
    });
  }
  list(userId = null, status = '', page = 1, filters = {}) {
    const conditions = [], args = [];
    if (userId !== null) { conditions.push('user_id=?'); args.push(userId); }
    if (status) { conditions.push('status=?'); args.push(status); }
    for(const [key,expression] of [['model',"json_extract(log,'$.model_name')"],['channel',"CAST(json_extract(log,'$.channel') AS TEXT)"],['owner','CAST(user_id AS TEXT)']])if(filters[key]){conditions.push(expression+'=?');args.push(String(filters[key]));}
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM claims ${where}`).get(...args).n;
    const items = this.db.prepare(`SELECT * FROM claims ${where} ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?`).all(...args, (page - 1) * 30).map(r => this.decode(r));
    return { items, total, page };
  }
  claimGroups(status='',page=1,owner=null){
    const conditions=[],args=[];
    if(status){conditions.push('status=?');args.push(status);}
    if(owner!==null){conditions.push('user_id=?');args.push(owner);}
    const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
    const total=this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM claims ${where}`).get(...args).n;
    const items=this.db.prepare(`SELECT user_id, MAX(username) AS username, COUNT(*) AS applications, COUNT(DISTINCT json_extract(log,'$.model_name')) AS models, SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END) AS paidAmount, MAX(created_at) AS createdAt FROM claims ${where} GROUP BY user_id ORDER BY createdAt DESC,user_id LIMIT 30 OFFSET ?`).all(...args,(page-1)*30);
    // Aggregate the whole owner group, not only one claim page. Never merge ledger rows.
    for(const group of items){
      const rows=this.db.prepare(`SELECT status,amount,log,rules FROM claims ${where}${where?' AND':' WHERE'} user_id=?`).iterate(...args,group.user_id);
      group.expectedAmount=0;group.statuses={};
      for(const row of rows){group.statuses[row.status]=(group.statuses[row.status]||0)+1;group.expectedAmount+=['succeeded','executing','unknown'].includes(row.status)?row.amount:expectedQuota(JSON.parse(row.log),JSON.parse(row.rules));}
    }
    return {items,total,page};
  }
  create(log, user, rules, reason, source, actor, notifyPending = true, runId = null) {
    return this.transaction(() => {
      if (this.byRequest(log.request_id)) throw new AppError('这笔消费已申请，请查看已有申请', 409);
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE user_id=? AND status IN ('pending','approved','executing','unknown')").get(user.id).n;
      if (pending >= rules.maxPending) throw new AppError('待处理申请数量已达上限', 409);
      const id = randomUUID(), now = Date.now();
      this.db.prepare("INSERT INTO claims(id,request_id,user_id,username,source,log,rules,reason,status,amount,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?)").run(id, log.request_id, user.id, user.username, source, JSON.stringify(log), JSON.stringify(rules), reason, now, now);
      if(runId)this.db.prepare('UPDATE claims SET run_id=? WHERE id=?').run(runId,id);
      const eventId=this.event(id, actor, 'application_created', { source, reason });
      this.notifyUserClaim(this.get(id),'event:'+eventId);
      if(notifyPending)this.notifyClaim('application_pending',this.get(id),'等待人工核实原消费');
      return this.get(id);
    });
  }
  usage(day, userId = null) {
    const owner = userId === null ? '' : ' AND user_id=?';
    return this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS quota, COUNT(*) AS count FROM claims WHERE execution_day=? AND status IN ('executing','unknown','succeeded')${owner}`).get(...(userId === null ? [day] : [day, userId]));
  }
  reserve(id, actor, amount, verifiedAmount, note, rules, now = Date.now()) {
    return this.transaction(() => {
      const c = this.get(id);
      if (!c || c.status !== 'approved') throw new AppError('申请状态已变化，不能执行', 409);
      const day = settlementClock(now, rules).day;
      for (const [owner, quota, count] of [[c.user_id, rules.userDailyQuota, rules.userDailyCount], [null, rules.siteDailyQuota, rules.siteDailyCount]]) {
        const used = this.usage(day, owner);
        if (used.quota + amount > quota || used.count + 1 > count) throw new AppError(`${owner === null ? '全站' : '用户'}当日额度或次数不足，申请已保留`, 409);
      }
      const attempt = randomUUID();
      this.db.prepare("UPDATE claims SET status='executing', amount=?, confirmed_unreturned=?, verification_note=?, operator_id=?, execution_day=?, attempt_id=?, updated_at=?, reserved_at=? WHERE id=?").run(amount, verifiedAmount, note, actor, day, attempt, now, now, id);
      this.event(id, actor, 'execution_reserved', { amount, verifiedAmount, note, attempt, day, ruleVersion: rules.version });
      return this.get(id);
    });
  }
  transition(id, from, to, actor, note) {
    return this.transaction(() => {
      const c = this.get(id);
      if (!c || !from.includes(c.status)) throw new AppError('当前状态不允许此操作', 409);
      this.db.prepare('UPDATE claims SET status=?,operator_id=?,review_note=?,updated_at=? WHERE id=?').run(to, actor, note, Date.now(), id);
      const eventId=this.event(id, actor, to, { note, previousStatus: c.status });
      const updated=this.get(id);
      if(c.status!==to)this.notifyUserClaim(updated,'event:'+eventId);
      if(!updated.run_id)this.notifyClaim(to === 'pending' ? 'application_pending' : to === 'succeeded' ? 'compensation_success' : to === 'unknown' ? 'execution_unknown' : to === 'failed' ? 'execution_failed' : 'review_result',updated,note);
      return this.get(id);
    });
  }
  overview(userId = null, now = Date.now()) {
    const where = userId === null ? '' : 'WHERE user_id=?', args = userId === null ? [] : [userId];
    const totals = this.db.prepare(`SELECT COUNT(*) AS applications, COUNT(DISTINCT CASE WHEN status='succeeded' THEN user_id END) AS compensatedUsers, COALESCE(SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END),0) AS compensatedQuota, COALESCE(SUM(status='pending'),0) AS pending, COALESCE(SUM(status='unknown'),0) AS unknown, COALESCE(SUM(status='failed'),0) AS failed FROM claims ${where}`).get(...args);
    const r = this.rules(), day = settlementClock(now, r).day;
    return { ...totals, day, timezone: r.timezone, dailyResetTime: r.dailyResetTime, today: this.usage(day, userId), personalLimit: { quota: r.userDailyQuota, count: r.userDailyCount }, siteToday: this.usage(day), siteLimit: { quota: r.siteDailyQuota, count: r.siteDailyCount } };
  }
  personalStatistics(userId, days = 30, now = Date.now()) {
    if (![7, 30, 90].includes(days)) throw new AppError('时间范围无效');
    const rules = this.rules(), timezone = rules.timezone, today = settlementClock(now, rules).day;
    const anchor = Date.parse(today + 'T12:00:00Z');
    const trend = Array.from({length: days}, (_, i) => ({day: new Date(anchor - (days - 1 - i) * 86400000).toISOString().slice(0, 10), quota: 0, count: 0}));
    const range = [trend[0].day, today];
    const rows = this.db.prepare("SELECT execution_day AS day, SUM(amount) AS quota, COUNT(*) AS count FROM claims WHERE user_id=? AND status='succeeded' AND execution_day BETWEEN ? AND ? GROUP BY execution_day").all(userId, ...range);
    const byDay = new Map(rows.map(row => [row.day, row]));
    for (const point of trend) Object.assign(point, byDay.get(point.day));
    return {days, timezone, site: '当前 云中猫API小站 实例', updatedAt: now, quota: rows.reduce((sum, row) => sum + row.quota, 0), count: rows.reduce((sum, row) => sum + row.count, 0), trend};
  }
  refundRecords(userId, page = 1) {
    const total=this.db.prepare("SELECT COUNT(DISTINCT COALESCE(run_id,id)) AS n FROM claims WHERE user_id=? AND status='succeeded'").get(userId).n;
    const groups=this.db.prepare("SELECT COALESCE(run_id,id) AS id, MAX(updated_at) AS completedAt, MIN(created_at) AS createdAt FROM claims WHERE user_id=? AND status='succeeded' GROUP BY COALESCE(run_id,id) ORDER BY completedAt DESC,id DESC LIMIT 30 OFFSET ?").all(userId,(page-1)*30);
    return {total,page,timezone:this.rules().timezone,items:groups.map(group=>({...group,claims:this.db.prepare("SELECT * FROM claims WHERE user_id=? AND COALESCE(run_id,id)=? AND status='succeeded' ORDER BY json_extract(log,'$.created_at') DESC,id").all(userId,group.id).map(row=>this.decode(row))}))};
  }
  stats(kind = 'users') {
    const key = { users: 'CAST(user_id AS TEXT)', models: "json_extract(log,'$.model_name')", channels: "CAST(json_extract(log,'$.channel') AS TEXT)", days: 'execution_day' }[kind];
    if (!key) throw new AppError('统计类型无效');
    return this.db.prepare(`SELECT ${key} AS name, COUNT(*) AS applications, COALESCE(SUM(status='succeeded'),0) AS succeeded, COALESCE(SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END),0) AS quota FROM claims GROUP BY ${key} ORDER BY quota DESC LIMIT 200`).all();
  }
  adminStatistics(kind='users',page=1){
    const key={users:'CAST(user_id AS TEXT)',models:"json_extract(log,'$.model_name')",channels:"CAST(json_extract(log,'$.channel') AS TEXT)"}[kind];
    if(!key)throw new AppError('统计类型无效');
    const total=this.db.prepare(`SELECT COUNT(DISTINCT ${key}) AS n FROM claims`).get().n;
    const items=this.db.prepare(`SELECT ${key} AS name, MAX(username) AS username, COUNT(*) AS applications, COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT json_extract(log,'$.model_name')) AS models, COUNT(DISTINCT json_extract(log,'$.channel')) AS channels, SUM(status='succeeded') AS succeeded, SUM(status='pending') AS pending, SUM(status='unknown') AS unknown, COALESCE(SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END),0) AS quota, MAX(updated_at) AS updatedAt FROM claims GROUP BY ${key} ORDER BY quota DESC,name LIMIT 30 OFFSET ?`).all((page-1)*30);
    return {items,total,page};
  }
  statusCounts(userId=null){return this.db.prepare('SELECT status,COUNT(*) AS count FROM claims'+(userId===null?'':' WHERE user_id=?')+' GROUP BY status').all(...(userId===null?[]:[userId]));}
}
