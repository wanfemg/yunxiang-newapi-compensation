import { createHash } from 'node:crypto';
import { AppError, assessLog, fundingSource, modelExcluded } from './rules.mjs';

const decisionSet = new Set(['empty', 'not_empty', 'uncertain']);
const recommendationSet = new Set(['approve','reject','manual']);
const safe = (value, max = 4000) => String(value ?? '').slice(0, max);
const DEFAULT_PROMPT = '你是额度补偿审核助手。结合消费日志、系统提取的信号和补偿规则判断该日志是否为空回。自动初审与管理员复核会分别提供各自的输出格式要求。只引用输入中存在的事实，不决定补偿金额，不执行补偿操作。';
const AUTO_REVIEW_GUIDANCE = '\n\n自动判定：输出 empty_probability，即“该日志确属空回”的概率，必须是 0 到 1 的 JSON 数值，不是对任意结论的置信度。候选日志已扣费且 completion_tokens=0；结合 knownSignals 和 rules 评估，有效回答、退款、工具/多模态/推理输出都应核对。日志完整、已扣费、零输出且无退款或成功输出证据时给高概率；有成功输出、退款或明确矛盾给低概率；仅关键证据不足或矛盾时给中间概率。站长设置的自动补偿阈值为 {{AI_AUTO_THRESHOLD}}%：概率达标自动补偿，未达标转管理员复核，不代表申请被拒绝。不得用 uncertain 标签覆盖达标概率。reason 用日常中文，先说已发现的事实，再解释为什么支持空回或还需核对什么，避免只说“证据不足”和堆砌英文术语；不超过 100 字。evidence 最多 3 条，每条用中文解释具体字段和值。不输出思考过程，不编造事实。只返回一个 JSON 对象，必须包含 empty_probability（数值）、reason（字符串）、evidence（字符串数组），不添加其他文字。';
const ADMIN_PROMPT = '\n\n当前任务是站长二次复核：独立核对消费日志、规则和 previousReview，初审结论不是事实。只返回 JSON：{"decision":"empty|not_empty|uncertain","confidence":0到1,"recommendation":"approve|reject|manual","summary":"综合判断","reason":"判断原因","evidence":["可核对的依据"]}。证据充分支持空回且无明显风险才 approve；明确不符合规则才 reject；证据不足或矛盾则 manual。summary 不超过 60 字；reason 用日常中文、不超过 120 字，说明实际发生了什么、为什么支持或不支持补偿、还需要管理员核对什么。manual 必须说明需要人工核对的具体信息，不得写成申请已被拒绝；evidence 最多 3 条，每条用中文解释具体字段和值。不输出思考过程，不决定金额，不执行操作，不编造事实。';

function parseReviewJSON(content) {
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('审核结果不是 JSON 对象');
  return parsed;
}

export function normalizeAIBaseURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new AppError('AI API 地址格式无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError('AI API 地址必须是无凭据、无查询参数的 HTTP(S) 地址');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '');
  if (!path) path = '/v1';
  return url.origin + path;
}

export function logFingerprint(log) {
  const fields = ['request_id', 'user_id', 'model_name', 'channel', 'quota', 'prompt_tokens', 'completion_tokens', 'is_stream', 'other', 'created_at'];
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map(k => [k, log?.[k] ?? null])))).digest('hex');
}

