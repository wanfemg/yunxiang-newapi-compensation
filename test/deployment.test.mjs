import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, deploymentPlan, composePlan } from '../src/deployment.mjs';
import * as deployment from '../src/deployment.mjs';

const container=(overrides={})=>({Name:'/new-api',State:{Running:true},Config:{Image:'calciumion/new-api:latest',Env:['PORT=3000'],Labels:{}},HostConfig:{NetworkMode:'custom'},NetworkSettings:{Networks:{newapi_default:{}},Ports:{}},...overrides});

test('deployment discovery only selects running 云中猫API小站/OneAPI containers',()=>{
  assert.equal(candidates([container(),container({State:{Running:false}}),container({Name:'/redis',Config:{Image:'redis:7'}})]).length,1);
  for (const image of ['yunxiang-newapi-compensation:local', 'newapi-compensation:local']) {
    assert.equal(candidates([container({Name:'/yunxiang-compensation',Config:{Image:image}})]).length,0);
  }
});
test('deployment detects Compose bridge and honors explicit network and port',()=>{
  const c=container({Config:{Env:['PORT=3001'],Labels:{'com.docker.compose.project':'newapi'}},NetworkSettings:{Networks:{private_net:{},newapi_default:{}}}});
  const p=deploymentPlan(c,{network:'newapi_default',port:3002});
  assert.equal(p.mode,'docker-compose');assert.equal(p.network,'newapi_default');assert.equal(p.url,'http://new-api:3002');
  assert.throws(()=>deploymentPlan(c,{network:'not-attached'}));
  assert.throws(()=>deploymentPlan(c),/多个网络/);
});
test('deployment detects host and remote API modes',()=>{
  assert.equal(deploymentPlan(container({HostConfig:{NetworkMode:'host'}})).url,'http://127.0.0.1:3000');
  const p=deploymentPlan(null,{url:'https://api.example.com'});
  assert.equal(p.network,'host');assert.equal(p.url,'https://api.example.com');assert.equal(p.database.connected,false);
});
test('default bridge uses published loopback port without altering original network',()=>{
  const c=container({NetworkSettings:{Networks:{bridge:{}},Ports:{'3000/tcp':[{HostIp:'0.0.0.0',HostPort:'3100'}]}}});
  const p=deploymentPlan(c);
  assert.equal(p.mode,'docker-published');assert.equal(p.network,'host');assert.equal(p.url,'http://127.0.0.1:3100');
  assert.equal(p.project.container,'new-api');
  c.NetworkSettings.Ports['3000/tcp']=[{HostIp:'192.0.2.1',HostPort:'3100'}];
  assert.throws(()=>deploymentPlan(c));
});
test('deployment metadata never persists 云中猫API小站 database credentials',()=>{
  const c=container({Config:{Env:['SQL_DSN=user:very-secret@tcp(mysql:3306)/newapi','SESSION_SECRET=another-secret']}});
  const p=deploymentPlan(c);assert.equal(p.database.main.type,'mysql');assert.doesNotMatch(JSON.stringify(p),/very-secret|another-secret/);
});
test('generated Compose preserves stable ledger volume, hardening and health port',()=>{
  for(const network of ['host','newapi_default']){
    const p=composePlan({network,port:3221}),s=p.services.compensation;
    assert.equal(p.name,'newapi-compensation');assert.deepEqual(s.volumes,['compensation_data:/app/data']);
    assert.equal(s.image,'yunxiang-newapi-compensation:local');assert.equal(s.container_name,'yunxiang-compensation');
    assert.equal(p.volumes.compensation_data.name,'newapi-compensation_compensation_data');
    assert.equal(s.environment.PORT,'3221');assert.match(s.healthcheck.test[3],/3221\/api\/health/);
    assert.equal(s.read_only,true);assert.deepEqual(s.cap_drop,['ALL']);
    if(network==='host'){assert.equal(s.environment.HOST,'127.0.0.1');assert.equal(s.ports,undefined);}
    else assert.deepEqual(s.ports,['127.0.0.1:3221:3221']);
  }
});
test('deployment rejects malformed ports and network names',()=>{
  for(const port of [0,65536,1.5,NaN]){assert.throws(()=>composePlan({port}));assert.throws(()=>deploymentPlan(container(),{port}));}
  for(const network of ['none','bridge','bad\nnetwork','x;id'])assert.throws(()=>composePlan({network}));
});

