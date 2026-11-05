import { AppError, assessLog, expectedQuota, isOpen, publicLog, positiveInt, validateRules, selfServiceDecision, fundingSource, compensationLabel, modelExcluded } from './rules.mjs';
import { UpstreamError } from './newapi.mjs';
import { LogQueries } from './log-queries.mjs';
import { AIReviewer, logFingerprint } from './ai-review.mjs';

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}不能为空且不得超过 ${max} 字`);
  return value.trim();
}
export class Compensation {
  constructor(store, upstream, clock = Date.now, ai = {}) { this.store = store; this.upstream = upstream; this.locks = new Set(); this.logQueries = new LogQueries(store, upstream, clock); this.ai = ai.reviewer || new AIReviewer({ store, now: clock }); }
  requireAdmin(user) { if (user.role < 10) throw new AppError('需要站长管理权限', 403); }
  async ruleContext(logs){
    const rules=this.store.rules();
    if(!this.upstream.catalog)return rules;
    try{
      const catalog=await this.upstream.catalog();
      return {...rules,retiredModelKeys:logs.filter(log=>!catalog.channels.some(c=>c.id===log.channel&&c.status===1&&c.models.includes(log.model_name))).map(log=>log.channel+':'+log.model_name)};
    }catch{return {...rules,catalogUnavailable:true};}
  }
  claimFor(user, id) {
    const c = this.store.get(id);
    if (!c || (user.role < 10 && c.user_id !== user.id)) throw new AppError('申请不存在', 404);
    return c;
  }
  view(c, admin = false) {
    const aiReview = this.store.aiReview(c.request_id, logFingerprint(c.log), process.env.AI_PROMPT_VERSION || 'empty-v1');
    if (admin) return {...c,fundingSource:fundingSource(c.log),compensationLabel:compensationLabel(c.log,c.source),expectedAmount:expectedQuota(c.log,c.rules),aiReview};
    const { rules, log, operator_id, attempt_id, verification_note, confirmed_unreturned, ...safe } = c;
    return { ...safe, log: publicLog(log), fundingSource:fundingSource(log),compensationLabel:compensationLabel(log,c.source),ruleVersion: rules.version,expectedAmount:expectedQuota(log,rules) };
  }
  async logs(user, query, admin = false) {
    if (admin) this.requireAdmin(user);
    let r = this.store.rules();
    let data;
    const skipped = new Map();
    const excludedKeys = new Set((r.excludedModels || []).map(entry=>JSON.stringify([entry.channelId,entry.model])));
    if (admin) {
      data = await this.upstream.logs({ user: null, page: query.page || 1, model: query.model || '', requestId: query.requestId || '', start: query.start || Math.floor(Date.now() / 1000 - r.applicationHours * 3600), end: query.end, channel: query.channel || '' });
    } else {
      const snapshot = await this.logQueries.read(user, query, r.applicationHours);
      const visible = snapshot.items.filter(log => {
        if (log.request_id && this.store.byRequest(log.request_id)?.status === 'succeeded') return false;
        if (!excludedKeys.has(JSON.stringify([log.channel,log.model_name]))) return true;
        const entry = skipped.get(log.model_name) || { model: log.model_name, count: 0, reason: '该模型不参与补偿，已跳过空回检测' };
        entry.count++; skipped.set(log.model_name, entry);
        return false;
      });
      const page = query.page || 1;
      data = { items: visible.slice((page - 1) * 30, page * 30), total: visible.length, page, syncedAt: snapshot.syncedAt };
    }
    r=await this.ruleContext(data.items);
    const items = data.items.map(log => {
      const assessment = assessLog(log, { id: log.user_id }, r);
      const c = log.request_id ? this.store.byRequest(log.request_id) : null;
      const reasons = [...assessment.reasons];
      if (!r.applicationsEnabled) reasons.push('申请暂未开放');
      if (!isOpen(r, Date.now())) reasons.push('不在每日申请开放时段');
      const day = this.store.overview(log.user_id);
      if (day.today.count >= r.userDailyCount || day.today.quota + assessment.expectedQuota > r.userDailyQuota || day.siteToday.count >= r.siteDailyCount || day.siteToday.quota + assessment.expectedQuota > r.siteDailyQuota) reasons.push('当日额度或次数不足');
      if (c) reasons.push('已有申请，查看处理进度');
      const decision=selfServiceDecision(log,{id:log.user_id},r);
      return { log: admin ? log : publicLog(log), assessment: { ...assessment, reasons, canApply: assessment.eligible && reasons.length === 0, route:decision.automatic?'automatic':'review', reviewReasons:decision.reasons }, claim: c ? { id: c.id, status: c.status } : null };
    });
    return { ...data, items, skippedModels: [...skipped.values()].sort((a,b)=>a.model.localeCompare(b.model)), skippedCount: [...skipped.values()].reduce((sum,entry)=>sum+entry.count,0) };
  }
  async apply(user, requestId, reason, manual = false, selfService = false, runId = null) {
    text(requestId, '请求标识', 200); reason = text(reason, '申请依据');
    if (manual) this.requireAdmin(user);
    const log = await this.upstream.log(requestId);
    if (!manual && log.user_id !== user.id) throw new AppError('只能申请本人的消费', 403);
    if (modelExcluded(log, this.store.rules())) throw new AppError('该模型不参与补偿，已跳过空回检测');
    const owner = manual ? await this.upstream.target(log.user_id) : user;
    positiveInt(owner.id);
    if (owner.id !== log.user_id || owner.status === 2) throw new AppError('原消费用户不可用');
    const rules = await this.ruleContext([log]);
    if (!rules.applicationsEnabled) throw new AppError('申请暂未开放');
    if (!isOpen(rules, Date.now())) throw new AppError('不在每日申请开放时段');
    const a = assessLog(log, owner, rules);
    if (!a.eligible) throw new AppError(a.reasons.join('；'));
    const usage = this.store.overview(owner.id);
    if (usage.today.count >= rules.userDailyCount || usage.today.quota + a.expectedQuota > rules.userDailyQuota || usage.siteToday.count >= rules.siteDailyCount || usage.siteToday.quota + a.expectedQuota > rules.siteDailyQuota) throw new AppError('当日额度或次数不足');
    return this.view(this.store.create(log, owner, rules, reason, manual ? 'manual' : 'self', user.id, !selfService, runId), user.role >= 10);
  }
  review(user, id, action, note) {
    this.requireAdmin(user); const claim=this.claimFor(user, id);
    note = text(note, '审核意见');
    if (!['approve', 'reject'].includes(action)) throw new AppError('审核动作无效');
    if(action==='approve'&&fundingSource(claim.log)==='subscription')throw new AppError('订阅转余额审批须确认核实金额并执行返还');
    return this.store.transition(id, ['pending'], action === 'approve' ? 'approved' : 'rejected', user.id, note);
  }
  async approveSubscription(user,id,verifiedAmount,note){
    this.requireAdmin(user);const claim=this.claimFor(user,id);
    if(fundingSource(claim.log)!=='subscription')throw new AppError('不是订阅消费');
    positiveInt(verifiedAmount,'核实尚未返还额度');note=text(note,'订阅转余额核验依据');
    if(verifiedAmount>claim.log.quota)throw new AppError('已核实未返还额度不能超过原消费');
    this.store.transition(id,['pending'],'approved',user.id,'订阅转钱包余额审批通过：'+note);
    return this.#execute(user,id,verifiedAmount,'订阅空回补入钱包余额：'+note);
  }
  async selfService(user, requestId, reason = '申请自助核验空回补偿', runId = null) {
    text(requestId,'请求标识',200);
    const existing=this.store.byRequest(requestId);
    if(existing){if(existing.user_id!==user.id)throw new AppError('只能处理本人的消费',403);return this.view(existing);}
    let created;
    try{created=await this.apply(user,requestId,reason,false,true,runId);}catch(error){
      // Concurrent duplicate submissions return the same immutable application, never re-execute it.
      const current=this.store.byRequest(requestId);
      if(error.status===409&&current?.user_id===user.id)return this.view(current);
      throw error;
    }
    const claim=this.store.get(created.id);
    let aiReview = null;
    const activeRules = this.store.rules();
    if (activeRules.aiEnabled) {
      this.store.event(claim.id,user.id,'ai_review_started',{promptVersion:process.env.AI_PROMPT_VERSION||'empty-v1'});
      this.store.notifyClaim('ai_reviewing',claim,'正在读取日志、补偿规则与重复申请记录');
      try {
        aiReview = await this.ai.review(claim.log, activeRules);
      } catch (error) {
        aiReview = this.store.saveAiReview({
          requestId: claim.request_id,
          userId: claim.user_id,
          fingerprint: logFingerprint(claim.log),
          promptVersion: process.env.AI_PROMPT_VERSION || 'empty-v1',
          decision: 'uncertain',
          confidence: 0,
          reason: error instanceof AppError ? error.message : 'AI 服务暂不可用，转管理员审核',
          evidence: [],
          rawResponse: null,
          status: 'fallback'
        });
      }
    }
    const decision=selfServiceDecision(claim.log,user,await this.ruleContext([claim.log]),Date.now(),aiReview);
    if (aiReview) {
      this.store.event(claim.id,user.id,'ai_reviewed',{decision:aiReview.decision,confidence:aiReview.confidence,reason:aiReview.reason,status:aiReview.status});
      const confidence = `${Math.round(Number(aiReview.confidence || 0) * 100)}%`;
      this.store.notifyClaim('ai_reviewed',claim,`AI 判定：${aiReview.decision}，置信度 ${confidence}。${aiReview.reason}`);
    }
    this.store.event(claim.id,user.id,'self_service_routed',{route:decision.automatic?'automatic':'review',reasons:decision.reasons});
    if(!decision.automatic){
      if(aiReview) this.store.notifyClaim('ai_manual_review',claim,`证据不足或未达到自动阈值，转管理员审核。${decision.reasons.join('；')}`);
      return this.view(this.store.transition(claim.id,['pending'],'pending',user.id,'异常转审批：'+decision.reasons.join('；')));
    }
    try{
      this.store.transition(claim.id,['pending'],'approved',user.id,'系统自助核验通过，待二次核验');
      const result=await this.#execute(user,claim.id,claim.log.quota,'系统自助：空回证据、AI 判定、余额扣费、规则与限额核验',true);
      if(aiReview&&result.status==='succeeded')this.store.notifyClaim('ai_auto_compensation',result,`AI 高置信度判定为空回并已确认补额度。${aiReview.reason}`);
      return this.view(result);
    }catch(error){
      const current=this.store.get(claim.id);
      if(current.status==='executing')return this.view(this.store.transition(claim.id,['executing'],'unknown',user.id,'自助返还结果未确认，禁止重试，须人工对账'));
      if(['pending','approved'].includes(current.status))return this.view(this.store.transition(claim.id,[current.status],'pending',user.id,'自助核验异常，转审批：'+(error instanceof AppError?error.message:'上游暂不可核验')));
      return this.view(current);
    }
  }
  async execute(user, id, verifiedAmount, note) {
    this.requireAdmin(user);
    return this.#execute(user,id,verifiedAmount,note);
  }
  async #execute(user, id, verifiedAmount, note, automatic = false) {
    positiveInt(verifiedAmount, '核实尚未返还额度'); note = text(note, '返还核验依据');
    if (this.locks.has(id)) throw new AppError('这笔申请正在处理', 409);
    this.locks.add(id);
    try {
      const c = this.claimFor(user, id);
      if (c.status !== 'approved') throw new AppError('仅已通过审核的申请允许执行', 409);
      const original = await this.upstream.log(c.request_id);
      for (const key of ['request_id', 'type', 'user_id', 'quota', 'created_at', 'model_name', 'channel', 'prompt_tokens', 'completion_tokens', 'group', 'other']) {
        if (JSON.stringify(original[key]) !== JSON.stringify(c.log[key])) throw new AppError('原消费发生变化，须重新核实，未执行返还', 409);
      }
      if(automatic){const target=await this.upstream.target(c.user_id);if(target?.id!==c.user_id||target.status!==1)throw new AppError('原消费账号状态异常');}
      // Await all network reads before the reservation; read latest rules immediately before it.
      const rules = await this.ruleContext([original]);
      if (!rules.executionEnabled) throw new AppError('补偿执行暂未开放');
      if(automatic){
        if(!rules.applicationsEnabled||!isOpen(rules,Date.now()))throw new AppError('自助补偿开放时间或开关已变更');
        const aiReview = this.store.aiReview(c.request_id, logFingerprint(original), process.env.AI_PROMPT_VERSION || 'empty-v1');
        const decision=selfServiceDecision(original,{id:c.user_id},rules,Date.now(),aiReview);
        if(!decision.automatic)throw new AppError(decision.reasons.join('；'));
        const originalDecision=selfServiceDecision(original,{id:c.user_id},{...rules,selfServiceMaxQuota:Math.min(rules.selfServiceMaxQuota,c.rules.selfServiceMaxQuota),selfServiceMinAgeSeconds:Math.max(rules.selfServiceMinAgeSeconds,c.rules.selfServiceMinAgeSeconds)},Date.now(),aiReview);
        if(!originalDecision.automatic)throw new AppError(originalDecision.reasons.join('；'));
      }
      const a = assessLog(original, { id: c.user_id }, rules);
      if (!a.eligible) throw new AppError(a.reasons.join('；'));
      if (verifiedAmount > original.quota) throw new AppError('已核实未返还额度不能超过原消费');
      const amount = Math.min(verifiedAmount, expectedQuota(original, c.rules), expectedQuota(original, rules));
      positiveInt(amount, '实际补偿额度');
      this.store.reserve(id, user.id, amount, verifiedAmount, note, rules);
      try { await this.upstream.credit(c.user_id, amount); }
      catch (e) {
        return this.store.transition(id, ['executing'], e instanceof UpstreamError && e.definitive ? 'failed' : 'unknown', user.id, e instanceof UpstreamError && e.definitive ? '原站明确拒绝，未返还；需核查后重新审核' : '请求结果不明，须核对原站到账凭据；禁止直接重试');
      }
      return this.store.transition(id, ['executing'], 'succeeded', user.id, 'NewAPI 明确返回成功');
    } finally { this.locks.delete(id); }
  }
  reconcile(user, id, outcome, note) {
    this.requireAdmin(user); note = text(note, '对账凭据');
    if (!['received', 'not_received'].includes(outcome)) throw new AppError('核对结果无效');
    return this.store.transition(id, ['unknown'], outcome === 'received' ? 'succeeded' : 'failed', user.id, `人工核对：${note}`);
  }
  reopen(user, id, note) {
    this.requireAdmin(user);
    return this.store.transition(id, ['failed', 'rejected'], 'pending', user.id, text(note, '重新审核原因'));
  }
  saveRules(user, body) {
    this.requireAdmin(user);
    return this.store.saveRules(validateRules(body), user.id, body.version);
  }
}
