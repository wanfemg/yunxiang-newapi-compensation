import { AppError } from './rules.mjs';

export class Branding {
  constructor(upstream) { this.upstream = upstream; this.cached = null; this.pending = null; }
  async read() {
    if (this.cached && this.cached.until > Date.now()) return this.cached;
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async load() {
    const status = (await this.upstream.request('/api/status')).data;
    let source = null, logo = '';
    try {
      const url = new URL(status?.logo || '', this.upstream.url);
      if (status?.logo && !url.username && !url.password) {
        if (url.origin === this.upstream.url.origin) { source = url; logo = '/api/brand/logo'; }
        else if (url.protocol === 'https:') logo = url.href;
      }
    } catch {}
    this.cached = { name: '云响', logo, source, until: Date.now() + 60000 };
    return this.cached;
  }
  async image() {
    const { source } = await this.read();
    if (!source) throw new AppError('原站未设置可读取的 Logo', 404);
    // Only the configured upstream origin is proxied; never forward admin credentials.
    const response = await this.upstream.fetcher(source, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !['image/png','image/jpeg','image/webp','image/gif','image/svg+xml','image/x-icon','image/vnd.microsoft.icon'].includes(type)) throw new AppError('Logo 格式不可用', 502);
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 2 * 1024 * 1024) throw new AppError('Logo 文件过大', 502);
      parts.push(part);
    }
    return { type, body: Buffer.concat(parts) };
  }
}
