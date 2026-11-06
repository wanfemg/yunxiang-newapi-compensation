import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {EmailNotifications} from '../src/email-notifications.mjs';
import {createApplication} from '../src/server.mjs';
import {mockServer,rules,user,admin} from './helpers.mjs';
async function setup(t){
  const remote=await mockServer(),store=new Store(),directory=mkdtempSync(join(tmpdir(),'ui-delivery-'));store.saveRules(rules(),1,1);
  const sent=[],mail=new EmailNotifications(store,directory,{sender:async(...args)=>{sent.push(args);},upstream:remote.upstream}),origin='http://127.0.0.1:3210';
  const {server}=createApplication({store,upstream:remote.upstream,emailNotifications:mail,origin});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await remote.close();store.close();assert.ok(directory.startsWith(join(tmpdir(),'ui-delivery-')));rmSync(directory,{recursive:true,force:true});});
  const request=async(path,auth={},method='GET',body)=>fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...auth},body:body===undefined?undefined:JSON.stringify(body)});
  const login=async who=>{const response=await request('/api/auth/login',{},'POST',{username:who.username,password:'fixture-password'}),data=await response.json();return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.data.csrf};};
  return {base,store,mail,request,login,sent,remote};
}
test('HTML 与未版本化资源不缓存，整个模块依赖图使用同一内容版本',async t=>{
  const f=await setup(t),html=await f.request('/'),text=await html.text();
  assert.ok(text.includes('<title>云响 · 云中猫API小站 补空回</title>'));
  assert.ok(text.includes('云中猫API小站 用户名'));
  assert.doesNotMatch(text,/newapi/i);
  assert.match(html.headers.get('cache-control'),/no-store/);
  const version=(await (await f.request('/api/ui-version')).json()).data.version;
  assert.match(version,/^[a-f0-9]{16}$/);assert.ok(text.includes('content="'+version+'"'));
  for(const name of ['style.css','glass.css','icons.js','app.js'])assert.ok(text.includes('/assets/'+version+'/'+name));
  const script=await f.request('/assets/'+version+'/app.js');assert.match(script.headers.get('cache-control'),/immutable/);
  const imports=[...(await script.text()).matchAll(/from '[.]\/([^']+)'/g)].map(m=>m[1]);assert.ok(imports.includes('notification-center.js'));assert.ok(imports.includes('ui-version.js'));
  for(const name of imports){const response=await f.request('/assets/'+version+'/'+name);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/immutable/);}
  for(const path of ['/app.js','/style.css','/app.js?v=old','/api/ui-version']){const response=await f.request(path);assert.match(response.headers.get('cache-control'),/no-store/);}
  const missing=await f.request('/assets/0000000000000000/app.js');assert.equal(missing.status,404);assert.match(missing.headers.get('cache-control'),/no-store/);
});
test('邮箱配置只给管理员，检查 CSRF、旧配置及测试收件人，响应不泄漏密码',async t=>{
  const f=await setup(t),a=await f.login(admin),u=await f.login(user),config={host:'smtp.example.com',port:587,security:'starttls',username:'sender',password:'private-mail-secret',fromEmail:'sender@example.com',fromName:'云响',enabled:true};
  assert.equal((await f.request('/api/admin/email-notifications')).status,401);assert.equal((await f.request('/api/admin/email-notifications',u)).status,403);
  assert.equal((await f.request('/api/admin/email-notifications',{Cookie:a.Cookie},'PUT',config)).status,403);
  const saved=await f.request('/api/admin/email-notifications',a,'PUT',config);assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes(config.password));
  const stale=await f.request('/api/admin/email-notifications',a,'PUT',{...config,version:1});assert.equal(stale.status,409);
  const bad=await f.request('/api/admin/email-notifications/test',a,'POST',{to:'bad'});assert.equal(bad.status,400);
  const sent=await f.request('/api/admin/email-notifications/test',a,'POST',{to:'test@example.com'});assert.equal(sent.status,200);assert.equal(f.sent[0][1],'test@example.com');
});
test('通知入队故障不改变成功的审核响应与申请状态',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);f.remote.data.logs[0].other='{}';
  const created=await (await f.request('/api/claims',u,'POST',{requestIds:['fixture-request-1'],reason:'人工核验'})).json(),id=created.data[0].claim.id;
  f.mail.notifyClaims=async()=>{throw Error('queue unavailable');};
  const response=await f.request('/api/admin/actions',a,'POST',{action:'approve',items:[{id}],note:'已核实'}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.data[0].status,'approved');assert.equal(f.store.get(id).status,'approved');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='email_notification_enqueue_failed'").get().n,1);
});
