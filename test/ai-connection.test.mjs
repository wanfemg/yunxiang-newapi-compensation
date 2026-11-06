import test from 'node:test';
import assert from 'node:assert/strict';
import {AIReviewer,normalizeAIBaseURL} from '../src/ai-review.mjs';
import {Store} from '../src/store.mjs';

const env={AI_BASE_URL:'https://gateway.example/v1',AI_API_KEY:'fixture-key',AI_MODEL:'selected-model'};
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});

test('连接测试实际调用所选模型，不以模型列表成功代替推理成功',async()=>{
  const calls=[],reviewer=new AIReviewer({env,fetcher:async(url,options)=>{
    calls.push({url,options});
    return url.endsWith('/models')?json({data:[{id:'selected-model'}]}):json({choices:[{message:{content:'OK'}}]});
  }});
  const result=await reviewer.test();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://gateway.example/v1/chat/completions');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-key');
  const body=JSON.parse(calls[0].options.body);
  assert.equal(body.model,'selected-model');
  assert.equal(body.stream,false);
  assert.ok(body.messages.length);
  assert.equal(result.reply,'OK');
});

test('没有选择模型时禁止连接测试且不发送上游请求',async()=>{
  let calls=0;
  const reviewer=new AIReviewer({env:{...env,AI_MODEL:''},fetcher:async()=>{calls++;return json({data:[]});}});
  await assert.rejects(()=>reviewer.test(),/模型/);
  assert.equal(calls,0);
});

test('页面保存的地址密钥和模型优先于旧环境配置',async t=>{
  const store=new Store();t.after(()=>store.close());
  store.saveAIConfig({baseUrl:'https://saved.example/v1',apiKey:'saved-key',model:'saved-model',timeoutMs:12000,prompt:'saved prompt'},1);
  const reviewer=new AIReviewer({store,env,fetcher:async(url,options)=>{
    assert.equal(url,'https://saved.example/v1/models');
    assert.equal(options.headers.Authorization,'Bearer saved-key');
    return json({data:[{id:'saved-model'}]});
  }});
  assert.equal(reviewer.config().model,'saved-model');
  assert.deepEqual(await reviewer.models(),[{id:'saved-model',name:'saved-model'}]);
});

test('模型拉取支持 v1 尾斜杠，忽略坏条目并去重',async()=>{
  const reviewer=new AIReviewer({env:{...env,AI_BASE_URL:env.AI_BASE_URL+'///'},fetcher:async(url,options)=>{
    assert.equal(url,'https://gateway.example/v1/models');
    assert.equal(options.headers.Authorization,'Bearer fixture-key');
    return json({data:[null,{id:'model-a'},{id:'model-a'},'model-b',{},42]});
  }});
  assert.deepEqual(await reviewer.models(),[{id:'model-a',name:'model-a'},{id:'model-b',name:'model-b'}]);
});

test('域名根地址统一使用 v1 模型及聊天端点',async()=>{
  const urls=[],reviewer=new AIReviewer({env:{...env,AI_BASE_URL:'https://gateway.example'},fetcher:async url=>{
    urls.push(url);return url.endsWith('/models')?json({data:[]}):json({choices:[{message:{content:'OK'}}]});
  }});
  await reviewer.models();await reviewer.test();
  assert.deepEqual(urls,['https://gateway.example/v1/models','https://gateway.example/v1/chat/completions']);
});

test('模型拉取拒绝网页、业务错误和错误格式而非显示零个模型',async()=>{
  for(const response of [new Response('<html>login</html>'),json({success:false,message:'token expired'}),json({unexpected:[]})]){
    const reviewer=new AIReviewer({env,fetcher:async()=>response});
    await assert.rejects(()=>reviewer.models(),/JSON|格式|token expired/);
  }
});

test('模型鉴权失败保留 HTTP 401 且不盲目换地址，错误不泄漏密钥',async()=>{
  let calls=0;const reviewer=new AIReviewer({env,fetcher:async()=>{
    calls++;return new Response(JSON.stringify({error:{message:'invalid fixture-key'}}),{status:401});
  }});
  await assert.rejects(()=>reviewer.models(),error=>/401/.test(error.message)&&!/fixture-key/.test(error.message));
  assert.equal(calls,1);
});

test('模型测试拒绝空回复、业务错误和模型不可用',async()=>{
  for(const response of [json({choices:[{message:{content:''}}]}),json({error:{message:'model unavailable'}}),new Response(JSON.stringify({error:{message:'model_not_found'}}),{status:404})]){
    const reviewer=new AIReviewer({env,fetcher:async()=>response});
    await assert.rejects(()=>reviewer.test(),/空|无有效|model/);
  }
});

test('统一地址处理保留代理前缀，兼容完整端点并拒绝带凭据的地址',()=>{
  for(const suffix of ['', '/', '/v1', '/v1///', '/v1/models','/v1/chat/completions']){
    assert.equal(normalizeAIBaseURL('https://gateway.example'+suffix),'https://gateway.example/v1');
  }
  assert.equal(normalizeAIBaseURL('https://gateway.example/proxy/v1/'),'https://gateway.example/proxy/v1');
  assert.equal(normalizeAIBaseURL('https://gateway.example/custom-api'),'https://gateway.example/custom-api');
  for(const suffix of ['?key=secret','#secret'])assert.throws(()=>normalizeAIBaseURL(env.AI_BASE_URL+suffix),/地址/);
  assert.throws(()=>normalizeAIBaseURL('https://user:secret@gateway.example/v1'),/凭据/);
});

test('模型列表常见数组格式、文本分块回复和网络失败均明确处理',async()=>{
  for(const body of [{data:['a','b']},{models:[{name:'a'},{name:'b'}]},{result:['a','b']},['a','b']]){
    const reviewer=new AIReviewer({env,fetcher:async()=>json(body)});
    assert.deepEqual((await reviewer.models()).map(item=>item.id),['a','b']);
  }
  const chunks=new AIReviewer({env,fetcher:async()=>json({choices:[{message:{content:[{type:'text',text:'OK'}]}}]})});
  assert.equal((await chunks.test()).reply,'OK');
  for(const [error,expected] of [[Object.assign(new Error('aborted'),{name:'TimeoutError'}),/超时/],[{cause:{code:'ENOTFOUND'}},/域名解析/],[{cause:{code:'CERT_HAS_EXPIRED'}},/证书/]]){
    const reviewer=new AIReviewer({env,fetcher:async()=>{throw error;}});
    await assert.rejects(()=>reviewer.models(),expected);
  }
});
