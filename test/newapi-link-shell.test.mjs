import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deployFixture, bashAvailable } from './deploy-fixture.mjs';

const ok = result => assert.equal(result.status,0,result.stdout+result.stderr);
const text = result => result.stdout+result.stderr;
const api = (name='newapi-main', network='baota_net', database='app') => ({
  Id:name+'-id',Name:'/'+name,State:{Running:true},Path:'/one-api',
  Config:{Image:'private/cloud-gateway:latest',WorkingDir:'/data',Env:[`SQL_DSN=postgres://app:hidden-password@127.0.0.1:5432/${database}`,'PORT=3000'],
    Labels:{'com.docker.compose.project':'main-project','com.docker.compose.service':'new-api','com.docker.compose.project.working_dir':'/srv/newapi','com.docker.compose.project.config_files':'/srv/newapi/docker-compose.yml'}},
  HostConfig:{NetworkMode:network},NetworkSettings:{Networks:{[network]:{}},Ports:{}},
  Mounts:[{Type:'volume',Name:'newapi_data',Source:'/var/lib/docker/volumes/newapi_data/_data',Destination:'/data',RW:true}]
});
const fixtureContainers = (fixture, containers) => {
  const file=join(fixture.base,'inspect.json');writeFileSync(file,JSON.stringify(containers));return file;
};

test('refresh menu and aliases dispatch without reinstalling or deleting the ledger', {skip:!bashAvailable},()=>{
  const f=deployFixture();
  try {
    ok(f.run());const before=readFileSync(join(f.volume,'compensation.sqlite'));
    const result=f.run('install.sh',[],{}, {interactive:true,input:'5\n'});
    ok(result);assert.match(text(result),/重新获取|重新识别/);
    assert.deepEqual(readFileSync(join(f.volume,'compensation.sqlite')),before);
    assert.equal(existsSync(join(f.directory,'.yunxiang-link.rollback')),false);
    assert.equal(f.calls().some(call=>call[0]==='network'&&call[1]!=='inspect'),false);
  }finally{f.clean();}
});

test('refresh API failure preserves every saved file and leaves the running service alone', {skip:!bashAvailable},()=>{
  const f=deployFixture();
  try {
    ok(f.run());
    const files=['.env.auto','compose.generated.json','docker-compose.yml','secrets/newapi_database.json','secrets/newapi_admin_token'];
    const before=files.map(name=>readFileSync(join(f.directory,name)));f.clearCalls();
    const result=f.run('install.sh',['--refresh-newapi','--non-interactive'],{MOCK_LINK_API_FAIL:'1'});
    assert.notEqual(result.status,0,text(result));
    files.forEach((name,index)=>assert.deepEqual(readFileSync(join(f.directory,name)),before[index],name));
    assert.equal(f.calls().some(call=>call[0]==='compose'&&(call.includes('stop')||call.includes('up'))),false);
    assert.equal(existsSync(join(f.state,'stopped')),false);
  }finally{f.clean();}
});

test('refresh rejects another API origin without proven original database identity', {skip:!bashAvailable},()=>{
  const f=deployFixture();
  try {
    ok(f.run());const before=readFileSync(join(f.directory,'.env.auto'));f.clearCalls();
    const file=fixtureContainers(f,[api('another-api','fresh')]);
    const result=f.run('install.sh',['--refresh-newapi','--non-interactive'],{NEWAPI_URL:'',MOCK_NEWAPI_INSPECT_FILE:file,NEWAPI_CONTAINER:'another-api'});
    assert.notEqual(result.status,0,text(result));assert.match(text(result),/无法证明|绑定/);
    assert.deepEqual(readFileSync(join(f.directory,'.env.auto')),before);
    assert.equal(f.calls().some(call=>call.includes('stop')||call.includes('up')),false);
  }finally{f.clean();}
});

test('noninteractive discovery never chooses the first of multiple renamed NewAPI projects', {skip:!bashAvailable},()=>{
  const f=deployFixture();
  try {
    const file=fixtureContainers(f,[api('first'),api('second')]);
    const result=f.run('install.sh',['--install','--non-interactive'],{NEWAPI_URL:'',MOCK_NEWAPI_INSPECT_FILE:file});
    assert.notEqual(result.status,0,text(result));assert.match(text(result),/多个 NewAPI|NEWAPI_CONTAINER/);
    assert.equal(existsSync(f.volume),false);
    assert.equal(f.calls().some(call=>call.includes('up')),false);
  }finally{f.clean();}
});

test('post-publish check failure rolls back saved configuration and retains the ledger', {skip:!bashAvailable},()=>{
  const f=deployFixture();
  try {
    ok(f.run());
    const before=readFileSync(join(f.directory,'.env.auto'));
    const ledger=join(f.volume,'compensation.sqlite');const db=new DatabaseSync(ledger);
    db.exec('CREATE TABLE sentinel(value TEXT)');db.prepare('INSERT INTO sentinel VALUES (?)').run('do-not-erase');db.close();
    const result=f.run('install.sh',['--reconnect','--non-interactive'],{MOCK_LINK_POSTCHECK_FAIL:'1'});
    assert.notEqual(result.status,0,text(result));assert.match(text(result),/已恢复重新获取前/);
    assert.deepEqual(readFileSync(join(f.directory,'.env.auto')),before);
    const saved=new DatabaseSync(ledger,{readOnly:true});try{assert.equal(saved.prepare('SELECT value FROM sentinel').get().value,'do-not-erase');}finally{saved.close();}
    assert.equal(existsSync(join(f.directory,'.yunxiang-link.rollback')),false);
    assert.equal(existsSync(join(f.state,'stopped')),false);
  }finally{f.clean();}
});
