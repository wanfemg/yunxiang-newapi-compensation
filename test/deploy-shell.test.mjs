import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const bash=process.env.BASH_PATH||(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash');
const available=spawnSync(bash,['--version'],{encoding:'utf8'}).status===0;
const root=resolve(import.meta.dirname,'..');
const harness=join(import.meta.dirname,'deploy-harness.sh').replaceAll('\\','/');
const setup=()=>{
  const dir=mkdtempSync(join(tmpdir(),'yunxiang-deploy-'));
  for(const file of ['auto-deploy.sh','install.sh','src'])cpSync(join(root,file),join(dir,file),{recursive:true});
  return dir;
};
const run=(dir,extra={})=>spawnSync(bash,[harness],{cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,NODE_EXE:process.execPath.replaceAll('\\','/'),NEWAPI_URL:'https://newapi.example.com',NEWAPI_ADMIN_USER_ID:'1',NEWAPI_ADMIN_TOKEN:'fixture-deploy-token',PUBLIC_ORIGIN:'https://refund.example.com',COMPENSATION_PORT:'3210',...extra}});

test('one-click shell writes first-run config and reuses it on updates',{skip:!available},()=>{
  const dir=setup();
  try{
    const first=run(dir);assert.equal(first.status,0,first.stdout+first.stderr);
    const env=readFileSync(join(dir,'.env.auto'),'utf8');
    assert.match(env,/NEWAPI_URL=https:\/\/newapi.example.com/);assert.doesNotMatch(first.stdout+first.stderr,/fixture-deploy-token/);
    assert.equal(readFileSync(join(dir,'secrets/newapi_admin_token'),'utf8'),'fixture-deploy-token');
    const next=run(dir,{NEWAPI_URL:'https://wrong.example.com',NEWAPI_ADMIN_USER_ID:'2'});
    assert.equal(next.status,0,next.stdout+next.stderr);
    assert.equal(readFileSync(join(dir,'.env.auto'),'utf8'),env);
    const compose=JSON.parse(readFileSync(join(dir,'compose.generated.json'),'utf8'));
    assert.deepEqual(compose.services.compensation.volumes,['compensation_data:/app/data']);
    assert.equal(compose.services.compensation.image,'yunxiang-newapi-compensation:local');
    assert.equal(compose.services.compensation.container_name,'yunxiang-compensation');
    assert.equal(compose.volumes.compensation_data.name,'newapi-compensation_compensation_data');
    const exported=JSON.parse(readFileSync(join(dir,'docker-compose.yml'),'utf8'));
    assert.equal(exported.services.compensation.build.context,dir);
    assert.match(exported.secrets.newapi_admin_token.file,/newapi_admin_token$/);
    assert.match(next.stdout,/docker-compose.yml/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('legacy generated deployment migrates names without changing upstream or data volume',{skip:!available},()=>{
  const dir=setup();
  try{
    assert.equal(run(dir).status,0);
    const env=readFileSync(join(dir,'.env.auto'),'utf8');
    const file=join(dir,'compose.generated.json'),old=JSON.parse(readFileSync(file,'utf8'));
    old.services.compensation.image='newapi-compensation:local';delete old.services.compensation.container_name;old.volumes.compensation_data={};
    writeFileSync(file,JSON.stringify(old));
    const result=run(dir);assert.equal(result.status,0,result.stdout+result.stderr);
    const migrated=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(migrated.services.compensation.image,'yunxiang-newapi-compensation:local');
    assert.equal(migrated.volumes.compensation_data.name,'newapi-compensation_compensation_data');
    assert.equal(readFileSync(join(dir,'.env.auto'),'utf8'),env);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one-click build failure does not report success or remove saved configuration',{skip:!available},()=>{
  const dir=setup();
  try{
    const result=run(dir,{MOCK_BUILD_FAIL:'1'});
    assert.equal(result.status,42,result.stdout+result.stderr);
    assert.doesNotMatch(result.stdout,/云响已启动/);assert.ok(existsSync(join(dir,'.env.auto')));
    assert.ok(existsSync(join(dir,'secrets/newapi_admin_token')));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
