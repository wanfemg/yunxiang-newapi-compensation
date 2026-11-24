import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { composePlan } from '../src/deployment.mjs';
import { gzipSync } from 'node:zlib';

const root=resolve(import.meta.dirname,'..');
const bash=process.env.BASH_PATH||(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash');
const available=spawnSync(bash,['--version'],{encoding:'utf8'}).status===0;
const toBash=value=>value.replaceAll('\\','/').replace(/^([a-z]):/i,(_,letter)=>'/'+letter.toLowerCase());
const setup=()=>{
  const directory=mkdtempSync(join(tmpdir(),'yunxiang-migrate-'));
  for(const item of ['migrate.sh','src'])cpSync(join(root,item),join(directory,item),{recursive:true});
  if(existsSync(join(root,'deploy-runtime.sh')))cpSync(join(root,'deploy-runtime.sh'),join(directory,'deploy-runtime.sh'));
  return directory;
};
const seed=directory=>{
  mkdirSync(join(directory,'secrets'),{recursive:true});
  mkdirSync(join(directory,'volume'),{recursive:true});
  writeFileSync(join(directory,'.env.auto'),'PUBLIC_ORIGIN=https://refund.example.com\nNEWAPI_URL=https://newapi.example.com\nNEWAPI_ADMIN_USER_ID=1\nALLOW_HTTP_UPSTREAM=0\n');
  writeFileSync(join(directory,'compose.generated.json'),JSON.stringify(composePlan({network:'host'})));
  writeFileSync(join(directory,'secrets','newapi_admin_token'),'fixture-secret');
  writeFileSync(join(directory,'secrets','newapi_database.json'),'{"version":1,"connected":false}');
  const db=new DatabaseSync(join(directory,'volume','compensation.sqlite'));
  db.exec("CREATE TABLE ledger(id TEXT PRIMARY KEY);INSERT INTO ledger VALUES('must-preserve')");
  db.close();
  writeFileSync(join(directory,'volume','secrets.key'),Buffer.alloc(32,7));
  writeFileSync(join(directory,'volume','dingtalk.enc'),'fixture-encrypted-notification');
  writeFileSync(join(directory,'docker-state.json'),JSON.stringify({volume:true,running:true}));
};
const run=(directory,args,extra={})=>spawnSync(bash,[toBash(join(import.meta.dirname,'migration-harness.sh')),...args],{
  cwd:directory,encoding:'utf8',timeout:20000,
  env:{...process.env,BASH_PATH:bash,NODE_EXE:process.execPath,MIGRATION_DOCKER:join(import.meta.dirname,'migration-docker.mjs'),MIGRATION_FIXTURE:directory,MIGRATION_SCRIPT:toBash(join(directory,'migrate.sh')),...extra}
});
const calls=directory=>readFileSync(join(directory,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const unsafeArchive=(name,type='0')=>{
  const header=Buffer.alloc(512);
  header.write(name,0,100,'utf8');header.write('0000777\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write('00000000000\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write(type,156);
  if(type==='2')header.write('/etc',157);
  header.write('ustar\0',257);
  const sum=header.reduce((total,value)=>total+value,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([header,Buffer.alloc(1024)]));
};

test('migration export packages a checked ledger and encrypted keys, restoring service', {skip:!available},()=>{
  const directory=setup();
  try{
    seed(directory);
    const archive=join(directory,'migration.tar.gz');
    const result=run(directory,['export',toBash(archive)]);
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.ok(existsSync(archive));
    const exported=join(directory,'exported');mkdirSync(exported);
    const unpack=spawnSync(bash,['-lc','tar -xzf "$1" -C "$2"','--',toBash(archive),toBash(exported)],{encoding:'utf8'});
    assert.equal(unpack.status,0,unpack.stdout+unpack.stderr);
    const db=new DatabaseSync(join(exported,'volume','compensation.sqlite'),{readOnly:true});
    assert.equal(db.prepare('SELECT id FROM ledger').get().id,'must-preserve');db.close();
    assert.equal(readFileSync(join(exported,'secrets','newapi_admin_token'),'utf8'),'fixture-secret');
    assert.deepEqual(readFileSync(join(exported,'volume','secrets.key')),Buffer.alloc(32,7));
    assert.equal(readFileSync(join(exported,'volume','dingtalk.enc'),'utf8'),'fixture-encrypted-notification');
    assert.equal(JSON.parse(readFileSync(join(directory,'docker-state.json'),'utf8')).running,true);
    assert.ok(calls(directory).some(args=>args[0]==='stop'));
    assert.ok(calls(directory).some(args=>args[0]==='start'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('migration helper failure restarts the previously running service and leaves no archive',{skip:!available},()=>{
  const directory=setup();
  try{
    seed(directory);
    const archive=join(directory,'failed.tar.gz');
    const result=run(directory,['export',toBash(archive)],{MIGRATION_HELPER_FAIL:'1'});
    assert.notEqual(result.status,0);
    assert.equal(existsSync(archive),false);
    assert.equal(JSON.parse(readFileSync(join(directory,'docker-state.json'),'utf8')).running,true);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('migration roundtrip restores ledger and keys and refuses a second import',{skip:!available},()=>{
  const source=setup(),destination=setup();
  try{
    seed(source);
    const archive=join(source,'migration.tar.gz');
    const exported=run(source,['export',toBash(archive)]);
    assert.equal(exported.status,0,exported.stdout+exported.stderr);
    writeFileSync(join(destination,'docker-state.json'),JSON.stringify({volume:false,running:false,container:false}));
    const imported=run(destination,['import',toBash(archive)]);
    assert.equal(imported.status,0,imported.stdout+imported.stderr);
    const db=new DatabaseSync(join(destination,'volume','compensation.sqlite'),{readOnly:true});
    assert.equal(db.prepare('SELECT id FROM ledger').get().id,'must-preserve');db.close();
    assert.deepEqual(readFileSync(join(destination,'volume','secrets.key')),Buffer.alloc(32,7));
    assert.equal(readFileSync(join(destination,'volume','dingtalk.enc'),'utf8'),'fixture-encrypted-notification');
    assert.equal(readFileSync(join(destination,'secrets','newapi_admin_token'),'utf8'),'fixture-secret');
    const again=run(destination,['import',toBash(archive)]);
    assert.notEqual(again.status,0);
    assert.match(again.stdout+again.stderr,/禁止覆盖/);
    assert.ok(!calls(destination).some(args=>args[0]==='volume'&&args[1]==='rm'));
  }finally{rmSync(source,{recursive:true,force:true});rmSync(destination,{recursive:true,force:true});}
});

test('migration import rejects an archive without a valid SQLite ledger before creating a volume',{skip:!available},()=>{
  const source=setup(),destination=setup();
  try{
    seed(source);
    writeFileSync(join(source,'volume','compensation.sqlite'),'not-a-database');
    const archive=join(source,'invalid.tar.gz');
    const pack=spawnSync(bash,['-lc','tar -czf "$1" -C "$2" .env.auto compose.generated.json secrets volume','--',toBash(archive),toBash(source)],{encoding:'utf8'});
    assert.equal(pack.status,0,pack.stdout+pack.stderr);
    writeFileSync(join(destination,'docker-state.json'),JSON.stringify({volume:false,running:false,container:false}));
    const imported=run(destination,['import',toBash(archive)]);
    assert.notEqual(imported.status,0);
    assert.equal(existsSync(join(destination,'.env.auto')),false);
    assert.equal(JSON.parse(readFileSync(join(destination,'docker-state.json'),'utf8')).volume,false);
    assert.ok(!calls(destination).some(args=>args[0]==='volume'&&args[1]==='create'));
  }finally{rmSync(source,{recursive:true,force:true});rmSync(destination,{recursive:true,force:true});}
});

test('migration import rejects a link archive before extraction or volume creation',{skip:!available},()=>{
  const source=setup(),destination=setup();
  try{
    const archive=join(source,'link.tar.gz');
    writeFileSync(archive,unsafeArchive('link','2'));
    writeFileSync(join(destination,'docker-state.json'),JSON.stringify({volume:false,running:false,container:false}));
    const imported=run(destination,['import',toBash(archive)]);
    assert.notEqual(imported.status,0);
    assert.ok(!calls(destination).some(args=>args[0]==='volume'&&args[1]==='create'));
  }finally{rmSync(source,{recursive:true,force:true});rmSync(destination,{recursive:true,force:true});}
});

test('migration import rejects parent-directory traversal before extraction',{skip:!available},()=>{
  const directory=setup();
  try{
    const archive=join(directory,'traversal.tar.gz');writeFileSync(archive,unsafeArchive('../escaped'));
    writeFileSync(join(directory,'docker-state.json'),JSON.stringify({volume:false,running:false,container:false}));
    const imported=run(directory,['import',toBash(archive)]);
    assert.notEqual(imported.status,0);
    assert.match(imported.stdout+imported.stderr,/越界路径/);
    assert.ok(!calls(directory).some(args=>args[0]==='volume'&&args[1]==='create'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
