import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { createApplication } from '../src/server.mjs';
import { mockServer, rules, user, admin, log } from './helpers.mjs';

async function setup(t){const remote=await mockServer();const store=new Store();store.saveRules(rules(),1,1);const origin='http://127.0.0.1:3210';const {server}=createApplication({store,upstream:remote.upstream,origin});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await remote.close();});
  const request=async(path,{method='GET',body,cookie,csrf,requestOrigin=origin}={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:requestOrigin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json(),cookie:res.headers.get('set-cookie')};};
  const login=async who=>{const out=await request('/api/auth/login',{method:'POST',body:{username:who.username,password:'fixture-password'}});assert.equal(out.status,200);return {cookie:out.cookie.split(';')[0],csrf:out.json.data.csrf};};return {remote,store,server,base,request,login};}

test('HTTP 秒级接续不重扫已覆盖时间，普通读取保留进度',async t=>{
 const f=await setup(t),u=await f.login(user);f.remote.data.logs=[];
 const first=(await f.request('/api/logs?view=eligible',u)).json.data;
 assert.equal(first.total,0);
 f.remote.data.logs.push(log('delayed-visible',{created_at:Math.floor(Date.now()/1000)-600}));
 assert.equal((await f.request('/api/logs?view=eligible',u)).json.data.total,0);
 // Set a known earlier successful cutoff instead of waiting for the wall clock.
 const snapshot=f.store.logQueryProgress(user.id);snapshot.end-=2;f.store.saveLogQueryProgress(user.id,snapshot);
 f.remote.data.logs.push(log('new-second',{id:101,created_at:snapshot.end+1}));
 const fresh=await f.request('/api/logs?view=eligible&refresh=1',u);
 assert.equal(fresh.status,200);assert.equal(fresh.json.data.total,1);
 assert.equal(fresh.json.data.items[0].log.request_id,'new-second');
 assert.equal(fresh.json.data.queryProgress.from,snapshot.end+1);
 assert.equal((await f.request('/api/logs?page=2',u)).json.data.queryProgress.end,fresh.json.data.queryProgress.end);
 assert.equal(f.remote.data.credits.length,0);
});

