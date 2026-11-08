export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const defaults = {
  version: 1, applicationsEnabled: false, executionEnabled: false, selfServiceEnabled: true, selfServiceMaxQuota: 100000, selfServiceMinAgeSeconds: 60, timezone: 'Asia/Shanghai',
  channels: [], models: [], excludedModels: [], restrictModels:true, userGroups: [], blockedUsers: [], refundBasisPoints: 10000,
  aiEnabled: false, aiAutoThreshold: 90, aiDailyLimit: 30,
  perRecordQuota: 0, perBatchQuota: 0, userDailyQuota: 0, userDailyCount: 0, siteDailyQuota: 0, siteDailyCount: 0,
  maxPending: 10, applicationHours: 72, consumptionStart: null, consumptionEnd: null,
  openStart: '00:00', openEnd: '00:00', dailyResetTime: '00:00',
  notifications: { enabled: false, events: ['application_pending', 'review_result', 'compensation_success', 'execution_failed', 'execution_unknown', 'ai_reviewing', 'ai_reviewed', 'ai_auto_compensation', 'ai_manual_review', 'batch_result'] },
  emailNotifications: { enabled: false, events: ['approved', 'rejected', 'succeeded', 'failed', 'unknown'] }
};
export const eventTypes = ['application_pending', 'review_result', 'compensation_success', 'execution_failed', 'execution_unknown', 'ai_reviewing', 'ai_reviewed', 'ai_auto_compensation', 'ai_manual_review', 'batch_result', 'notification_test'];
export function positiveInt(value, label = '数值') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(`${label}必须是正整数`);
  return value;
}
export function validateRules(input) {
  const r = structuredClone(input);
  r.dailyResetTime ??= defaults.dailyResetTime;
  r.perBatchQuota ??= defaults.perBatchQuota;
  r.emailNotifications ??= structuredClone(defaults.emailNotifications);
  if (!Object.hasOwn(r, 'excludedModels')) r.excludedModels = [];
  for (const key of Object.keys(defaults)) if (!(key in r)) throw new AppError(`缺少规则：${key}`);
  for (const key of ['applicationsEnabled', 'executionEnabled', 'selfServiceEnabled','restrictModels']) if (typeof r[key] !== 'boolean') throw new AppError('开关必须为布尔值');
  try { new Intl.DateTimeFormat('en', { timeZone: r.timezone }).format(); } catch { throw new AppError('时区无效'); }
  for (const key of ['channels', 'blockedUsers']) {
    if (!Array.isArray(r[key]) || r[key].length > 1000) throw new AppError(`${key}格式无效`);
    r[key] = [...new Set(r[key].map(v => positiveInt(v, key)))];
  }
  for (const key of ['models', 'userGroups']) {
    if (!Array.isArray(r[key]) || r[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 200) || r[key].length > 1000) throw new AppError(`${key}格式无效`);
    r[key] = [...new Set(r[key].map(v => v.trim()))];
  }
  if (!Array.isArray(r.excludedModels) || r.excludedModels.length > 10000) throw new AppError('不可补模型规则格式无效');
  const exclusions = new Map();
  for (const entry of r.excludedModels) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 200) throw new AppError('不可补模型规则格式无效');
    const rule = { channelId: positiveInt(entry.channelId, '排除渠道 ID'), model: entry.model.trim() };
    exclusions.set(JSON.stringify([rule.channelId, rule.model]), rule);
  }
  r.excludedModels = [...exclusions.values()];
  for (const key of ['perRecordQuota', 'perBatchQuota', 'userDailyQuota', 'userDailyCount', 'siteDailyQuota', 'siteDailyCount']) {
    if (!Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 1_000_000_000_000) throw new AppError(`${key}必须是非负安全整数`);
  }
  if (typeof r.aiEnabled !== 'boolean') throw new AppError('AI 判定开关必须为布尔值');
  if (!Number.isSafeInteger(r.aiAutoThreshold) || r.aiAutoThreshold < 70 || r.aiAutoThreshold > 100) throw new AppError('AI 自动判定阈值须为 70–100');
  if (!Number.isSafeInteger(r.aiDailyLimit) || r.aiDailyLimit < 1 || r.aiDailyLimit > 1000) throw new AppError('AI 每日审核次数须为 1–1000');
  positiveInt(r.maxPending, '待审核数量'); positiveInt(r.applicationHours, '申请有效小时');
  positiveInt(r.selfServiceMaxQuota, '自助单笔额度上限');positiveInt(r.selfServiceMinAgeSeconds, '结算等待秒数');
  if(r.selfServiceMaxQuota>1_000_000_000_000||r.selfServiceMinAgeSeconds<30||r.selfServiceMinAgeSeconds>86400)throw new AppError('自助上限或结算等待时间无效（30–86400 秒）');
  if (r.maxPending > 1000 || r.applicationHours > 87600) throw new AppError('申请数量或有效期过大');
  positiveInt(r.refundBasisPoints, '补偿比例');
  if (r.refundBasisPoints > 10000) throw new AppError('补偿比例不能超过 100%');
  for (const k of ['openStart', 'openEnd', 'dailyResetTime']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r[k])) throw new AppError('时间格式为 HH:mm');
  for (const k of ['consumptionStart', 'consumptionEnd']) if (r[k] !== null && (!Number.isSafeInteger(r[k]) || r[k] < 0)) throw new AppError('消费时间范围须为秒级时间戳或 null');
  if (r.consumptionStart !== null && r.consumptionEnd !== null && r.consumptionStart > r.consumptionEnd) throw new AppError('消费时间范围颠倒');
  if (!r.notifications || typeof r.notifications.enabled !== 'boolean' || !Array.isArray(r.notifications.events) || r.notifications.events.some(e => !eventTypes.includes(e))) throw new AppError('通知事件配置无效');
  if(!r.emailNotifications||typeof r.emailNotifications.enabled!=='boolean'||!Array.isArray(r.emailNotifications.events)||r.emailNotifications.events.some(e=>!['approved','rejected','succeeded','failed','unknown'].includes(e)))throw new AppError('邮箱通知事件配置无效');
  if (r.applicationsEnabled || r.executionEnabled) {
    if (!r.channels.length || (r.restrictModels&&!r.models.length)) throw new AppError('开启前必须设置渠道及启用限制时的模型范围');
    for (const k of ['userDailyQuota', 'userDailyCount', 'siteDailyQuota', 'siteDailyCount']) positiveInt(r[k], '每日限额和次数');
  }
  return Object.fromEntries(Object.keys(defaults).map(k => [k, r[k]]));
}
export function localClock(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function isOpen(r, now) {
  const { time } = localClock(now, r.timezone);
  if (r.openStart === r.openEnd) return true;
  return r.openStart < r.openEnd ? time >= r.openStart && time < r.openEnd : time >= r.openStart || time < r.openEnd;
}
export function settlementClock(now, rules) {
  const clock = localClock(now, rules.timezone);
  if (clock.time >= (rules.dailyResetTime || '00:00')) return clock;
  const previous = new Date(Date.parse(clock.day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  return { ...clock, day: previous };
}
export function expectedQuota(log, r) {
  positiveInt(log.quota, '原消费额度');
  const amount = Number(BigInt(log.quota) * BigInt(r.refundBasisPoints) / 10000n);
  return r.perRecordQuota > 0 ? Math.min(amount, r.perRecordQuota) : amount;
}
export function fundingSource(log) {
  let other;try{other=typeof log.other==='string'?JSON.parse(log.other||'{}'):log.other;}catch{}
  if(!other||typeof other!=='object'||Array.isArray(other))return 'unknown';
  if(other.billing_source==='subscription'||other.subscription_id)return 'subscription';
  return other.billing_source==='wallet'?'wallet':'unknown';
}
export function compensationLabel(log, source = 'self') {
  if (fundingSource(log) === 'subscription') return '订阅空回 · 余额补偿';
  return source === 'manual' ? '人工空回补偿' : '空回补偿';
}
export function modelExcluded(log, rules) {
  return (rules.excludedModels || []).some(entry => entry.channelId === log.channel && entry.model === log.model_name);
}
export function assessLog(log, user, r, now = Date.now()) {
  const result = { candidate: false, eligible: false, evidence: 'pending', reasons: [], expectedQuota: 0, deadline: null };
  if (log.user_id !== user.id) { result.reasons.push('不是本人的消费'); return result; }
  if (modelExcluded(log, r)) { result.reasons.push('该模型不参与补偿，已跳过空回检测'); return result; }
  if (log.type !== 2 || !Number.isSafeInteger(log.quota) || log.quota <= 0 || log.completion_tokens !== 0) { result.reasons.push('不满足已扣费且输出 token 为零的候选条件'); return result; }
  result.candidate = true;
  let other; try { other = typeof log.other === 'string' ? JSON.parse(log.other || '{}') : (log.other || {}); } catch { other = {}; }
  const reject = String(other.admin_info?.reject_reason || other.reject_reason || '');
  const special = Boolean(other.image_output || other.audio_output || other.reasoning_tokens || other.tool_surcharges?.length || /block|filter|abort|disconnect|cancel/i.test(reject));
  result.evidence = special ? 'special' : /gemini_empty_candidates|empty_response/.test(reject) ? 'empty_marked' : 'pending';
  if (!log.request_id || typeof log.request_id !== 'string' || log.request_id.length > 200) result.reasons.push('缺少可靠的原消费标识');
  if (!Number.isSafeInteger(log.created_at) || log.created_at <= 0 || log.created_at * 1000 > now) result.reasons.push('消费时间无效');
  else {
    result.deadline = log.created_at * 1000 + r.applicationHours * 3600000;
    if (now > result.deadline) result.reasons.push('已超过申请有效期');
  }
  if (!r.channels.includes(log.channel)) result.reasons.push('渠道未开放补偿');
  const retired=r.retiredModelKeys?.includes(log.channel+':'+log.model_name);
  if (r.restrictModels!==false&&!r.models.includes(log.model_name)&&!retired) result.reasons.push('模型未开放补偿');
  if (r.userGroups.length && !r.userGroups.includes(log.group)) result.reasons.push('用户组未开放补偿');
  if (r.blockedUsers.includes(user.id)) result.reasons.push('当前用户不参与补偿');
  if (r.consumptionStart !== null && log.created_at < r.consumptionStart) result.reasons.push('消费早于开放范围');
  if (r.consumptionEnd !== null && log.created_at > r.consumptionEnd) result.reasons.push('消费晚于开放范围');
  result.expectedQuota = expectedQuota(log, r);
  if (result.expectedQuota <= 0) result.reasons.push('按规则计算的补偿额度不足一个整数额度单位');
  result.eligible = result.reasons.length === 0;
  return result;
}
export function publicLog(log) {
  return {...Object.fromEntries(['request_id', 'created_at', 'model_name', 'quota', 'prompt_tokens', 'completion_tokens', 'is_stream'].map(k => [k, log[k]])),fundingSource:fundingSource(log)};
}

export function selfServiceDecision(log, user, rules, now = Date.now(), aiReview = null) {
  const assessment = assessLog(log, user, rules, now), reasons = [...assessment.reasons];
  if(fundingSource(log)==='subscription')reasons.push('订阅消费须站长审批，批准并核验后补入钱包余额');
  if(rules.retiredModelKeys?.includes(log.channel+':'+log.model_name))reasons.push('原消费模型已下架、删除或渠道停用，转人工审核');
  if(rules.catalogUnavailable)reasons.push('渠道模型目录暂不可核验，转人工审核');
  let other;try{other=typeof log.other==='string'?JSON.parse(log.other):log.other;}catch{}
  if(!other||typeof other!=='object'||Array.isArray(other))other={};
  const reject=other.admin_info?.reject_reason||other.reject_reason;
  if(!rules.selfServiceEnabled)reasons.push('自助返还已暂停');
  if(!rules.executionEnabled)reasons.push('返还执行暂未开放');
  if(rules.aiEnabled){
    if(aiReview?.status!=='completed')reasons.push(aiReview?'AI 判定未成功完成，转人工审核':'等待 AI 判定');
    else if(aiReview.decision==='not_empty')reasons.push('AI 判定为非空回，转人工审核；置信度不代表空回概率');
    else if(aiReview.decision!=='empty')reasons.push('AI 证据不足，无法确定是否空回，转人工审核；提高置信度不改变判定结论');
    else if(!Number.isFinite(aiReview.confidence)||aiReview.confidence<rules.aiAutoThreshold/100)reasons.push('AI 置信度未达到当前自动通过阈值 '+rules.aiAutoThreshold+'%，转人工审核');
  }else if(assessment.evidence!=='empty_marked'||!['gemini_empty_candidates','empty_response'].includes(reject))reasons.push('缺少明确的上游空回证据');
  if(other.billing_source!=='wallet'&&fundingSource(log)!=='subscription')reasons.push('余额消费来源尚未确认');
  if((other.tool_calls&&(!Array.isArray(other.tool_calls)||other.tool_calls.length))||other.function_call||(other.tool_surcharges&&(!Array.isArray(other.tool_surcharges)||other.tool_surcharges.length))||other.image_output||other.audio_output||other.reasoning_tokens||other.thoughts_tokens)reasons.push('存在工具、多模态或推理输出，须人工核实');
  if(['refunded','refunded_quota','refund_quota','refund_amount','refund_status'].some(key=>other[key]!==undefined&&![false,0,'0','none','not_refunded'].includes(other[key])))reasons.push('存在退款或退款状态不明的标记');
  if(now-log.created_at*1000<rules.selfServiceMinAgeSeconds*1000)reasons.push('尚未超过结算等待期');
  if(log.quota>rules.selfServiceMaxQuota)reasons.push('原消费超过自助单笔上限');
  return {automatic:assessment.eligible&&reasons.length===0,reasons:[...new Set(reasons)]};
}
