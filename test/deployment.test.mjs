import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, deploymentPlan, composePlan } from '../src/deployment.mjs';

const container=(overrides={})=>({Name:'/new-api',State:{Running:true},Config:{Image:'calciumion/new-api:latest',Env:['PORT=3000'],Labels:{}},HostConfig:{NetworkMode:'custom'},NetworkSettings:{Networks:{newapi_default:{}},Ports:{}},...overrides});

test('deployment discovery only selects running NewAPI/OneAPI containers',()=>{
  assert.equal(candidates([container(),container({State:{Running:false}}),container({Name:'/redis',Config:{Image:'redis:7'}})]).length,1);
});
test('deployment detects Compose bridge and honors explicit network and port',()=>{
  const c=container({Config:{Env:['PORT=3001'],Labels:{'com.docker.compose.project':'newapi'}},NetworkSettings:{Networks:{private_net:{},newapi_default:{}}}});
  const p=deploymentPlan(c,{network:'newapi_default',port:3002});
  assert.equal(p.mode,'docker-compose');assert.equal(p.network,'newapi_default');assert.equal(p.url,'http://new-api:3002');
  assert.throws(()=>deploymentPlan(c,{network:'not-attached'}));
});
test('deployment detects host and remote API modes',()=>{
  assert.equal(deploymentPlan(container({HostConfig:{NetworkMode:'host'}})).url,'http://127.0.0.1:3000');
  const p=deploymentPlan(null,{url:'https://api.example.com'});
  assert.equal(p.network,'host');assert.equal(p.url,'https://api.example.com');assert.equal(p.database.connected,false);
});
test('default bridge uses published loopback port without altering original network',()=>{
  const c=container({NetworkSettings:{Networks:{bridge:{}},Ports:{'3000/tcp':[{HostIp:'0.0.0.0',HostPort:'3100'}]}}});
  assert.deepEqual({...deploymentPlan(c),database:null},{mode:'docker-published',network:'host',url:'http://127.0.0.1:3100',database:null});
  c.NetworkSettings.Ports['3000/tcp']=[{HostIp:'192.0.2.1',HostPort:'3100'}];
  assert.throws(()=>deploymentPlan(c));
});
test('deployment metadata never persists NewAPI database credentials',()=>{
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
