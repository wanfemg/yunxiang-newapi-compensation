import assert from 'node:assert/strict';
import test from 'node:test';
import { AIReviewer } from '../src/ai-review.mjs';
import { admin, fixture, log, user } from './helpers.mjs';

function reviewer(f, reply, inspect = () => {}) {
  return new AIReviewer({
    store: f.store,
    env: { AI_BASE_URL: 'http://ai.test/v1', AI_API_KEY: 'sk-private-fixture-key', AI_MODEL: 'fixture' },
    fetcher: async (_url, options) => {
      inspect(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    }
  });
}

test('空回概率只接受真正的数值，格式异常会说明原因并转人工', async t => {
  for (const value of [null, false, '', '0.99', [], {}]) {
    await t.test(JSON.stringify(value), async t => {
      const f = fixture({ rules: { aiEnabled: true } });
      t.after(() => f.store.close());
      f.service.ai = reviewer(f, JSON.stringify({ empty_probability: value, reason: '没有有效回答' }));
      const result = await f.service.selfService(user, 'fixture-request-1');
      const review = f.service.view(f.store.get(result.id), true).aiReview;
      assert.equal(result.status, 'pending');
      assert.equal(review.decision, 'uncertain');
      assert.equal(review.analysis?.emptyProbability, undefined);
      assert.equal(review.analysis?.responseIssue, 'invalid_probability');
      assert.match(result.review_note, /格式|有效空回概率/);
      assert.match(result.review_note, /管理员审核|人工审核/);
      assert.doesNotMatch(result.review_note, /非空回|已拒绝|未通过/);
      assert.equal(f.calls(), 0);
    });
  }
});

test('达到标准的代码块 JSON 回复无需再次调用模型即可识别', async t => {
  const f = fixture({ rules: { aiEnabled: true } });
  t.after(() => f.store.close());
  let calls = 0;
  f.service.ai = reviewer(f, '```json\n{"empty_probability":0.99,"reason":"已扣费，但没有生成有效回答","evidence":["输出数量为 0"]}\n```', () => calls++);
  const result = await f.service.selfService(user, 'fixture-request-1');
  assert.equal(result.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(f.calls(), 1);
});

test('AI 服务异常的具体原因会进入用户处理说明，技术明细隐藏密钥', async t => {
  for (const scenario of [
    { status: 401, detail: 'invalid sk-private-fixture-key', reason: /密钥.*无效|密钥.*过期/ },
    { status: 429, detail: 'rate limited', reason: /请求过多|额度不足|余额不足/ },
    { status: 503, detail: 'unavailable', reason: /服务.*故障|服务.*不可用/ },
    { timeout: true, reason: /规定时间|超时/ }
  ]) {
    await t.test(String(scenario.status || 'timeout'), async t => {
      const f = fixture({ rules: { aiEnabled: true } });
      t.after(() => f.store.close());
      f.service.ai = new AIReviewer({
        store: f.store,
        env: { AI_BASE_URL: 'http://ai.test/v1', AI_API_KEY: 'sk-private-fixture-key', AI_MODEL: 'fixture' },
        fetcher: async () => {
          if (scenario.timeout) throw new DOMException('timeout', 'TimeoutError');
          return new Response(JSON.stringify({ error: { message: scenario.detail } }), { status: scenario.status });
        }
      });
      const result = await f.service.selfService(user, 'fixture-request-1');
      assert.equal(result.status, 'pending');
      assert.match(result.review_note, scenario.reason);
      assert.match(result.review_note, /管理员审核|人工审核/);
      assert.doesNotMatch(result.review_note, /http:|sk-private-fixture-key|HTTP|已拒绝/);
      assert.doesNotMatch(JSON.stringify(f.service.view(f.store.get(result.id), true).aiReview), /sk-private-fixture-key/);
      assert.equal(f.calls(), 0);
    });
  }
});

test('低于标准时告诉用户实际概率、要求及原因，申请保持待审核', async t => {
  const f = fixture({ rules: { aiEnabled: true, aiAutoThreshold: 95 } });
  t.after(() => f.store.close());
  f.service.ai = reviewer(f, '{"empty_probability":0.82,"reason":"日志缺少是否已退款的信息，尚需管理员核对"}');
  const result = await f.service.selfService(user, 'fixture-request-1');
  assert.equal(result.status, 'pending');
  assert.match(result.review_note, /82%.*95%/);
  assert.match(result.review_note, /缺少是否已退款/);
  assert.doesNotMatch(result.review_note, /已拒绝|审核未通过/);
});

test('临界概率不四舍五入为已经达到的标准', async t => {
  const f = fixture({ rules: { aiEnabled: true, aiAutoThreshold: 95 } });
  t.after(() => f.store.close());
  f.service.ai = reviewer(f, '{"empty_probability":0.94999,"reason":"仍有信息需要核对"}');
  const result = await f.service.selfService(user, 'fixture-request-1');
  assert.equal(result.status, 'pending');
  assert.match(result.review_note, /94\.999%.*95%/);
});

test('每条 AI 请求只带本条消费相关规则，无关模型目录不会增加请求体积', async t => {
  const f = fixture({ rules: { aiEnabled: true } });
  t.after(() => f.store.close());
  const bodies = [];
  const ai = reviewer(f, '{"empty_probability":0.99,"reason":"已扣费，没有有效回答"}', body => bodies.push(body));
  const base = f.store.rules();
  await ai.review(log('small-catalog'), base);
  await ai.review(log('large-catalog'), {
    ...base,
    models: [...base.models, ...Array.from({ length: 1000 }, (_, i) => 'irrelevant-model-' + i)],
    excludedModels: Array.from({ length: 1000 }, (_, i) => ({ channelId: 3, model: 'excluded-model-' + i }))
  });
  const inputs = bodies.map(body => JSON.parse(body.messages[1].content));
  assert.equal(inputs[1].knownSignals.eligible, true);
  assert.equal(inputs[1].rules.modelAllowed, true);
  assert.equal(inputs[1].rules.modelExcluded, false);
  assert.equal(inputs[1].rules.models, undefined);
  assert.equal(inputs[1].rules.excludedModels, undefined);
  assert.ok(Math.abs(JSON.stringify(bodies[1]).length - JSON.stringify(bodies[0]).length) < 100);
  assert.match(bodies[1].messages[0].content, /日常中文|通俗中文/);
  assert.match(bodies[1].messages[0].content, /最多.*3.*条/);
});

test('并发审核合并目录请求，规则变更即时生效且之后独立核验仍重新读取目录', async t => {
  const f = fixture({ rules: { aiEnabled: true } });
  t.after(() => f.store.close());
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  f.upstream.catalog = async () => {
    calls++;
    await pending;
    return { channels: [{ id: 3, status: 1, models: ['fixture-model'] }] };
  };
  const first = f.service.ruleContext([log()]);
  const second = f.service.ruleContext([log('another')]);
  await new Promise(resolve => setImmediate(resolve));
  const oldRules = f.store.rules();
  f.store.saveRules({ ...oldRules, aiAutoThreshold: 95 }, admin.id, oldRules.version);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.aiAutoThreshold === 95));
  await f.service.ruleContext([log('final-check')]);
  assert.equal(calls, 2);
});

test('非对象附加日志不会让自动审核异常退出', async t => {
  for (const other of ['null', '[]', 'false']) {
    const f = fixture({ rules: { aiEnabled: true } });
    t.after(() => f.store.close());
    const ai = reviewer(f, '{"empty_probability":0.99,"reason":"已扣费，没有有效回答"}');
    const result = await ai.review(log(other, { other }), f.store.rules());
    assert.equal(result.status, 'completed');
  }
});
