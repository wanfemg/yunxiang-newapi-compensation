const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const fixtureOpen=fs.openSync, fixtureAppend=fs.appendFileSync, fixtureClose=fs.closeSync;
const root = path.resolve(process.env.YUNXIANG_HELPER_ROOT);
const mappings = JSON.parse(process.env.YUNXIANG_HELPER_MOUNTS || '{}');
const mappingEntries=Object.entries(mappings).sort((a,b)=>b[0].length-a[0].length);
function translate(value) {
  if (typeof value !== 'string') return value;
  let mapped = value;
  for (const [destination, source] of mappingEntries) {
    if (value === destination || value.startsWith(destination + '/')) { mapped = source + value.slice(destination.length); break; }
  }
  const absolute = path.resolve(mapped);
  if (absolute === root || absolute.startsWith(root + path.sep) || Object.values(mappings).some(source => absolute === path.resolve(source) || absolute.startsWith(path.resolve(source) + path.sep))) return mapped;
  const error = new Error(`ENOENT: unmounted container path ${value}`);
  error.code = 'ENOENT';
  throw error;
}
for (const name of ['readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'mkdirSync', 'openSync', 'chmodSync']) {
  const original = fs[name];
  fs[name] = function(value, ...args) { return original.call(this, translate(value), ...args); };
}
syncBuiltinESMExports();

// Simulate the HTTP transport only: the production upstream-check module,
// identity validation and response-schema checks all execute unchanged.
global.fetch=async function fixtureFetch(input, request={}) {
  const url=new URL(typeof input==='string'?input:input.url||String(input));
  const method=String(request.method||'GET').toUpperCase();
  const state=process.env.YUNXIANG_DOCKER_STATE;
  if(!state) throw Error('fixture API state missing');
  const descriptor=fixtureOpen(path.join(state,'api-calls.jsonl'),'a');
  try{fixtureAppend(descriptor,JSON.stringify({method,url:url.href})+'\n');}finally{fixtureClose(descriptor);}
  if(method!=='GET') throw Error('fixture forbids quota writes and other mutating API calls');
  if(process.env.MOCK_LINK_API_FAIL==='1') throw Error('fixture upstream unavailable');
  const id=Number(process.env.MOCK_LINK_API_USER_ID||1);
  const user={id,username:'fixture-admin',display_name:'Fixture administrator',role:100,status:1,quota:1000000,group:'default'};
  let data;
  if(url.pathname==='/api/status') data={system_name:'Fixture NewAPI',version:'fixture',quota_per_unit:500000};
  else if(url.pathname==='/api/user/self') data=user;
  else if(/^\/api\/user\/\d+$/.test(url.pathname)) data={...user,id:Number(url.pathname.split('/').at(-1))};
  else if(url.pathname==='/api/log/') data={items:[],total:0};
  else if(url.pathname==='/api/group/') data=['default'];
  else if(url.pathname==='/api/channel/') data={items:[{id:1,name:'fixture-channel',status:1,models:'fixture-model'}],total:1};
  else return new Response(JSON.stringify({success:false,message:'unsupported fixture API route'}),{status:404,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({success:true,data}),{status:200,headers:{'Content-Type':'application/json'}});
};
