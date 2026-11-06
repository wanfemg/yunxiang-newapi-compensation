// Local browser fixture: SMTP delivery is mocked and no real messages are sent.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {EmailNotifications} from '../src/email-notifications.mjs';
import {createApplication} from '../src/server.mjs';
import {mockServer,rules,user,log} from './helpers.mjs';
const remote=await mockServer(),store=new Store(),directory=mkdtempSync(join(tmpdir(),'notify-preview-'));store.saveRules(rules({aiEnabled:true}),1,1);
const target=remote.upstream.target.bind(remote.upstream);remote.upstream.target=async id=>({...await target(id),setting:JSON.stringify({notification_email:'preview@example.com'})});
const mail=new EmailNotifications(store,directory,{upstream:remote.upstream,sender:async()=>{}});
mail.save({host:'smtp.example.com',port:587,security:'starttls',username:'preview',password:'fixture-only',fromEmail:'sender@example.com',fromName:'云响补空回',enabled:true});
store.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('display',?)").run(JSON.stringify(await remote.upstream.display()));
for(const status of ['approved','succeeded']){
  await mail.notifyClaims(status,[{id:'preview-'+status,request_id:'preview-'+status,user_id:7,username:user.username,status,amount:status==='succeeded'?120:0,log:log('preview-'+status),rules:store.rules()}]);
}
await mail.flush();
store.create(log(),user,store.rules(),'本地界面验证','self',7);
const port=Number(process.env.PREVIEW_PORT||3216),origin='http://127.0.0.1:'+port;
const {server}=createApplication({store,upstream:remote.upstream,emailNotifications:mail,origin});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));console.log('LOCAL MOCK UI '+origin);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close();remote.server.closeAllConnections();remote.server.close();store.close();if(directory.startsWith(join(tmpdir(),'notify-preview-')))rmSync(directory,{recursive:true,force:true});process.exit(0);});
