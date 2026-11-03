import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discoverDatabase } from './db-discovery.mjs';

export function candidates(containers) {
  return containers.filter(c => c.State?.Running && /(^|[\s/_.-])(new-?api|one-?api)([:/_.\s-]|$)/i.test([c.Name,c.Config?.Image,c.Path,...(c.Args||[])].join(' ')));
}
export function deploymentPlan(container, options = {}) {
  if (!container) return {mode:'host',network:'host',url:options.url||'http://127.0.0.1:3000',database:{version:1,connected:false,mode:'api',main:{type:'unknown'},logs:{type:'unknown'}}};
  const name=String(container.Name||'').replace(/^\//,'');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))throw Error('容器名称无效');
  const env=Object.fromEntries((container.Config?.Env||[]).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const port=Number(options.port??env.PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('原站端口无效');
  let database;
  try { const detected=discoverDatabase(container);database={version:1,container:name,connected:false,main:{type:detected.main.type},logs:{type:detected.logs.type,...(detected.logs.sameAs?{sameAs:'main'}:{})}}; }
  catch {database={version:1,container:name,connected:false,mode:'api',main:{type:'unknown'},logs:{type:'unknown'}};}
  if(container.HostConfig?.NetworkMode==='host')return {mode:'docker-host',network:'host',url:`http://127.0.0.1:${port}`,database};
  const networks=Object.entries(container.NetworkSettings?.Networks||{}).filter(([key])=>!['bridge','host','none'].includes(key));
  const network=options.network||networks[0]?.[0];
  if (!network) {
    const bindings=container.NetworkSettings?.Ports?.[`${port}/tcp`]||[];
    const local=bindings.find(b=>['127.0.0.1','0.0.0.0',''].includes(b.HostIp)&&/^\d+$/.test(b.HostPort));
    if(local&&Number(local.HostPort)>0&&Number(local.HostPort)<=65535)return {mode:'docker-published',network:'host',url:`http://127.0.0.1:${Number(local.HostPort)}`,database};
  }
  if(!network||!networks.some(([key])=>key===network))throw Error('未发现用户自定义网络；设置 NEWAPI_URL 使用原站已发布端口接入');
  return {mode:container.Config?.Labels?.['com.docker.compose.project']?'docker-compose':'docker',network,url:`http://${name}:${port}`,database};
}
export function composePlan({network='host',port=3210}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('本地端口无效');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)||['bridge','none'].includes(network))throw Error('网络名称无效');
  return {name:'newapi-compensation',services:{compensation:{
    build:{context:'.',target:'runtime'},image:'newapi-compensation:local',restart:'unless-stopped',init:true,
    environment:{HOST:network==='host'?'127.0.0.1':'0.0.0.0',PORT:String(port),DATA_DIR:'/app/data',PUBLIC_ORIGIN:'${PUBLIC_ORIGIN}',NEWAPI_URL:'${NEWAPI_URL}',NEWAPI_ADMIN_USER_ID:'${NEWAPI_ADMIN_USER_ID}',NEWAPI_ADMIN_TOKEN_FILE:'/run/secrets/newapi_admin_token',NEWAPI_DB_CONFIG_FILE:'/run/secrets/newapi_database',ALLOW_HTTP_UPSTREAM:'${ALLOW_HTTP_UPSTREAM:-0}'},
    network_mode:network,volumes:['compensation_data:/app/data'],secrets:['newapi_admin_token','newapi_database'],
    ...(network!=='host'?{ports:[`127.0.0.1:${port}:${port}`]}:{}),
    read_only:true,tmpfs:['/tmp:size=16m,mode=1777'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],stop_grace_period:'45s',
    healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:${port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],interval:'30s',timeout:'5s',start_period:'10s',retries:3},
    logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}
  }},volumes:{compensation_data:{}},secrets:{newapi_admin_token:{file:'./secrets/newapi_admin_token'},newapi_database:{file:'./secrets/newapi_database.json'}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const input=JSON.parse(readFileSync(0,'utf8'));
    const output=process.argv[2]==='compose'?composePlan(input):process.argv[2]==='candidates'?candidates(input).map(c=>({name:c.Name.replace(/^\//,''),image:c.Config.Image})):process.argv[2]==='container'?deploymentPlan(input,{network:process.argv[3]||undefined,port:process.argv[4]||undefined}):deploymentPlan(input.container,input.options);
    if(output.services&&output.services.compensation.network_mode!=='host')output.services.compensation.environment.HOST='0.0.0.0';
    process.stdout.write(JSON.stringify(output,null,2)+'\n');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
