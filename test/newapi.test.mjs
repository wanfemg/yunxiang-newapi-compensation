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
test('TOTP 使用源项目的 2fa 方法；连接仅 HTTPS 或本机 HTTP',async()=>{
 let body;const api=new NewAPI({url:'https://fixture.example',fetcher:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({success:true,data:{access_token:'x'}}));}});await api.verify('fixture-flow','123456');assert.deepEqual(body,{flow_token:'fixture-flow',method:'2fa',code:'123456'});
 assert.throws(()=>new NewAPI({url:'http://public.example'}));assert.throws(()=>new NewAPI({url:'https://name:secret@fixture.example'}));
});
