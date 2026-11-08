import { AppError } from './rules.mjs';
import { randomUUID } from 'node:crypto';

const MAX_LOGS = 10_000;
const rowKey = log => log.id === undefined ? JSON.stringify(log) : JSON.stringify([log.id, log.request_id]);

// Query snapshots are only for discovery. Applying and paying always read upstream again.
export class LogQueries {
  constructor(store, upstream, clock = Date.now) {
    this.store = store;
    this.upstream = upstream;
    this.clock = clock;
    this.pending = new Map();
  }
  async read(user, query, hours) {
    const now = this.clock();
    const end = Math.floor(now / 1000);
    const start = Math.max(0, Math.floor(end - hours * 3600));
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(end)) throw new AppError('消费时间范围无效');
    // Capture the click time before waiting. Each later request scans only its remaining tail.
    const previous = this.pending.get(user.id) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.sync(user, query, start, end, now));
    this.pending.set(user.id, job);
    try { return await job; }
    finally { if (this.pending.get(user.id) === job) this.pending.delete(user.id); }
  }
  async sync(user, query, start, end, now) {
    const previous = this.store.logQueryProgress(user.id);
    const visible = snapshot => ({ ...snapshot, items: snapshot.items.filter(log => log.user_id === user.id && log.created_at >= start && log.created_at <= end) });
    if (previous && (!query.refresh || end <= previous.end)) return { ...visible(previous), scanned: false, added: 0 };
    const from = previous ? Math.max(start, previous.end + 1) : start;
    const fetched = [], batchId = randomUUID();
    const identities = new Set();
    let total = Infinity;
    for (let page = 1; fetched.length < total; page++) {
      const data = await this.upstream.logs({ user, page, start: from, end });
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > MAX_LOGS) throw new AppError('日志数量过多或响应异常，请管理员调整查询天数；查询进度未推进', 409);
      if (total !== Infinity && data.total !== total) throw new AppError('日志总数在同步中变化，请重试；查询进度未推进', 502);
      total = data.total;
      if ((!data.items.length && fetched.length < total) || fetched.length + data.items.length > total || page > 1000) throw new AppError('日志同步不完整，请重试；查询进度未推进', 502);
      for (const log of data.items) {
        if (identities.has(rowKey(log))) throw new AppError('日志分页重复，请重试；查询进度未推进', 502);
        identities.add(rowKey(log));
      }
      fetched.push(...data.items.map(log => ({ ...log, query_batch_id: batchId })));
    }
    // Keep distinct source rows even if request_id collides; payout rejects ambiguous IDs.
    const rows = new Map();
    for (const log of [...(previous?.items || []), ...fetched]) {
      if (log.user_id !== user.id || log.created_at < start || log.created_at > end) continue;
      rows.set(rowKey(log), log);
    }
    if (rows.size > MAX_LOGS) throw new AppError('保留日志数量过多，请管理员调整查询天数；查询进度未推进', 409);
    const items = [...rows.values()].sort((a, b) => b.created_at - a.created_at || Number(b.id || 0) - Number(a.id || 0));
    const snapshot = { items, end, syncedAt: now, from, added: fetched.filter(log => log.user_id === user.id && log.created_at >= from && log.created_at <= end).length, coverageStart: Math.max(start, previous?.coverageStart ?? start) };
    this.store.saveLogQueryProgress(user.id, snapshot, { id: batchId, user, from, end, items: fetched });
    return { ...snapshot, scanned: true };
  }
}
