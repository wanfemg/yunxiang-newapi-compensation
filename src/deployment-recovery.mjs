import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const networkPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

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

export function normalizeComposePaths(compose, projectDir) {
  if (!compose?.services?.compensation) throw Error('未知的云响编排配置');
  const result = rewritePaths(structuredClone(compose), projectDir);
  if (!result.compose.volumes) result.compose.volumes = {};
  if (!result.compose.volumes.compensation_data) result.compose.volumes.compensation_data = { name: 'newapi-compensation_compensation_data' };
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
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const output = command === 'normalize'
      ? normalizeComposePaths(input, process.argv[3])
      : command === 'network'
        ? recoverNetwork(input, JSON.parse(process.argv[4] || 'null'), process.argv[5] || '')
        : command === 'set-network'
          ? setNetwork(input, process.argv[3])
          : (() => { throw Error('未知命令'); })();
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