test('HTTP 操作记录只有管理员可读且包含可视化关联信息',async t=>{
 const f=await setup(t),a=await f.login(admin),u=await f.login(user);
 const c=f.store.create(log(),user,f.store.rules(),'测试操作记录','self',user.id);
 f.store.event(c.id,admin.id,'rejected',{note:'输出正常'});
 assert.equal((await f.request('/api/admin/audit',u)).status,403);
 const e=(await f.request('/api/admin/audit',a)).json.data.find(e=>e.action==='rejected');
 assert.equal(e.model,'fixture-model');assert.equal(e.targetUsername,user.username);assert.equal(e.actorName,admin.username);assert.equal(e.requestId,c.request_id);
 assert.ok(!Object.hasOwn(e,'claim_log'));
});
test('HTTP 查询整批提交、跨模型合计增额、次数与通知去重',async t=>{
 const f=await setup(t),u=await f.login(user),a=await f.login(admin);
 f.store.saveRules({...f.store.rules(),models:['fixture-model','other-model'],userDailyCount:1,notifications:{enabled:true,events:['batch_result']}},admin.id,f.store.rules().version);
 f.remote.data.channels=[{id:3,name:'测试渠道',status:1,models:'fixture-model,other-model'}];
 f.remote.data.logs.push(log('batch-other',{id:101,quota:80,model_name:'other-model'}));
 const queried=(await f.request('/api/logs?refresh=1',u)).json.data,batch=queried.batches[0];
 assert.equal(batch.records,2);assert.equal(batch.models.length,2);
 assert.equal((await f.request('/api/batches',u)).json.data.length,1);
 const submitted=await f.request('/api/batches/'+batch.id+'/submit',{...u,method:'POST',body:{reason:'整批核实'}});
 assert.equal(submitted.status,200);assert.equal(submitted.json.data.status,'succeeded');assert.equal(submitted.json.data.amount,200);
 assert.deepEqual(f.remote.data.credits,[{id:7,action:'add_quota',mode:'add',value:200}]);
 assert.equal(f.store.overview(user.id).today.count,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM notifications').get().n,1);
 await f.request('/api/batches/'+batch.id+'/submit',{...u,method:'POST',body:{}});
 assert.equal(f.remote.data.credits.length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM notifications').get().n,1);
 const audit=(await f.request('/api/admin/audit',a)).json.data;
 assert.ok(audit.some(e=>e.action==='batch_succeeded'&&e.batchId===batch.id&&e.amount===200));
 const unowned={...user,id:8,username:'other'};const owned=f.store.queryBatch(batch.id);
 f.store.insertQueryBatch({id:'00000000-0000-4000-8000-000000000008',user:unowned,from:owned.query_from,end:owned.query_end,items:[log('foreign',{user_id:8})]});
 assert.equal((await f.request('/api/batches/00000000-0000-4000-8000-000000000008',u)).status,404);
});
test('HTTP 最后一条人工审核结束后整批只增额一次，订阅金额先逐笔核实',async t=>{
 const f=await setup(t),u=await f.login(user),a=await f.login(admin);
 f.remote.data.logs.push(log('subscription',{id:101,quota:80,other:JSON.stringify({billing_source:'subscription',subscription_id:1})}));
 const batch=(await f.request('/api/logs?refresh=1',u)).json.data.batches[0];
 const initial=(await f.request('/api/batches/'+batch.id+'/submit',{...u,method:'POST',body:{}})).json.data;
 assert.equal(initial.status,'review');assert.equal(f.remote.data.credits.length,0);
 const c=f.store.byRequest('subscription');
 const out=await f.request('/api/admin/actions',{...a,method:'POST',body:{action:'approve',items:[{id:c.id,verifiedAmount:50}],note:'核实订阅未退款部分'}});
 assert.equal(out.json.data[0].status,'succeeded');assert.equal(f.remote.data.credits.length,1);assert.equal(f.remote.data.credits[0].value,170);
 assert.equal(f.store.overview(user.id).today.count,1);
});

test('HTTP 按完整结果筛选再分页，候选和全部消费视图各自计数',async t=>{
 const f=await setup(t),u=await f.login(user),now=Math.floor(Date.now()/1000);
 f.remote.data.logs=[...Array.from({length:30},(_,i)=>log('normal-'+i,{id:i+1,created_at:now-i,completion_tokens:100})),...Array.from({length:31},(_,i)=>log('empty-'+i,{id:i+100,created_at:now-100-i})),log('uncertain',{id:200,other:'{}',created_at:now-200})];
 const first=(await f.request('/api/logs?view=eligible',u)).json.data;
 assert.equal(first.total,32);assert.equal(first.items.length,30);
 assert.ok(first.items.every(item=>item.assessment.eligible));
 const second=(await f.request('/api/logs?view=eligible&page=2',u)).json.data;
 assert.equal(second.total,32);assert.equal(second.items.length,2);
 assert.equal(new Set([...first.items,...second.items].map(item=>item.log.request_id)).size,32);
 const pending=(await f.request('/api/logs?view=pending',u)).json.data;
 assert.equal(pending.total,1);assert.equal(pending.items[0].log.request_id,'uncertain');
 assert.equal((await f.request('/api/logs?view=all',u)).json.data.total,62);
 assert.equal((await f.request('/api/logs?view=invalid',u)).status,400);
 assert.equal(f.remote.data.credits.length,0);
});

test('旧版原站 Cookie 登录不向浏览器泄漏上游 Cookie，撤销账号立即阻断',async t=>{
 const f=await setup(t);f.remote.data.legacyLogin=true;
 const response=await f.request('/api/auth/login',{method:'POST',body:{username:user.username,password:'fixture-password'}});
 assert.equal(response.status,200);assert.equal(response.json.data.user.id,7);
 assert.ok(!JSON.stringify(response).includes('legacy-7'));
 const cookie=response.cookie.split(';')[0];assert.equal((await f.request('/api/me',{cookie})).status,200);
 f.remote.data.disabled=true;assert.equal((await f.request('/api/me',{cookie})).status,401);
});

test('保持登录使用 30 天会话，普通登录保持默认时长',async t=>{
 const f=await setup(t);
 const normal=await f.request('/api/auth/login',{method:'POST',body:{username:user.username,password:'fixture-password'}});
 const remembered=await f.request('/api/auth/login',{method:'POST',body:{username:user.username,password:'fixture-password',remember:true}});
 assert.match(normal.cookie,/Max-Age=28800/);
 assert.match(remembered.cookie,/Max-Age=2592000/);
});

test('AI 配置经真实 HTTP 拉取模型并验证所选模型推理，空回复和鉴权错误均不成功',async t=>{
  const f=await setup(t),a=await f.login(admin),u=await f.login(user),calls=[];
  let mode='ok';
  const ai=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    calls.push({path:req.url,auth:req.headers.authorization,body:text?JSON.parse(text):null,method:req.method});
    res.setHeader('Content-Type','application/json');
    if(mode==='unauthorized'){res.statusCode=401;res.end(JSON.stringify({error:{message:'invalid fixture-ai-key'}}));return;}
    if(req.url==='/v1/models'){res.end(JSON.stringify({success:true,object:'list',data:[{id:'chat-model'}]}));return;}
    if(req.url==='/v1/chat/completions'){const body=JSON.parse(text);const content=mode==='empty'?'':body.messages[0].content.includes('二次复核')?'{"decision":"empty","confidence":0.98,"recommendation":"approve","summary":"日志与规则一致","reason":"输出 token 为零","evidence":["completion_tokens=0"]}':body.messages[0].role==='system'?'{"decision":"uncertain","confidence":0.5,"reason":"需要人工核验","evidence":["缺少原始输出"]}':'OK';res.end(JSON.stringify({choices:[{message:{content}}]}));return;}
    res.statusCode=404;res.end('{}');
  });
  ai.listen(0,'127.0.0.1');await once(ai,'listening');
  t.after(async()=>{ai.closeAllConnections();await new Promise(resolve=>ai.close(resolve));});
  const baseUrl='http://127.0.0.1:'+ai.address().port;
  const save=body=>f.request('/api/admin/ai-config',{...a,method:'PUT',body});
  assert.equal((await f.request('/api/admin/ai-config/models',u)).status,403);
  assert.equal((await save({baseUrl,apiKey:'fixture-ai-key',model:''})).json.data.baseUrl,baseUrl+'/v1');
  const models=await f.request('/api/admin/ai-config/models',a);
  assert.deepEqual(models.json.data.items,[{id:'chat-model',name:'chat-model'}]);
  assert.equal((await f.request('/api/admin/ai-config/test',{...a,method:'POST',body:{}})).status,400);
  assert.equal(calls.length,1);
  const saved=await save({baseUrl:baseUrl+'/v1/',model:'chat-model',apiKey:''});
  assert.ok(!JSON.stringify(saved).includes('fixture-ai-key'));
  const tested=await f.request('/api/admin/ai-config/test',{...a,method:'POST',body:{}});
  assert.equal(tested.status,200);assert.equal(tested.json.data.reply,'OK');assert.equal(tested.json.data.model,'chat-model');
  assert.equal(calls[1].path,'/v1/chat/completions');assert.equal(calls[1].method,'POST');
  assert.equal(calls[1].body.model,'chat-model');assert.equal(calls[1].auth,'Bearer fixture-ai-key');
  mode='empty';assert.equal((await f.request('/api/admin/ai-config/test',{...a,method:'POST',body:{}})).status,502);
  mode='unauthorized';
  const rejected=await f.request('/api/admin/ai-config/models',a);
  assert.equal(rejected.status,502);assert.match(rejected.json.message,/401/);assert.ok(!JSON.stringify(rejected.json).includes('fixture-ai-key'));
  mode='ok';
  const version=f.store.rules().version;
  assert.equal((await save({baseUrl,model:'chat-model',aiEnabled:true,aiAutoThreshold:94,aiDailyLimit:15,rulesVersion:version})).status,200);
  assert.equal((await f.request('/api/rules',a)).json.data.aiEnabled,true);
  assert.equal((await f.request('/api/admin/ai-config',a)).json.data.aiAutoThreshold,94);
  assert.equal((await save({baseUrl,model:'wrong',aiEnabled:false,rulesVersion:version})).status,409);
  assert.equal(f.store.aiConfig().model,'chat-model');
  const c=f.store.create(log(),user,f.store.rules(),'管理员辅助审核','self',7);
  assert.equal((await f.request('/api/admin/claims/'+c.id+'/ai-review',{...u,method:'POST',body:{}})).status,403);
  const before=calls.length;
  const assisted=await f.request('/api/admin/claims/'+c.id+'/ai-review',{...a,method:'POST',body:{}});
  assert.equal(assisted.status,200);assert.equal(assisted.json.data.aiReview.reason,'输出 token 为零');
  assert.equal(assisted.json.data.status,'pending');assert.equal(f.remote.data.credits.length,0);
  await f.request('/api/admin/claims/'+c.id+'/ai-review',{...a,method:'POST',body:{}});
  assert.equal(calls.length,before+1);
  mode='ok';f.remote.data.logs.push(log('ai-approve'));
  const ready=f.store.create(log('ai-approve'),user,f.store.rules(),'管理员复核通过','self',7);
  assert.equal((await f.request('/api/admin/claims/'+ready.id+'/ai-review',{...u,method:'POST',body:{}})).status,403);
  const secondReview=await f.request('/api/admin/claims/'+ready.id+'/ai-review',{...a,method:'POST',body:{}});
  assert.equal(secondReview.json.data.aiReview.analysis.recommendation,'approve');
  const aiApproval=await f.request('/api/admin/claims/'+ready.id+'/ai-approve',{...a,method:'POST',body:{}});
  assert.equal(aiApproval.status,200);assert.equal(aiApproval.json.data.status,'succeeded');assert.equal(f.remote.data.credits.length,1);
  assert.equal((await f.request('/api/admin/claims/'+ready.id+'/ai-approve',{...a,method:'POST',body:{}})).status,409);
  assert.equal((await f.request('/api/admin/ai-settings',{...u,method:'PUT',body:{aiEnabled:false,rulesVersion:f.store.rules().version}})).status,403);
  assert.equal((await f.request('/api/admin/ai-settings',{...a,method:'PUT',body:{aiEnabled:false,rulesVersion:f.store.rules().version}})).status,200);
  assert.equal((await f.request('/api/admin/ai-config',a)).json.data.aiEnabled,false);
  assert.equal((await f.request('/api/admin/claims/'+c.id+'/ai-review',{...a,method:'POST',body:{}})).status,409);
});

