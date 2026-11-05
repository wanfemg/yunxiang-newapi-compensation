import assert from 'node:assert/strict';
import test from 'node:test';
import { AIReviewer, logFingerprint } from '../src/ai-review.mjs';
import { Store } from '../src/store.mjs';
import { admin, log, rules, user } from './helpers.mjs';

test('AI 判定按日志指纹幂等，重复调用不重复请求', async () => {
  const store = new Store();
  store.saveRules(rules({ aiEnabled: true }), admin.id, 1);
  let calls = 0;
  const reviewer = new AIReviewer({
    store,
    env: { AI_BASE_URL: 'http://ai.test/v1', AI_API_KEY: 'key', AI_MODEL: 'fixture' },
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision: 'empty', confidence: 0.96, reason: '无有效输出', evidence: ['completion_tokens=0'] }) } }] }) };
    }
  });
  const source = log();
  const first = await reviewer.review(source, store.rules());
  const second = await reviewer.review({ ...source }, store.rules());
  assert.equal(first.decision, 'empty');
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
  assert.equal(store.aiReview(source.request_id, logFingerprint(source), 'empty-v1').id, first.id);
  store.close();
});

test('AI 未配置时只转管理员，不改变原规则路径', async () => {
  const store = new Store();
  store.saveRules(rules({ aiEnabled: true }), admin.id, 1);
  const result = await new AIReviewer({ store, env: {} }).review(log(), store.rules());
  assert.equal(result.decision, 'uncertain');
  assert.equal(result.status, 'fallback');
  store.close();
});
