import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discoverDatabase, sanitizedDatabase } from './db-discovery.mjs';

const newapiToken = /(^|[\s/_.-])(?:new[-_]?api|one[-_]?api)(?:[:/_.\s-]|$)/i;
const ancillaryToken = /(^|[\s/_.-])(?:tools?|toolbox|compensation|model[-_]?status|status[-_]?monitor|proxy|workers?|postgres(?:ql)?|mysql|mariadb|redis|database|db|adminer|nginx|caddy|backup)(?:[:/_.\s-]|$)/i;
const newapiExecutable = /(?:^|[\s;&|"'])(?:\/?[\w.\/-]*\/)?(?:new[-_]?api|one[-_]?api)(?:$|[\s;&|"'])/i;
const containerName = container => String(container?.Name || '').replace(/^\//, '');
const labelsFor = container => container?.Config?.Labels || {};
const executablePath = container => {
  const entrypoint = Array.isArray(container?.Config?.Entrypoint) ? container.Config.Entrypoint[0] : '';
  const executable = container?.Path || entrypoint || '';
  return typeof executable === 'string' && !/[\s\0"'`$=;]/.test(executable) ? executable : '';
};

// Keep the complete inspect objects in memory for callers, but never print them.
// A shared NewAPI image is insufficient when its service is a worker or proxy.
export function candidates(containers = []) {
  if (!Array.isArray(containers)) throw Error('容器识别结果必须为数组');
  return containers.filter(container => {
    if (!container?.State?.Running) return false;
    const labels = labelsFor(container);
    const service = labels['com.docker.compose.service'] || '';
    const image = String(container.Config?.Image || '').split('/').at(-1);
    const identity = [containerName(container), image, service].filter(Boolean).join(' ');
    const knownMainService = /^(?:new[-_]?api|one[-_]?api)$/i.test(service);
    if (ancillaryToken.test(service) || ancillaryToken.test(image) ||
      (!knownMainService && ancillaryToken.test(containerName(container))) ||
      labels['com.docker.compose.project'] === 'newapi-compensation') return false;
    const executable = [container.Path, ...(Array.isArray(container.Args) ? container.Args : [])].filter(Boolean).join(' ');
    return newapiToken.test(identity) || newapiExecutable.test(executable);
  });
}

export function projectMetadata(container) {
  const labels = labelsFor(container);
  return {
    container: containerName(container),
    id: String(container?.Id || ''),
    image: String(container?.Config?.Image || ''),
    containerWorkingDirectory: String(container?.Config?.WorkingDir || ''),
    executable: executablePath(container),
    project: String(labels['com.docker.compose.project'] || ''),
    service: String(labels['com.docker.compose.service'] || ''),
    workingDirectory: String(labels['com.docker.compose.project.working_dir'] || ''),
    composeFiles: String(labels['com.docker.compose.project.config_files'] || '').split(',').map(file => file.trim()).filter(Boolean),
    mounts: (container?.Mounts || []).map(mount => ({
      type: String(mount.Type || ''), name: mount.Name || null,
      source: String(mount.Source || ''), destination: String(mount.Destination || ''),
      readOnly: mount.RW === false,
    })),
  };
}

function matchesContainer(container, selector) {
  const value = String(selector || '').replace(/^\//, '');
  return value && (containerName(container) === value || container.Id === value ||
    (/^[a-f0-9]{6,64}$/i.test(value) && String(container.Id || '').startsWith(value)));
}

export function selectCandidate(containers, { container, previous } = {}) {
  const choices = candidates(containers);
  if (container) {
    const matches = choices.filter(choice => matchesContainer(choice, container));
    if (!matches.length) throw Error('指定的容器不是运行中的 NewAPI 主体，请重新选择');
    if (matches.length !== 1) throw Error('指定的 NewAPI 容器 ID 不唯一，匹配多个项目');
    return { selected: matches[0], choices, previous: null };
  }
  const previousSelectors = typeof previous === 'string' ? [previous] : [previous?.id, previous?.container, previous?.name].filter(Boolean);
  const previousMatches = choices.filter(choice => previousSelectors.some(selector => matchesContainer(choice, selector)));
  return { selected: choices.length === 1 ? choices[0] : null, choices,
    previous: previousMatches.length === 1 ? previousMatches[0] : null };
}

export function deploymentPlan(container, options = {}) {
  if (!container) return {mode:'host',network:'host',url:options.url||'http://127.0.0.1:3000',database:{version:1,connected:false,mode:'api',main:{type:'unknown'},logs:{type:'unknown'}}};
  const name=containerName(container);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))throw Error('容器名称无效');
  const env=Object.fromEntries((container.Config?.Env||[]).filter(line=>typeof line==='string'&&line.indexOf('=')>0).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const port=Number(options.port??env.PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('原站端口无效');
  let database;
  try { database=sanitizedDatabase(discoverDatabase(container,{fileValues:options.fileValues}),options.containers||[]); }
  catch { const reason='NewAPI 数据库配置识别失败，请检查选中项目的数据库配置';database={version:1,container:name,connected:false,mode:'api',warning:reason,main:{type:'unknown',location:'unresolved',reason},logs:{type:'unknown',location:'unresolved',reason}}; }
  const project=projectMetadata(container);
  if(container.HostConfig?.NetworkMode==='host') {
    if(options.network&&options.network!=='host')throw Error('原站使用 host 网络；指定的网络不属于此原站');
    return {mode:'docker-host',network:'host',url:options.url||`http://127.0.0.1:${port}`,database,project};
  }
  const networks=Object.entries(container.NetworkSettings?.Networks||{}).filter(([key])=>!['bridge','host','none'].includes(key));
  if (!options.network && networks.length > 1) throw Error('原站连接多个网络；设置 NEWAPI_NETWORK 选择已连接的网络');
  const network=options.network||networks[0]?.[0];
  if (!network) {
    const bindings=container.NetworkSettings?.Ports?.[`${port}/tcp`]||[];
    const local=bindings.find(b=>['127.0.0.1','0.0.0.0',''].includes(b.HostIp)&&/^\d+$/.test(b.HostPort));
    if(local&&Number(local.HostPort)>0&&Number(local.HostPort)<=65535)return {mode:'docker-published',network:'host',url:options.url||`http://127.0.0.1:${Number(local.HostPort)}`,database,project};
  }
  if(!network||!networks.some(([key])=>key===network))throw Error('未发现用户自定义网络；设置 NEWAPI_URL 使用原站已发布端口接入');
  return {mode:container.Config?.Labels?.['com.docker.compose.project']?'docker-compose':'docker',network,url:options.url||`http://${name}:${port}`,database,project};
}
export function composePlan({network='host',port=3210}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('本地端口无效');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)||['bridge','none'].includes(network))throw Error('网络名称无效');
  return {name:'newapi-compensation',services:{compensation:{
    build:{context:'.',target:'runtime'},image:'yunxiang-newapi-compensation:local',container_name:'yunxiang-compensation',restart:'unless-stopped',init:true,
    environment:{HOST:network==='host'?'127.0.0.1':'0.0.0.0',PORT:String(port),DATA_DIR:'/app/data',PUBLIC_ORIGIN:'${PUBLIC_ORIGIN}',NEWAPI_URL:'${NEWAPI_URL}',NEWAPI_ADMIN_USER_ID:'${NEWAPI_ADMIN_USER_ID}',NEWAPI_ADMIN_TOKEN_FILE:'/run/secrets/newapi_admin_token',NEWAPI_DB_CONFIG_FILE:'/run/secrets/newapi_database',ALLOW_HTTP_UPSTREAM:'${ALLOW_HTTP_UPSTREAM:-0}'},
    network_mode:network,volumes:['compensation_data:/app/data'],secrets:['newapi_admin_token','newapi_database'],
    ...(network!=='host'?{ports:[`127.0.0.1:${port}:${port}`]}:{}),
    read_only:true,tmpfs:['/tmp:size=16m,mode=1777'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],stop_grace_period:'45s',
    healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:${port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],interval:'30s',timeout:'5s',start_period:'10s',retries:3},
    logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}
  }},volumes:{compensation_data:{name:'newapi-compensation_compensation_data'}},secrets:{newapi_admin_token:{file:'./secrets/newapi_admin_token'},newapi_database:{file:'./secrets/newapi_database.json'}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const input=JSON.parse(readFileSync(0,'utf8'));
    const output=process.argv[2]==='compose'?composePlan(input):process.argv[2]==='candidates'?candidates(input).map(c=>({name:containerName(c),...projectMetadata(c)})):process.argv[2]==='container'?deploymentPlan(input,{network:process.argv[3]||undefined,port:process.argv[4]||undefined}):deploymentPlan(input.container,input.options);
    if(output.services&&output.services.compensation.network_mode!=='host')output.services.compensation.environment.HOST='0.0.0.0';
    process.stdout.write(JSON.stringify(output,null,2)+'\n');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