test('HTTP 渠道模型排除由站长保存，查询展示跳过摘要且伪造申请不能绕过',async t=>{
 const f=await setup(t),a=await f.login(admin),u=await f.login(user);
 const body={...f.store.rules(),excludedModels:[{channelId:3,model:'fixture-model'}]};
 assert.equal((await f.request('/api/admin/rules',{...u,method:'PUT',body})).status,403);
 const saved=await f.request('/api/admin/rules',{...a,method:'PUT',body});assert.equal(saved.status,200);
 assert.deepEqual(saved.json.data.excludedModels,body.excludedModels);
 assert.equal((await f.request('/api/rules',u)).json.data.excludedModels,undefined);
 const query=await f.request('/api/logs',u);assert.equal(query.json.data.total,0);assert.equal(query.json.data.skippedCount,1);
 assert.equal(query.json.data.skippedModels[0].model,'fixture-model');assert.equal(query.json.data.skippedModels[0].channelId,undefined);
 const attempt=await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['fixture-request-1']}});
 assert.equal(attempt.json.data[0].success,false);assert.match(attempt.json.data[0].message,/不参与补偿/);
 assert.equal(f.remote.data.credits.length,0);
});

test('数据库清理仅管理员可预览执行，要求 CSRF 和单次确认',async t=>{
 const f=await setup(t),a=await f.login(admin),u=await f.login(user);
 const body={cache:true,notifications:true,backups:false,compact:false,cacheDays:7,notificationDays:30,backupDays:30};
 assert.equal((await f.request('/api/admin/storage',u)).status,403);
 assert.equal((await f.request('/api/admin/storage/preview',{...u,method:'POST',body})).status,403);
 assert.equal((await f.request('/api/admin/storage/preview',{cookie:a.cookie,method:'POST',body})).status,403);
 const preview=await f.request('/api/admin/storage/preview',{...a,method:'POST',body});assert.equal(preview.status,200);
 const request={...a,method:'POST',body:{token:preview.json.data.token,confirmation:'确认清理'}};
 assert.equal((await f.request('/api/admin/storage/cleanup',request)).status,200);
 assert.equal((await f.request('/api/admin/storage/cleanup',request)).status,409);
});

