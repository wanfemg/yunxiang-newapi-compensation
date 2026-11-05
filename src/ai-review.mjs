import { createHash } from 'node:crypto';
import { AppError } from './rules.mjs';

const decisionSet = new Set(['empty', 'not_empty', 'uncertain']);
const safe = (value, max = 4000) => String(value ?? '').slice(0, max);

export function logFingerprint(log) {
  const fields = ['request_id', 'user_id', 'model_name', 'channel', 'quota', 'prompt_tokens', 'completion_tokens', 'is_stream', 'other', 'created_at'];
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map(k => [k, log?.[k] ?? null])))).digest('hex');
}

export class AIReviewer {
  constructor({ store, fetcher = fetch, env = process.env, now = Date.now } = {}) {
    this.store = store; this.fetcher = fetcher; this.env = env; this.now = now;
  }
  configured() {
    const c = this.config();
    return Boolean(c.baseUrl && c.apiKey && c.model);
  }
  config() {
    const stored = this.store?.aiConfig?.() || {};
    return {
      baseUrl: String(this.env.AI_BASE_URL ?? stored.baseUrl ?? '').trim(),
      apiKey: String(this.env.AI_API_KEY ?? stored.apiKey ?? ''),
      model: String(this.env.AI_MODEL ?? stored.model ?? '').trim(),
      timeoutMs: Number(this.env.AI_TIMEOUT_MS ?? stored.timeoutMs ?? 15000)
    };
  }
  async request(path, options = {}) {
    const c = this.config();
    if (!c.baseUrl || !c.apiKey) throw new AppError('AI API 地址或密钥未配置', 400);
    return this.fetcher(c.baseUrl.replace(/\/$/, '') + path, {
      ...options,
      headers: { Accept: 'application/json', Authorization: `Bearer ${c.apiKey}`, ...(options.headers || {}) },
      signal: AbortSignal.timeout(c.timeoutMs)
    });
  }
  async models() {
    const response = await this.request('/models');
    if (!response.ok) throw new AppError(`AI 模型接口返回 HTTP ${response.status}`, 502);
    const body = await response.json();
    const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return items.map(item => typeof item === 'string' ? { id: item, name: item } : { id: String(item.id || item.name || ''), name: String(item.name || item.id || '') })
      .filter(item => item.id).slice(0, 1000);
  }
  async test() {
    const c = this.config();
    const response = await this.request('/models');
    return { ok: response.ok, model: c.model, status: response.status };
  }
  async review(log, rules) {
    const promptVersion = String(this.env.AI_PROMPT_VERSION || 'empty-v1');
    const fingerprint = logFingerprint(log);
    const existing = this.store.aiReview(log.request_id, fingerprint, promptVersion);
    if (existing) return existing;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const used = this.store.aiReviewCount(today, log.user_id);
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
        { role: 'system', content: '你是额度补偿审核助手。只根据提供的日志和规则判断是否疑似空回，不决定金额，不执行任何操作。必须只返回 JSON：{"decision":"empty|not_empty|uncertain","confidence":0到1,"reason":"简短中文理由","evidence":["证据"]}。证据不足必须返回 uncertain。' },
        { role: 'user', content: JSON.stringify({ log: { request_id: log.request_id, user_id: log.user_id, model_name: log.model_name, channel: log.channel, quota: log.quota, prompt_tokens: log.prompt_tokens, completion_tokens: log.completion_tokens, is_stream: log.is_stream, created_at: log.created_at, other: safe(log.other) }, rules: { refundBasisPoints: rules.refundBasisPoints, selfServiceMaxQuota: rules.selfServiceMaxQuota, selfServiceMinAgeSeconds: rules.selfServiceMinAgeSeconds, excludedModels: rules.excludedModels, models: rules.models } }) }
      ]
    };
    let response;
    try {
      response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      const decision = decisionSet.has(parsed?.decision) ? parsed.decision : 'uncertain';
      const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion,
        decision, confidence, reason: safe(parsed?.reason, 1000) || 'AI 未提供理由',
        evidence: Array.isArray(parsed?.evidence) ? parsed.evidence.slice(0, 12).map(v => safe(v, 300)) : [],
        rawResponse: safe(content, 8000), status: 'completed'
      });
    } catch (error) {
      return this.store.saveAiReview({
        requestId: log.request_id, userId: log.user_id, fingerprint, promptVersion,
        decision: 'uncertain', confidence: 0, reason: 'AI 请求失败，转管理员审核', evidence: [safe(error.message, 300)], rawResponse: null, status: 'failed'
      });
    }
  }
}
