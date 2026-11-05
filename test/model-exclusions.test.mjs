import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, log, user, admin, rules } from './helpers.mjs';
import { assessLog, validateRules } from '../src/rules.mjs';

const excluded = [{ channelId: 3, model: 'fixture-model' }];

test('不可补模型规则兼容旧配置、去重并拒绝非法输入', () => {
  const old = rules(); delete old.excludedModels;
  assert.deepEqual(validateRules(old).excludedModels, []);
  assert.deepEqual(validateRules(rules({ excludedModels: [...excluded, ...excluded] })).excludedModels, excluded);
  for (const value of [null, {}, ['fixture-model'], [{ channelId: '3', model: 'fixture-model' }], [{ channelId: -1, model: 'x' }], [{ channelId: 3, model: '' }], [{ channelId: 3, model: 'x'.repeat(201) }]]) {
    assert.throws(() => validateRules(rules({ excludedModels: value })));
  }
});

test('排除优先于允许列表、全部模型模式和历史下架例外，同名其他渠道不受影响', () => {
  for (const restrictModels of [true, false]) {
    const r = rules({ channels: [3, 5], excludedModels: excluded, restrictModels, retiredModelKeys: ['3:fixture-model'] });
    const blocked = assessLog(log(), user, r);
    assert.equal(blocked.candidate, false); assert.equal(blocked.eligible, false); assert.equal(blocked.expectedQuota, 0);
    assert.match(blocked.reasons[0], /跳过空回检测/);
    assert.equal(assessLog(log('allowed', { channel: 5 }), user, r).eligible, true);
  }
});

test('整次查询先跳过排除模型再分页，跳过摘要仅限本人且不泄露渠道', async t => {
  const logs = Array.from({ length: 40 }, (_, i) => log('blocked-' + i, { id: i + 1 }));
  logs.push(log('allowed', { id: 1001, channel: 5 }), log('other-user', { id: 1002, user_id: 8 }));
  const f = fixture({ logs, rules: { channels: [3, 5], excludedModels: excluded } });
  t.after(() => f.store.close());
  const out = await f.service.logs(user, {});
  assert.equal(out.total, 1); assert.equal(out.items[0].log.request_id, 'allowed');
  assert.equal(out.skippedCount, 40);
  assert.deepEqual(out.skippedModels, [{ model: 'fixture-model', count: 40, reason: '该模型不参与补偿，已跳过空回检测' }]);
  assert.equal((await f.service.logs(user, { page: 2 })).items.length, 0);
  assert.equal(JSON.stringify(out.skippedModels).includes('channel'), false);
});

test('查询缓存立即应用最新排除规则，取消排除恢复原日志且不重新拉取', async t => {
  const f = fixture(); t.after(() => f.store.close());
  let reads = 0; const original = f.upstream.logs;
  f.upstream.logs = async query => { reads++; return original(query); };
  assert.equal((await f.service.logs(user, {})).total, 1);
  let r = f.store.rules(); f.service.saveRules(admin, { ...r, excludedModels: excluded });
  const blocked = await f.service.logs(user, {});
  assert.equal(blocked.total, 0); assert.equal(blocked.skippedCount, 1);
  r = f.store.rules(); f.service.saveRules(admin, { ...r, excludedModels: [] });
  const restored = await f.service.logs(user, {});
  assert.equal(restored.total, 1); assert.equal(restored.skippedCount, 0); assert.equal(reads, 1);
});

test('直接用户申请和管理员手动申请均拒绝排除模型且不产生申请或发放', async t => {
  const f = fixture({ rules: { excludedModels: excluded } }); t.after(() => f.store.close());
  await assert.rejects(f.service.selfService(user, 'fixture-request-1'), /不参与补偿/);
  await assert.rejects(f.service.apply(admin, 'fixture-request-1', '手动申请', true), /不参与补偿/);
  assert.equal(f.store.byRequest('fixture-request-1'), null);
  assert.equal(f.calls(), 0);
});

test('旧申请执行前再次检查排除规则，历史成功记录保留且不得重复发放', async t => {
  const f = fixture({ logs: [log('pending', { other: '{}' }), log('paid', { id: 101 })] }); t.after(() => f.store.close());
  const pending = await f.service.selfService(user, 'pending');
  f.service.review(admin, pending.id, 'approve', '人工确认');
  const paid = await f.service.selfService(user, 'paid'); assert.equal(paid.status, 'succeeded');
  f.service.saveRules(admin, { ...f.store.rules(), excludedModels: excluded });
  await assert.rejects(f.service.execute(admin, pending.id, 120, '再次执行'), /不参与补偿/);
  assert.equal((await f.service.selfService(user, 'paid')).status, 'succeeded');
  assert.equal(f.calls(), 1); assert.equal(f.store.get(pending.id).status, 'approved');
  const query = await f.service.logs(user, {}); assert.equal(query.skippedCount, 1);
});