test('规则简化读取天数、原站分组及显示单位额度，服务端拒绝过期配置与伪造分组',async t=>{
 const f=await setup(t),a=await f.login(admin),u=await f.login(user);
 assert.equal((await f.request('/api/admin/groups',u)).status,403);
 assert.deepEqual((await f.request('/api/admin/groups',a)).json.data.groups,['auto','default','vip']);
 const display=(await f.request('/api/display',a)).json.data;
 const body={...f.store.rules(),lookbackDays:7,dailyResetTime:'04:00',userGroups:['default'],displayRevision:display.revision,displayedQuotas:{perRecordQuota:'0',selfServiceMaxQuota:'1000',userDailyQuota:'300',siteDailyQuota:'900'}};
 const out=await f.request('/api/admin/rules',{...a,method:'PUT',body});
 assert.equal(out.status,200);assert.equal(f.store.rules().userDailyQuota,30000);assert.equal(f.store.rules().applicationHours,168);assert.equal(f.store.rules().consumptionStart,null);assert.equal(f.store.rules().dailyResetTime,'04:00');
 assert.equal((await f.request('/api/rules',u)).json.data.dailyResetTime,'04:00');
 assert.equal((await f.request('/api/admin/rules',{...a,method:'PUT',body:{...body,version:f.store.rules().version,userGroups:['missing']}})).status,409);
 f.remote.data.display={quota_display_type:'TOKENS'};
 assert.equal((await f.request('/api/admin/rules',{...a,method:'PUT',body:{...body,version:f.store.rules().version}})).status,409);
});
test('真实 HTTP 适配闭环：原身份、申请、站长审核、额度返还、用户查询',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  f.remote.data.logs[0].other='{}';
  const logs=await f.request('/api/logs',u);assert.equal(logs.json.data.items[0].log.other,undefined);assert.equal(logs.json.data.items[0].assessment.canApply,true);
  const create=await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['fixture-request-1'],reason:'无输出，申请核实'}});const id=create.json.data[0].claim.id;
  const approved=await f.request('/api/admin/actions',{...a,method:'POST',body:{action:'approve',items:[{id}],note:'已核实无有效输出、未退款'}});
  assert.equal(approved.json.data[0].status,'succeeded');assert.deepEqual(f.remote.data.credits,[{id:7,action:'add_quota',mode:'add',value:120}]);
  const execute=await f.request('/api/admin/actions',{...a,method:'POST',body:{action:'execute',items:[{id,verifiedAmount:120}],note:'重复执行'}});
  assert.equal(execute.json.data[0].success,false);assert.equal(f.remote.data.credits.length,1);
  const detail=await f.request('/api/claims/'+id,u);assert.equal(detail.json.data.status,'succeeded');assert.equal(detail.json.data.verification_note,undefined);
});

