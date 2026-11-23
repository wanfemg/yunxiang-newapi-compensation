import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const bash=process.env.BASH_PATH||(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash');
const available=spawnSync(bash,['--version'],{encoding:'utf8'}).status===0;
const root=resolve(import.meta.dirname,'..');
const harness=join(import.meta.dirname,'deploy-harness.sh').replaceAll('\\','/');
const toMsys=path=>path.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>`/${drive.toLowerCase()}`);
const remotePackage=(dir)=>{
  const source=join(dir,'remote-source');
  mkdirSync(source,{recursive:true});
  for(const file of ['src','public','test','Dockerfile','.dockerignore','.gitattributes','package.json','package-lock.json','auto-deploy.sh','install.sh','status.sh','migrate.sh','README.md'])cpSync(join(root,file),join(source,file),{recursive:true});
  const archive=join(dir,'yunxiang-source.tar.gz');
  const tar=spawnSync(bash,['-lc','tar -czf "$1" -C "$2" remote-source','--',toMsys(archive),toMsys(dir)],{cwd:dir,encoding:'utf8'});
  assert.equal(tar.status,0,tar.stdout+tar.stderr);
  const answer=join(dir,'one-click-answer');
  writeFileSync(answer,'2\n');
  const installer=join(dir,'installer');
  mkdirSync(installer,{recursive:true});
  cpSync(join(root,'install.sh'),join(installer,'install.sh'));
  cpSync(join(root,'test','deploy-harness.sh'),join(installer,'deploy-harness.sh'));
  return {archive,answer,installer};
};
const setup=()=>{
  const dir=mkdtempSync(join(tmpdir(),'yunxiang-deploy-'));
  for(const file of ['auto-deploy.sh','install.sh','src'])cpSync(join(root,file),join(dir,file),{recursive:true});
  return dir;
};
const run=(dir,extra={})=>spawnSync(bash,[harness],{cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,NODE_EXE:process.execPath.replaceAll('\\','/'),NEWAPI_URL:'https://newapi.example.com',NEWAPI_ADMIN_USER_ID:'1',NEWAPI_ADMIN_TOKEN:'fixture-deploy-token',PUBLIC_ORIGIN:'https://refund.example.com',COMPENSATION_PORT:'3210',...extra}});
const runMode=(dir,mode,extra={})=>spawnSync(bash,[harness,mode],{cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,NODE_EXE:process.execPath.replaceAll('\\','/'),NEWAPI_URL:'https://newapi.example.com',NEWAPI_ADMIN_USER_ID:'1',NEWAPI_ADMIN_TOKEN:'fixture-deploy-token',PUBLIC_ORIGIN:'https://refund.example.com',COMPENSATION_PORT:'3210',...extra}});

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
test('deployment entry supports explicit update migrate and reinstall modes',{skip:!available},()=>{
  const dir=setup();
  try{
    assert.equal(run(dir).status,0);
    const env=readFileSync(join(dir,'.env.auto'),'utf8');
    const update=runMode(dir,'--migrate');
    assert.equal(update.status,0,update.stdout+update.stderr);
    assert.match(update.stdout,/部署模式：migrate/);
    assert.equal(readFileSync(join(dir,'.env.auto'),'utf8'),env);
    const reinstall=runMode(dir,'--reinstall');
    assert.equal(reinstall.status,0,reinstall.stdout+reinstall.stderr);
    assert.match(reinstall.stdout,/部署模式：reinstall/);
    assert.match(reinstall.stdout,/已清理旧云响容器/);
    assert.equal(readFileSync(join(dir,'.env.auto'),'utf8'),env);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one-click installer prompts before downloading an existing deployment',{skip:!available},()=>{
  const dir=setup();
  try{
    assert.equal(run(dir).status,0);
    const {archive,answer,installer}=remotePackage(dir);
    const remote=spawnSync(bash,[harness],{
      cwd:dir,
      encoding:'utf8',
      timeout:30000,
      input:'2\n',
      env:{...process.env,ARCHIVE:toMsys(archive),YUNXIANG_INSTALLER:toMsys(join(installer,'install.sh')),YUNXIANG_ANSWER:toMsys(answer),NODE_EXE:process.execPath.replaceAll('\\','/'),YUNXIANG_INSTALL_DIR:dir,NEWAPI_URL:'https://newapi.example.com',NEWAPI_ADMIN_USER_ID:'1',NEWAPI_ADMIN_TOKEN:'fixture-deploy-token',PUBLIC_ORIGIN:'https://refund.example.com',COMPENSATION_PORT:'3210'}
    });
    assert.equal(remote.status,0,remote.stdout+remote.stderr);
    assert.match(remote.stdout,/部署模式：migrate/);
    assert.ok(remote.stdout.indexOf('选择操作 [1-3，默认 1]: 2')<remote.stdout.indexOf('下载云响：'));
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
