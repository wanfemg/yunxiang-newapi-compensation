import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { NewAPI } from '../src/newapi.mjs';
test('原站加密登录兼容 v2 包封，密码不作为明文字段传输',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'}});let sent;
 const api=new NewAPI({url:'https://fixture.example',fetcher:async(url,options)=>{
  if(url.pathname.endsWith('encryption-key'))return new Response(JSON.stringify({success:true,data:{enabled:true,kid:'fixture-kid',public_key:publicKey}}));
  sent=JSON.parse(options.body);return new Response(JSON.stringify({success:true,data:{access_token:'fixture-access'}}));
 }});
 const out=await api.login('fixture-user','中文🔐'.repeat(80));assert.equal(out.access_token,'fixture-access');assert.equal(sent.password,undefined);
 const parts=sent.password_encrypted.split('.'),key=privateDecrypt({key:privateKey,oaepHash:'sha256',oaepLabel:Buffer.from('password-v2')},Buffer.from(parts[1],'base64'));
 const encrypted=Buffer.from(parts[3],'base64'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(parts[2],'base64'));decipher.setAAD(Buffer.from('password-v2:fixture-kid'));decipher.setAuthTag(encrypted.subarray(-16));assert.equal(Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString(),'中文🔐'.repeat(80));
});

test('旧版没有加密接口时使用原站 Session Cookie，保留身份核验与 Cookie 轮换',async()=>{
 const calls=[];const api=new NewAPI({url:'https://fixture.example',fetcher:async(url,options)=>{
  calls.push({path:url.pathname,...options});
  if(url.pathname.endsWith('encryption-key'))return new Response('not found',{status:404});
  if(url.pathname==='/api/user/login')return new Response(JSON.stringify({success:true,data:{id:7,username:'legacy'}}),{headers:{'Set-Cookie':'session=legacy-secret; HttpOnly; Path=/'}});
  assert.equal(options.headers.Cookie,'session=legacy-secret');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['New-Api-User'],'7');
  return new Response(JSON.stringify({success:true,data:{id:7,username:'legacy',role:1,status:1}}),{headers:{'Set-Cookie':'session=rotated-secret; Path=/'}});
 }});
 const out=await api.login('legacy','existing-password');assert.equal(out.session_cookie,'session=legacy-secret');
 const credential={cookie:out.session_cookie};assert.equal((await api.identity(credential,out.user.id)).id,7);assert.equal(credential.cookie,'session=rotated-secret');
 assert.deepEqual(JSON.parse(calls[1].body),{username:'legacy',password:'existing-password'});
});

test('加密配置超时、业务拒绝或无效响应时不降级提交密码',async()=>{
 for(const response of [()=>new Response('unavailable',{status:503}),()=>new Response(JSON.stringify({success:false})),()=>{throw Error('timeout');}]){
  let calls=0;const api=new NewAPI({url:'https://fixture.example',fetcher:async()=>{calls++;return response();}});
  await assert.rejects(()=>api.login('legacy','secret'));assert.equal(calls,1);
 }
});

test('旧版二步验证使用临时 Cookie，验证后才接收登录身份',async()=>{
 const api=new NewAPI({url:'https://fixture.example',fetcher:async(url,options)=>{
  if(url.pathname.endsWith('encryption-key'))return new Response('',{status:404});
  if(url.pathname==='/api/user/login')return new Response(JSON.stringify({success:true,data:{require_2fa:true}}),{headers:{'Set-Cookie':'session=pending; Path=/'}});
  assert.equal(url.pathname,'/api/user/login/2fa');assert.equal(options.headers.Cookie,'session=pending');assert.deepEqual(JSON.parse(options.body),{code:'123456'});
  return new Response(JSON.stringify({success:true,data:{id:7,username:'legacy'}}),{headers:{'Set-Cookie':'session=verified; Path=/'}});
 }});
 const challenge=await api.login('legacy','secret');assert.equal(challenge.require_verification,true);assert.equal(challenge.session_cookie,undefined);
 const out=await api.verify(challenge.flow_token,'123456');assert.equal(out.session_cookie,'session=verified');assert.equal(out.user.id,7);
});

test('身份 ID 不一致或账号被禁用时拒绝登录',async()=>{
 for(const data of [{id:8,username:'other',role:1,status:1},{id:7,username:'disabled',role:1,status:2}]){
  const api=new NewAPI({url:'https://fixture.example',fetcher:async()=>new Response(JSON.stringify({success:true,data}))});
  await assert.rejects(()=>api.identity({cookie:'session=secret'},7));
 }
});
test('TOTP 使用源项目的 2fa 方法；连接仅 HTTPS 或本机 HTTP',async()=>{
 let body;const api=new NewAPI({url:'https://fixture.example',fetcher:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({success:true,data:{access_token:'x'}}));}});await api.verify('fixture-flow','123456');assert.deepEqual(body,{flow_token:'fixture-flow',method:'2fa',code:'123456'});
 assert.throws(()=>new NewAPI({url:'http://public.example'}));assert.throws(()=>new NewAPI({url:'https://name:secret@fixture.example'}));
});

test('旧版管理接口忽略增额动作返回用户状态时不视为到账',async()=>{
 const api=new NewAPI({url:'https://fixture.example',adminToken:'management',adminUserId:1,fetcher:async(url,options)=>{
  assert.equal(url.pathname,'/api/user/manage');assert.deepEqual(JSON.parse(options.body),{id:7,action:'add_quota',mode:'add',value:120});
  return new Response(JSON.stringify({success:true,data:{role:1,status:1}}));
 }});
 await assert.rejects(()=>api.credit(7,120),e=>e.definitive===false&&/不兼容/.test(e.message));
});
