import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyLedger, validateLedger, normalizeComposePaths } from '../src/deployment-recovery.mjs';
import { composePlan } from '../src/deployment.mjs';

test('zero-byte and non-SQLite ledger files are rejected without creating a replacement database',()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-ledger-empty-'));
  try{
    const file=join(directory,'compensation.sqlite');
    for(const content of [Buffer.alloc(0),Buffer.alloc(100,32),Buffer.from('SQLite format 3\0')]){
      writeFileSync(file,content);
      assert.throws(()=>validateLedger(directory),/SQLite/);
      assert.deepEqual(readFileSync(file),content);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('ledger copy preserves uncheckpointed WAL rows and all encrypted notification data',()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-ledger-copy-'));
  try{
    const source=join(directory,'source'),crashed=join(directory,'crashed'),destination=join(directory,'destination');mkdirSync(source);mkdirSync(crashed);
    const dbFile=join(crashed,'compensation.sqlite');
    const created=spawnSync(process.execPath,['--input-type=module','-e',`import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE ledger(id TEXT);INSERT INTO ledger VALUES('wal-only')");process.kill(process.pid,'SIGKILL');`,dbFile],{encoding:'utf8'});
    assert.notEqual(created.status,0);
    assert.ok(existsSync(dbFile+'-wal'));
    cpSync(dbFile,join(source,'compensation.sqlite'));
    cpSync(dbFile+'-wal',join(source,'compensation.sqlite-wal'));
    writeFileSync(join(source,'secrets.key'),Buffer.alloc(32,4));
    writeFileSync(join(source,'dingtalk.enc'),'keep-encrypted');
    copyLedger(source,destination);
    const db=new DatabaseSync(join(destination,'compensation.sqlite'),{readOnly:true});
    assert.equal(db.prepare('SELECT id FROM ledger').get().id,'wal-only');db.close();
    assert.deepEqual(readFileSync(join(destination,'secrets.key')),Buffer.alloc(32,4));
    assert.equal(readFileSync(join(destination,'dingtalk.enc'),'utf8'),'keep-encrypted');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('encrypted SMTP settings reject a missing notification key',()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-ledger-key-'));
  try{
    const db=new DatabaseSync(join(directory,'compensation.sqlite'));
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('email_smtp','encrypted')");db.close();
    assert.throws(()=>validateLedger(directory),/secrets.key/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('empty SMTP metadata with disabled email does not require a nonexistent key',()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-ledger-empty-email-'));
  try{
    const db=new DatabaseSync(join(directory,'compensation.sqlite'));
    db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('email_smtp','');
      CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO settings VALUES(1,'{"emailNotifications":{"enabled":false}}')`);
    db.close();
    assert.doesNotThrow(()=>validateLedger(directory));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('ledger restore refuses a nonempty target without changing its existing files',()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-ledger-existing-'));
  try{
    const source=join(directory,'source'),destination=join(directory,'destination');mkdirSync(source);mkdirSync(destination);
    const db=new DatabaseSync(join(source,'compensation.sqlite'));db.exec('CREATE TABLE ledger(id TEXT)');db.close();
    writeFileSync(join(destination,'keep.txt'),'keep-existing');
    assert.throws(()=>copyLedger(source,destination,{restore:true}),/禁止覆盖/);
    assert.equal(readFileSync(join(destination,'keep.txt'),'utf8'),'keep-existing');
    assert.equal(existsSync(join(destination,'compensation.sqlite')),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('normalizing legacy cloud deployment keeps its ledger and migrates image/container names',()=>{
  const compose=composePlan({network:'host'});
  compose.services.compensation.image='newapi-compensation:local';
  delete compose.services.compensation.container_name;
  compose.volumes.compensation_data={};
  const {compose:next,changes}=normalizeComposePaths(compose,'/opt/yunxiang');
  assert.equal(next.services.compensation.image,'yunxiang-newapi-compensation:local');
  assert.equal(next.services.compensation.container_name,'yunxiang-compensation');
  assert.equal(next.volumes.compensation_data.name,'newapi-compensation_compensation_data');
  assert.ok(changes.includes('services.compensation.image'));
  assert.ok(changes.includes('services.compensation.container_name'));
  assert.ok(changes.includes('volumes.compensation_data.name'));
  assert.equal(compose.services.compensation.image,'newapi-compensation:local');
});

test('deployment normalization rejects another project, extra services, and unrelated ledger mounts',()=>{
  const mutations=[
    compose=>{compose.name='newapi';},
    compose=>{compose.services.newapi={image:'newapi:latest'};},
    compose=>{compose.services.compensation.volumes=['newapi_data:/app/data'];compose.volumes={newapi_data:{name:'newapi_data'}};},
    compose=>{compose.volumes.compensation_data.name='newapi_database';},
    compose=>{compose.volumes.compensation_data.external=true;},
    compose=>{compose.services.compensation.volumes=['/host/newapi:/app/data'];},
  ];
  for(const mutate of mutations){
    const compose=composePlan({network:'host'});mutate(compose);
    assert.throws(()=>normalizeComposePaths(compose,'/opt/yunxiang'),/云响|账本/);
  }
});
