import { AppError, assessLog, expectedQuota, fundingSource, isOpen, positiveInt, selfServiceDecision, limitDetail } from './rules.mjs';
import { logFingerprint } from './ai-review.mjs';
import { UpstreamError } from './newapi.mjs';

const sameLog=(a,b)=>['request_id','type','user_id','quota','created_at','model_name','channel','prompt_tokens','completion_tokens','group','other'].every(key=>JSON.stringify(a[key])===JSON.stringify(b[key]));
async function mapLimit(items,limit,fn){
  let next=0;
  const results=await Promise.allSettled(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const index=next++;await fn(items[index],index);}
  }));
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
}

export class QueryBatches {
  constructor(service) { this.service=service; this.store=service.store; this.jobs=new Map(); this.submissions=new Map(); }
  require(user,id) {
    const batch=this.store.queryBatch(id);
    if(!batch||(user.role<10&&batch.user_id!==user.id))throw new AppError('补偿批次不存在',404);
    return batch;
  }
  async view(user,id) {
    const batch=this.require(user,id),claims=this.store.batchClaims(id),rules=batch.status==='open'?await this.service.ruleContext(batch.logs):this.store.rules();
    const candidates=batch.status==='open'?batch.logs.filter(log=>log.request_id&&!this.store.byRequest(log.request_id)).map(log=>({log,assessment:assessLog(log,{id:batch.user_id},rules)})).filter(item=>item.assessment.candidate):[];
    const available=candidates.filter(item=>item.assessment.eligible);
    const items=claims.length?claims.map(c=>({id:c.id,requestId:c.request_id,model:c.log.model_name,status:c.status,amount:c.amount||expectedQuota(c.log,c.rules),note:c.review_note||''})):candidates.map(({log,assessment})=>({requestId:log.request_id,model:log.model_name,status:assessment.eligible?'unsubmitted':'unavailable',amount:assessment.expectedQuota,note:assessment.reasons.join('；')}));
    const total=items.filter(c=>!['rejected','failed','unavailable'].includes(c.status)).reduce((n,c)=>n+c.amount,0);
    const paidAmount=claims.filter(c=>c.status==='succeeded').reduce((n,c)=>n+c.amount,0);
    const pendingAmount=items.filter(c=>['pending','approved','unsubmitted'].includes(c.status)).reduce((n,c)=>n+c.amount,0);
    const submissionLimit=batch.status==='open'?this.store.compensationLimit(batch.user_id,id,0,rules,{countsOnly:true}):null;
    const estimatedLimit=batch.status==='open'?this.store.compensationLimit(batch.user_id,id,total,rules):null;
    const limit=batch.status==='waiting_limit'?this.paymentLimit(batch,claims,rules):null;
    return {id:batch.id,userId:batch.user_id,username:batch.username,status:batch.status,note:batch.note,from:batch.query_from,end:batch.query_end,createdAt:batch.created_at,updatedAt:batch.updated_at,amount:batch.amount,paidAmount,pendingAmount,expectedAmount:total,records:items.length,availableRecords:available.length,canSubmit:batch.status==='open'&&available.length>0&&!submissionLimit,submissionLimit,warnings:estimatedLimit?.kind==='quota'?[estimatedLimit]:[],limit,previousLimit:batch.limit,canResume:batch.status==='waiting_limit'&&!limit&&claims.some(c=>c.status==='approved'),resumable:batch.status==='waiting_limit',models:[...new Set(items.map(c=>c.model))],pending:claims.filter(c=>c.status==='pending').length,approved:claims.filter(c=>c.status==='approved').length,judged:claims.filter(c=>c.status!=='pending'||c.review_note).length,items};
  }
  paymentLimit(batch,claims,rules){
    const approved=claims.filter(c=>c.status==='approved'),paid=claims.filter(c=>c.status==='succeeded').reduce((sum,c)=>sum+c.amount,0);
    const amount=approved.reduce((sum,c)=>sum+Math.min(c.confirmed_unreturned||expectedQuota(c.log,c.rules),expectedQuota(c.log,c.rules),expectedQuota(c.log,rules)),0);
    const caps=[rules.perBatchQuota,...claims.map(c=>c.rules.perBatchQuota)].filter(value=>value>0);
    if(caps.length&&paid+amount>Math.min(...caps))return limitDetail('batch','user',paid,Math.min(...caps),paid+amount,rules,Date.now(),true);
    return amount?this.store.compensationLimit(batch.user_id,batch.id,amount,rules):null;
  }
  async list(user) {
    const rows=this.store.db.prepare("SELECT id FROM compensation_batches WHERE user_id=? AND status NOT IN ('succeeded','rejected') ORDER BY created_at DESC,id").all(user.id);
    const batches=[];
    for(const {id}of rows){const batch=await this.view(user,id);if(batch.records)batches.push(batch);}
    return batches;
  }
  run(id,fn) {
    if(this.jobs.has(id))return this.jobs.get(id);
    const job=Promise.resolve().then(fn).finally(()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);});
    this.jobs.set(id,job);return job;
  }
  async submit(user,id,reason='申请按查询批次核验空回补偿') {
    return this.submission(user,id,reason).completion;
  }
  async submitBackground(user,id,reason='申请按查询批次核验空回补偿') {
    const task=this.submission(user,id,reason);
    return {batch:await task.accepted,completion:task.completion};
  }
  submission(user,id,reason) {
    const owned=this.require(user,id);
    if(owned.user_id!==user.id)throw new AppError('只能提交本人的查询批次',403);
    if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new AppError('补偿说明无效');
    if(this.submissions.has(id))return this.submissions.get(id);
    if(this.jobs.has(id))return {accepted:this.view(user,id),completion:this.jobs.get(id)};
    const {promise:accepted,resolve:accept,reject}=Promise.withResolvers();
    accepted.catch(()=>{});
    const completion=this.run(id,async()=>{
      const batch=this.require(user,id);
      if(batch.status!=='open'){const result=await this.view(user,id);accept(result);return result;}
      const rules=await this.service.ruleContext(batch.logs);
      if(!rules.applicationsEnabled||!isOpen(rules,Date.now()))throw new AppError('申请暂未开放');
      const logs=batch.logs.filter(log=>log.request_id&&!this.store.byRequest(log.request_id)&&assessLog(log,user,rules).eligible);
      if(!logs.length){this.store.updateBatch(id,'rejected','本次查询没有可补偿的记录');const result=await this.view(user,id);accept(result);return result;}
      const counts=new Map();
      for(const log of batch.logs)if(log.request_id)counts.set(log.request_id,(counts.get(log.request_id)||0)+1);
      if(logs.some(log=>counts.get(log.request_id)!==1))throw new AppError('存在重复原请求标识，禁止关联补偿，请管理员核实',409);
      this.store.enrollBatch(id,logs,user,rules,reason.trim(),user.id);
      accept(await this.view(user,id));
      const claims=this.store.batchClaims(id);
      await mapLimit(claims,4,async claim=>{
        try{
          const original=await this.service.upstream.log(claim.request_id);
          if(!sameLog(original,claim.log))throw new AppError('原消费发生变化，转人工核实');
          const current=await this.service.ruleContext([original]),assessment=assessLog(original,user,current,Date.now(),{acceptedAt:claim.created_at,applicationHours:claim.rules.applicationHours});
          if(!assessment.eligible)throw new AppError(assessment.reasons.join('；'));
          await this.service.selfService(user,claim.request_id,reason,id,true);
        }catch(error){
          const current=this.store.get(claim.id);
          if(current.status==='pending')this.store.transition(claim.id,['pending'],'pending',user.id,error instanceof AppError?error.message:'原消费暂不可核验，转人工审核');
        }
      });
      await this.finishJudging(user,id);
      return this.view(user,id);
    }).catch(error=>{
      reject(error);
      if(this.store.queryBatch(id)?.status==='judging')this.store.updateBatch(id,'review','自动审核暂时中断，申请已保留并转管理员继续处理，无需重复提交');
      throw error;
    });
    const task={accepted,completion};
    this.submissions.set(id,task);
    const cleanup=()=>{this.store.releaseCompensationSlot(id);if(this.submissions.get(id)===task)this.submissions.delete(id);};
    completion.then(cleanup,cleanup);
    return task;
  }
  async stage(user,claim,amount,note) {
    this.service.requireAdmin(user);positiveInt(amount,'核实尚未返还额度');
    if(typeof note!=='string'||!note.trim()||note.length>2000)throw new AppError('返还核验依据不能为空且不得超过 2000 字');
    const batch=this.require(user,claim.batch_id);
    if(!['review','waiting_limit'].includes(batch.status)||claim.status!=='approved')throw new AppError('仅整批待处理且已通过审核的记录允许核验',409);
    if(amount>claim.log.quota)throw new AppError('已核实未返还额度不能超过原消费');
    this.store.db.prepare('UPDATE claims SET confirmed_unreturned=?,verification_note=?,batch_auto=0 WHERE id=?').run(amount,note.trim(),claim.id);
  }
  settle(user,id) {
    this.service.requireAdmin(user);this.require(user,id);
    return this.run(id,()=>this.finishJudging(user,id));
  }
  async resume(user,id){
    const batch=this.require(user,id);
    if(user.role<10&&batch.user_id!==user.id)throw new AppError('只能继续本人的补偿批次',403);
    if(batch.status==='succeeded')return this.view(user,id);
    if(batch.status!=='waiting_limit')throw new AppError('当前批次没有等待恢复的额度或次数',409);
    return this.run(id,()=>this.finishJudging(user,id));
  }
  async finishJudging(user,id) {
    const batch=this.require(user,id),claims=this.store.batchClaims(id);
    if(!['judging','review','waiting_limit'].includes(batch.status))return this.view(user,id);
    const partial=claims.some(c=>c.rules.aiEnabled);
    if(claims.some(c=>c.status==='pending')&&!partial){
      this.store.updateBatch(id,'review','部分记录待人工审核；全部审核结束后统一补额度');
      return this.view(user,id);
    }
    const approved=claims.filter(c=>c.status==='approved');
    if(!approved.length){
      const pending=claims.some(c=>c.status==='pending'),paid=claims.some(c=>c.status==='succeeded');
      this.store.updateBatch(id,pending?'review':paid?'succeeded':'rejected',pending?'未通过自动判定的记录已转人工审核':paid?'已通过部分补偿完成，其余申请未通过':'本次记录均未通过，不占补偿次数');
      return this.view(user,id);
    }
    const entries=[];
    try{
      const target=await this.service.upstream.target(batch.user_id);
      if(target?.id!==batch.user_id||target.status!==1)throw new AppError('原消费账号状态异常');
      const originals=new Array(approved.length);
      await mapLimit(approved,4,async(claim,index)=>{
        const original=await this.service.upstream.log(claim.request_id);
        if(!sameLog(original,claim.log))throw new AppError('原消费发生变化，须重新审核：'+claim.request_id);
        originals[index]=original;
      });
      const rules=await this.service.ruleContext(originals);
      if(!rules.executionEnabled)throw new AppError('补偿执行暂未开放');
      for(let i=0;i<approved.length;i++){
        const c=approved[i],original=originals[i],accepted={acceptedAt:c.created_at,applicationHours:c.rules.applicationHours},assessment=assessLog(original,{id:batch.user_id},rules,Date.now(),accepted);
        if(!assessment.eligible)throw new AppError(assessment.reasons.join('；'));
        if(c.batch_auto){
          const ai=this.store.aiReview(c.request_id,logFingerprint(original),this.service.ai.promptVersion?.()||'empty-v1');
          const stricter={...rules,selfServiceMaxQuota:Math.min(rules.selfServiceMaxQuota,c.rules.selfServiceMaxQuota),selfServiceMinAgeSeconds:Math.max(rules.selfServiceMinAgeSeconds,c.rules.selfServiceMinAgeSeconds)};
          const decision=selfServiceDecision(original,{id:batch.user_id},stricter,Date.now(),ai,accepted);
          if(!rules.applicationsEnabled||!isOpen(rules,Date.now())||!decision.automatic){
            this.store.transition(c.id,['approved'],'pending',user.id,'自动审核条件已变化，须管理员复核：'+decision.reasons.join('；'));
            throw new AppError('自动审核条件已变化，须管理员复核：'+decision.reasons.join('；'));
          }
        }
        if(!c.batch_auto&&fundingSource(c.log)==='subscription'&&!c.confirmed_unreturned)throw new AppError('订阅消费仍需逐笔核实未退款金额');
        const verified=c.confirmed_unreturned||expectedQuota(c.log,c.rules);
        entries.push({id:c.id,amount:Math.min(verified,expectedQuota(original,c.rules),expectedQuota(original,rules)),verifiedAmount:verified,note:c.verification_note||'整批审核完成，合并补额度'});
      }
      this.store.reserveBatch(id,user.id,entries,rules);
    }catch(error){
      // No remote write has happened. Keep all records for explicit administrator handling.
      if(this.store.queryBatch(id).status!=='executing')this.store.updateBatch(id,error.limit?'waiting_limit':'review',error instanceof AppError?error.message:'原站核验失败，整批未执行，请管理员处理',null,error.limit||null);
      return this.view(user,id);
    }
    let status='succeeded',note='云中猫API小站明确返回整批补额度成功';
    try{await this.service.upstream.credit(batch.user_id,entries.reduce((n,e)=>n+e.amount,0));}
    catch(error){
      status=error instanceof UpstreamError&&error.definitive?'failed':'unknown';
      note=status==='failed'?'原站明确拒绝，整批未补偿；核查后重新审核':'整批到账结果不明，请核对原站流水，禁止重复补偿';
    }
    try{this.store.finishBatch(id,status,user.id,note);}
    catch(error){
      if(this.store.queryBatch(id).status==='executing')this.store.finishBatch(id,'unknown',user.id,'原站请求完成但本地记录未确认，禁止重复补偿，须整批对账');
      else throw error;
    }
    return this.view(user,id);
  }
}
