import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {createApplication} from '../src/server.mjs';
import {mockServer,rules,user,admin,log} from './helpers.mjs';

async function setup(t){
  const remote=await mockServer(),store=new Store();store.saveRules(rules(),admin.id,1);
  const origin='http://127.0.0.1:3210',{server,service,drain}=createApplication({store,upstream:remote.upstream,origin});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await drain();store.close();await remote.close();});
  async function request(path,session={},body){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(session.cookie?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  async function login(who){const response=await request('/api/auth/login',{}, {username:who.username,password:'fixture-password'});return {cookie:response.cookie.split(';')[0],csrf:response.body.data.csrf};}
  return {remote,store,service,base,request,login};
}

test('管理员定向补查只发现遗漏日志，不推进正常游标且不能越权',async t=>{
  const f=await setup(t),a=await f.login(admin),u=await f.login(user);
  const initial=(await f.request('/api/logs?refresh=1',u)).body.data;
  const cutoff=initial.queryProgress.end,start=cutoff-600;
  f.remote.data.logs.push(log('late-log',{id:909,created_at:cutoff-300}));
  const body={userId:user.id,start,end:cutoff};
  assert.equal((await f.request('/api/admin/logs/backfill',u,body)).status,403);
  assert.equal((await f.request('/api/admin/logs/backfill',a,{...body,start:cutoff+1})).status,400);
  const found=await f.request('/api/admin/logs/backfill',a,body);
  assert.equal(found.status,200);assert.equal(found.body.data.backfill.added,1);
  assert.equal(f.store.logQueryProgress(user.id).end,cutoff);
  const batchCount=f.store.db.prepare('SELECT COUNT(*) n FROM compensation_batches').get().n;
  const repeated=await f.request('/api/admin/logs/backfill',a,body);
  assert.equal(repeated.status,200);assert.equal(repeated.body.data.backfill.added,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM compensation_batches').get().n,batchCount);
  assert.equal(f.remote.data.credits.length,0);
});

test('限额暂停的本人批次可以继续，无需重交申请且不截断金额',async t=>{
  const f=await setup(t),u=await f.login(user);
  f.store.saveRules({...f.store.rules(),userDailyQuota:300},admin.id,f.store.rules().version);
  const first=log('paid-200',{id:901,quota:200}),second=log('waiting-150',{id:902,quota:150});
  f.remote.data.logs=[first,second];
  const create=source=>{const id=randomUUID();f.store.insertQueryBatch({id,user,from:source.created_at,end:source.created_at,items:[source]});return id;};
  const firstId=create(first),secondId=create(second);
  assert.equal((await f.request('/api/batches/'+firstId+'/submit',u,{})).body.data.status,'succeeded');
  const blocked=await f.request('/api/batches/'+secondId+'/submit',u,{});
  assert.equal(blocked.status,200);assert.equal(blocked.body.data.status,'waiting_limit');
  const claimId=f.store.byRequest(second.request_id).id;
  const blockedDetail=(await f.request('/api/claims/'+claimId,u)).body.data;
  assert.equal(blockedDetail.status,'approved');assert.equal(blockedDetail.waitingLimit,true);
  assert.equal(blockedDetail.canResume,false);assert.equal(blockedDetail.limit.code,'USER_DAILY_QUOTA_LIMIT');
  assert.equal(f.remote.data.credits.length,1);
  const waiting=await f.request('/api/batches/'+secondId+'/resume',u,{});
  assert.equal(waiting.status,200);assert.equal(waiting.body.data.status,'waiting_limit');
  assert.equal(f.remote.data.credits.length,1);
  f.store.saveRules({...f.store.rules(),userDailyQuota:500},admin.id,f.store.rules().version);
  const readyDetail=(await f.request('/api/claims/'+claimId,u)).body.data;
  assert.equal(readyDetail.waitingLimit,true);assert.equal(readyDetail.canResume,true);assert.equal(readyDetail.limit,null);
  const resumed=await f.request('/api/batches/'+secondId+'/resume',u,{});
  assert.equal(resumed.status,200);assert.equal(resumed.body.data.status,'succeeded');
  const paidDetail=(await f.request('/api/claims/'+claimId,u)).body.data;
  assert.equal(paidDetail.waitingLimit,false);assert.equal(paidDetail.canResume,false);assert.equal(paidDetail.limit,null);
  assert.deepEqual(f.remote.data.credits.map(credit=>credit.value),[200,150]);
  assert.equal((await f.request('/api/batches/'+secondId+'/resume',u,{})).body.data.status,'succeeded');
  assert.equal(f.remote.data.credits.length,2);
  const foreign=create(log('foreign',{user_id:8}));f.store.db.prepare('UPDATE compensation_batches SET user_id=8 WHERE id=?').run(foreign);
  assert.equal((await f.request('/api/batches/'+foreign+'/resume',u,{})).status,404);
});
