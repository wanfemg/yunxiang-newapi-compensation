const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const root = path.resolve(process.env.YUNXIANG_HELPER_ROOT);
const mappings = JSON.parse(process.env.YUNXIANG_HELPER_MOUNTS || '{}');
function translate(value) {
  if (typeof value !== 'string') return value;
  let mapped = value;
  for (const [destination, source] of Object.entries(mappings)) {
    if (value === destination || value.startsWith(destination + '/')) { mapped = source + value.slice(destination.length); break; }
  }
  const absolute = path.resolve(mapped);
  if (absolute === root || absolute.startsWith(root + path.sep) || Object.values(mappings).some(source => absolute === path.resolve(source) || absolute.startsWith(path.resolve(source) + path.sep))) return mapped;
  const error = new Error(`ENOENT: unmounted container path ${value}`);
  error.code = 'ENOENT';
  throw error;
}
for (const name of ['readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'mkdirSync', 'openSync', 'chmodSync']) {
  const original = fs[name];
  fs[name] = function(value, ...args) { return original.call(this, translate(value), ...args); };
}
syncBuiltinESMExports();
