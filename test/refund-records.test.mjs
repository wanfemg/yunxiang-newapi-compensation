import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {fixture,log,user,rules} from './helpers.mjs';

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

test('成功记录显示真实查询区间，部分通过保持原区间且不使用消费时间',()=>{
  const store=new Store();
  try{
    const from=1795148401,end=1795169408;
    for(const [id,statuses] of [['completed',['succeeded','succeeded']],['partial',['succeeded','pending','rejected']]]){
      const logs=statuses.map((status,index)=>log(id+'-'+index,{created_at:from+60+index}));
      store.insertQueryBatch({id,user,from,end,items:logs});
      store.enrollBatch(id,logs,user,rules(),'核验',user.id);
      const claims=store.batchClaims(id);
      for(const [index,claim] of claims.entries())store.db.prepare('UPDATE claims SET status=?,amount=? WHERE id=?').run(statuses[index],120,claim.id);
      store.updateBatch(id,id==='completed'?'succeeded':'review');
    }
    const records=store.refundRecords(user.id);
    assert.equal(records.total,2);
    for(const record of records.items){
      assert.deepEqual(record.queryRange,{from,end});
      assert.ok(record.claims.every(claim=>claim.log.created_at>from&&claim.log.created_at<end));
    }
    assert.equal(records.items.find(record=>record.id==='completed').claims.length,2);
    assert.equal(records.items.find(record=>record.id==='partial').claims.length,1);
  }finally{store.close();}
});

test('历史无批次记录不推测查询范围，其他用户的批次时间不泄露',()=>{
  const store=new Store();
  try{
    const other={...user,id:9},foreign=log('foreign-source',{user_id:other.id});
    store.insertQueryBatch({id:'foreign-batch',user:other,from:1795148401,end:1795169408,items:[foreign]});
    const legacy=store.create(log('legacy-source'),user,rules(),'历史申请','self',user.id);
    const manual=store.create(log('manual-source'),user,rules(),'手动申请','admin',user.id,false,'manual-run');
    const linked=store.create(log('foreign-link'),user,rules(),'关联错误','self',user.id,false,'foreign-run');
    store.db.prepare("UPDATE claims SET status='succeeded',amount=120 WHERE id IN (?,?,?)").run(legacy.id,manual.id,linked.id);
    store.db.prepare('UPDATE claims SET batch_id=? WHERE id=?').run('foreign-batch',linked.id);
    const records=store.refundRecords(user.id);
    assert.equal(records.total,3);
    assert.ok(records.items.every(record=>record.queryRange===null));
    assert.ok(records.items.every(record=>record.claims.every(claim=>claim.user_id===user.id)));
    assert.equal(store.refundRecords(other.id).total,0);
  }finally{store.close();}
});

test('历史提交按提交时间倒序分页，老提交后完成不置顶，同毫秒按首次插入顺序',()=>{
  const store=new Store();
  try{
    const ids=[...Array.from({length:30},(_,i)=>'group-'+i),'z-same-first','a-same-last'];
    const start=Date.now()-60000;
    for(const [index,id] of ids.entries()){
      const claim=store.create(log(id),user,rules(),'核验','self',user.id,false,id);
      store.db.prepare("UPDATE claims SET status='succeeded',amount=120,created_at=?,updated_at=? WHERE id=?")
        .run(start+Math.min(index,30),start+1000-index,claim.id);
    }
    const first=store.refundRecords(user.id),second=store.refundRecords(user.id,2);
    assert.equal(first.total,32);assert.equal(first.items.length,30);assert.equal(second.items.length,2);
    assert.deepEqual([...first.items,...second.items].map(record=>record.id),ids.toReversed());
    store.db.prepare("UPDATE claims SET updated_at=? WHERE run_id='group-0'").run(Date.now()+1000);
    assert.deepEqual(store.refundRecords(user.id).items.map(record=>record.id),first.items.map(record=>record.id));
  }finally{store.close();}
});

test('用户申请与待处理批次始终按创建时间倒序，状态更新时间不改变顺序',async t=>{
  const f=fixture();t.after(()=>f.store.close());const start=Date.now()-60000,claims=[];
  for(const [index,id] of ['old','new'].entries()){
    const claim=f.store.create(log('claim-'+id),user,rules(),'核验','self',user.id,false);
    claims.push(claim);
    f.store.db.prepare('UPDATE claims SET created_at=?,updated_at=? WHERE id=?').run(start+index,start+1000-index,claim.id);
    f.store.insertQueryBatch({id:'query-'+id,user,from:Math.floor(start/1000),end:Math.floor(Date.now()/1000),items:[log('query-source-'+id)]});
    f.store.db.prepare('UPDATE compensation_batches SET created_at=?,updated_at=? WHERE id=?').run(start+index,start+1000-index,'query-'+id);
  }
  assert.deepEqual(f.store.list(user.id).items.map(claim=>claim.id),claims.toReversed().map(claim=>claim.id));
  assert.deepEqual((await f.service.batches.list(user)).map(batch=>batch.id),['query-new','query-old']);
  f.store.db.prepare('UPDATE claims SET updated_at=? WHERE id=?').run(Date.now(),claims[0].id);
  f.store.db.prepare("UPDATE compensation_batches SET updated_at=? WHERE id='query-old'").run(Date.now());
  assert.deepEqual(f.store.list(user.id).items.map(claim=>claim.id),claims.toReversed().map(claim=>claim.id));
  assert.deepEqual((await f.service.batches.list(user)).map(batch=>batch.id),['query-new','query-old']);
});
