import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, log, user, admin } from './helpers.mjs';
import { Compensation } from '../src/service.mjs';
import { LogQueries } from '../src/log-queries.mjs';

function setup(t, items = [log('old', { created_at: Math.floor(Date.now() / 1000) - 600 })]) {
  const f = fixture({ logs: items });
  t.after(() => f.store.close());
  let now = Date.now(), fail = false;
  const calls = [];
  f.upstream.logs = async query => {
    calls.push(query);
    if (fail) throw Error('upstream unavailable');
    const rows = f.logs.filter(l => (!query.user || l.user_id === query.user.id) && l.created_at >= query.start && l.created_at <= query.end && (!query.model || l.model_name === query.model) && (!query.requestId || l.request_id === query.requestId));
    return { items: structuredClone(rows.slice((query.page - 1) * 30, query.page * 30)), total: rows.length, page: query.page };
  };
  const clock = () => now;
  const service = new Compensation(f.store, f.upstream, clock);
  return { ...f, service, calls, clock, advance: ms => { now += ms; }, fail: value => { fail = value; } };
}

test('重复查询与并发查询共用持久缓存，未申请日志不消失', async t => {
  const f = setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.logs(user, {})));
  assert.equal(f.calls.length, 1);
  assert.ok(results.every(r => r.items[0].assessment.canApply));
  const restarted = new Compensation(f.store, f.upstream, f.clock);
  assert.equal((await restarted.logs(user, {})).items[0].log.request_id, 'old');
  assert.equal(f.calls.length, 1);
});

test('后续仅同步增量及最近五分钟，保留历史未申请日志并合并重叠项', async t => {
  const f = setup(t);
  await f.service.logs(user, {});
  const boundary = f.calls[0].end;
  f.advance(16_000);
  f.logs.push(log('new', { id: 101, created_at: boundary + 1 }), log('late', { id: 102, created_at: boundary - 200 }));
  const out = await f.service.logs(user, {});
  assert.equal(f.calls[1].start, boundary - 300);
  assert.deepEqual(new Set(out.items.map(v => v.log.request_id)), new Set(['old', 'new', 'late']));
  f.advance(16_000);
  assert.equal((await f.service.logs(user, {})).total, 3);
});

test('缓存实时关联申请进度，成功项在分页前排除，重复提交仍不重发', async t => {
  const f = setup(t, [log('paid'), log('review', { id: 101, other: '{}' }), log('available', { id: 102 })]);
  await f.service.logs(user, {});
  const paid = await f.service.selfService(user, 'paid');
  const pending = await f.service.selfService(user, 'review');
  assert.equal(paid.status, 'succeeded');
  assert.equal(pending.status, 'pending');
  const out = await f.service.logs(user, {});
  assert.equal(out.total, 2);
  assert.equal(out.items.find(v => v.log.request_id === 'review').assessment.canApply, false);
  assert.equal(out.items.find(v => v.log.request_id === 'review').claim.status, 'pending');
  assert.equal(out.items.find(v => v.log.request_id === 'available').assessment.canApply, true);
  assert.equal((await f.service.selfService(user, 'paid')).id, paid.id);
  assert.equal(f.calls.length, 1);
});

test('缓存按账号与筛选隔离，管理员消费查询不使用用户缓存', async t => {
  const f = setup(t, [log('a'), log('b', { user_id: 8, username: 'other-user' })]);
  await f.service.logs(user, {});
  const other = await f.service.logs({ ...user, id: 8, username: 'other-user' }, {});
  assert.deepEqual(other.items.map(v => v.log.request_id), ['b']);
  await f.service.logs(user, { model: 'fixture-model' });
  await f.service.logs(admin, {}, true);
  await f.service.logs(admin, {}, true);
  assert.equal(f.calls.length, 5);
});

test('同步失败不推进游标，重试仍补齐日志；定期重新核对延迟历史', async t => {
  const f = setup(t);
  await f.service.logs(user, {});
  const boundary = f.calls[0].end;
  f.advance(16_000);
  f.fail(true);
  await assert.rejects(f.service.logs(user, {}), /unavailable/);
  f.fail(false);
  f.logs.push(log('new', { created_at: boundary + 1 }));
  assert.equal((await f.service.logs(user, {})).total, 2);
  assert.equal(f.calls[1].start, f.calls[2].start);
  f.advance(15 * 60_000);
  f.logs.push(log('very-late', { created_at: boundary - 500 }));
  assert.equal((await f.service.logs(user, {})).total, 3);
  assert.ok(f.calls.at(-1).start < boundary - 500);
});

test('分页共享完整同步快照；同秒不同消费不会丢失', async t => {
  const items = Array.from({ length: 65 }, (_, i) => log('row-' + i, { id: i + 1 }));
  const f = setup(t, items);
  const first = await f.service.logs(user, { page: 1 });
  const second = await f.service.logs(user, { page: 2 });
  const third = await f.service.logs(user, { page: 3 });
  assert.equal(f.calls.length, 3);
  assert.equal(first.total, 65);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(v => v.log.request_id)).size, 65);
});

test('重复请求标识保留独立源记录，缓存不能绕过原始日志核验', async t => {
  const f = setup(t, [log('collision', { id: 1 }), log('collision', { id: 2 })]);
  assert.equal((await f.service.logs(user, {})).total, 2);
  await assert.rejects(f.service.selfService(user, 'collision'), /ambiguous/);
  assert.equal(f.store.overview().applications, 0);
  f.logs.splice(1);
  f.logs[0].quota = 0;
  await assert.rejects(f.service.selfService(user, 'collision'), /候选条件/);
});

test('空页、超大同步和无效范围不写入不完整缓存', async t => {
  const f = setup(t);
  const cache = new LogQueries(f.store, { logs: async () => ({ items: [], total: 2 }) }, f.clock);
  await assert.rejects(cache.read(user, {}, 72), /不完整/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM log_query_cache').get().n, 0);
  const large = new LogQueries(f.store, { logs: async () => ({ items: [], total: 10001 }) }, f.clock);
  await assert.rejects(large.read(user, {}, 72), /数量过多/);
  await assert.rejects(cache.read(user, { start: -1 }, 72), /范围无效/);
});

test('缺失原请求标识的缓存日志只展示不可申请，不影响查询', async t => {
  const f = setup(t, [log(undefined, { request_id: undefined })]);
  const out = await f.service.logs(user, {});
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].assessment.canApply, false);
  assert.equal(out.items[0].claim, null);
});
