import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args=process.argv.slice(2),root=process.env.MIGRATION_FIXTURE;
const statePath=join(root,'docker-state.json');
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{volume:false,running:true};
const save=()=>writeFileSync(statePath,JSON.stringify(state));
appendFileSync(join(root,'calls.jsonl'),JSON.stringify(args)+'\n');
const fail=(message,code=1)=>{console.error(message);process.exit(code);};
const hostPath=value=>process.platform!=='win32'?value:value.replace(/^\/([a-z])\//i,(_,letter)=>letter.toUpperCase()+':/').replace(/^\/tmp(?=\/|$)/,tmpdir().replaceAll('\\','/'));
if(args[0]==='info'||args[0]==='context'||args[0]==='pull'||args[0]==='image')process.exit(0);
if(args[0]==='volume'){
  if(args[1]==='inspect')process.exit(state.volume?0:1);
  if(args[1]==='create'){state.volume=true;mkdirSync(join(root,'volume'),{recursive:true});save();process.exit(0);}
  if(args[1]==='rm'){state.volume=false;rmSync(join(root,'volume'),{recursive:true,force:true});save();process.exit(0);}
}
if(args[0]==='ps'){
  if(args.some(arg=>arg.includes('volume='))){if(state.running)console.log('fixture-yunxiang');}
  else if(state.container!==false)console.log('fixture-yunxiang');
  process.exit(0);
}
if(args[0]==='inspect'){
  if(args.includes('--format'))console.log(state.running?'true':'false');
  else console.log(JSON.stringify([{Id:'fixture-yunxiang',Name:'/yunxiang-compensation',State:{Running:state.running},Config:{Labels:{'com.docker.compose.project':'newapi-compensation','com.docker.compose.service':'compensation'}}}]));
  process.exit(0);
}
if(args[0]==='stop'){state.running=false;save();process.exit(0);}
if(args[0]==='start'){state.running=true;save();process.exit(0);}
if(args[0]==='run'){
  if(process.env.MIGRATION_HELPER_FAIL==='1')fail('fixture helper failure',27);
  const mappings=[];
  for(let index=1;index<args.length;index++){
    if(args[index]==='-v'){
      const mount=args[++index],match=mount.match(/^(.*):(\/[^:]+)(?::(rw|ro))?$/);
      if(!match)fail('bad mount '+mount);
      const source=match[1]==='newapi-compensation_compensation_data'?join(root,'volume'):hostPath(match[1]);
      if(match[1]==='newapi-compensation_compensation_data'&&!state.volume){
        state.volume=true;mkdirSync(source,{recursive:true});save();
      }
      mappings.push([match[2],source.replaceAll('\\','/')]);
    }
  }
  const imageIndex=args.findIndex(arg=>/^(?:node|alpine):/.test(arg));
  if(imageIndex===-1)fail('missing helper image');
  const command=args.slice(imageIndex+1);
  const project=value=>{for(const [target,source] of mappings.sort((a,b)=>b[0].length-a[0].length))value=value.replaceAll(target,source);return value;};
  let result;
  if(command[0]==='node'){
    const code=project(readFileSync(0,'utf8')).replace(/from '([a-z]:\/[^']+)'/ig,(_,path)=>`from '${pathToFileURL(path).href}'`);
    result=spawnSync(process.execPath,command.slice(1),{input:code,encoding:'utf8'});
  }else if(command[0]==='sh'){
    result=spawnSync(process.env.BASH_PATH,command.slice(1).map(project),{encoding:'utf8'});
  }else fail('unexpected helper command '+JSON.stringify(command));
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  process.exit(result.status??1);
}
fail('unexpected docker invocation '+JSON.stringify(args));
