import { AppError } from './rules.mjs';
import { createHash, randomUUID } from 'node:crypto';

const MAX_LOGS = 10_000;
const rowKey = log => log.id === undefined ? JSON.stringify(log) : JSON.stringify([log.id, log.request_id]);
const identityFields=['request_id','user_id','type','created_at','model_name','channel','quota','prompt_tokens','completion_tokens','is_stream','group','token_id','token_name','other','content'];
const identifyRows = (rows,preserve=true) => {
  const counts=new Map();
  return rows.map(log=>{
    const fingerprint=createHash('sha256').update(JSON.stringify(identityFields.map(key=>log[key]??null))).digest('hex');
    const occurrence=(counts.get(fingerprint)||0)+1;counts.set(fingerprint,occurrence);
    return {...log,query_identity:preserve&&log.query_identity?log.query_identity:fingerprint+':'+occurrence};
  });
};
const mergeRanges = ranges => {
  const merged = [];
  for (const range of ranges.filter(range => range.start <= range.end).sort((a,b) => a.start-b.start)) {
    const last=merged.at(-1);
    if(last && range.start<=last.end+1) last.end=Math.max(last.end,range.end);
    else merged.push({...range});
  }
  return merged;
};
const gapsIn = (start,end,coverage) => {
  const gaps=[];let next=start;
  for(const range of coverage){
    if(range.end<next)continue;
    if(range.start>end)break;
    if(range.start>next)gaps.push({start:next,end:Math.min(end,range.start-1)});
    next=Math.max(next,range.end+1);
  }
  if(next<=end)gaps.push({start:next,end});
  return gaps;
};