test('HTTP 正常消费自助返还，客户端伪造审批或金额不生效，重复提交不重发',async t=>{
  const f=await setup(t),u=await f.login(user);
  const data=await f.request('/api/logs',u);assert.equal(data.json.data.items[0].assessment.route,'automatic');
  const body={requestIds:['fixture-request-1'],verifiedAmount:999999,amount:999999,status:'approved',route:'automatic'};
  const first=await f.request('/api/claims',{...u,method:'POST',body});
  assert.equal(first.json.data[0].status,'succeeded');assert.equal(first.json.data[0].claim.amount,120);
  assert.equal(first.json.data[0].claim.log.other,undefined);
  const second=await f.request('/api/claims',{...u,method:'POST',body});assert.equal(second.json.data[0].claim.id,first.json.data[0].claim.id);assert.equal(f.remote.data.credits.length,1);
  const refreshed=await f.request('/api/logs',u);assert.equal(refreshed.json.data.total,0);assert.deepEqual(refreshed.json.data.items,[]);
  f.remote.data.logs.push(log('exception',{other:'{}'}));
  const exception=await f.request('/api/claims',{...u,method:'POST',body:{...body,requestIds:['exception'],reason:'需核实'}});
  assert.equal(exception.json.data[0].status,'pending');assert.equal(f.remote.data.credits.length,1);
});
test('HTTP 渠道目录仅管理员可读且移除密钥，额度显示配置需要登录',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  f.remote.data.channels=[{id:3,name:'主渠道',status:1,models:'fixture-model',key:'private-channel-key',base_url:'https://private-channel.invalid'}];
  assert.equal((await f.request('/api/display')).status,401);
  assert.equal((await f.request('/api/display',u)).status,200);
  assert.equal((await f.request('/api/admin/catalog',u)).status,403);
  const catalog=await f.request('/api/admin/catalog',a);assert.equal(catalog.status,200);
  assert.deepEqual(Object.keys(catalog.json.data.channels[0]).sort(),['id','models','name','status']);
  assert.equal(JSON.stringify(catalog.json).includes('private-channel'),false);
  const publicRules=await f.request('/api/rules',u);assert.equal(publicRules.json.data.channels,undefined);
});