test('discovery recognizes renamed NewAPI containers by Compose service and executable',()=>{
  for (const service of ['new-api', 'newapi', 'new_api', 'one-api', 'oneapi']) {
    const c=container({Name:'/my-custom-app',Config:{Image:'registry.example/app:latest',Labels:{'com.docker.compose.service':service}}});
    assert.deepEqual(candidates([c]),[c],service);
  }
  for(const executable of ['/usr/local/bin/new-api','/app/one-api']) {
    const c=container({Name:'/my-custom-app',Path:executable,Config:{Image:'registry.example/app:latest'}});
    assert.deepEqual(candidates([c]),[c]);
  }
  const shell=container({Name:'/my-custom-app',Path:'/bin/sh',Args:['-c','exec /app/new-api --port 3000'],Config:{Image:'registry.example/app:latest'}});
  assert.deepEqual(candidates([shell]),[shell]);
  const mirrored=container({Name:'/custom-app',Config:{Image:'proxy.registry.example/new-api:latest'}});
  assert.deepEqual(candidates([mirrored]),[mirrored]);
  const projectNamedWorker=container({Name:'/worker-new-api-1',Config:{Image:'custom/app:latest',Labels:{'com.docker.compose.service':'new-api'}}});
  assert.deepEqual(candidates([projectNamedWorker]),[projectNamedWorker]);
});

test('discovery excludes ancillary services even when their image contains NewAPI',()=>{
  for(const suffix of ['tools','compensation','model-status','proxy','worker','postgres','mysql','redis','backup']) {
    const c=container({Name:`/new-api-${suffix}`,Config:{Image:'custom/new-api:latest',Labels:{'com.docker.compose.service':suffix}}});
    assert.deepEqual(candidates([c]),[],suffix);
  }
  assert.deepEqual(candidates([container({Name:'/custom-app',State:{Running:false},Config:{Image:'custom/app',Labels:{'com.docker.compose.service':'new-api'}}})]),[]);
  const urlArgument=container({Name:'/custom-app',Path:'/bin/runner',Args:['--upstream','http://new-api:3000'],Config:{Image:'custom/app'}});
  assert.deepEqual(candidates([urlArgument]),[]);
});

test('project metadata exposes only known project and mount fields without credentials',()=>{
  assert.equal(typeof deployment.projectMetadata,'function');
  const c=container({Id:'ab'.repeat(32),Config:{Image:'custom/app:v2',Env:['SQL_DSN=top-secret','SESSION_SECRET=hidden'],Labels:{'com.docker.compose.project':'production','com.docker.compose.service':'new-api','com.docker.compose.project.working_dir':'/opt/newapi','com.docker.compose.project.config_files':'/opt/newapi/compose.yml, /opt/newapi/override.yml','custom.secret':'do-not-copy'}},Mounts:[{Type:'bind',Source:'/opt/newapi/data',Destination:'/data',RW:false},{Type:'volume',Name:'newapi_data',Source:'/var/lib/docker/volumes/newapi_data/_data',Destination:'/app/data',RW:true}]});
  const p=deployment.projectMetadata(c);
  assert.deepEqual(p,{container:'new-api',id:'ab'.repeat(32),image:'custom/app:v2',containerWorkingDirectory:'',executable:'',project:'production',service:'new-api',workingDirectory:'/opt/newapi',composeFiles:['/opt/newapi/compose.yml','/opt/newapi/override.yml'],mounts:[{type:'bind',name:null,source:'/opt/newapi/data',destination:'/data',readOnly:true},{type:'volume',name:'newapi_data',source:'/var/lib/docker/volumes/newapi_data/_data',destination:'/app/data',readOnly:false}]});
  assert.doesNotMatch(JSON.stringify(p),/top-secret|hidden|do-not-copy|SQL_DSN|SESSION_SECRET/);
});

