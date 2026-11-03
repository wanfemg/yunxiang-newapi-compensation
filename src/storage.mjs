import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError } from './rules.mjs';

const DAY = 86400000;
const backupName = /^compensation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');

export class StorageMaintenance {
  constructor(store, clock = Date.now) { this.store = store; this.clock = clock; this.plans = new Map(); }
  backupDirectory() {
    const file = this.store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!file) return null;
    const directory = join(realpathSync(dirname(file)), 'backups');
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== resolve(directory)) return null;
      return directory;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  backups() {
    const directory = this.backupDirectory();
    if (!directory) return [];
    return readdirSync(directory).filter(name => backupName.test(name)).flatMap(name => {
      const stat = lstatSync(join(directory, name));
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        ? [{ name, size: stat.size, modifiedAt: stat.mtimeMs, signature: signature(stat) }] : [];
    }).sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  }
  info() {
    const files = this.backups();
    return { ...this.store.storageInfo(), backups: { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), available: Boolean(this.backupDirectory()) } };
  }
  preview(actor, input) {
    const options = {};
    for (const key of ['cache','notifications','backups','compact']) {
      if (typeof input[key] !== 'boolean') throw new AppError('清理选项必须为开关');
      options[key] = input[key];
    }
    for (const [key, minimum] of [['cacheDays',1],['notificationDays',7],['backupDays',7]]) {
      const value = input[key];
      if (!Number.isSafeInteger(value) || value < minimum || value > 3650) throw new AppError('清理保留天数无效');
      options[key] = value;
    }
    if (!Object.values(options).some(v => v === true)) throw new AppError('至少选择一种清理项目');
    const now = this.clock();
    for (const [token, plan] of this.plans) if (plan.expires < now) this.plans.delete(token);
    if (this.plans.size >= 100) throw new AppError('清理预览过多，稍后重试',429);
    const cache = options.cache ? this.store.db.prepare('SELECT cache_key,created_at FROM log_query_cache WHERE created_at<?').all(now - options.cacheDays * DAY) : [];
    const notifications = options.notifications ? this.store.db.prepare("SELECT id,status,created_at FROM notifications WHERE created_at<? AND status IN ('sent','failed','cancelled')").all(now - options.notificationDays * DAY) : [];
    const files = options.backups ? this.backups().slice(3).filter(f => f.modifiedAt < now - options.backupDays * DAY) : [];
    const token = randomBytes(24).toString('base64url');
    // A single-use plan binds deletion to precisely what this administrator previewed.
    this.plans.set(token, { actor, expires: now + 300000, options, cache, notifications, files });
    return { token, expiresAt: now + 300000, cache: cache.length, notifications: notifications.length, backups: files.map(({name,size})=>({name,size})), backupBytes: files.reduce((n,f)=>n+f.size,0), compact: options.compact };
  }
  clean(actor, token, confirmation) {
    const plan = this.plans.get(token);
    if (!plan || plan.actor !== actor || plan.expires < this.clock()) throw new AppError('清理预览已失效，请重新预览',409);
    if (confirmation !== '确认清理') throw new AppError('请确认清理范围');
    if (this.store.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status='executing'").get().n) throw new AppError('正在发放补偿，请处理结束后再清理',409);
    this.plans.delete(token);
    const result = this.store.transaction(() => {
      let cache=0, notifications=0;
      const deleteCache=this.store.db.prepare('DELETE FROM log_query_cache WHERE cache_key=? AND created_at=?');
      for (const row of plan.cache) cache+=deleteCache.run(row.cache_key,row.created_at).changes;
      const deleteNotice=this.store.db.prepare('DELETE FROM notifications WHERE id=? AND created_at=? AND status=?');
      for (const row of plan.notifications) notifications+=deleteNotice.run(row.id,row.created_at,row.status).changes;
      const result={cache,notifications,backups:0,backupBytes:0,skippedBackups:0,compacted:false};
      this.store.event(null,actor,'storage_cleanup',{options:plan.options,cache,notifications,backupCandidates:plan.files.map(f=>f.name)});
      return result;
    });
    const allowed = new Map(this.backups().slice(3).map(f=>[f.name,f]));
    const directory = this.backupDirectory();
    for (const file of plan.files) {
      const current = allowed.get(file.name);
      if (!directory || current?.signature !== file.signature) { result.skippedBackups++; continue; }
      try {
        const stat=lstatSync(join(directory,file.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || signature(stat)!==file.signature) { result.skippedBackups++; continue; }
        unlinkSync(join(directory,file.name)); result.backups++; result.backupBytes+=file.size;
      } catch { result.skippedBackups++; }
    }
    if (plan.options.compact) {
      try {
        this.store.db.exec('VACUUM');
        this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        result.compacted=true;
      } catch { result.compactError='记录清理完成，但空间整理未完成，请稍后重试'; }
    }
    this.store.event(null,actor,'storage_cleanup_completed',result);
    return result;
  }
}
