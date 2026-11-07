import { createHash } from 'node:crypto';
import { AppError } from './rules.mjs';

const decisionSet = new Set(['empty', 'not_empty', 'uncertain']);
const recommendationSet = new Set(['approve','reject','manual']);
const safe = (value, max = 4000) => String(value ?? '').slice(0, max);
const DEFAULT_PROMPT = '你是额度补偿审核助手。只根据提供的日志和规则判断是否疑似空回，不决定金额，不执行任何操作。必须只返回 JSON：{"decision":"empty|not_empty|uncertain","confidence":0到1,"reason":"简短中文理由","evidence":["证据"]}。证据不足必须返回 uncertain。';
const ADMIN_PROMPT = '\n\n当前任务是站长的二次复核：独立核对消费日志、补偿规则和 previousReview 中的初审结论，指出初审是否与事实一致，不得把初审结论当作事实。综合评估证据是否足以通过申请，说明仍需人工核查的风险。只返回 JSON：{"decision":"empty|not_empty|uncertain","confidence":0到1,"recommendation":"approve|reject|manual","summary":"综合判断","reason":"判断原因","evidence":["逐条可核对的依据"]}。仅当日志和规则均支持空回、证据充分且无明显风险时 recommendation 才可为 approve；明确不符合规则时为 reject；证据不足、矛盾或结果不确定时为 manual。不得决定金额，不得执行操作。';

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
    return mode==='admin'?version+'-admin-assist-v1':version;
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
  redact(value, config = this.config()) {
    let text = String(value ?? '');
    if (config.apiKey) text = text.replaceAll(config.apiKey, '[已隐藏密钥]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/sk-[a-zA-Z0-9_-]+/g, '[已隐藏密钥]').replace(/[\r\n\t<>]/g, ' ').slice(0, 240);
  }
  async request(path, options = {}, c = this.config()) {
    if (!c.baseUrl || !c.apiKey) throw new AppError('AI API 地址或密钥未配置', 400);
    const endpoint = normalizeAIBaseURL(c.baseUrl) + path;
    const timeout = Number.isSafeInteger(c.timeoutMs) && c.timeoutMs >= 3000 && c.timeoutMs <= 120000 ? c.timeoutMs : 15000;
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
  async chat(messages, extra = {}, config = this.config()) {
    if (!config.model) throw new AppError('请先选择或输入模型名称，再保存并测试', 400);
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...extra, model: config.model, stream: false, messages})
    }, config);
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
    this.inflight.set(key,{promise,userId:log.user_id,day:new Date(this.now()).toISOString().slice(0,10)});
    try{return await promise;}finally{this.inflight.delete(key);}
  }
  async runReview(log, rules,{mode='automatic',previousReview=null}={}) {
    const promptVersion = this.promptVersion(mode);
    const fingerprint = logFingerprint(log);
    const existing = this.store.aiReview(log.request_id, fingerprint, promptVersion);
    if (existing) return existing;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const used = this.store.aiReviewCount(today, log.user_id)+[...this.inflight.values()].filter(item=>item.userId===log.user_id&&item.day===today).length;
    if (used >= rules.aiDailyLimit) throw new AppError('AI 审核次数已达今日上限，请转管理员审核', 429);
    if (!this.configured()) return this.store.saveAiReview({
      requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion,
      decision: 'uncertain', confidence: 0, reason: 'AI 服务未配置，转管理员审核', evidence: [], rawResponse: null, status: 'fallback'
    });
    const config = this.config();
    const payload = {
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: config.prompt+(mode==='admin'?ADMIN_PROMPT:'') },
        { role: 'user', content: JSON.stringify({ log: { request_id: log.request_id, user_id: log.user_id, model_name: log.model_name, channel: log.channel, quota: log.quota, prompt_tokens: log.prompt_tokens, completion_tokens: log.completion_tokens, is_stream: log.is_stream, created_at: log.created_at, other: safe(log.other) }, rules: { refundBasisPoints: rules.refundBasisPoints, selfServiceMaxQuota: rules.selfServiceMaxQuota, selfServiceMinAgeSeconds: rules.selfServiceMinAgeSeconds, excludedModels: rules.excludedModels, models: rules.models },...(mode==='admin'?{previousReview:previousReview?{decision:previousReview.decision,confidence:previousReview.confidence,reason:previousReview.reason,evidence:previousReview.evidence}:null}: {}) }) }
      ]
    };
    try {
      const content = await this.chat(payload.messages, {temperature: payload.temperature, response_format: payload.response_format}, config);
      const parsed = JSON.parse(content);
      const decision = decisionSet.has(parsed?.decision) ? parsed.decision : 'uncertain';
      const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
      const analysis=mode==='admin'?{
        recommendation:recommendationSet.has(parsed?.recommendation)?parsed.recommendation:'manual',
        summary:safe(parsed?.summary,1200)||'AI 未提供综合判断'
      }:null;
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion,
        decision, confidence, reason: safe(parsed?.reason, 1000) || 'AI 未提供理由',
        evidence: Array.isArray(parsed?.evidence) ? parsed.evidence.slice(0, 12).map(v => safe(v, 300)) : [],
        rawResponse: safe(content, 8000), status: 'completed',analysis
      });
    } catch (error) {
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion,
        decision: 'uncertain', confidence: 0, reason: 'AI 请求失败，转管理员审核', evidence: [this.redact(error.message, config)], rawResponse: null, status: 'failed'
      });
    }
  }
}