test('HTTP 用户分组仅站长可读，按用户过滤并拒绝非法用户 ID',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  f.store.create(log('model-a'),user,rules(),'x','self',7);f.store.create(log('model-b',{model_name:'second-model'}),user,rules(),'x','self',7);
  assert.equal((await f.request('/api/admin/claim-groups',u)).status,403);
  assert.equal((await f.request('/api/admin/claim-groups?owner=oops',a)).status,400);
  const groups=await f.request('/api/admin/claim-groups?status=pending&owner=7',a);assert.equal(groups.json.data.total,1);assert.equal(groups.json.data.items[0].models,2);assert.equal(groups.json.data.items[0].expectedAmount,240);
});

test('HTTP 订阅申请由站长确认金额审批后补入余额，重复审批不重复到账',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  f.remote.data.logs[0].other=JSON.stringify({billing_source:'subscription',subscription_id:17,reject_reason:'empty_response'});
  const request=await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['fixture-request-1'],reason:'订阅空回'}}),id=request.json.data[0].claim.id;
  assert.equal(request.json.data[0].status,'pending');assert.equal(f.remote.data.credits.length,0);
  const config=(await f.request('/api/display',a)).json.data;
  const body={action:'approve',items:[{id}],note:'确认订阅扣费且未退款，补入余额',displayRevision:config.revision};
  assert.equal((await f.request('/api/admin/actions',{...u,method:'POST',body})).status,403);
  const missing=await f.request('/api/admin/actions',{...a,method:'POST',body});assert.equal(missing.json.data[0].success,false);assert.equal(f.store.get(id).status,'pending');
  body.items[0].displayedAmount='1.2';const approved=await f.request('/api/admin/actions',{...a,method:'POST',body});assert.equal(approved.json.data[0].status,'succeeded');assert.deepEqual(f.remote.data.credits,[{id:7,action:'add_quota',mode:'add',value:120}]);
  assert.equal((await f.request('/api/admin/actions',{...a,method:'POST',body})).json.data[0].success,false);assert.equal(f.remote.data.credits.length,1);
  assert.equal((await f.request('/api/claims/'+id,u)).json.data.amount,120);
});

test('HTTP 显示金额服务端精确换算；原站配置变化时拒绝整批执行',async t=>{
  const f=await setup(t),a=await f.login(admin),c=f.store.create(structuredClone(f.remote.data.logs[0]),user,rules(),'x','self',7);f.store.transition(c.id,['pending'],'approved',1,'核实');
  const config=(await f.request('/api/display',a)).json.data;
  f.remote.data.display={quota_display_type:'CUSTOM',quota_per_unit:100,custom_currency_symbol:'额度 ',custom_currency_exchange_rate:2};
  const body={action:'execute',items:[{id:c.id,displayedAmount:'1.2',verifiedAmount:999999}],note:'确认无输出且未返还',displayRevision:config.revision};
  assert.equal((await f.request('/api/admin/actions',{...a,method:'POST',body})).status,409);assert.equal(f.remote.data.credits.length,0);assert.equal(f.store.get(c.id).status,'approved');
  body.displayRevision=(await f.request('/api/display',a)).json.data.revision;
  body.items[0].displayedAmount='2.400000000000001';const precise=await f.request('/api/admin/actions',{...a,method:'POST',body});assert.equal(precise.json.data[0].success,false);assert.equal(f.remote.data.credits.length,0);
  body.items[0].displayedAmount='2.4';const result=await f.request('/api/admin/actions',{...a,method:'POST',body});assert.equal(result.json.data[0].status,'succeeded');assert.equal(f.remote.data.credits[0].value,120);
});

test('HTTP 未登录、越权、跨站和缺少 CSRF 都被拒绝',async t=>{
  const f=await setup(t);assert.equal((await f.request('/api/claims')).status,401);const u=await f.login(user);assert.equal((await f.request('/api/admin/rules',u)).status,403);
  assert.equal((await f.request('/api/claims',{...u,method:'POST',requestOrigin:'https://other.example',body:{}})).status,403);
  assert.equal((await f.request('/api/claims',{cookie:u.cookie,method:'POST',body:{}})).status,403);
});

