import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {log,user,rules} from './helpers.mjs';

test('成功批次按批次分页不拆分，同日不同提交不合并，未成功与他人记录不计入',()=>{
  const store=new Store();
  try{
    const create=(id,runId,owner=user,status='succeeded')=>{
      const c=store.create(log(id,{user_id:owner.id}),owner,rules(),'核验','self',owner.id,false,runId);
      store.db.prepare('UPDATE claims SET status=?,amount=? WHERE id=?').run(status,120,c.id);return c;
    };
    for(let i=0;i<31;i++)create('run-'+i,'batch-'+i);
    create('extra-in-batch','batch-0');create('pending','batch-pending',user,'pending');create('unknown','batch-unknown',user,'unknown');
    create('other-owner','batch-0',{...user,id:9});create('legacy',null);
    const first=store.refundRecords(user.id),second=store.refundRecords(user.id,2);
    assert.equal(first.total,32);assert.equal(first.items.length,30);assert.equal(second.items.length,2);
    const all=[...first.items,...second.items];assert.equal(new Set(all.map(v=>v.id)).size,32);
    assert.equal(all.find(v=>v.id==='batch-0').claims.length,2);
    assert.equal(all.reduce((sum,v)=>sum+v.claims.length,0),33);
    assert.equal(all.every(v=>v.claims.every(c=>c.user_id===user.id&&c.status==='succeeded')),true);
  }finally{store.close();}
});

test('旧数据库自动增加可空批次列，历史消费和状态保留',()=>{
  const dir=mkdtempSync(join(tmpdir(),'refund-migration-')),path=join(dir,'db.sqlite');let store=new Store(path);
  try{
    const claim=store.create(log(),user,rules(),'旧申请','self',user.id);
    store.db.exec('DROP INDEX claims_run; ALTER TABLE claims DROP COLUMN run_id');store.close();store=new Store(path);
    assert.equal(store.get(claim.id).run_id,null);assert.equal(store.get(claim.id).status,'pending');assert.equal(store.get(claim.id).log.quota,120);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
