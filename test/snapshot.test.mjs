import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshotValue,renderSnapshot} from '../public/snapshot.js';

test('snapshot decodes nested JSON without changing scalar identifiers or malformed text',()=>{
  assert.deepEqual(parseSnapshotValue(JSON.stringify(JSON.stringify({a:1}))),{a:1});
  for(const value of ['00013','false','null','{broken','"00013"',42,null])assert.equal(parseSnapshotValue(value),value);
});

test('snapshot renders safe grouped fields, nested metadata and the unchanged original',()=>{
  const snapshot={log:{quota:100,other:JSON.stringify({stream_status:{end_error:'<img src=x onerror=alert(1)>'},unknown_field:false,empty:[],nil:null})},rules:{refundBasisPoints:7500,applicationsEnabled:true},verification_note:'',attempt_id:null};
  const original=JSON.stringify(snapshot);
  const html=renderSnapshot(snapshot,{formatQuota:n=>'$'+n/100});
  for(const text of ['原消费与规则快照','规则快照','核验信息','原始 JSON','流式响应异常','75%','$1','原始额度 100','空列表','未记录','空字符串','unknown_field','&lt;img'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('<img'));
  assert.equal(JSON.stringify(snapshot),original);
  assert.ok(html.includes('snapshot-node'));
});

test('overview renders nested admin scheduling and preserves every original event',()=>{
  const policy=[{attempt:1,channel_id:13,elapsed_ms:25,decision:{reason:'channel_selected',action:'attempt'}},{attempt:1,elapsed_ms:89999,decision:{reason:'stream_not_successful',source:'system'}}];
  const html=renderSnapshot({log:{completion_tokens:0,use_time:90,other:JSON.stringify({billing_source:'subscription',admin_info:{request_policy:JSON.stringify(policy)},stream_status:JSON.stringify({status:'error',end_reason:'client_gone'})})},rules:{perRecordQuota:0}});
  for(const text of ['snapshot-timeline','已选择渠道 #13','89,999 ms','请求终止','订阅额度','client_gone','不额外限制','原始 JSON'])assert.ok(html.includes(text),text);
});

test('missing metrics never masquerade as zero and malformed metadata remains readable',()=>{
  const html=renderSnapshot({log:{other:'{broken'},rules:{}});
  assert.ok(!html.includes('snapshot-zero'));
  assert.ok(!html.includes('输入 0 Token'));
  assert.ok(html.includes('输入未记录'));
  assert.ok(html.includes('扩展信息原文'));
  assert.ok(html.includes('{broken'));
});

test('snapshot bounds deeply nested and wide visual trees while preserving raw JSON',()=>{
  const log=Object.fromEntries(Array.from({length:2010},(_,i)=>['field'+i,i]));
  const html=renderSnapshot({log,rules:{},verification_note:null,attempt_id:null});
  assert.ok(html.includes('其余字段见原始 JSON'));
  assert.ok(html.includes('&quot;field2009&quot;'));
});
