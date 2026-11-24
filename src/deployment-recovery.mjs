import { chmodSync, chownSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

const networkPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function checkedTree(directory, visit = () => {}) {
  const item = lstatSync(directory);
  if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw Error('迁移数据包含链接或特殊文件');
  visit(directory, item);
  if (item.isDirectory()) for (const name of readdirSync(directory)) checkedTree(join(directory, name), visit);
}

export function validateLedger(directory) {
  checkedTree(directory);
  const file = join(directory, 'compensation.sqlite');
  if (!existsSync(file) || !lstatSync(file).isFile()) throw Error('迁移数据缺少 SQLite 账本');
  const header = Buffer.alloc(16), fd = openSync(file, 'r');
  try {
    if (lstatSync(file).size < 100 || readSync(fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) {
      throw Error('迁移数据不是有效 SQLite 账本');
    }
  } finally {
    closeSync(fd);
  }
  let encryptedSettings = false;
  // SQLite may rebuild SHM when reading WAL; verify a scratch copy of read-only imports.
  const scratch = mkdtempSync(join(tmpdir(), 'yunxiang-ledger-check-'));
  let db;
  try {
    const checkFile = join(scratch, 'compensation.sqlite');
    cpSync(file, checkFile);
    if (existsSync(file + '-wal')) cpSync(file + '-wal', checkFile + '-wal');
    db = new DatabaseSync(checkFile);
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('SQLite 账本完整性检查失败');
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get()) {
      const smtp = db.prepare("SELECT value FROM metadata WHERE key='email_smtp'").get();
      encryptedSettings = typeof smtp?.value === 'string' && smtp.value.trim().length > 0;
    }
    if (!encryptedSettings && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_notifications'").get()) {
      encryptedSettings = Boolean(db.prepare("SELECT 1 FROM email_notifications WHERE recipient IS NOT NULL AND recipient<>'' LIMIT 1").get());
    }
  } finally {
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  const key = join(directory, 'secrets.key');
  if (existsSync(key) && readFileSync(key).length !== 32) throw Error('通知加密密钥文件无效');
  if ((encryptedSettings || existsSync(join(directory, 'dingtalk.enc'))) && !existsSync(key)) throw Error('迁移数据缺少通知加密密钥 secrets.key');
}

export function validateMigration(directory) {
  checkedTree(directory);
  for (const file of ['.env.auto', 'compose.generated.json', 'secrets/newapi_admin_token', 'secrets/newapi_database.json']) {
    const path = join(directory, file);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0) throw Error(`迁移包缺少 ${file}`);
  }
  const compose = JSON.parse(readFileSync(join(directory, 'compose.generated.json'), 'utf8'));
  validateCompose(compose);
  JSON.parse(readFileSync(join(directory, 'secrets/newapi_database.json'), 'utf8'));
  validateLedger(join(directory, 'volume'));
}

export function copyLedger(source, destination, { restore = false } = {}) {
  validateLedger(source);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (readdirSync(destination).length) throw Error('目标账本目录非空，禁止覆盖');
  for (const name of readdirSync(source)) cpSync(join(source, name), join(destination, name), { recursive: true, force: false, errorOnExist: true });
  validateLedger(destination);
  checkedTree(destination, (file, item) => {
    if (restore && process.platform !== 'win32') chownSync(file, 1000, 1000);
    chmodSync(file, item.isDirectory() ? 0o700 : 0o600);
  });
}

function rewritePaths(compose, projectDir) {
  const root = resolve(projectDir);
  const changes = [];
  for (const [name, service] of Object.entries(compose.services || {})) {
    const context = service?.build?.context;
    if (typeof context === 'string' && isAbsolute(context) && resolve(context) !== root) {
      service.build.context = root;
      changes.push(`services.${name}.build.context`);
    }
  }
  for (const [name, secret] of Object.entries(compose.secrets || {})) {
    const file = secret?.file;
    if (typeof file === 'string' && isAbsolute(file) && resolve(file) !== join(root, 'secrets', basename(file))) {
      secret.file = join(root, 'secrets', basename(file));
      changes.push(`secrets.${name}.file`);
    }
  }
  return { compose, changes };
}

function validateCompose(compose) {
  if (compose?.name !== 'newapi-compensation' || !compose.services?.compensation || Object.keys(compose.services).length !== 1) {
    throw Error('未知的云响编排配置；项目必须为 newapi-compensation 且仅包含 compensation 服务');
  }
  const service = compose.services.compensation;
  const mounts = service.volumes;
  const mount = Array.isArray(mounts) && mounts.length === 1 ? mounts[0] : null;
  const ledgerMount = typeof mount === 'string'
    ? ['compensation_data:/app/data', 'compensation_data:/app/data:rw'].includes(mount)
    : mount?.type === 'volume' && mount.source === 'compensation_data' && mount.target === '/app/data' && !mount.read_only;
  const volumes = compose.volumes || {};
  const ledger = volumes.compensation_data || {};
  if (!ledgerMount || Object.keys(volumes).some(name => name !== 'compensation_data') ||
      (ledger.name && ledger.name !== 'newapi-compensation_compensation_data') || ledger.external ||
      (ledger.driver && ledger.driver !== 'local') || Object.keys(ledger.driver_opts || {}).length) {
    throw Error('云响账本挂载必须使用专属数据卷 newapi-compensation_compensation_data');
  }
  if (service.image && !['newapi-compensation:local', 'yunxiang-newapi-compensation:local'].includes(service.image)) {
    throw Error('未知的云响镜像，拒绝迁移其他服务');
  }
}

export function normalizeComposePaths(compose, projectDir) {
  validateCompose(compose);
  const result = rewritePaths(structuredClone(compose), projectDir);
  if (!result.compose.volumes) result.compose.volumes = {};
  const ledger = result.compose.volumes.compensation_data || {};
  if (ledger.name !== 'newapi-compensation_compensation_data') {
    result.compose.volumes.compensation_data = { ...ledger, name: 'newapi-compensation_compensation_data' };
    result.changes.push('volumes.compensation_data.name');
  }
  const service = result.compose.services.compensation;
  for (const [field, value] of [['image', 'yunxiang-newapi-compensation:local'], ['container_name', 'yunxiang-compensation']]) {
    if (service[field] !== value) {
      service[field] = value;
      result.changes.push(`services.compensation.${field}`);
    }
  }
  return result;
}

export function recoverNetwork(compose, container, explicitNetwork = '') {
  if (!compose?.services?.compensation) throw Error('未知的云响编排配置');
  const service = compose.services.compensation;
  const current = service.network_mode;
  if (current === 'host') return { compose, changes: [] };

  const networks = Object.keys(container?.NetworkSettings?.Networks || {});
  const attached = networks.filter(name => !['bridge', 'host', 'none'].includes(name));
  let network = explicitNetwork || '';
  if (!network) {
    if (attached.includes(current)) return { compose, changes: [] };
    if (attached.length !== 1) throw Error('无法唯一识别 云中猫API小站 网络；设置 NEWAPI_NETWORK 后重试');
    network = attached[0];
  }
  if (!networkPattern.test(network) || ['bridge', 'none'].includes(network)) throw Error('网络名称无效');
  if (container && !attached.includes(network)) throw Error('指定的网络未连接 云中猫API小站 容器');

  const next = structuredClone(compose);
  next.services.compensation.network_mode = network;
  return { compose: next, changes: [`services.compensation.network_mode:${network}`] };
}

export function setNetwork(compose, network) {
  if (!compose?.services?.compensation) throw Error('未知的云响编排配置');
  if (!networkPattern.test(network) || ['bridge', 'none'].includes(network)) throw Error('网络名称无效');
  const next = structuredClone(compose);
  next.services.compensation.network_mode = network;
  return { compose: next, changes: [`services.compensation.network_mode:${network}`] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (command === 'validate-package') validateMigration(process.argv[3]);
    else if (command === 'check-volume') validateLedger(process.argv[3]);
    else if (command === 'export-volume' || command === 'restore-volume') copyLedger(process.argv[3], process.argv[4], { restore: command === 'restore-volume' });
    else {
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const output = command === 'normalize'
        ? normalizeComposePaths(input, process.argv[3])
        : command === 'network'
          ? recoverNetwork(input, JSON.parse(process.argv[4] || 'null'), process.argv[5] || '')
          : command === 'set-network'
            ? setNetwork(input, process.argv[3])
            : (() => { throw Error('未知命令'); })();
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
