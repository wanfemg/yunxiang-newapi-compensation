import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { DingTalk } from '../src/notifications.mjs';
import { dingtalkPayload } from '../src/dingtalk-message.mjs';
import { displayConfig, formatQuota } from '../public/display.js';
import { rules, log, user } from './helpers.mjs';

const currency = displayConfig({ quota_display_type: 'USD', quota_per_unit: 500000 });
function fixture(t, display = currency) {
  const store = new Store();
  t.after(() => store.close());
  store.saveRules(rules({ notifications: { enabled: true, events: ['batch_result', 'compensation_success'] } }), 1, 1);
  if (display) store.db.prepare("INSERT INTO metadata(key,value) VALUES('display',?)").run(JSON.stringify(display));
  const claim = (id, model, amount, status = 'succeeded', runId = 'summary-run', channel = 3) => {
    const created = store.create(log(id, { model_name: model, channel, quota: amount }), user, store.rules(), '核实', 'self', 7, false, runId);
    store.db.prepare('UPDATE claims SET status=?,amount=?,review_note=? WHERE id=?')
      .run(status, amount, '重复处理说明不应出现在通知中', created.id);
    return store.get(created.id);
  };
  const payload = () => dingtalkPayload(store.db.prepare('SELECT event,body FROM notifications ORDER BY id DESC LIMIT 1').get(), 'https://refund.example.com/');
  return { store, claim, payload };
}

test('92 笔钉钉通知按模型合并为 10 行，实际发送仅保留用户、总额及模型条数额度', async t => {
  const f = fixture(t), totals = new Map();
  let total = 0;
  for (let index = 0; index < 92; index++) {
    const model = 'gemini-4-argon-' + index % 10, amount = (index + 1) * 10000;
    f.claim('private-request-' + index, model, amount, 'succeeded', 'summary-run', Math.floor(index / 10) % 2 ? 3 : 5);
    const group = totals.get(model) || { count: 0, amount: 0 };
    group.count++; group.amount += amount; total += amount; totals.set(model, group);
  }
  f.store.notifyClaimsBatch('summary-run');
  const directory = mkdtempSync(join(tmpdir(), 'ding-summary-')), sent = [];
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bot = new DingTalk(f.store, directory, async (_, request) => {
    sent.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  }, 'https://refund.example.com/');
  bot.save({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=fixture-token', secret: 'fixture-secret' });
  await bot.flush();
  assert.equal(sent.length, 1);
  const card = sent[0].actionCard;
  assert.ok(card.text.includes('合计补回：' + formatQuota(total, currency)), card.text);
  for (const [model, group] of totals) {
    assert.ok(card.text.includes(`- **${model}**：${group.count} 条 · ${formatQuota(group.amount, currency)}`), card.text);
  }
  assert.equal(card.text.split('\n').filter(line => line.startsWith('- **')).length, 10);
  assert.doesNotMatch(card.text, /private-request|逐笔|明细|处理说明|模型数|时间|已省略|避免逐笔刷屏/);
  assert.ok(card.text.length < 1200, card.text);
  assert.equal(card.singleURL, 'https://refund.example.com/');
});

test('混合结果仅累计成功的实际金额，待审和待确认计数不伪装成已补回', t => {
  const f = fixture(t);
  f.claim('paid-one', 'gemini-4-argon', 100000);
  f.claim('paid-two', 'gemini-4-argon', 300000);
  f.claim('not-confirmed', 'gemini-4-argon', 5000000, 'unknown');
  f.claim('waiting-review', 'gemini-4-argon', 900000, 'pending');
  f.claim('failed-request', 'other-model', 1000000, 'failed');
  f.store.notifyClaimsBatch('summary-run');
  const text = f.payload().actionCard.text;
  assert.match(text, /合计补回：\$0\.80/);
  assert.match(text, /gemini-4-argon\*\*：4 条 · \$0\.80 · 待审核 1 条 · 待确认 1 条/);
  assert.match(text, /other-model\*\*：1 条 · \$0\.00 · 失败 1 条/);
  assert.doesNotMatch(text, /paid-one|not-confirmed|waiting-review|failed-request|处理说明/);
});

test('单条通知同样精简，模型名转义不丢失下划线，缺少币种时明确原始额度', t => {
  const f = fixture(t, null), claim = f.claim('single-private-request', 'gemini_4_[custom]', 120, 'succeeded', null);
  f.store.notifyClaim('compensation_success', claim, '不需要展示的长说明');
  const text = f.payload().actionCard.text;
  assert.ok(text.includes('gemini\\_4\\_\\[custom\\]'), text);
  assert.match(text, /合计补回：120 原始额度/);
  assert.match(text, /1 条 · 120 原始额度/);
  assert.doesNotMatch(text, /single-private-request|长说明|申请号|原请求|时间/);
});

test('两笔同模型同金额的独立申请不会被摘要去重吞掉，同一申请重复通知仍去重', t => {
  const f = fixture(t);
  const first = f.claim('independent-first', 'same-model', 120, 'succeeded', null);
  const second = f.claim('independent-second', 'same-model', 120, 'succeeded', null);
  for (const claim of [first, second, first, second]) f.store.notifyClaim('compensation_success', claim, '补偿成功');
  const notifications = f.store.db.prepare('SELECT body FROM notifications').all();
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].body, notifications[1].body, 'visible messages remain equally concise');
  assert.doesNotMatch(notifications[0].body, /independent-first|independent-second/);
});

test('模型汇总先合并原始额度再按站点币种显示，人民币、额度和自定义单位均一致', t => {
  for (const status of [
    { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7.2 },
    { quota_display_type: 'TOKENS' },
    { quota_display_type: 'CUSTOM', quota_per_unit: 100, custom_currency_exchange_rate: 2, custom_currency_symbol: '点' }
  ]) {
    const display = displayConfig(status), f = fixture(t, display);
    f.claim('currency-one', 'same-model', 123);
    f.claim('currency-two', 'same-model', 456);
    f.store.notifyClaimsBatch('summary-run');
    const text = f.payload().actionCard.text;
    assert.ok(text.includes('合计补回：' + formatQuota(579, display)), text);
    assert.ok(text.includes('same-model**：2 条 · ' + formatQuota(579, display)), text);
    assert.equal(text.split('\n').filter(line => line.startsWith('- **')).length, 1);
  }
});

test('旧队列消息只保留明确的汇总字段，不再发送逐笔请求和固定尾注', () => {
  const body = JSON.stringify({ title: '补偿成功（2 笔）', text: [
    '- **用户**：fixture-user（ID 7）',
    '- **申请笔数 / 模型数**：2 / 1',
    '- **已确认补回**：2 笔 · $1.00',
    '- **逐笔结果**：',
    '- **gemini-4** · legacy-private-request · 已补回 · $1.00 · 冗长重复说明',
    '- **时间**：2026/11/25 22:19:42'
  ].join('\n') });
  const text = dingtalkPayload({ event: 'batch_result', body }, 'https://refund.example.com/').actionCard.text;
  assert.match(text, /fixture-user/);
  assert.match(text, /已确认补回: 2 笔 · \$1\.00/);
  assert.doesNotMatch(text, /legacy-private-request|明细|时间|重复说明|按用户合并通知/);
});
