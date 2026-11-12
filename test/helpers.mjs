import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { NewAPI } from '../src/newapi.mjs';
import { Compensation } from '../src/service.mjs';
import { defaults } from '../src/rules.mjs';

export const user = { id: 7, username: 'fixture-user', display_name: '本地验证用户', role: 1, status: 1, group: 'default' };
export const admin = { id: 1, username: 'fixture-admin', display_name: '本地验证站长', role: 100, status: 1, group: 'default' };
export function log(id = 'fixture-request-1', overrides = {}) {
  return { id: 100, user_id: user.id, username: user.username, created_at: Math.floor(Date.now()/1000) - 60, type: 2, model_name: 'fixture-model', channel: 3, quota: 120, prompt_tokens: 60, completion_tokens: 0, group: 'default', request_id: id, is_stream: true, other: JSON.stringify({ billing_source: 'wallet', admin_info: { reject_reason: 'gemini_empty_candidates' } }), ...overrides };
}
export function rules(overrides = {}) {
  return { ...structuredClone(defaults), applicationsEnabled: true, executionEnabled: true, channels: [3], models: ['fixture-model'], userDailyQuota: 1000, userDailyCount: 5, siteDailyQuota: 5000, siteDailyCount: 20, ...overrides };
}
export function fixture(options = {}) {
  const store = new Store(); store.saveRules(rules(options.rules), admin.id, 1);
  const logs = options.logs || [log()]; let calls = 0;
  const upstream = { logs: async ({user: owner,page=1,start=0,end=Infinity,model='',requestId='',channel=''} = {}) => {
    const rows=logs.filter(l=>(!owner||l.user_id===owner.id)&&l.created_at>=start&&l.created_at<=end&&(!model||l.model_name===model)&&(!requestId||l.request_id===requestId)&&(!channel||l.channel===Number(channel)));
    return {items:structuredClone(rows.slice((page-1)*30,page*30)),total:rows.length,page};
  }, log: async id => { const x=logs.filter(l=>l.request_id===id); if(x.length!==1)throw Error('ambiguous'); return structuredClone(x[0]); }, target: async () => user, credit: async (...args) => { calls++; if(options.credit) return options.credit(...args); } };
  return { store, upstream, service: new Compensation(store, upstream), logs, calls: () => calls };
}
export async function mockServer() {
  const data = { logs: [log()], credits: [], disabled: false, mode: 'success', identityCalls: 0 };
  const server = createServer(async (req,res) => {
    let body=''; for await(const chunk of req)body+=chunk; const b=body?JSON.parse(body):{};
    const url=new URL(req.url,'http://localhost');
    const reply=(d,success=true)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success,data:d}));};
    if(url.pathname==='/api/status')return reply(data.display||{quota_display_type:'CUSTOM',quota_per_unit:100,custom_currency_symbol:'额度 ',custom_currency_exchange_rate:1});
    if(url.pathname==='/api/user/login/encryption-key'){if(data.legacyLogin){res.statusCode=404;return reply(null,false);}return reply({enabled:false});}
    if(url.pathname==='/api/user/login') {
      const u=b.username===user.username?user:b.username===admin.username?admin:null;
      if(data.legacyLogin&&u&&b.password==='fixture-password'){res.setHeader('Set-Cookie',`session=legacy-${u.id}; HttpOnly; Path=/`);return reply(u);}
      return u&&b.password==='fixture-password'?reply({access_token:u.id===7?'fixture-user-token':'fixture-admin-token',user:u}):reply(null,false);
    }
    const token=req.headers.authorization;
    if(url.pathname==='/api/user/self') {
      data.identityCalls++;
      const u=token==='Bearer fixture-admin-token'?admin:(token==='Bearer fixture-user-token'||(data.legacyLogin&&req.headers.cookie==='session=legacy-7'))&&!data.disabled?user:null;
      return reply(u,Boolean(u));
    }
    if(token!=='Bearer fixture-admin-token') {res.statusCode=403;return reply(null,false);}
    if(url.pathname==='/api/channel/')return reply({items:data.channels||[{id:3,name:'主渠道',status:1,models:'fixture-model,gemini-2.5-pro,gemini-2.5-flash'},{id:5,name:'备用渠道',status:1,models:'gemini-2.5-flash'}],total:(data.channels||[3,5]).length});
    if(url.pathname==='/api/group/')return reply(data.groups||['default','vip','auto']);
    if(url.pathname==='/api/log/') {
      let items=data.logs;
      if(url.searchParams.get('request_id'))items=items.filter(l=>l.request_id===url.searchParams.get('request_id'));
      if(url.searchParams.get('username'))items=items.filter(l=>l.username===url.searchParams.get('username'));
      if(url.searchParams.get('model_name'))items=items.filter(l=>l.model_name===url.searchParams.get('model_name'));
      if(url.searchParams.get('channel'))items=items.filter(l=>l.channel===Number(url.searchParams.get('channel')));
      if(url.searchParams.get('start_timestamp'))items=items.filter(l=>l.created_at>=Number(url.searchParams.get('start_timestamp')));
      if(url.searchParams.get('end_timestamp'))items=items.filter(l=>l.created_at<=Number(url.searchParams.get('end_timestamp')));
      const page=Number(url.searchParams.get('p')||1),size=Number(url.searchParams.get('page_size')||30),total=items.length;
      items=[...items].sort((a,b)=>b.created_at-a.created_at||b.id-a.id).slice((page-1)*size,page*size);
      return reply({items,total});
    }
    if(url.pathname==='/api/user/7')return reply(user);
    if(url.pathname==='/api/user/manage') {
      data.credits.push(b);
      if(data.mode==='ambiguous'){res.statusCode=502;return reply(null,false);}
      return reply(null,data.mode!=='refused');
    }
    res.statusCode=404;reply(null,false);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const upstream=new NewAPI({url:'http://127.0.0.1:'+server.address().port,adminToken:'fixture-admin-token',adminUserId:1});
  return {server,data,upstream,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
