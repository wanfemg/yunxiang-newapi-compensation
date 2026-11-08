import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createApplication} from '../src/server.mjs';
import {fixture,log,user,admin,mockServer,rules} from './helpers.mjs';
import {userInbox} from '../public/user-inbox.js';

test('站内通知覆盖审核和补偿结果，同状态与重复提交不重复通知',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const c=await f.service.apply(user,'fixture-request-1','核验');
  assert.equal(f.store.inbox(user.id).unread,1);
  f.store.transition(c.id,['pending'],'pending',user.id,'等待核验');
  assert.equal(f.store.inbox(user.id).total,1);
  f.service.review(admin,c.id,'reject','不符合补偿规则');
  assert.equal(f.store.inbox(user.id).items[0].title,'申请审核未通过');
  assert.match(f.store.inbox(user.id).items[0].body,/不符合补偿规则/);
  f.service.reopen(admin,c.id,'补充证据');
  f.service.review(admin,c.id,'approve','核验通过');
  const result=await f.service.execute(admin,c.id,120,'核实未返还');
  assert.equal(result.status,'succeeded');
  const items=f.store.inbox(user.id).items;
  assert.deepEqual(items.map(v=>v.status),['succeeded','approved','pending','rejected','pending']);
  await f.service.selfService(user,'fixture-request-1');
  assert.equal(f.store.inbox(user.id).total,5);
  assert.equal(f.store.inbox(admin.id).total,0);
});

test('全部已读只处理已查看范围，单条已读幂等且不能操作其他用户通知',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const c=await f.service.apply(user,'fixture-request-1','核验'),snapshot=f.store.inbox(user.id);
  f.service.review(admin,c.id,'reject','审核未通过');
  assert.equal(f.store.readInbox(user.id,{throughId:snapshot.throughId}).unread,1);
  const latest=f.store.inbox(user.id,1,true).items[0];
  assert.throws(()=>f.store.readInbox(admin.id,{id:latest.id}),/不存在/);
  assert.equal(f.store.readInbox(user.id,{id:latest.id}).unread,0);
  const readAt=f.store.inbox(user.id).items[0].read_at;
  f.store.readInbox(user.id,{id:latest.id});
  assert.equal(f.store.inbox(user.id).items[0].read_at,readAt);
  assert.equal(f.store.inbox(user.id,1,true).total,0);
  for(const input of [{id:0},{id:'1'},{throughId:-1},{}])assert.throws(()=>f.store.readInbox(user.id,input),/无效/);
});

test('站内通知读取状态重启保留，旧库结果只回填一次，恢复中断执行产生待核对通知',t=>{
  const directory=mkdtempSync(join(tmpdir(),'inbox-')),path=join(directory,'data.sqlite');
  let store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const c=store.create(log(),user,store.rules(),'核验','self',7);
  store.transition(c.id,['pending'],'rejected',1,'审核未通过');
  store.db.exec("DELETE FROM user_notifications; DELETE FROM metadata WHERE key='user_notifications_migrated'");
  store.close();store=new Store(path);
  let data=store.inbox(user.id);assert.equal(data.total,1);assert.equal(data.items[0].status,'rejected');
  store.readInbox(user.id,{id:data.items[0].id});
  store.close();store=new Store(path);assert.equal(store.inbox(user.id).total,1);assert.equal(store.inbox(user.id).unread,0);
  store.transition(c.id,['rejected'],'pending',1,'重新审核');
  store.transition(c.id,['pending'],'approved',1,'通过');
  store.reserve(c.id,1,120,120,'核实',rules());
  store.close();store=new Store(path);
  data=store.inbox(user.id);assert.equal(data.items[0].status,'unknown');assert.equal(data.total,4);
  store.close();store=new Store(path);assert.equal(store.inbox(user.id).total,4);
});

test('站内通知分页完整，不受单页未读数量影响',t=>{
  const f=fixture();t.after(()=>f.store.close());
  for(let i=0;i<35;i++)f.store.create(log('inbox-'+i),user,{...f.store.rules(),maxPending:100},'核验','self',7);
  const first=f.store.inbox(user.id),second=f.store.inbox(user.id,2);
  assert.equal(first.items.length,30);assert.equal(second.items.length,5);assert.equal(first.unread,35);
  assert.equal(new Set([...first.items,...second.items].map(v=>v.id)).size,35);
});

test('通知 HTTP 接口验证登录、CSRF、用户归属和已读范围',async t=>{
  const remote=await mockServer(),store=new Store(),origin='http://127.0.0.1:3210';store.saveRules(rules(),1,1);
  const {server,service}=createApplication({store,upstream:remote.upstream,origin});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await remote.close();store.close();});
  const request=(path,auth={},method='GET',body)=>fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...auth},body:body===undefined?undefined:JSON.stringify(body)});
  const login=async who=>{const r=await request('/api/auth/login',{},'POST',{username:who.username,password:'fixture-password'}),d=await r.json();return {Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':d.data.csrf};};
  const u=await login(user),a=await login(admin),c=await service.apply(user,'fixture-request-1','核验');
  service.review(admin,c.id,'reject','证据不足');
  assert.equal((await request('/api/inbox')).status,401);
  const data=(await (await request('/api/inbox',u)).json()).data;assert.equal(data.unread,2);
  assert.match(data.items[0].body,/证据不足/);assert.equal(data.items[0].claim_id,c.id);
  assert.equal((await (await request('/api/inbox',a)).json()).data.total,0);
  assert.equal((await request('/api/inbox/read',{Cookie:u.Cookie},'POST',{id:data.items[0].id})).status,403);
  assert.equal((await request('/api/inbox/read',a,'POST',{id:data.items[0].id})).status,404);
  assert.equal((await request('/api/inbox/read',u,'POST',{throughId:data.throughId})).status,200);
  assert.equal((await (await request('/api/inbox?unread=1',u)).json()).data.total,0);
  assert.equal((await request('/api/inbox?page=-1',u)).status,400);
});

test('通知展示转义模型与审核意见，提供未读筛选和申请详情入口',()=>{
  const esc=v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;');
  const html=userInbox({data:{unread:1,throughId:1,total:1,items:[{id:1,claim_id:'claim',status:'rejected',title:'审核未通过',body:'<script>bad</script>',read_at:null,created_at:Date.now()}]},unreadOnly:true,esc,date:()=>'',icon:()=>'',badge:()=>'',pager:()=>'',empty:()=>''});
  assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/data-inbox-open="1"/);assert.match(html,/仅看未读/);assert.match(html,/全部标为已读/);
});