export class AIReviewer {
  constructor({ store, fetcher = fetch, env = process.env, now = Date.now } = {}) {
    this.store = store; this.fetcher = fetcher; this.env = env; this.now = now;
    this.inflight = new Map();
  }
  configured() {
    const c = this.config();
    return Boolean(c.baseUrl && c.apiKey && c.model);
  }
  promptVersion(mode='automatic') {
    const custom = String(this.store?.aiConfig?.(this.env).prompt ?? this.env.AI_PROMPT ?? '').trim();
    const version=String(this.env.AI_PROMPT_VERSION || (custom ? createHash('sha256').update(this.config().prompt).digest('hex').slice(0,16) : 'empty-v1'));
    return mode==='admin'?version+'-admin-assist-v1':version+'-auto-review-v3';
  }
  config() {
    const stored = this.store?.aiConfig?.(this.env) || {};
    return {
      baseUrl: String(stored.baseUrl ?? this.env.AI_BASE_URL ?? '').trim(),
      apiKey: String(stored.apiKey ?? this.env.AI_API_KEY ?? '').trim().replace(/^Bearer\s+/i, ''),
      model: String(stored.model ?? this.env.AI_MODEL ?? '').trim(),
      timeoutMs: Number(stored.timeoutMs ?? this.env.AI_TIMEOUT_MS ?? 15000),
      prompt: String(stored.prompt ?? this.env.AI_PROMPT ?? DEFAULT_PROMPT).trim() || DEFAULT_PROMPT
    };
  }
  redact(value, config = this.config(), max = 240) {
    let text = String(value ?? '');
    if (config.apiKey) text = text.replaceAll(config.apiKey, '[已隐藏密钥]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/sk-[a-zA-Z0-9_-]+/g, '[已隐藏密钥]').replace(/[\r\n\t<>]/g, ' ').slice(0, max);
  }
  failureReason(error) {
    const detail = String(error?.message || '');
    const reason = error instanceof SyntaxError ? 'AI 返回的审核内容格式不正确，系统没有采纳这次结果'
      : /HTTP 401/.test(detail) ? 'AI 服务的访问密钥无效或已过期，暂时无法自动审核'
      : /HTTP 403/.test(detail) ? 'AI 服务拒绝本次调用，管理员需要检查密钥权限或访问设置'
      : /HTTP 404/.test(detail) ? '当前 AI 模型或接口地址不可用，暂时无法自动审核'
      : /HTTP 402/.test(detail) ? 'AI 服务余额不足，暂时无法自动审核'
      : /HTTP 429/.test(detail) ? 'AI 服务当前请求过多或余额不足，暂时无法自动审核'
      : /HTTP (400|422)/.test(detail) ? 'AI 服务不支持当前模型或请求格式，管理员需要检查模型和接口设置'
      : /HTTP 413/.test(detail) ? '这条消费的日志超过 AI 服务可处理的长度，本次无法自动审核'
      : /超时|TimeoutError|AbortError/.test(detail) ? 'AI 在规定时间内没有回复，本次没有完成自动审核'
      : /HTTP 5\d\d/.test(detail) ? 'AI 服务暂时故障，本次没有完成自动审核'
      : /域名解析|连接被拒绝|网络连接|证书/.test(detail) ? '暂时连接不上 AI 服务，本次没有完成自动审核'
      : /未返回有效文本/.test(detail) ? 'AI 没有返回审核结论，本次没有完成自动审核'
      : /JSON|响应格式/.test(detail) ? 'AI 返回的审核内容格式不正确，系统没有采纳这次结果'
      : /API 地址/.test(detail) ? 'AI 接口地址填写不正确，管理员需要检查接口设置'
      : 'AI 服务本次未能完成审核';
    return reason + '，已转管理员审核。';
  }
  async request(path, options = {}, c = this.config(), beforeSend = null) {
    if (!c.baseUrl || !c.apiKey) throw new AppError('AI API 地址或密钥未配置', 400);
    const endpoint = normalizeAIBaseURL(c.baseUrl) + path;
    const timeout = Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 3000 && c.timeoutMs <= 120000 ? c.timeoutMs : 15000;
    beforeSend?.();
    try {
      return await this.fetcher(endpoint, {
        ...options,
        headers: { Accept: 'application/json', Authorization: `Bearer ${c.apiKey}`, ...(options.headers || {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) {
      const code = error?.cause?.code || error?.code;
      const reason = ['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code) ? `请求超时（${timeout / 1000} 秒）`
        : ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? '域名解析失败'
        : code === 'ECONNREFUSED' ? '连接被拒绝'
        : /CERT|TLS|SSL/.test(String(code)) ? 'TLS 证书校验失败'
        : '网络连接失败，请检查服务端网络、证书和接口地址';
      throw new AppError(`AI ${reason}；请求地址：${endpoint}`, 502);
    }
  }
  async responseJSON(response, label, config) {
    let body;
    try { body = await response.json(); }
    catch {
      throw new AppError(`AI ${label}接口返回 HTTP ${response.status || 200}，响应不是有效 JSON，请检查是否返回登录页、验证页或代理错误页`, 502);
    }
    if (!response.ok || body?.error || body?.success === false) {
      const detail = this.redact(body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || body?.message || body?.msg || '', config);
      const hints = {401:'密钥无效或已失效，请使用模型调用令牌',403:'密钥权限、分组或访问策略不允许',404:'接口路径或模型不存在',429:'请求受限或额度不足'};
      throw new AppError(`AI ${label}接口返回 HTTP ${response.status || 502}${hints[response.status] ? `（${hints[response.status]}）` : ''}${detail ? `：${detail}` : ''}`, 502);
    }
    return body;
  }
  async models() {
    const config = this.config();
    const response = await this.request('/models', {}, config);
    const body = await this.responseJSON(response, '模型列表', config);
    const items = Array.isArray(body) ? body : [body?.data, body?.models, body?.result].find(Array.isArray);
    if (!items) throw new AppError('AI 模型列表响应格式错误：缺少 data 数组，请确认接口支持 OpenAI 格式', 502);
    const result = new Map();
    for (const item of items) {
      const id = typeof item === 'string' ? item.trim() : typeof item?.id === 'string' ? item.id.trim() : typeof item?.name === 'string' ? item.name.trim() : '';
      if (!id || result.has(id)) continue;
      result.set(id, {id, name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : id});
      if (result.size >= 1000) break;
    }
    if (items.length && !result.size) throw new AppError('AI 模型列表响应格式错误：未找到有效模型 ID', 502);
    return [...result.values()];
  }
  async chat(messages, extra = {}, config = this.config(), beforeSend = null) {
    if (!config.model) throw new AppError('请先选择或输入模型名称，再保存并测试', 400);
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...extra, model: config.model, stream: false, messages})
    }, config, beforeSend);
    const body = await this.responseJSON(response, '模型调用', config);
    const content = body?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part=>part?.type === 'text' && typeof part.text === 'string').map(part=>part.text).join('') : '';
    if (!text.trim()) throw new AppError('AI 模型未返回有效文本（空回复或响应格式不兼容），不能视为调用成功', 502);
    return text;
  }
  async test() {
    const c = this.config();
    const started = this.now();
    const reply = await this.chat([{role: 'user', content: '这是一条连接测试消息，请只回复 OK。'}], {}, c);
    return {ok: true, model: c.model, status: 200, elapsedMs: Math.max(0, this.now() - started), reply: this.redact(reply, c)};
  }
  async review(log, rules, options={}) {
    const mode=options.mode==='admin'?'admin':'automatic';
    const key=JSON.stringify([log.request_id,logFingerprint(log),this.promptVersion(mode)]);
    const existing=this.inflight.get(key);
    if(existing)return existing.promise;
    const promise=this.runReview(log,rules,{...options,mode});
    this.inflight.set(key,{promise,mode,userId:log.user_id,day:new Date(this.now()).toISOString().slice(0,10),batchId:options.batchId||null});
    try{return await promise;}finally{this.inflight.delete(key);}
  }
  async runReview(log, rules,{mode='automatic',previousReview=null,batchId=null}={}) {
    const promptVersion = this.promptVersion(mode);
    const fingerprint = logFingerprint(log);
    const existing = this.store.aiReview(log.request_id, fingerprint, promptVersion);
    if (existing) return existing;
    if (!this.configured()) return this.store.saveAiReview({
      requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion, reviewBatchId: batchId,
      decision: 'uncertain', confidence: 0, reason: '管理员尚未配置 AI 服务，本次无法自动审核，已转管理员审核。', evidence: [], rawResponse: null, status: 'fallback'
    });
    const config = this.config();
    const assessment = assessLog(log,{id:log.user_id},rules,this.now());
    let other;try{other=typeof log.other==='string'?JSON.parse(log.other||'{}'):log.other||{};}catch{other={};}
    if (!other || typeof other !== 'object' || Array.isArray(other)) other = {};
    const relevantRules = {
      aiAutoThreshold: rules.aiAutoThreshold, refundBasisPoints: rules.refundBasisPoints,
      perRecordQuota: rules.perRecordQuota, perBatchQuota: rules.perBatchQuota,
      channelAllowed: rules.channels.includes(log.channel),
      modelAllowed: rules.restrictModels === false || rules.models.includes(log.model_name) || Boolean(rules.retiredModelKeys?.includes(log.channel + ':' + log.model_name)),
      modelExcluded: modelExcluded(log, rules)
    };
    const payload = {
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: config.prompt+(mode==='admin'?ADMIN_PROMPT:AUTO_REVIEW_GUIDANCE.replace('{{AI_AUTO_THRESHOLD}}',String(rules.aiAutoThreshold))) },
        { role: 'user', content: JSON.stringify({ log: { request_id: log.request_id, user_id: log.user_id, model_name: log.model_name, channel: log.channel, quota: log.quota, prompt_tokens: log.prompt_tokens, completion_tokens: log.completion_tokens, is_stream: log.is_stream, created_at: log.created_at, other: safe(typeof log.other === 'string' ? log.other : JSON.stringify(other)) }, knownSignals:{candidate:assessment.candidate,eligible:assessment.eligible,evidence:assessment.evidence,ruleReasons:assessment.reasons,expectedQuota:assessment.expectedQuota,fundingSource:fundingSource(log),rejectReason:safe(other.admin_info?.reject_reason||other.reject_reason||'',500),hasToolOutput:Boolean(other.tool_calls?.length||other.function_call||other.tool_surcharges?.length),hasMultimodalOrReasoningOutput:Boolean(other.image_output||other.audio_output||other.reasoning_tokens||other.thoughts_tokens),hasRefundMarker:['refunded','refunded_quota','refund_quota','refund_amount','refund_status'].some(key=>other[key]!==undefined&&![false,0,'0','none','not_refunded'].includes(other[key]))}, rules: relevantRules,...(mode==='admin'?{previousReview:previousReview?{decision:previousReview.decision,confidence:previousReview.confidence,reason:previousReview.reason,evidence:previousReview.evidence}:null}: {}) }) }
      ]
    };
    try {
      const content = await this.chat(payload.messages, {temperature: payload.temperature, response_format: payload.response_format}, config,
        mode==='admin'?null:()=>this.store.beginAIReview(batchId||JSON.stringify([log.request_id,fingerprint,promptVersion]),log.user_id,rules,this.now()));
      const parsed = parseReviewJSON(content);
      const probability=parsed.empty_probability;
      const hasProbability=typeof probability==='number'&&Number.isFinite(probability)&&probability>=0&&probability<=1;
      const confidence=hasProbability?Math.max(probability,1-probability):Math.max(0,Math.min(1,Number(parsed?.confidence)||0));
      const decision=hasProbability
        ?probability>=rules.aiAutoThreshold/100?'empty':probability<=1-rules.aiAutoThreshold/100?'not_empty':'uncertain'
        :mode==='automatic'?'uncertain':decisionSet.has(parsed?.decision)?parsed.decision:'uncertain';
      const analysis=mode==='admin'?{
        recommendation:recommendationSet.has(parsed?.recommendation)?parsed.recommendation:'manual',
        summary:this.redact(typeof parsed.summary==='string'?parsed.summary:'',config,1200)||'AI 未提供综合判断'
      }:!hasProbability?{responseIssue:'invalid_probability'}:null;
      const modelReason=this.redact(typeof parsed.reason==='string'?parsed.reason:typeof parsed.summary==='string'?parsed.summary:'',config,1000);
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion, reviewBatchId: batchId,
        decision, confidence, reason: !hasProbability&&mode==='automatic'?`AI 未返回有效空回概率，审核结果格式不正确，系统无法自动补偿，已转管理员审核。${modelReason?`AI 说明：${modelReason}`:''}`:modelReason||'AI 未提供具体原因，请管理员结合原消费日志核对。',
        evidence: Array.isArray(parsed?.evidence) ? parsed.evidence.filter(v=>typeof v==='string').slice(0, 12).map(v => this.redact(v,config,300)) : [],
        rawResponse: safe(content, 8000), status: 'completed',analysis:hasProbability?{...analysis,emptyProbability:probability}:analysis
      });
    } catch (error) {
      if(error.code==='AI_DAILY_COUNT_LIMIT')throw error;
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion, reviewBatchId: batchId,
        decision: 'uncertain', confidence: 0, reason: this.failureReason(error), evidence: [this.redact(error.message, config)], rawResponse: null, status: 'failed'
      });
    }
  }
}
