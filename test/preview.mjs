// Explicit local UI fixture only. Never imported by the production server.
import { Store } from '../src/store.mjs';
import { createApplication } from '../src/server.mjs';
import { mockServer, rules, user, log } from './helpers.mjs';
export const remote=await mockServer(),store=new Store();store.saveRules(rules(),1,1);
const previewQueryDelay=Number(process.env.PREVIEW_QUERY_DELAY_MS)||0;
if(previewQueryDelay>0){
  const queryLogs=remote.upstream.logs.bind(remote.upstream);
  remote.upstream.logs=async query=>{await new Promise(resolve=>setTimeout(resolve,previewQueryDelay));return queryLogs(query);};
}
remote.data.logs.push(log('fixture-request-2',{quota:240,other:'{}'}),log('fixture-request-3',{quota:160,completion_tokens:30}));
remote.data.logs.push(log('fixture-self-service',{quota:80}));
store.create(log(),user,rules(),'本地 UI 验证数据，非真实消费','self',7);
if(process.env.PREVIEW_DEMO_DATA==='1'){
  const demoRules=rules({models:['fixture-model','gemini-2.5-pro','gemini-2.5-flash'],userDailyQuota:100000,userDailyCount:100,siteDailyQuota:500000,siteDailyCount:500});
  store.saveRules({...demoRules,version:store.rules().version},1,store.rules().version);
  remote.data.logs.push(
    log('demo-auto-pro',{model_name:'gemini-2.5-pro',quota:1200,created_at:Math.floor(Date.now()/1000)-600}),
    log('demo-auto-flash',{model_name:'gemini-2.5-flash',quota:350,created_at:Math.floor(Date.now()/1000)-900}),
    log('demo-manual-review',{model_name:'gemini-2.5-pro',quota:650,other:'{}'}),
    log('demo-normal-output',{model_name:'gemini-2.5-flash',quota:180,completion_tokens:90}),
    log('demo-retired-model',{model_name:'gemini-retired',quota:500,created_at:Math.floor(Date.now()/1000)-600})
  );
  const manual=remote.data.logs.find(l=>l.request_id==='demo-manual-review');store.create(manual,user,demoRules,'历史空回，请站长核验','self',7);
  const subscription=log('demo-subscription-review',{model_name:'gemini-2.5-flash',quota:360,other:JSON.stringify({billing_source:'subscription',subscription_id:17,reject_reason:'empty_response'})});remote.data.logs.push(subscription);store.create(subscription,user,demoRules,'订阅空回，交站长处理','self',7);
  for(const [days,amount,model] of [[2,2800,'gemini-2.5-pro'],[7,500,'gemini-2.5-flash'],[14,1200,'gemini-2.5-pro']]){
    const completed=Date.now()-days*86400000,source=log('demo-history-'+days,{quota:amount,model_name:model,created_at:Math.floor(completed/1000)-600});
    remote.data.logs.push(source);
    const c=store.create(source,user,demoRules,'模拟成功历史','self',7,false,'demo-run-'+days);
    store.transition(c.id,['pending'],'approved',1,'模拟自动审批通过');
    store.reserve(c.id,1,amount,amount,'模拟历史到账',demoRules,completed);
    store.transition(c.id,['executing'],'succeeded',1,'模拟补回成功');
    store.db.prepare('UPDATE claims SET created_at=?,updated_at=? WHERE id=?').run(completed,completed,c.id);
  }
  const secondUser={...user,id:8,username:'demo-user-8',display_name:'第二位演示用户'};
  const otherLog=log('demo-other-user',{user_id:8,username:secondUser.username,model_name:'gemini-2.5-flash',channel:5,quota:800});remote.data.logs.push(otherLog);
  const other=store.create(otherLog,secondUser,demoRules,'演示用户统计','self',8,false,'demo-other-run');
  store.transition(other.id,['pending'],'approved',1,'模拟审核通过');
  store.reserve(other.id,1,800,800,'模拟到账',demoRules);
  store.transition(other.id,['executing'],'succeeded',1,'模拟返还完成');
}
export const previewOrigin='http://127.0.0.1:'+Number(process.env.PREVIEW_PORT||3211);
export const {server,service}=createApplication({store,upstream:remote.upstream,origin:previewOrigin});
await new Promise(r=>server.listen(Number(process.env.PREVIEW_PORT||3211),'127.0.0.1',r));
console.log('LOCAL FIXTURE '+previewOrigin);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close();remote.server.close();store.close();process.exit(0);});