// Query snapshots are only for discovery. Applying and paying always read upstream again.
export class LogQueries {
  constructor(store, upstream, clock = Date.now) {
    this.store = store;
    this.upstream = upstream;
    this.clock = clock;
    this.pending = new Map();
  }
  async read(user, query, hours, { consumptionStart = null, consumptionEnd = null } = {}) {
    const now = this.clock();
    const {start,end}=this.window(hours,{consumptionStart,consumptionEnd},now);
    // Capture the click time before waiting. Each later request scans only its remaining tail.
    return this.enqueue(user,()=>this.sync(user,query,start,end,now));
  }
  window(hours,{consumptionStart=null,consumptionEnd=null}={},now=this.clock()) {
    const current=Math.floor(now/1000);
    if(!Number.isFinite(hours)||hours<=0||!Number.isSafeInteger(current)||[consumptionStart,consumptionEnd].some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0)))throw new AppError('消费时间范围无效');
    const end=Math.min(current,consumptionEnd??current),start=Math.max(0,Math.floor(current-hours*3600),consumptionStart??0);
    if(start>end)throw new AppError('当前没有已开放的消费时间范围');
    return {start,end};
  }
  async enqueue(user,run) {
    const previous = this.pending.get(user.id) || Promise.resolve();
    const job = previous.catch(() => {}).then(run);
    this.pending.set(user.id, job);
    try { return await job; }
    finally { if (this.pending.get(user.id) === job) this.pending.delete(user.id); }
  }
  coverage(snapshot) {
    return mergeRanges(snapshot?.coverage||(Number.isSafeInteger(snapshot?.end)?[{start:snapshot.coverageStart??snapshot.from,end:snapshot.end}]:[]));
  }
  progress(user,start,end) {
    const saved=this.store.logQueryProgress(user.id);
    if(saved)return saved;
    // Paid query batches preserve a usable cutoff when an old installation has no progress row.
    const batch=this.store.db.prepare(`SELECT b.query_from AS start,b.query_end AS end,b.created_at AS syncedAt
      FROM compensation_batches b WHERE b.user_id=? AND EXISTS(
        SELECT 1 FROM claims c WHERE c.batch_id=b.id AND c.user_id=b.user_id AND c.status='succeeded')
      ORDER BY b.query_end DESC,b.created_at DESC,b.rowid DESC LIMIT 1`).get(user.id);
    if(!batch)return null;
    return {items:this.store.logQueryRows(user.id,start,end),from:batch.start,end:batch.end,syncedAt:batch.syncedAt,coverageStart:batch.start,coverage:[{start:batch.start,end:batch.end}],window:{start,end}};
  }
  visible(snapshot,user,start,end) {
    const coverage=this.coverage(snapshot);
    const from=Number.isSafeInteger(snapshot?.end)?Math.max(start,snapshot.end+1):start;
    return {...snapshot,window:{start,end},coverage:coverage.map(range=>({start:Math.max(start,range.start),end:Math.min(end,range.end)})).filter(range=>range.start<=range.end),gaps:gapsIn(from,end,coverage),items:snapshot.items.filter(log=>log.user_id===user.id&&log.created_at>=start&&log.created_at<=end)};
  }
  mergeRows(user,start,end,previous,fetched,batchId) {
    const saved=new Map();
    const previousStart=previous?.window?.start??previous?.coverageStart??start;
    const restored=start<previousStart?this.store.logQueryRows(user.id,start,Math.min(end,previousStart-1)):[];
    for(const log of [...restored,...(previous?.items||[])]) {
      if(log.user_id===user.id&&log.created_at>=start&&log.created_at<=end)saved.set(log.query_identity||rowKey(log),log);
    }
    const rows=new Map(identifyRows([...saved.values()]).map(log=>[log.query_identity,log])),added=[];
    const knownSource=fetched.length?new Map([...this.store.logQueryRows(user.id,start,end),...saved.values()].map(log=>[log.query_identity||rowKey(log),log])):saved;
    const known=new Set(identifyRows([...knownSource.values()]).map(log=>log.query_identity));
    for(const log of identifyRows(fetched,false))if(!known.has(log.query_identity)){
      const discovered={...log,query_batch_id:batchId};rows.set(log.query_identity,discovered);added.push(discovered);
    }
    if(rows.size>MAX_LOGS)throw new AppError('保留日志数量过多，请管理员调整查询天数；查询进度未推进',409);
    return {items:[...rows.values()].sort((a,b)=>b.created_at-a.created_at||Number(b.id||0)-Number(a.id||0)),added};
  }
  async sync(user, query, start, end, now) {
    const previous = this.progress(user,start,end);
    const coverage=this.coverage(previous);
    const hasCheckpoint=Number.isSafeInteger(previous?.end);
    const scanStart=hasCheckpoint?Math.max(start,previous.end+1):start;
    const gaps=gapsIn(scanStart,end,coverage);
    if(hasCheckpoint&&(!query.refresh||(!gaps.length&&end<=previous.end))){
      const previousStart=previous.window?.start??previous.coverageStart??start;
      const items=start<previousStart?this.mergeRows(user,start,end,previous,[],null).items:previous.items;
      return {...this.visible({...previous,coverage,items},user,start,end),scanned:false,added:0};
    }
    const from=gaps[0]?.start??end,batchId=randomUUID(),fetched=[];
    for(const range of gaps)fetched.push(...await this.fetchRange(user,range));
    const {items,added}=this.mergeRows(user,start,end,previous,fetched,batchId);
    const nextCoverage=mergeRanges([...coverage,...gaps]);
    const snapshot = { items, end:Math.max(end,previous?.end??end), syncedAt: now, from, added:added.length, coverageStart: Math.max(start,nextCoverage[0]?.start??start), coverage:nextCoverage,window:{start,end} };
    this.store.saveLogQueryProgress(user.id, snapshot, { id: batchId, user, from, end, items:added });
    return { ...this.visible(snapshot,user,start,end), scanned: true };
  }
  async targetedBackfill(user,{start,end},hours,bounds={}) {
    const now=this.clock(),window=this.window(hours,bounds,now);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<window.start||end>window.end)throw new AppError('补查起止时间必须位于当前管理员允许的消费时间范围内');
    return this.enqueue(user,async()=>{
      const previous=this.store.logQueryProgress(user.id),batchId=randomUUID(),fetched=await this.fetchRange(user,{start,end});
      const {items,added}=this.mergeRows(user,window.start,window.end,previous,fetched,batchId);
      const coverage=mergeRanges([...this.coverage(previous),{start,end}]);
      const snapshot={...previous,items,itemsOmitted:false,end:previous?.end??null,from:previous?.from??start,syncedAt:previous?.syncedAt??null,coverage,coverageStart:coverage[0].start,window,backfill:{from:start,end,added:added.length,batchId:added.length?batchId:null,completedAt:now}};
      this.store.saveLogQueryProgress(user.id,snapshot,{id:batchId,user,from:start,end,items:added});
      return {...this.visible(snapshot,user,window.start,window.end),scanned:true,added:added.length};
    });
  }
  async fetchRange(user,{start,end}) {
    const fetched=[];
    const identities = new Set();
    let total = Infinity;
    for (let page = 1; fetched.length < total; page++) {
      const data = await this.upstream.logs({ user, page, start, end });
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > MAX_LOGS) throw new AppError('日志数量过多或响应异常，请管理员调整查询天数；查询进度未推进', 409);
      if (total !== Infinity && data.total !== total) throw new AppError('日志总数在同步中变化，请重试；查询进度未推进', 502);
      total = data.total;
      if ((!data.items.length && fetched.length < total) || fetched.length + data.items.length > total || page > 1000) throw new AppError('日志同步不完整，请重试；查询进度未推进', 502);
      for (const log of data.items) {
        if (identities.has(rowKey(log))) throw new AppError('日志分页重复，请重试；查询进度未推进', 502);
        identities.add(rowKey(log));
      }
      fetched.push(...data.items);
    }
    return fetched.filter(log=>log.user_id===user.id&&log.created_at>=start&&log.created_at<=end);
  }
}
