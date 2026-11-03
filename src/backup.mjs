import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const source=resolve(process.env.DATA_DIR||'./data','compensation.sqlite');
const destination=resolve(process.argv[2]||join(dirname(source),'backups','compensation-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite'));
let db;
try{
  if(!existsSync(source))throw Error('本地账本尚未创建');
  if(existsSync(destination)||destination===source)throw Error('备份路径已存在，拒绝覆盖');
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  process.umask(0o077);
  db=new DatabaseSync(source,{readOnly:true});
  await backup(db,destination);
  chmodSync(destination,0o600);
  const check=new DatabaseSync(destination,{readOnly:true});
  try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('备份完整性检查失败');}finally{check.close();}
  console.log('SQLite 一致性快照已创建：'+destination+'。机器人加密密钥及部署 secrets 需另行受限备份；旧快照恢复前必须核对原站发放流水。');
}catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