test('project metadata includes executable and container working directory without command secrets',()=>{
  const c=container({Path:'/bin/sh',Args:['-c','exec /app/new-api --db-password=command-secret'],Config:{Image:'custom/app',WorkingDir:'/app',Entrypoint:['/entrypoint','entrypoint-secret']}});
  const metadata=deployment.projectMetadata(c);
  assert.equal(metadata.containerWorkingDirectory,'/app');assert.equal(metadata.executable,'/bin/sh');
  assert.doesNotMatch(JSON.stringify(metadata),/command-secret|entrypoint-secret|db-password|exec \/app/);
  delete c.Path;
  assert.equal(deployment.projectMetadata(c).executable,'/entrypoint');
  c.Path='/bin/sh -c command-secret';
  assert.equal(deployment.projectMetadata(c).executable,'');
});

test('candidate selection requires unique explicit identity and returns ambiguous choices',()=>{
  assert.equal(typeof deployment.selectCandidate,'function');
  const first=container({Id:'abcdef01'.repeat(8)}),second=container({Id:'abcdef02'.repeat(8),Name:'/second-new-api'}),other=container({Id:'fedcba'.repeat(10),Name:'/new-api-worker'});
  assert.equal(deployment.selectCandidate([first]).selected,first);
  assert.equal(deployment.selectCandidate([first,second],{container:'second-new-api'}).selected,second);
  assert.equal(deployment.selectCandidate([first,second],{container:'abcdef02'}).selected,second);
  assert.throws(()=>deployment.selectCandidate([first,second],{container:'abcdef0'}),/多个|不唯一/);
  assert.throws(()=>deployment.selectCandidate([first,other],{container:'new-api-worker'}),/NewAPI/);
  assert.throws(()=>deployment.selectCandidate([first],{container:'missing'}),/NewAPI/);
  const result=deployment.selectCandidate([first,second],{previous:{container:'new-api',id:first.Id}});
  assert.equal(result.selected,null);assert.equal(result.previous,first);assert.deepEqual(result.choices,[first,second]);
  assert.deepEqual(deployment.selectCandidate([]),{selected:null,choices:[],previous:null});
});

test('deployment plan includes project and sanitized main and log database locations',()=>{
  const c=container({Id:'newapi-id',Config:{Image:'custom/app:latest',WorkingDir:'/app',Env:['SQL_DSN=host=postgres port=5433 user=app password=private-password dbname=api sslmode=require','LOG_SQL_DSN=logs:private-log-password@tcp(mysql:3307)/logs'],Labels:{'com.docker.compose.project':'production','com.docker.compose.service':'new-api','com.docker.compose.project.working_dir':'/opt/newapi'}}});
  const p=deploymentPlan(c);
  assert.equal(p.project.workingDirectory,'/opt/newapi');
  assert.equal(p.database.main.type,'postgresql');assert.equal(p.database.main.endpoint.host,'postgres');assert.equal(p.database.main.endpoint.port,5433);
  assert.equal(p.database.logs.type,'mysql');assert.equal(p.database.logs.endpoint.database,'logs');
  assert.doesNotMatch(JSON.stringify(p),/private-password|private-log-password|password=/);
});

test('unknown database DSNs produce visible sanitized metadata warnings',()=>{
  const c=container({Config:{Env:['SQL_DSN=broken://user:private-password@host/database']}});
  const p=deploymentPlan(c);
  assert.equal(p.database.main.type,'unknown');assert.equal(p.database.main.location,'unresolved');
  assert.ok(p.database.main.reason);
  assert.doesNotMatch(JSON.stringify(p),/private-password|broken:\/\//);
});

test('explicit upstream network must already belong to the selected container',()=>{
  assert.throws(()=>deploymentPlan(container({HostConfig:{NetworkMode:'host'},NetworkSettings:{Networks:{host:{}}}}),{network:'foreign'}),/网络/);
  assert.throws(()=>deploymentPlan(container(),{network:'host'}),/网络/);
});
