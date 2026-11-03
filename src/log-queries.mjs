import { AppError } from './rules.mjs';

const REUSE_MS = 15_000;
const RECHECK_MS = 15 * 60_000;
const OVERLAP_SECONDS = 300;
const MAX_LOGS = 10_000;

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
    const requestedStart = query.start ?? Math.floor(now / 1000 - hours * 3600);
    const start = Math.max(requestedStart, Math.floor(now / 1000 - hours * 3600));
    const end = Math.min(query.end ?? Math.floor(now / 1000), Math.floor(now / 1000));
    if (!Number.isSafeInteger(requestedStart) || requestedStart < 0 || !Number.isSafeInteger(end) || end < start) throw new AppError('消费时间范围无效');
    const key = JSON.stringify([user.id, user.username, query.model || '', query.requestId || '', query.start ?? null, query.end ?? null, hours]);
    if (!this.pending.has(key)) {
      const job = this.sync(key, user, query, start, end, now);
      this.pending.set(key, job);
      job.finally(() => this.pending.delete(key)).catch(() => {});
    }
    const snapshot = await this.pending.get(key);
    const items = snapshot.items.filter(log => log.user_id === user.id && log.created_at >= start && log.created_at <= end);
    return { items, syncedAt: snapshot.syncedAt };
  }
  async sync(key, user, query, start, end, now) {
    const previous = this.store.cachedLogQuery(key);
    if (previous && now >= previous.syncedAt && now - previous.syncedAt < REUSE_MS) return previous;
    const full = !previous || now < previous.syncedAt || now - previous.fullAt >= RECHECK_MS;
    const from = full ? start : Math.max(start, previous.end - OVERLAP_SECONDS);
    const fetched = [];
    let total = Infinity;
    for (let page = 1; fetched.length < total; page++) {
      const data = await this.upstream.logs({ user, page, model: query.model || '', requestId: query.requestId || '', start: from, end });
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > MAX_LOGS) throw new AppError('日志数量过多或响应异常，请缩小消费时间范围', 409);
      total = data.total;
      if ((!data.items.length && fetched.length < total) || page > 1000) throw new AppError('日志同步不完整，请重试', 502);
      fetched.push(...data.items);
    }
    // Keep distinct source rows even if request_id collides; payout rejects ambiguous IDs.
    const rows = new Map();
    for (const log of [...(full ? [] : previous.items.filter(log => log.created_at < from)), ...fetched]) {
      if (log.user_id !== user.id || log.created_at < start || log.created_at > end) continue;
      const id = log.id === undefined ? JSON.stringify(log) : JSON.stringify([log.id, log.request_id]);
      rows.set(id, log);
    }
    if (rows.size > MAX_LOGS) throw new AppError('日志数量过多，请缩小消费时间范围', 409);
    const items = [...rows.values()].sort((a, b) => b.created_at - a.created_at || Number(b.id || 0) - Number(a.id || 0));
    const snapshot = { items, end, syncedAt: now, fullAt: full ? now : previous.fullAt };
    this.store.cacheLogQuery(key, snapshot);
    return snapshot;
  }
}
