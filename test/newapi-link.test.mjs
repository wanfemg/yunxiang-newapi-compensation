import test from 'node:test';
import assert from 'node:assert/strict';
import { associationDecision, refreshedConfiguration, sqliteFiles, configFileRequests, verifyLedgerOrigin } from '../src/newapi-link.mjs';
import { composePlan } from '../src/deployment.mjs';
import { basename, resolve, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const database = (name = 'app') => ({version:1,engineId:'fixture-engine-id',container:'api',main:{type:'postgresql',endpoint:{host:'postgres',port:5432,database:name},databaseContainer:{id:'stable-db-id'}},logs:{type:'postgresql',sameAs:'main'}});
test('rediscovery preserves ledger identity and rejects a different database at the same URL', () => {
  assert.equal(associationDecision(database(),database(),'http://api:3000','http://api:3000').rebind,false);
  assert.throws(()=>associationDecision(database(),database('different'),'http://api:3000','http://api:3000'),/数据库|实例/);
});
test('only a proven persistent database permits a renamed API origin', () => {
  assert.equal(associationDecision(database(),{...database(),container:'renamed'},'http://api:3000','http://renamed:3000').rebind,true);
  assert.throws(()=>associationDecision({version:1,container:'api',main:{type:'postgresql'},logs:{type:'postgresql'}},database(),'http://api:3000','http://renamed:3000'),/无法证明|绑定/);
});
test('relink changes upstream and network while preserving port, public origin, token file, ledger and hardening', () => {
  const compose=composePlan({network:'old',port:3244});
  const env='PUBLIC_ORIGIN=https://refund.example.com\nNEWAPI_URL=http://api:3000\nNEWAPI_ADMIN_USER_ID=1\nALLOW_HTTP_UPSTREAM=1\n';
  const result=refreshedConfiguration({compose,env,previous:database(),plan:{url:'http://api:3000',network:'fresh',database:database()},projectDirectory:process.cwd()});
  assert.equal(result.compose.services.compensation.network_mode,'fresh');
  assert.equal(result.compose.services.compensation.environment.PORT,'3244');
  assert.deepEqual(result.compose.services.compensation.volumes,compose.services.compensation.volumes);
  assert.deepEqual(result.compose.services.compensation.cap_drop,['ALL']);
  assert.equal(result.database.engineId,'fixture-engine-id');
  assert.match(result.env,/PUBLIC_ORIGIN=https:\/\/refund.example.com/);
  assert.deepEqual(compose.services.compensation.network_mode,'old');
});
test('refresh resolves absolute build and secret paths against the host project instead of the helper cwd', () => {
  const compose=composePlan({network:'old',port:3210});
  const host=resolve('host-install'), old=resolve('previous-server');
  compose.services.compensation.build.context=old;
  for (const secret of Object.values(compose.secrets)) secret.file=join(old,'secrets',basename(secret.file));
  const input={compose,env:'PUBLIC_ORIGIN=https://refund.example.com\nNEWAPI_URL=http://api:3000\nNEWAPI_ADMIN_USER_ID=1\nALLOW_HTTP_UPSTREAM=1\n',previous:database(),plan:{url:'http://api:3000',network:'fresh',database:database()},projectDirectory:host};
  const result=refreshedConfiguration(input);
  assert.equal(result.compose.services.compensation.build.context,host);
  for (const secret of Object.values(result.compose.secrets)) assert.equal(secret.file,join(host,'secrets',basename(secret.file)));
  assert.equal(compose.services.compensation.build.context,old);
  assert.throws(()=>refreshedConfiguration({...input,projectDirectory:undefined}),/宿主/);
});
test('ledger binding verification reads a WAL snapshot without creating SHM or modifying original files', async () => {
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-link-wal-test-'));
  let writer;
  try {
    writer=new DatabaseSync(join(directory,'compensation.sqlite'));
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES ('newapi_origin','http://old-api:3000')");
    const source=join(directory,'readonly');mkdirSync(source);
    for(const suffix of ['', '-wal']) copyFileSync(join(directory,'compensation.sqlite'+suffix),join(source,'compensation.sqlite'+suffix));
    const before=['','-wal'].map(suffix=>readFileSync(join(source,'compensation.sqlite'+suffix)));
    await verifyLedgerOrigin(source,'http://old-api:3000','http://renamed-api:3000');
    await assert.rejects(verifyLedgerOrigin(source,'http://another-api:3000','http://renamed-api:3000'),/账本绑定/);
    for(const [index,suffix] of ['', '-wal'].entries()) assert.deepEqual(readFileSync(join(source,'compensation.sqlite'+suffix)),before[index]);
    assert.equal(existsSync(join(source,'compensation.sqlite-shm')),false);
    await verifyLedgerOrigin(source,'http://old-api:3000','http://renamed-api:3000',true);
    const check=new DatabaseSync(join(source,'compensation.sqlite'));
    try{assert.equal(check.prepare("SELECT value FROM metadata WHERE key='newapi_origin'").get().value,'http://renamed-api:3000');}finally{check.close();}
  } finally { writer?.close();rmSync(directory,{recursive:true,force:true}); }
});
test('file-backed database credentials request only explicit absolute paths',()=>{
  const c={Config:{Env:['SQL_DSN_FILE=/run/secrets/main','LOG_SQL_DSN_FILE=/run/secrets/logs','SESSION_SECRET=never-read']}};
  assert.deepEqual(configFileRequests(c).map(x=>x.path),['/run/secrets/main','/run/secrets/logs']);
  assert.throws(()=>configFileRequests({Config:{Env:['SQL_DSN_FILE=../../etc/passwd']}}),/路径/);
  assert.deepEqual(configFileRequests({Config:{Env:['SQL_DSN=postgres://db/app','SQL_DSN_FILE=/unused','DATABASE_URL_FILE=/also-unused']}}),[]);
  assert.deepEqual(configFileRequests({Config:{Env:['SQL_DSN_FILE=/active','DATABASE_URL_FILE=/unused','LOG_SQL_DSN_FILE=/logs']}}).map(x=>x.path),['/active','/logs']);
});
test('SQLite probes include separate log files and never require changing original files',()=>{
  const files=sqliteFiles({main:{type:'sqlite',containerPath:'/data/main.db'},logs:{type:'sqlite',containerPath:'/logs/log.db'}});
  assert.deepEqual(files,['/data/main.db','/logs/log.db']);
  assert.deepEqual(sqliteFiles({main:{type:'sqlite',containerPath:'/data/main.db'},logs:{type:'sqlite',sameAs:'main'}}),['/data/main.db']);
});
