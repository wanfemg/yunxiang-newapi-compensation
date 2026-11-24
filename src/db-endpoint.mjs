// Parse connection locations only. Credentials never leave this module.
function invalid() { throw new Error('数据库连接地址无法解析'); }
function port(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) invalid();
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) invalid();
  return number;
}
function decoded(value) { try { return decodeURIComponent(value); } catch { invalid(); } }
function endpoint(host, value, database, fallback) {
  const number = port(value, fallback);
  host = String(host || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (host.startsWith('/')) return { socket: host, database: String(database || '') };
  if (/[\s,@=?#\/\\]/.test(host)) invalid();
  return { host, port: number, database: String(database || '') };
}

// libpq conninfo supports single quotes and backslash escaping, including spaces
// and '=' inside passwords. Splitting on spaces or '=' silently corrupts it.
function parsePostgresConninfo(input) {
  const values = {};
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] || '') && index < input.length) index++;
    if (index === input.length) break;
    const key = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(index));
    if (!key) invalid();
    index += key[0].length;
    while (/\s/.test(input[index] || '') && index < input.length) index++;
    if (input[index++] !== '=') invalid();
    while (/\s/.test(input[index] || '') && index < input.length) index++;
    let value = '';
    const quote = input[index] === "'" ? input[index++] : null;
    let closed = !quote;
    while (index < input.length) {
      const character = input[index++];
      if (character === '\\') {
        if (index === input.length) invalid();
        value += input[index++];
      } else if (quote && character === quote) { closed = true; break; }
      else if (!quote && /\s/.test(character)) break;
      else value += character;
    }
    if (!closed || (quote && index < input.length && !/\s/.test(input[index]))) invalid();
    values[key[0].toLowerCase()] = value;
  }
  return values;
}

function parsedDatabaseDsn(input, { isLog = false } = {}) {
  const value = String(input).trim();
  if (!value || value.length > 65536 || /[\0\r\n]/.test(value)) invalid();
  if (/^postgres(?:ql)?:\/\//i.test(value)) {
    const url = new URL(value);
    const host = url.searchParams.get('host') || url.hostname;
    const database = url.searchParams.get('dbname') || decoded(url.pathname.slice(1));
    return { type: 'postgresql', endpoint: endpoint(host, url.searchParams.get('port') || url.port, database, 5432) };
  }
  if (/^[a-z_][a-z\d_]*\s*=/i.test(value)) {
    const fields = parsePostgresConninfo(value);
    if (fields.service && !fields.host && !fields.hostaddr) invalid();
    return { type: 'postgresql', endpoint: endpoint(fields.host || fields.hostaddr, fields.port, fields.dbname, 5432) };
  }
  if (/^mysql:\/\//i.test(value)) {
    const url = new URL(value);
    return { type: 'mysql', endpoint: endpoint(url.hostname, url.port, decoded(url.pathname.slice(1)), 3306) };
  }
  if (/^(clickhouse|tcp|http|https):\/\//i.test(value)) {
    if (!isLog) throw new Error('识别到不支持的 ClickHouse 主库配置');
    const url = new URL(value);
    const defaultPort = url.protocol === 'http:' ? 8123 : url.protocol === 'https:' ? 8443 : 9000;
    return { type: 'clickhouse', endpoint: endpoint(url.hostname, url.port, url.searchParams.get('database') || decoded(url.pathname.slice(1)), defaultPort) };
  }
  const go = /^(?:.*@)?(tcp|tcp4|tcp6|unix|unixpacket)\((.*)\)\/([^?]*)(?:\?.*)?$/.exec(value);
  if (go) {
    if (go[1].startsWith('unix')) return { type: 'mysql', endpoint: { socket: go[2], database: decoded(go[3]) } };
    const address = go[2];
    const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
    const pair = /^([^:]*)(?::(\d+))?$/.exec(address);
    if (!ipv6 && !pair) invalid();
    return { type: 'mysql', endpoint: endpoint((ipv6 || pair)[1], (ipv6 || pair)[2], decoded(go[3]), 3306) };
  }
  const local = /^(?:.*@)?\/([^?]*)(?:\?.*)?$/.exec(value);
  if (local) return { type: 'mysql', endpoint: endpoint('127.0.0.1', undefined, decoded(local[1]), 3306) };
  invalid();
}

export function parseDatabaseDsn(input, options) {
  try { return parsedDatabaseDsn(input, options); }
  catch { throw new Error('数据库连接地址无法解析'); }
}
