import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './rules.mjs';

export class DingTalk {
  constructor(store, directory, fetcher = fetch) {
    this.store = store; this.fetcher = fetcher; this.running = false;
    this.file = join(directory, 'dingtalk.enc');
    const keyFile = join(directory, 'secrets.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('通知密钥文件无效');
  }
  config() {
    if (!existsSync(this.file)) return {};
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString());
  }
  status() { const c = this.config(); return { configured: Boolean(c.webhook), signed: Boolean(c.secret) }; }
  save({ webhook, secret, clear = false }) {
    const previous = this.config();
    const next = clear ? {} : { webhook: webhook || previous.webhook, secret: secret === undefined ? previous.secret : secret };
    if (!clear) {
      let u; try { u = new URL(next.webhook); } catch { throw new AppError('钉钉 Webhook 地址无效'); }
      if (u.protocol !== 'https:' || u.hostname !== 'oapi.dingtalk.com' || u.port || u.pathname !== '/robot/send' || u.username || u.password || !u.searchParams.get('access_token')) throw new AppError('仅接受钉钉官方机器人 HTTPS Webhook');
      if (typeof next.secret !== 'string' || !next.secret || next.secret.length > 300) throw new AppError('必须填写钉钉加签密钥');
      next.webhook = u.toString();
    }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    const data = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    writeFileSync(`${this.file}.tmp`, data, { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
    return this.status();
  }
  async flush() {
    if (this.running || !this.store.rules().notifications.enabled) return;
    this.running = true;
    try {
      const config = this.config();
      if (!config.webhook) return;
      const rows = this.store.db.prepare("SELECT * FROM notifications WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 10").all(Date.now());
      for (const row of rows) {
        if (row.event !== 'notification_test' && !this.store.rules().notifications.events.includes(row.event)) {
          this.store.db.prepare("UPDATE notifications SET status='cancelled',result='事件开关已关闭' WHERE id=?").run(row.id); continue;
        }
        const url = new URL(config.webhook), timestamp = String(Date.now());
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('sign', createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64'));
        let success = false;
        try {
          let markdown;try{markdown=JSON.parse(row.body);}catch{}
          if(!markdown||typeof markdown.title!=='string'||typeof markdown.text!=='string')markdown={title:'NewAPI 补空回通知',text:'### NewAPI 补空回通知\n\n'+String(row.body).replace(/[<>@]/g,' ')};
          const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'markdown', markdown,at:{isAtAll:false} }), redirect: 'error', signal: AbortSignal.timeout(8000) });
          success = response.ok && (await response.json()).errcode === 0;
        } catch {}
        const attempts = row.attempts + 1;
        this.store.db.prepare('UPDATE notifications SET status=?,attempts=?,next_at=?,result=? WHERE id=?').run(success ? 'sent' : attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(3600000, 30000 * 2 ** attempts), success ? '发送成功' : '发送失败，检查机器人配置或网络；通知可能重复送达', row.id);
      }
    } finally { this.running = false; }
  }
}
