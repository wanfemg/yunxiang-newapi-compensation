import { AppError, assessLog, expectedQuota, isOpen, publicLog, positiveInt, validateRules, selfServiceDecision, fundingSource, compensationLabel, modelExcluded } from './rules.mjs';
import { UpstreamError } from './newapi.mjs';
import { LogQueries } from './log-queries.mjs';
import { AIReviewer, logFingerprint } from './ai-review.mjs';
import { QueryBatches } from './query-batches.mjs';

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}不能为空且不得超过 ${max} 字`);
  return value.trim();
}
export class Compensation {
  constructor(store, upstream, clock = Date.now, ai = {}) { this.store = store; this.upstream = upstream; this.locks = new Set(); this.logQueries = new LogQueries(store, upstream, clock); this.ai = ai.reviewer || new AIReviewer({ store, now: clock }); this.batches = new QueryBatches(this); }
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
    if (admin) {
      const fingerprint=logFingerprint(c.log),version=this.ai.promptVersion?.()||'empty-v1';
      const adminReview=this.ai.promptVersion?this.store.aiReview(c.request_id,fingerprint,this.ai.promptVersion('admin')):null;
      const current=this.store.aiReview(c.request_id,fingerprint,version);
      const aiReview=adminReview||current||this.store.latestAIReview(c.request_id,fingerprint);
      return {...c,fundingSource:fundingSource(c.log),compensationLabel:compensationLabel(c.log,c.source),expectedAmount:expectedQuota(c.log,c.rules),aiReview,aiReviewIsCurrent:Boolean(adminReview||current),aiReviewMode:adminReview?'admin':current?'automatic':'historical'};
    }
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
      const { end, from, added, coverageStart, scanned } = snapshot;
      data = { items: visible, total: visible.length, page: query.page || 1, syncedAt: snapshot.syncedAt, queryProgress: {end,from,added,coverageStart,scanned} };
    }
    r=await this.ruleContext(data.items);
    const usage = new Map();
    let items = data.items.map(log => {
      const assessment = assessLog(log, { id: log.user_id }, r);
      const c = log.request_id ? this.store.byRequest(log.request_id) : null;
      const reasons = [...assessment.reasons];
      if (!r.applicationsEnabled) reasons.push('申请暂未开放');
      if (!isOpen(r, Date.now())) reasons.push('不在每日申请开放时段');
      if (!usage.has(log.user_id)) usage.set(log.user_id, this.store.overview(log.user_id));
      const day = usage.get(log.user_id);
      if (day.today.count >= r.userDailyCount || day.today.quota + assessment.expectedQuota > r.userDailyQuota || day.siteToday.count >= r.siteDailyCount || day.siteToday.quota + assessment.expectedQuota > r.siteDailyQuota) reasons.push('当日额度或次数不足');
      if (c) reasons.push('已有申请，查看处理进度');
      const decision=selfServiceDecision(log,{id:log.user_id},r);
      return { log: admin ? log : publicLog(log), assessment: { ...assessment, reasons, canApply: assessment.eligible && reasons.length === 0, route:decision.automatic?'automatic':'review', reviewReasons:decision.reasons }, claim: c ? { id: c.id, status: c.status } : null };
    });
    if (!admin) {
      items = items.filter(item => query.view === 'eligible' ? item.assessment.eligible : query.view === 'pending' ? item.assessment.candidate && item.assessment.evidence !== 'empty_marked' : true);
      data.total = items.length;
      items = items.slice((data.page - 1) * 30, data.page * 30);
    }
    return { ...data, items, ...(!admin?{batches:await this.batches.list(user)}:{}), skippedModels: [...skipped.values()].sort((a,b)=>a.model.localeCompare(b.model)), skippedCount: [...skipped.values()].reduce((sum,entry)=>sum+entry.count,0) };
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
    if(claim.batch_id){
      const batch=this.store.queryBatch(claim.batch_id);
      if(batch.status!=='review')throw new AppError('当前补偿批次已锁定，不能修改审核',409);
      this.store.db.prepare('UPDATE claims SET batch_auto=0 WHERE id=?').run(id);
    }
    return this.store.transition(id, ['pending'], action === 'approve' ? 'approved' : 'rejected', user.id, note);
  }
  async assistReview(user,id){
    this.requireAdmin(user);
    const claim=this.claimFor(user,id),rules=this.store.rules();
    if(!rules.aiEnabled)throw new AppError('AI 辅助审核已关闭，请先在 AI 设置中开启',409);
    if(!['pending','approved'].includes(claim.status))throw new AppError('当前申请状态不支持 AI 辅助审核',409);
    if(!this.ai.configured())throw new AppError('请先保存 AI API 地址、密钥和模型',400);
    const previousReview=this.store.aiReview(claim.request_id,logFingerprint(claim.log),this.ai.promptVersion?.()||'empty-v1');
    const result=await this.ai.review(claim.log,rules,{mode:'admin',previousReview});
    const recorded=this.store.db.prepare("SELECT 1 FROM events WHERE claim_id=? AND action='admin_ai_reviewed' AND json_extract(detail,'$.reviewId')=?").get(id,result.id);
    if(!recorded)this.store.event(id,user.id,'admin_ai_reviewed',{reviewId:result.id,decision:result.decision,confidence:result.confidence,promptVersion:result.prompt_version,status:result.status});
    return this.view(this.store.get(id),true);
  }
  async approveWithAI(user,id){
    this.requireAdmin(user);
    const claim=this.claimFor(user,id),rules=this.store.rules();
    if(claim.status!=='pending')throw new AppError('仅待审核申请可采纳 AI 建议并补额度',409);
    if(claim.batch_id&&this.store.queryBatch(claim.batch_id)?.status!=='review')throw new AppError('整批正在处理中，请等待审查完成',409);
    if(fundingSource(claim.log)==='subscription')throw new AppError('订阅申请须逐笔核实未退款金额，请使用原审核流程');
    if(!this.ai.promptVersion)throw new AppError('AI 复核版本不可用，请重新执行 AI 辅助审核',409);
    const review=this.store.aiReview(claim.request_id,logFingerprint(claim.log),this.ai.promptVersion('admin'));
    if(!review||review.status!=='completed')throw new AppError('请先完成 AI 二次复核，再采纳审核建议',409);
    if(review.analysis?.recommendation!=='approve'||review.decision!=='empty'||review.confidence*100<rules.aiAutoThreshold)throw new AppError('AI 建议不是高置信度通过，须由管理员按常规流程处理',409);
    const note=`管理员采纳 AI 二次复核建议并确认补偿：${review.analysis.summary}；${review.reason}`;
    this.store.transition(id,['pending'],'approved',user.id,note);
    return this.execute(user,id,expectedQuota(claim.log,claim.rules),note);
  }
  async approveSubscription(user,id,verifiedAmount,note,deferBatch=false){
    this.requireAdmin(user);const claim=this.claimFor(user,id);
    if(claim.batch_id&&this.store.queryBatch(claim.batch_id)?.status!=='review')throw new AppError('整批正在处理中，请等待审查完成',409);
    if(fundingSource(claim.log)!=='subscription')throw new AppError('不是订阅消费');
    positiveInt(verifiedAmount,'核实尚未返还额度');note=text(note,'订阅转余额核验依据');
    if(verifiedAmount>claim.log.quota)throw new AppError('已核实未返还额度不能超过原消费');
    this.store.transition(id,['pending'],'approved',user.id,'订阅转钱包余额审批通过：'+note);
    return this.execute(user,id,verifiedAmount,'订阅空回补入钱包余额：'+note,deferBatch);
  }
  async selfService(user, requestId, reason = '申请自助核验空回补偿', runId = null, prepared = false) {
    text(requestId,'请求标识',200);
    const existing=this.store.byRequest(requestId);
    if(existing&&existing.user_id!==user.id)throw new AppError('只能处理本人的消费',403);
    const queryBatch=!prepared&&(existing?.batch_id||this.store.batchForRequest(user.id,requestId));
    if(queryBatch){
      const batchLog=this.store.queryBatch(queryBatch)?.logs.find(log=>log.request_id===requestId);
      if(batchLog&&modelExcluded(batchLog,this.store.rules()))throw new AppError('该模型不参与补偿，已跳过空回检测');
      await this.batches.submit(user,queryBatch,reason);
      const claim=this.store.byRequest(requestId);
      if(!claim)throw new AppError('这条消费不符合本次补偿条件');
      return this.view(claim);
    }
    if(existing&&!prepared)return this.view(existing);
    let created;
    try{created=prepared?existing:await this.apply(user,requestId,reason,false,true,runId);}catch(error){
      // Concurrent duplicate submissions return the same immutable application, never re-execute it.
      const current=this.store.byRequest(requestId);
      if(error.status===409&&current?.user_id===user.id)return this.view(current);
      throw error;
    }
    const claim=this.store.get(created.id);
    let aiReview = null;
    const activeRules = this.store.rules();
    if (activeRules.aiEnabled) {
      this.store.event(claim.id,user.id,'ai_review_started',{promptVersion:this.ai.promptVersion?.()||'empty-v1'});
      this.store.notifyClaim('ai_reviewing',claim,'正在读取日志、补偿规则与重复申请记录');
      try {
        aiReview = await this.ai.review(claim.log, activeRules);
      } catch (error) {
        aiReview = this.store.saveAiReview({
          requestId: claim.request_id,
          userId: claim.user_id,
          fingerprint: logFingerprint(claim.log),
          promptVersion: this.ai.promptVersion?.() || 'empty-v1',
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
      if(prepared)this.store.db.prepare('UPDATE claims SET batch_auto=1 WHERE id=?').run(claim.id);
      this.store.transition(claim.id,['pending'],'approved',user.id,'系统自助核验通过，待二次核验');
      if(prepared)return this.view(this.store.get(claim.id));
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
  async execute(user, id, verifiedAmount, note, deferBatch = false) {
    this.requireAdmin(user);
    const claim=this.claimFor(user,id);
    if(claim.batch_id){
      await this.batches.stage(user,claim,verifiedAmount,note);
      if(!deferBatch)await this.batches.settle(user,claim.batch_id);
      return this.store.get(id);
    }
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
        const aiReview = this.store.aiReview(c.request_id, logFingerprint(original), this.ai.promptVersion?.() || 'empty-v1');
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
      return this.store.transition(id, ['executing'], 'succeeded', user.id, '云中猫API小站 明确返回成功');
    } finally { this.locks.delete(id); }
  }
  reconcile(user, id, outcome, note) {
    this.requireAdmin(user); note = text(note, '对账凭据');
    if (!['received', 'not_received'].includes(outcome)) throw new AppError('核对结果无效');
    const claim=this.claimFor(user,id);
    if(claim.batch_id){
      if(claim.status!=='unknown'||this.store.queryBatch(claim.batch_id)?.status!=='unknown')throw new AppError('仅到账待核对的整批允许对账',409);
      this.store.finishBatch(claim.batch_id,outcome==='received'?'succeeded':'failed',user.id,'整批人工核对：'+note);
      return this.store.get(id);
    }
    return this.store.transition(id, ['unknown'], outcome === 'received' ? 'succeeded' : 'failed', user.id, `人工核对：${note}`);
  }
  reopen(user, id, note) {
    this.requireAdmin(user);
    note=text(note,'重新审核原因');
    const claim=this.claimFor(user,id);
    if(claim.batch_id){
      const batch=this.store.queryBatch(claim.batch_id);
      if(['executing','unknown','succeeded','judging'].includes(batch.status))throw new AppError('整批正在处理、待对账或已经补偿，不能重复补额度',409);
      if(batch.status==='failed'){
        this.store.transaction(()=>{
          for(const item of this.store.batchClaims(batch.id).filter(c=>c.status==='failed')){
            this.store.db.prepare("UPDATE claims SET status='pending',batch_auto=0,confirmed_unreturned=NULL,verification_note=NULL,review_note=?,updated_at=? WHERE id=?").run(text(note,'重新审核原因'),Date.now(),item.id);
            this.store.event(item.id,user.id,'pending',{note:'整批重新审核：'+note});
          }
          this.store.updateBatch(batch.id,'review','整批重新审核，全部完成后统一补偿');
        });
        return this.store.get(id);
      }
      this.store.updateBatch(batch.id,'review','重新审核，全部完成后统一补偿');
    }
    return this.store.transition(id, claim.batch_id?['failed','rejected','approved']:['failed','rejected'], 'pending', user.id, note);
  }
  saveRules(user, body) {
    this.requireAdmin(user);
    return this.store.saveRules(validateRules(body), user.id, body.version);
  }
}
