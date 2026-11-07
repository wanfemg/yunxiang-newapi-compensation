// Local browser fixture. Both identity and AI upstreams are mocked.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {AIReviewer} from '../src/ai-review.mjs';
import {createApplication} from '../src/server.mjs';
import {mockServer,rules,log,user} from './helpers.mjs';

const remote=await mockServer(),store=new Store();
store.saveRules(rules({aiEnabled:true}),1,1);
store.create(log(),user,store.rules(),'管理员 AI 辅助审核预览','self',7);
const ai=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization!=='Bearer fixture-key'){
    res.statusCode=401;res.end(JSON.stringify({error:{message:'Invalid API key'}}));return;
  }
  if(req.url==='/v1/models'){
    res.end(JSON.stringify({success:true,object:'list',data:[{id:'fixture-chat'},{id:'fixture-empty'},{id:'fixture-denied'}]}));return;
  }
  if(req.url==='/v1/chat/completions'){
    const body=JSON.parse(raw);
    await new Promise(resolve=>setTimeout(resolve,300));
    if(body.model==='fixture-denied'){res.statusCode=403;res.end(JSON.stringify({error:{message:'Model permission denied'}}));return;}
    const content=body.model==='fixture-empty'?'':body.messages[0].content.includes('二次复核')?'{"decision":"empty","confidence":0.97,"recommendation":"approve","summary":"消费日志与空回补偿规则一致，建议通过。","reason":"输出 token 为零，消费额度为正，且没有退款证据。","evidence":["completion_tokens=0","原消费额度为 120"]}':body.messages[0].role==='system'?'{"decision":"empty","confidence":0.97,"reason":"没有有效输出","evidence":["completion_tokens=0"]}':'OK';
    res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content}}]}));return;
  }
  res.statusCode=404;res.end('{}');
});
ai.listen(0,'127.0.0.1');await once(ai,'listening');
const aiBase='http://127.0.0.1:'+ai.address().port+'/v1';
store.saveAIConfig({baseUrl:aiBase,apiKey:'fixture-key',model:'fixture-chat'},1);
const port=Number(process.env.PREVIEW_PORT||3217),origin='http://127.0.0.1:'+port;
const {server,service}=createApplication({store,upstream:remote.upstream,origin});
service.ai=new AIReviewer({store,env:{}});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
console.log(JSON.stringify({ui:origin,aiBase}));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  for(const item of [server,ai,remote.server]){item.closeAllConnections();item.close();}
  store.close();process.exit(0);
});