test('补回记录按真实提交批次分组，重复提交不改批次，只显示本人成功金额',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  f.remote.data.logs.push(log('same-run',{quota:80}),log('needs-review',{other:'{}'}));
  const body={requestIds:['fixture-request-1','same-run','needs-review'],reason:'自动审批'};
  const submit=await f.request('/api/claims',{...u,method:'POST',body});assert.equal(submit.status,200);
  const first=await f.request('/api/refund-records?userId=1',u);assert.equal(first.json.data.total,1);
  const record=first.json.data.items[0];assert.equal(record.claims.length,2);assert.equal(record.claims.reduce((sum,c)=>sum+c.amount,0),200);
  assert.equal(record.claims[0].log.other,undefined);
  assert.equal((await f.request('/api/refund-records',a)).json.data.total,0);
  assert.equal((await f.request('/api/refund-records')).status,401);
  await f.request('/api/claims',{...u,method:'POST',body});assert.equal((await f.request('/api/refund-records',u)).json.data.items[0].id,record.id);
  f.remote.data.logs.push(log('next-run',{quota:20}));await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['next-run']}});
  assert.equal((await f.request('/api/refund-records',u)).json.data.total,2);
});
test('HTTP 批量逐条返回；原站撤销身份立即阻断',async t=>{
  const f=await setup(t),u=await f.login(user);const r=await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['fixture-request-1','missing'],reason:'核实'}});assert.equal(r.json.data[0].success,true);assert.equal(r.json.data[1].success,false);f.remote.data.disabled=true;assert.equal((await f.request('/api/overview',u)).status,401);
});
test('HTTP 模糊返还结果不算成功；重复 request_id 不允许关联',async t=>{
  const f=await setup(t),a=await f.login(admin),u=await f.login(user);f.remote.data.logs.push(log('fixture-request-1'));const r=await f.request('/api/claims',{...u,method:'POST',body:{requestIds:['fixture-request-1'],reason:'x'}});assert.equal(r.json.data[0].success,false);f.remote.data.logs.pop();const c=f.store.create(structuredClone(f.remote.data.logs[0]),user,rules(),'x','self',7);f.store.transition(c.id,['pending'],'approved',1,'x');f.remote.data.mode='ambiguous';const e=await f.request('/api/admin/actions',{...a,method:'POST',body:{action:'execute',items:[{id:c.id,verifiedAmount:120}],note:'x'}});assert.equal(e.json.data[0].status,'unknown');
});
test('页面静态资源、CSP、Cookie 属性与退出',async t=>{
  const f=await setup(t);const html=await fetch(f.base);assert.equal(html.status,200);assert.match(await html.text(),/云响/);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:user.username,password:'fixture-password'}});assert.match(login.cookie,/HttpOnly/);assert.match(login.cookie,/SameSite=Strict/);assert.equal(JSON.stringify(login.json).includes('fixture-user-token'),false);
  const auth={cookie:login.cookie.split(';')[0],csrf:login.json.data.csrf};await f.request('/api/auth/logout',{...auth,method:'POST',body:{}});assert.equal((await f.request('/api/me',auth)).status,401);
});

test('个人统计强制限定当前账号、范围校验和成功金额',async t=>{
  const f=await setup(t),u=await f.login(user),a=await f.login(admin);
  assert.equal((await f.request('/api/statistics')).status,401);
  const c=f.store.create(log(),user,rules(),'统计验证','self',7);
  f.store.transition(c.id,['pending'],'approved',1,'核实');
  f.store.reserve(c.id,1,120,120,'核实',rules());
  f.store.transition(c.id,['executing'],'succeeded',1,'到账');
  for(const days of [7,30,90]){
    const result=await f.request('/api/statistics?days='+days+'&userId=1',u);
    assert.equal(result.status,200);assert.equal(result.json.data.quota,120);
    assert.equal(result.json.data.count,1);assert.equal(result.json.data.trend.length,days);
    assert.equal(result.json.data.trend.reduce((sum,p)=>sum+p.quota,0),120);
  }
  assert.equal((await f.request('/api/statistics',a)).json.data.quota,0);
  for(const value of ['0','8','NaN','-1','10000'])assert.equal((await f.request('/api/statistics?days='+value,u)).status,400);
  f.store.transition(c.id,['succeeded'],'unknown',1,'测试统计排除');
  assert.equal((await f.request('/api/statistics',u)).json.data.quota,0);
  const icons=await fetch(f.base+'/icons.js');assert.equal(icons.status,200);assert.match(icons.headers.get('content-type'),/javascript/);
});
