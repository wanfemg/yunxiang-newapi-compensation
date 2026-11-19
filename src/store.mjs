import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { defaults, AppError, settlementClock, expectedQuota, fundingSource, compensationLabel, validateRules, limitDetail, nextResetAt, throwLimit } from './rules.mjs';
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
      CREATE TABLE IF NOT EXISTS compensation_batches (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, username TEXT NOT NULL,
        query_from INTEGER NOT NULL, query_end INTEGER NOT NULL, logs TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compensation_batches_owner ON compensation_batches(user_id,created_at);
      CREATE TABLE IF NOT EXISTS ai_reviews (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        log_fingerprint TEXT NOT NULL, prompt_version TEXT NOT NULL,
        review_batch_id TEXT,
        decision TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL,
        evidence TEXT NOT NULL, raw_response TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(request_id, log_fingerprint, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS ai_reviews_user_day ON ai_reviews(user_id, created_at);
      CREATE TABLE IF NOT EXISTS compensation_counts (compensation_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, reserved_at INTEGER NOT NULL, execution_day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS compensation_counts_day ON compensation_counts(execution_day,user_id);
      CREATE TABLE IF NOT EXISTS compensation_slots (compensation_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, execution_day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_review_runs (review_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, started_at INTEGER NOT NULL, execution_day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_review_runs_day ON ai_review_runs(execution_day,user_id);
    `);
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='run_id'))this.db.exec('ALTER TABLE claims ADD COLUMN run_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='batch_id'))this.db.exec('ALTER TABLE claims ADD COLUMN batch_id TEXT REFERENCES compensation_batches(id)');
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='batch_auto'))this.db.exec('ALTER TABLE claims ADD COLUMN batch_auto INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='reserved_at')){
      this.db.exec(`ALTER TABLE claims ADD COLUMN reserved_at INTEGER;
        UPDATE claims SET reserved_at=COALESCE((SELECT MAX(created_at) FROM events WHERE claim_id=claims.id AND action='execution_reserved'),updated_at) WHERE execution_day IS NOT NULL`);
    }
    if(!this.db.prepare('PRAGMA table_info(ai_reviews)').all().some(c=>c.name==='analysis'))this.db.exec('ALTER TABLE ai_reviews ADD COLUMN analysis TEXT');
    if(!this.db.prepare('PRAGMA table_info(ai_reviews)').all().some(c=>c.name==='review_batch_id'))this.db.exec('ALTER TABLE ai_reviews ADD COLUMN review_batch_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(compensation_batches)').all().some(c=>c.name==='limit_json'))this.db.exec('ALTER TABLE compensation_batches ADD COLUMN limit_json TEXT');
    if(!this.db.prepare('PRAGMA table_info(claims)').all().some(c=>c.name==='limit_json'))this.db.exec('ALTER TABLE claims ADD COLUMN limit_json TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS claims_run ON claims(user_id,run_id)');
    if (!this.db.prepare('PRAGMA table_info(notifications)').all().some(c => c.name === 'dedupe_key')) {
      this.db.exec('ALTER TABLE notifications ADD COLUMN dedupe_key TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS notifications_dedupe ON notifications(dedupe_key,status,created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS claims_batch ON claims(batch_id)');
    this.db.exec('PRAGMA user_version=6');
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
    this.db.prepare("UPDATE compensation_batches SET status='unknown',note='服务重启，整批到账待核对，禁止重复补偿',updated_at=? WHERE status='executing'").run(Date.now());
    this.db.prepare("UPDATE compensation_batches SET status='review',note='审查中断，剩余记录转人工审核',updated_at=? WHERE status='judging'").run(Date.now());
    this.db.exec('DELETE FROM compensation_slots');
    this.transaction(() => {
      const rules = this.rules();
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='compensation_counts_migrated'").get()) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO compensation_counts VALUES(?,?,?,?)');
        for (const row of this.db.prepare("SELECT COALESCE(batch_id,id) AS key,user_id,MIN(COALESCE(reserved_at,updated_at)) AS started FROM claims WHERE status IN ('executing','unknown','succeeded') GROUP BY COALESCE(batch_id,id)").all()) insert.run(row.key,row.user_id,row.started,settlementClock(row.started,rules).day);
        this.db.prepare("INSERT INTO metadata VALUES('compensation_counts_migrated','1')").run();
      }
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='ai_review_runs_migrated'").get()) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO ai_review_runs VALUES(?,?,?,?)');
        for (const row of this.db.prepare("SELECT COALESCE(review_batch_id,id) AS key,user_id,MIN(created_at) AS started FROM ai_reviews WHERE status IN ('completed','failed') AND prompt_version NOT LIKE '%-admin-assist-%' GROUP BY COALESCE(review_batch_id,id)").all()) insert.run(row.key,row.user_id,row.started,settlementClock(row.started,rules).day);
        this.db.prepare("INSERT INTO metadata VALUES('ai_review_runs_migrated','1')").run();
      }
    });
    // Existing paid claims keep their original ledger identity. Only discovered logs acquire a query batch.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT user_id,payload FROM log_query_progress').all()) {
        const snapshot=JSON.parse(row.payload), items=snapshot.items.filter(log=>!log.query_batch_id);
        if(!items.length)continue;
        const id=randomUUID(),user={id:row.user_id,username:items[0].username||String(row.user_id)};
        for(const log of items)log.query_batch_id=id;
        this.insertQueryBatch({id,user,from:snapshot.coverageStart||snapshot.from,end:snapshot.end,items});
        this.db.prepare('UPDATE log_query_progress SET payload=? WHERE user_id=?').run(JSON.stringify(snapshot),row.user_id);
      }
    });
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
    const category = (key,label,table,columns,cleanup) => {
      const expression=columns.map(column=>`COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
      const row=this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(${expression}),0) AS payloadBytes FROM ${table}`).get();
      return {key,label,...row,cleanup};
    };
    const categories=[
      category('cache','临时查询缓存','log_query_cache',['payload'],'delete'),
      category('snapshots','查询进度日志副本','log_query_progress',['payload'],'settledCopies'),
      category('batches','查询批次与原始日志','compensation_batches',['logs','note'],'retained'),
      category('claims','补偿申请与发放账本','claims',['log','rules','reason','review_note','verification_note'],'retained'),
      category('aiReviews','AI 审核证据','ai_reviews',['reason','evidence','raw_response','analysis'],'retained'),
      category('audit','管理员操作记录','events',['detail','action'],'retained'),
      category('dingNotifications','钉钉通知','notifications',['body','result','dedupe_key'],'contentOnly'),
      category('emailNotifications','邮件通知','email_notifications',['body','result','recipient','dedupe_key'],'contentOnly'),
      category('inbox','用户站内通知','user_notifications',['title','body','dedupe_key'],'retained')
    ];
    let systemBytes=this.db.prepare('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS n FROM settings').get().n+this.db.prepare('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS n FROM metadata').get().n;
    let systemCount=count('settings')+count('metadata');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_notification_claims'").get()){
      systemBytes+=this.db.prepare('SELECT COALESCE(SUM(length(CAST(event AS BLOB))+length(CAST(claim_id AS BLOB))),0) AS n FROM email_notification_claims').get().n;
      systemCount+=count('email_notification_claims');
    }
    for(const [table,key] of [['compensation_counts','compensation_key'],['compensation_slots','compensation_key'],['ai_review_runs','review_key']]){
      systemBytes+=this.db.prepare(`SELECT COALESCE(SUM(length(CAST(${key} AS BLOB))+length(CAST(execution_day AS BLOB))),0) AS n FROM ${table}`).get().n;
      systemCount+=count(table);
    }
    categories.push({key:'system',label:'系统设置与持久标记',count:systemCount,payloadBytes:systemBytes,cleanup:'retained'});
    const logicalBytes=this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size;
    return { engine: 'SQLite', persistent: Boolean(file), journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      claims: count('claims'), logs: count('log_query_cache'), events: count('events'),
      notifications: count('notifications'), freeBytes: this.db.prepare('PRAGMA freelist_count').get().freelist_count * this.db.prepare('PRAGMA page_size').get().page_size,
      bytes: logicalBytes, logicalBytes, categories, payloadBytes:categories.reduce((sum,row)=>sum+row.payloadBytes,0) };
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
      if (rules.timezone !== current.timezone || (rules.dailyResetTime || '00:00') !== current.dailyResetTime) {
        const update = this.db.prepare('UPDATE claims SET execution_day=? WHERE id=?');
        for (const claim of this.db.prepare('SELECT id,reserved_at FROM claims WHERE reserved_at IS NOT NULL').all()) {
          update.run(settlementClock(claim.reserved_at, rules).day, claim.id);
        }
        for (const row of this.db.prepare('SELECT compensation_key,reserved_at FROM compensation_counts').all()) this.db.prepare('UPDATE compensation_counts SET execution_day=? WHERE compensation_key=?').run(settlementClock(row.reserved_at,rules).day,row.compensation_key);
        for (const row of this.db.prepare('SELECT compensation_key,created_at FROM compensation_slots').all()) this.db.prepare('UPDATE compensation_slots SET execution_day=? WHERE compensation_key=?').run(settlementClock(row.created_at,rules).day,row.compensation_key);
        for (const row of this.db.prepare('SELECT review_key,started_at FROM ai_review_runs').all()) this.db.prepare('UPDATE ai_review_runs SET execution_day=? WHERE review_key=?').run(settlementClock(row.started_at,rules).day,row.review_key);
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
    const pendingBatch=claim.status==='pending'&&claim.batch_id?this.queryBatch(claim.batch_id):null;
    const awaitingAutomatic=pendingBatch&&!claim.review_note&&['open','judging'].includes(pendingBatch.status);
    const transferredToManual=pendingBatch?.status==='judging'&&Boolean(claim.review_note);
    const title=awaitingAutomatic?'申请已保存，正在自动核验':transferredToManual?'申请转人工审核':{pending:'申请等待审核',approved:'申请审核通过',rejected:'申请审核未通过',succeeded:'额度补偿成功',failed:'额度补偿失败',unknown:'额度补偿待核对'}[claim.status];
    if(!title)return;
    const note=awaitingAutomatic?'申请已保存，正在自动核验。审核结果会继续更新，无需重复提交。':{pending:'申请已进入人工审核队列。',approved:'审核已通过，等待执行补偿。',rejected:'本次申请未通过审核。',succeeded:'原站已确认补偿成功。',failed:'本次补偿未成功，请查看申请处理说明。',unknown:'到账结果尚未确认，正在等待管理员核对，请勿重复提交。'}[claim.status];
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
    const batch=this.queryBatch(runId),waiting=batch?.status==='waiting_limit';
    const title=waiting?'审核结果 · 补偿暂缓':batchNotificationTitle(claims,hasAI);
    const rows=claims.map(c=>`- **${safe(c.log.model_name)}** · ${safe(c.request_id)} · ${labels[c.status]||safe(c.status)} · ${display?formatQuota(c.status==='succeeded'?c.amount:expectedQuota(c.log,c.rules),display):c.status==='succeeded'?c.amount:expectedQuota(c.log,c.rules)}${c.review_note?' · '+safe(c.review_note):''}`);
    const text='### '+title+'\n'+[
      `- **用户**：${safe(claims[0].username)}（ID ${claims[0].user_id}）`,
      `- **申请笔数 / 模型数**：${claims.length} / ${new Set(claims.map(c=>c.log.model_name)).size}`,
      `- **已确认补回**：${succeeded.length} 笔 · ${display?formatQuota(total,display):total}`,
      ...(waiting?[`- **整批处理说明**：${safe(batch.note)}`]:[]),
      '- **逐笔结果**：',...rows,
      `- **时间**：${new Date(Math.max(...claims.map(c=>c.updated_at))).toLocaleString('zh-CN',{timeZone:this.rules().timezone,hour12:false})}`
    ].join('\n');
    this.notify('batch_result',JSON.stringify({title,text}),JSON.stringify([runId,owner,claims.map(c=>[c.id,c.status,c.amount,c.review_note]),hasAI,waiting?batch.limit:null]));
  }
  decode(row) { return row ? { ...row, log: JSON.parse(row.log), rules: JSON.parse(row.rules), limit: row.limit_json ? JSON.parse(row.limit_json) : null } : null; }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM claims WHERE id=?').get(id)); }
  byRequest(id) { return this.decode(this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)); }
  auditEvents() {
    return this.db.prepare(`SELECT e.*,COALESCE(c.username,b.username) AS targetUsername,COALESCE(c.user_id,b.user_id) AS targetUserId,c.request_id AS requestId,c.log AS claim_log,
      COALESCE(c.batch_id,b.id) AS batchId,
      (SELECT json_group_array(DISTINCT json_extract(log,'$.model_name')) FROM claims WHERE batch_id=b.id) AS batchModels,
      CASE WHEN e.action='succeeded' THEN c.amount WHEN e.action='batch_succeeded' THEN json_extract(e.detail,'$.amount') END AS amount,
      (SELECT username FROM claims WHERE user_id=e.actor_id ORDER BY created_at DESC LIMIT 1) AS actorName
      FROM events e LEFT JOIN claims c ON c.id=e.claim_id
      LEFT JOIN compensation_batches b ON b.id=COALESCE(c.batch_id,json_extract(e.detail,'$.batchId'))
      ORDER BY e.id DESC LIMIT 100`).all().map(row => {
      const { claim_log,batchModels, ...event } = row;
      let model = null;
      try { model = JSON.parse(claim_log || '{}').model_name || null; } catch {}
      return { ...event, model, models:JSON.parse(batchModels||'[]') };
    });
  }
  cachedLogQuery(key) {
    const row = this.db.prepare('SELECT payload FROM log_query_cache WHERE cache_key=?').get(key);
    return row ? JSON.parse(row.payload) : null;
  }
  logQueryProgress(userId) {
    const row = this.db.prepare('SELECT payload FROM log_query_progress WHERE user_id=?').get(userId);
    if(!row)return null;
    const snapshot=JSON.parse(row.payload);
    if(snapshot.itemsOmitted){
      const start=snapshot.window?.start??snapshot.coverageStart??snapshot.from,end=snapshot.window?.end??snapshot.end;
      snapshot.items=[...new Map([...(snapshot.items||[]),...this.logQueryRows(userId,start,end)].map(log=>[log.query_identity||JSON.stringify(log),log])).values()];
    }
    return snapshot;
  }
  logQueryRows(userId,start,end) {
    return this.db.prepare(`SELECT l.value AS payload FROM compensation_batches b,json_each(b.logs) l
      WHERE b.user_id=? AND b.query_end>=? AND b.query_from<=?
      AND json_extract(l.value,'$.user_id')=? AND json_extract(l.value,'$.created_at') BETWEEN ? AND ?
      ORDER BY b.created_at,b.id,l.key`).all(userId,start,end,userId,start,end).map(row=>JSON.parse(row.payload));
  }
  clearLogQueryPayload(userId=null) {
    return this.transaction(()=>{
      const rows=userId===null?this.db.prepare('SELECT user_id,payload FROM log_query_progress').all():this.db.prepare('SELECT user_id,payload FROM log_query_progress WHERE user_id=?').all(userId);
      const update=this.db.prepare('UPDATE log_query_progress SET payload=? WHERE user_id=?');
      for(const row of rows){
        const snapshot=JSON.parse(row.payload),start=snapshot.window?.start??snapshot.coverageStart??snapshot.from,end=snapshot.window?.end??snapshot.end;
        const backedUp=new Set(this.logQueryRows(row.user_id,start,end).map(log=>JSON.stringify(log)));
        snapshot.items=(snapshot.items||[]).filter(log=>!backedUp.has(JSON.stringify(log)));
        snapshot.itemsOmitted=true;update.run(JSON.stringify(snapshot),row.user_id);
      }
      return rows.length;
    });
  }
  saveLogQueryProgress(userId, snapshot, batch = null) {
    // One row commits discovered logs and the successful cutoff together, outside disposable caches.
    this.transaction(() => {
      if(batch)this.insertQueryBatch(batch);
      this.db.prepare('INSERT INTO log_query_progress(user_id,payload) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload').run(userId, JSON.stringify(snapshot));
    });
  }
  insertQueryBatch({id,user,from,end,items}) {
    if(!items.length)return;
    this.db.prepare('INSERT INTO compensation_batches(id,user_id,username,query_from,query_end,logs,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,user.id,user.username,from,end,JSON.stringify(items),Date.now(),Date.now());
  }
  queryBatch(id) {
    const row=this.db.prepare('SELECT * FROM compensation_batches WHERE id=?').get(id);
    return row?{...row,logs:JSON.parse(row.logs),limit:row.limit_json?JSON.parse(row.limit_json):null}:null;
  }
  batchClaims(id) { return this.db.prepare('SELECT * FROM claims WHERE batch_id=? ORDER BY created_at,id').all(id).map(row=>this.decode(row)); }
  batchForRequest(userId,requestId) {
    return this.db.prepare("SELECT b.id FROM compensation_batches b,json_each(b.logs) l WHERE b.user_id=? AND json_extract(l.value,'$.request_id')=? ORDER BY b.created_at LIMIT 1").get(userId,requestId)?.id;
  }
  updateBatch(id,status,note='',amount=null,limit=null) {
    this.db.prepare('UPDATE compensation_batches SET status=?,note=?,amount=COALESCE(?,amount),updated_at=?,limit_json=? WHERE id=?').run(status,note,amount,Date.now(),limit?JSON.stringify(limit):null,id);
    return this.queryBatch(id);
  }
  enrollBatch(id,logs,user,rules,reason,actor) {
    return this.transaction(()=>{
      const batch=this.queryBatch(id);
      if(!batch||batch.status!=='open'||batch.user_id!==user.id)throw new AppError('本次查询已提交，请查看处理进度',409);
      const pending=this.db.prepare("SELECT COUNT(DISTINCT COALESCE(batch_id,id)) AS n FROM claims WHERE user_id=? AND status IN ('pending','approved','executing','unknown')").get(user.id).n;
      if(pending>=rules.maxPending)throw new AppError('待处理补偿次数已达上限',409);
      this.holdCompensationSlot(id,user.id,rules);
      for(const log of logs){
        if(this.byRequest(log.request_id))continue;
        const claimId=randomUUID(),now=Date.now();
        this.db.prepare("INSERT INTO claims(id,request_id,user_id,username,source,log,rules,reason,status,amount,created_at,updated_at,run_id,batch_id) VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)")
          .run(claimId,log.request_id,user.id,user.username,'self',JSON.stringify(log),JSON.stringify(rules),reason,now,now,id,id);
        const eventId=this.event(claimId,actor,'application_created',{source:'self',reason,batchId:id});
        this.notifyUserClaim(this.get(claimId),'event:'+eventId);
      }
      return this.updateBatch(id,'judging','正在逐条审查，全部完成后合并补偿');
    });
  }
  reserveBatch(id,actor,entries,rules) {
    return this.transaction(()=>{
      const batch=this.queryBatch(id),claims=this.batchClaims(id);
      const partial=claims.some(c=>c.rules.aiEnabled);
      const allowed=partial?['pending','approved','rejected','succeeded']:['approved','rejected'];
      if(!batch||!['review','judging','waiting_limit'].includes(batch.status)||claims.some(c=>!allowed.includes(c.status)))throw new AppError('批次尚有未处理的执行结果，不能补偿',409);
      const approved=claims.filter(c=>c.status==='approved');
      if(!approved.length||entries.length!==approved.length||new Set(entries.map(e=>e.id)).size!==approved.length||approved.some(c=>!entries.some(e=>e.id===c.id)))throw new AppError('补偿批次内容不完整',409);
      const amount=entries.reduce((sum,e)=>sum+e.amount,0);
      if(!Number.isSafeInteger(amount)||amount<=0)throw new AppError('整批补偿金额无效');
      const paid=claims.filter(c=>c.status==='succeeded').reduce((n,c)=>n+c.amount,0),total=paid+amount;
      if(!Number.isSafeInteger(total))throw new AppError('批次累计补偿金额无效');
      const caps=[rules.perBatchQuota,...claims.map(c=>c.rules.perBatchQuota)].filter(v=>v>0);
      if(caps.length&&total>Math.min(...caps))throwLimit(limitDetail('batch','user',paid,Math.min(...caps),total,rules,Date.now(),true));
      const now=Date.now(),day=settlementClock(now,rules).day,attempt=randomUUID();
      const limit=this.compensationLimit(batch.user_id,id,amount,rules,{now});
      if(limit)throwLimit(limit);
      this.reserveCompensationCount(id,batch.user_id,rules,now);
      this.releaseCompensationSlot(id);
      for(const entry of entries){
        if(!Number.isSafeInteger(entry.amount)||entry.amount<=0)throw new AppError('单条补偿额度无效');
        this.db.prepare("UPDATE claims SET status='executing',amount=?,confirmed_unreturned=?,verification_note=?,operator_id=?,execution_day=?,attempt_id=?,updated_at=?,reserved_at=?,limit_json=NULL WHERE id=?")
          .run(entry.amount,entry.verifiedAmount,entry.note,actor,day,attempt,now,now,entry.id);
        this.event(entry.id,actor,'execution_reserved',{batchId:id,amount:entry.amount,attempt,day});
      }
      this.event(null,actor,'batch_executing',{batchId:id,amount,records:entries.length});
      return this.updateBatch(id,'executing','正在合并发放本次通过部分',total);
    });
  }
  finishBatch(id,status,actor,note) {
    return this.transaction(()=>{
      const batch=this.queryBatch(id);
      if(!batch||!['executing','unknown'].includes(batch.status))throw new AppError('批次状态不允许此操作',409);
      const active=this.batchClaims(id).filter(c=>c.status===batch.status),amount=active.reduce((n,c)=>n+c.amount,0);
      for(const claim of active){
        this.db.prepare('UPDATE claims SET status=?,operator_id=?,review_note=?,updated_at=? WHERE id=?').run(status,actor,note,Date.now(),claim.id);
        const eventId=this.event(claim.id,actor,status,{note,batchId:id,previousStatus:claim.status});
        this.notifyUserClaim(this.get(claim.id),'event:'+eventId);
      }
      this.event(null,actor,'batch_'+status,{batchId:id,amount,note});
      const remaining=this.batchClaims(id),paid=remaining.filter(c=>c.status==='succeeded').reduce((n,c)=>n+c.amount,0);
      const awaiting=remaining.some(c=>['pending','approved'].includes(c.status));
      return this.updateBatch(id,status==='succeeded'&&awaiting?'review':status,status==='succeeded'&&awaiting?'通过部分已补回，其余记录待人工审核；后续仅补未到账部分，仍计同一次补偿':note,paid+(status==='unknown'?amount:0));
    });
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
    return this.aiReviewKeys(day,userId).length;
  }
  aiReviewKeys(day, userId) {
    return this.db.prepare('SELECT review_key AS key FROM ai_review_runs WHERE user_id=? AND execution_day=?').all(userId,day).map(row=>row.key);
  }
  beginAIReview(key,userId,rules,now=Date.now()) {
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM ai_review_runs WHERE review_key=?').get(key))return;
      const active=this.rules(),day=settlementClock(now,active).day,used=this.aiReviewCount(day,userId);
      if(used>=active.aiDailyLimit){
        const limit={...limitDetail('count','user',used,active.aiDailyLimit,1,active,now),code:'AI_DAILY_COUNT_LIMIT'};
        limit.message=`AI 自动审核次数已达今日上限 ${used}/${active.aiDailyLimit} 次；${limit.message.split('；').at(-1)}`;
        throw new AppError(limit.message,429,{code:limit.code,limit});
      }
      this.db.prepare('INSERT INTO ai_review_runs VALUES(?,?,?,?)').run(key,userId,now,day);
    });
  }
  saveAiReview(input) {
    return this.transaction(() => {
      const now = Date.now();
      const existing = this.aiReview(input.requestId, input.fingerprint, input.promptVersion);
      if (existing) return existing;
      const id = randomUUID();
      this.db.prepare('INSERT INTO ai_reviews(id,request_id,user_id,log_fingerprint,prompt_version,review_batch_id,decision,confidence,reason,evidence,raw_response,status,created_at,updated_at,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.requestId, input.userId, input.fingerprint, input.promptVersion, input.reviewBatchId || null, input.decision, input.confidence, input.reason, JSON.stringify(input.evidence || []), input.rawResponse, input.status, now, now,input.analysis?JSON.stringify(input.analysis):null);
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
  create(log, user, rules, reason, source, actor, notifyPending = true, runId = null, holdSlot = false) {
    return this.transaction(() => {
      if (this.byRequest(log.request_id)) throw new AppError('这笔消费已申请，请查看已有申请', 409);
      const pending = this.db.prepare("SELECT COUNT(DISTINCT COALESCE(batch_id,id)) AS n FROM claims WHERE user_id=? AND status IN ('pending','approved','executing','unknown')").get(user.id).n;
      if (pending >= rules.maxPending) throw new AppError('待处理申请数量已达上限', 409);
      const id = randomUUID(), now = Date.now();
      const limit=this.compensationLimit(user.id,id,0,rules,{now,countsOnly:true});
      if(limit)throwLimit(limit);
      if(holdSlot)this.holdCompensationSlot(id,user.id,rules,now);
      this.db.prepare("INSERT INTO claims(id,request_id,user_id,username,source,log,rules,reason,status,amount,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?)").run(id, log.request_id, user.id, user.username, source, JSON.stringify(log), JSON.stringify(rules), reason, now, now);
      if(runId)this.db.prepare('UPDATE claims SET run_id=? WHERE id=?').run(runId,id);
      const eventId=this.event(id, actor, 'application_created', { source, reason });
      this.notifyUserClaim(this.get(id),'event:'+eventId);
      if(notifyPending)this.notifyClaim('application_pending',this.get(id),'等待人工核实原消费');
      return this.get(id);
    });
  }
  hasCompensationCount(key) {
    return Boolean(this.db.prepare("SELECT 1 FROM compensation_counts n WHERE n.compensation_key=? AND EXISTS(SELECT 1 FROM claims c WHERE COALESCE(c.batch_id,c.id)=n.compensation_key AND c.status IN ('executing','unknown','succeeded'))").get(key));
  }
  processingCount(day,userId=null,exceptKey='') {
    return this.db.prepare('SELECT COUNT(*) AS n FROM compensation_slots WHERE execution_day=? AND compensation_key<>?'+(userId===null?'':' AND user_id=?')).get(...(userId===null?[day,exceptKey]:[day,exceptKey,userId])).n;
  }
  compensationLimit(userId,key,amount,rules,{now=Date.now(),countsOnly=false}={}) {
    const day=settlementClock(now,rules).day,newCount=this.hasCompensationCount(key)?0:1;
    for(const [owner,scope,quota,count]of [[userId,'user',rules.userDailyQuota,rules.userDailyCount],[null,'site',rules.siteDailyQuota,rules.siteDailyCount]]){
      const used=this.usage(day,owner),occupied=used.count+this.processingCount(day,owner,key);
      if(newCount&&occupied+newCount>count)return limitDetail('count',scope,occupied,count,newCount,rules,now);
      if(!countsOnly&&used.quota+amount>quota)return limitDetail('quota',scope,used.quota,quota,amount,rules,now);
    }
    return null;
  }
  holdCompensationSlot(key,userId,rules,now=Date.now()) {
    const limit=this.compensationLimit(userId,key,0,rules,{now,countsOnly:true});
    if(limit)throwLimit(limit);
    if(!this.hasCompensationCount(key))this.db.prepare('INSERT OR IGNORE INTO compensation_slots VALUES(?,?,?,?)').run(key,userId,now,settlementClock(now,rules).day);
  }
  releaseCompensationSlot(key) { this.db.prepare('DELETE FROM compensation_slots WHERE compensation_key=?').run(key); }
  reserveCompensationCount(key,userId,rules,now) {
    if(!this.hasCompensationCount(key))this.db.prepare('INSERT INTO compensation_counts VALUES(?,?,?,?) ON CONFLICT(compensation_key) DO UPDATE SET reserved_at=excluded.reserved_at,execution_day=excluded.execution_day').run(key,userId,now,settlementClock(now,rules).day);
  }
  usage(day, userId = null) {
    const owner = userId === null ? '' : ' AND user_id=?';
    const args=userId===null?[day]:[day,userId];
    const {quota}=this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS quota FROM claims WHERE execution_day=? AND status IN ('executing','unknown','succeeded')${owner}`).get(...args);
    const {count}=this.db.prepare(`SELECT COUNT(*) AS count FROM compensation_counts n WHERE execution_day=?${userId===null?'':' AND user_id=?'} AND EXISTS(SELECT 1 FROM claims c WHERE COALESCE(c.batch_id,c.id)=n.compensation_key AND c.status IN ('executing','unknown','succeeded'))`).get(...args);
    return {quota,count};
  }
  reserve(id, actor, amount, verifiedAmount, note, rules, now = Date.now()) {
    return this.transaction(() => {
      const c = this.get(id);
      if (!c || c.status !== 'approved') throw new AppError('申请状态已变化，不能执行', 409);
      if(c.batch_id)throw new AppError('查询批次必须统一补额度，禁止逐条执行',409);
      const caps=[rules.perBatchQuota,c.rules.perBatchQuota].filter(v=>v>0);
      if(caps.length&&amount>Math.min(...caps))throwLimit(limitDetail('batch','user',0,Math.min(...caps),amount,rules,now,true));
      const day = settlementClock(now, rules).day;
      const limit=this.compensationLimit(c.user_id,id,amount,rules,{now});
      if(limit)throwLimit(limit);
      this.reserveCompensationCount(id,c.user_id,rules,now);
      this.releaseCompensationSlot(id);
      const attempt = randomUUID();
      this.db.prepare("UPDATE claims SET status='executing', amount=?, confirmed_unreturned=?, verification_note=?, operator_id=?, execution_day=?, attempt_id=?, updated_at=?, reserved_at=?,limit_json=NULL WHERE id=?").run(amount, verifiedAmount, note, actor, day, attempt, now, now, id);
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
      const firstAutomaticManualResult=c.batch_id&&c.status==='pending'&&to==='pending'&&!c.review_note&&String(note||'').trim();
      if(c.status!==to||firstAutomaticManualResult)this.notifyUserClaim(updated,'event:'+eventId);
      if(!updated.run_id)this.notifyClaim(to === 'pending' ? 'application_pending' : to === 'succeeded' ? 'compensation_success' : to === 'unknown' ? 'execution_unknown' : to === 'failed' ? 'execution_failed' : 'review_result',updated,note);
      return this.get(id);
    });
  }
  overview(userId = null, now = Date.now()) {
    const where = userId === null ? '' : 'WHERE user_id=?', args = userId === null ? [] : [userId];
    const totals = this.db.prepare(`SELECT COUNT(*) AS applications, COUNT(DISTINCT CASE WHEN status='succeeded' THEN user_id END) AS compensatedUsers, COALESCE(SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END),0) AS compensatedQuota, COALESCE(SUM(status='pending'),0) AS pending, COALESCE(SUM(status='unknown'),0) AS unknown, COALESCE(SUM(status='failed'),0) AS failed FROM claims ${where}`).get(...args);
    const r = this.rules(), day = settlementClock(now, r).day;
    return { ...totals, day, timezone: r.timezone, dailyResetTime: r.dailyResetTime, nextResetAt:nextResetAt(now,r),today: this.usage(day, userId),processingCount:this.processingCount(day,userId), personalLimit: { quota: r.userDailyQuota, count: r.userDailyCount }, siteToday: this.usage(day),siteProcessingCount:this.processingCount(day), siteLimit: { quota: r.siteDailyQuota, count: r.siteDailyCount } };
  }
  personalStatistics(userId, days = 30, now = Date.now()) {
    if (![7, 30, 90].includes(days)) throw new AppError('时间范围无效');
    const rules = this.rules(), timezone = rules.timezone, today = settlementClock(now, rules).day;
    const anchor = Date.parse(today + 'T12:00:00Z');
    const trend = Array.from({length: days}, (_, i) => ({day: new Date(anchor - (days - 1 - i) * 86400000).toISOString().slice(0, 10), quota: 0, count: 0}));
    const range = [trend[0].day, today];
    const rows = this.db.prepare("SELECT execution_day AS day, SUM(amount) AS quota, 0 AS count FROM claims WHERE user_id=? AND status='succeeded' AND execution_day BETWEEN ? AND ? GROUP BY execution_day").all(userId, ...range);
    const byDay = new Map(rows.map(row => [row.day, row]));
    for(const row of this.db.prepare("SELECT execution_day AS day,COUNT(*) AS count FROM compensation_counts n WHERE user_id=? AND execution_day BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM claims c WHERE COALESCE(c.batch_id,c.id)=n.compensation_key AND c.status='succeeded') GROUP BY execution_day").all(userId,...range)){
      const point=byDay.get(row.day)||{day:row.day,quota:0,count:0};point.count=row.count;byDay.set(row.day,point);
    }
    for (const point of trend) Object.assign(point, byDay.get(point.day));
    return {days, timezone, site: '当前 云中猫API小站 实例', updatedAt: now, quota: trend.reduce((sum, row) => sum + row.quota, 0), count: trend.reduce((sum, row) => sum + row.count, 0), trend};
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
