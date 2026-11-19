import { randomBytes, createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError } from './rules.mjs';

const DAY=86400000;
const backupName=/^compensation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes=value=>Buffer.byteLength(String(value??''));
const clearedBody=JSON.stringify({contentCleared:true,title:'历史内容已清理'});
const contentCleared=body=>{try{return JSON.parse(body).contentCleared===true;}catch{return false;}};
const noticeHash=row=>digest([row.status,row.created_at,row.body,row.result,row.recipient]);
const evidenceKeys=['request_id','user_id','created_at','model_name','channel','quota','prompt_tokens','completion_tokens','other'];

export class StorageMaintenance {
  constructor(store,clock=Date.now){this.store=store;this.clock=clock;this.plans=new Map();}
  databaseFile(){return this.store.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file||null;}
  backupDirectory(){
    const file=this.databaseFile();if(!file)return null;
    const directory=join(realpathSync(dirname(file)),'backups');
    try{
      const stat=lstatSync(directory);
      return stat.isDirectory()&&!stat.isSymbolicLink()&&realpathSync(directory)===resolve(directory)?directory:null;
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  backups(){
    const directory=this.backupDirectory();if(!directory)return [];
    return readdirSync(directory).filter(name=>backupName.test(name)).flatMap(name=>{
      try{const stat=lstatSync(join(directory,name));return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1?[{name,size:stat.size,modifiedAt:stat.mtimeMs,signature:signature(stat)}]:[];}
      catch(error){if(error.code==='ENOENT')return [];throw error;}
    }).sort((a,b)=>b.modifiedAt-a.modifiedAt||b.name.localeCompare(a.name));
  }
  physical(files=this.backups()){
    const file=this.databaseFile();
    const size=path=>{if(!path)return 0;try{const stat=lstatSync(path);return stat.isFile()&&!stat.isSymbolicLink()?stat.size:0;}catch(error){if(error.code==='ENOENT')return 0;throw error;}};
    const databaseBytes=size(file),walBytes=size(file?file+'-wal':null),shmBytes=size(file?file+'-shm':null),backupBytes=files.reduce((sum,row)=>sum+row.size,0);
    return {databaseBytes,walBytes,shmBytes,backupBytes,totalBytes:databaseBytes+walBytes+shmBytes+backupBytes};
  }
  info(){
    const files=this.backups();
    return {...this.store.storageInfo(),physical:this.physical(files),observedAt:this.clock(),backups:{count:files.length,bytes:files.reduce((sum,row)=>sum+row.size,0),available:Boolean(this.backupDirectory()),retainedMinimum:3}};
  }
  settledEvidence(cutoff){
    const result=new Map();
    for(const row of this.store.db.prepare("SELECT request_id,user_id,log FROM claims WHERE status IN ('succeeded','rejected') AND updated_at<?").iterate(cutoff)){
      try{const log=JSON.parse(row.log);if(log.request_id===row.request_id&&Number(log.user_id)===row.user_id)result.set(row.user_id+':'+row.request_id,log);}catch{}
    }
    return result;
  }
  snapshotCandidate(row,cutoff,evidence){
    let snapshot;try{snapshot=JSON.parse(row.payload);}catch{return null;}
    if(!Array.isArray(snapshot.items)||snapshot.itemsOmitted)return null;
    const remove=[];
    snapshot.items.forEach((log,index)=>{
      if(!log||Number(log.user_id)!==row.user_id||!Number.isFinite(log.created_at)||log.created_at*1000>=cutoff)return;
      const saved=evidence.get(row.user_id+':'+log.request_id);
      if(saved&&evidenceKeys.every(key=>JSON.stringify(saved[key])===JSON.stringify(log[key])))remove.push(index);
    });
    if(!remove.length)return null;
    const removed=new Set(remove),items=snapshot.items.filter((_,index)=>!removed.has(index));
    const maintenance={...snapshot.maintenance,removedSettledCopies:Number(snapshot.maintenance?.removedSettledCopies||0)+remove.length,cleanedAt:this.clock()};
    const estimated=bytes(row.payload)-bytes(JSON.stringify({...snapshot,items,maintenance}));
    return {userId:row.user_id,hash:digest(row.payload),remove,count:remove.length,payloadBytes:Math.max(0,estimated)};
  }
  preview(actor,input){
    const options={};
    for(const key of ['cache','notifications','backups','compact']){
      if(typeof input[key]!=='boolean')throw new AppError('清理选项必须为开关');options[key]=input[key];
    }
    if(input.snapshots!==undefined&&typeof input.snapshots!=='boolean')throw new AppError('清理选项必须为开关');
    options.snapshots=input.snapshots??false;
    for(const [key,minimum,fallback] of [['cacheDays',1],['notificationDays',7],['backupDays',7],['snapshotDays',1,30]]){
      const value=input[key]??fallback;
      if(!Number.isSafeInteger(value)||value<minimum||value>3650)throw new AppError('清理保留天数无效');options[key]=value;
    }
    if(!['cache','notifications','backups','compact','snapshots'].some(key=>options[key]))throw new AppError('至少选择一种清理项目');
    const now=this.clock();
    for(const [token,plan] of this.plans)if(plan.expires<now)this.plans.delete(token);
    if(this.plans.size>=100)throw new AppError('清理预览过多，稍后重试',429);
    const cache=options.cache?this.store.db.prepare('SELECT cache_key,created_at,payload FROM log_query_cache WHERE created_at<?').all(now-options.cacheDays*DAY).map(row=>({key:row.cache_key,createdAt:row.created_at,hash:digest(row.payload),payloadBytes:bytes(row.payload)})):[];
    const notifications=[];
    if(options.notifications)for(const table of ['notifications','email_notifications']){
      const recipient=table==='email_notifications'?'recipient':'NULL AS recipient';
      for(const row of this.store.db.prepare(`SELECT id,status,created_at,body,result,${recipient} FROM ${table} WHERE created_at<? AND status IN ('sent','failed','cancelled','skipped')`).iterate(now-options.notificationDays*DAY)){
        if(contentCleared(row.body))continue;
        notifications.push({table,id:row.id,hash:noticeHash(row),payloadBytes:Math.max(0,bytes(row.body)+bytes(row.result)+bytes(row.recipient)-bytes(clearedBody)-bytes('历史内容已清理'))});
      }
    }
    const snapshots=[];
    if(options.snapshots){
      const cutoff=now-options.snapshotDays*DAY,evidence=this.settledEvidence(cutoff);
      for(const row of this.store.db.prepare('SELECT user_id,payload FROM log_query_progress').iterate()){
        const candidate=this.snapshotCandidate(row,cutoff,evidence);if(candidate)snapshots.push(candidate);
      }
    }
    const files=options.backups?this.backups().slice(3).filter(row=>row.modifiedAt<now-options.backupDays*DAY):[];
    const item=(rows,count=rows.length)=>({count,payloadBytes:rows.reduce((sum,row)=>sum+row.payloadBytes,0)});
    const breakdown={cache:item(cache),snapshots:item(snapshots,snapshots.reduce((sum,row)=>sum+row.count,0)),dingNotifications:item(notifications.filter(row=>row.table==='notifications')),emailNotifications:item(notifications.filter(row=>row.table==='email_notifications'))};
    const token=randomBytes(24).toString('base64url');
    this.plans.set(token,{actor,expires:now+300000,options,cache,notifications,snapshots,files,cutoff:now-options.snapshotDays*DAY});
    return {token,expiresAt:now+300000,cache:cache.length,notifications:notifications.length,snapshots:breakdown.snapshots.count,breakdown,payloadBytes:Object.values(breakdown).reduce((sum,row)=>sum+row.payloadBytes,0),backups:files.map(({name,size})=>({name,size})),backupBytes:files.reduce((sum,row)=>sum+row.size,0),compact:options.compact};
  }
  clean(actor,token,confirmation){
    const plan=this.plans.get(token);
    if(!plan||plan.actor!==actor||plan.expires<this.clock())throw new AppError('清理预览已失效，请重新预览',409);
    if(confirmation!=='确认清理')throw new AppError('请确认清理范围');
    if(this.store.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status='executing'").get().n)throw new AppError('正在发放补偿，请处理结束后再清理',409);
    this.plans.delete(token);
    const before=this.physical();
    const result=this.store.transaction(()=>{
      let cache=0,notifications=0,snapshots=0,payloadBytes=0;
      for(const planned of plan.cache){
        const row=this.store.db.prepare('SELECT payload,created_at FROM log_query_cache WHERE cache_key=?').get(planned.key);
        if(!row||row.created_at!==planned.createdAt||digest(row.payload)!==planned.hash)continue;
        cache+=this.store.db.prepare('DELETE FROM log_query_cache WHERE cache_key=?').run(planned.key).changes;payloadBytes+=planned.payloadBytes;
      }
      for(const planned of plan.notifications){
        const recipient=planned.table==='email_notifications'?'recipient':'NULL AS recipient';
        const row=this.store.db.prepare(`SELECT id,status,created_at,body,result,${recipient} FROM ${planned.table} WHERE id=?`).get(planned.id);
        if(!row||noticeHash(row)!==planned.hash)continue;
        const clearRecipient=planned.table==='email_notifications'?',recipient=NULL':'';
        notifications+=this.store.db.prepare(`UPDATE ${planned.table} SET body=?,result=?${clearRecipient} WHERE id=?`).run(clearedBody,'历史内容已清理',planned.id).changes;
        payloadBytes+=planned.payloadBytes;
      }
      if(plan.snapshots.length){
        const evidence=this.settledEvidence(plan.cutoff);
        for(const planned of plan.snapshots){
          const row=this.store.db.prepare('SELECT user_id,payload FROM log_query_progress WHERE user_id=?').get(planned.userId);
          if(!row||digest(row.payload)!==planned.hash)continue;
          const candidate=this.snapshotCandidate(row,plan.cutoff,evidence);
          if(!candidate||JSON.stringify(candidate.remove)!==JSON.stringify(planned.remove))continue;
          const snapshot=JSON.parse(row.payload),remove=new Set(candidate.remove);
          snapshot.items=snapshot.items.filter((_,index)=>!remove.has(index));
          snapshot.maintenance={...snapshot.maintenance,removedSettledCopies:Number(snapshot.maintenance?.removedSettledCopies||0)+candidate.count,cleanedAt:this.clock()};
          const next=JSON.stringify(snapshot);
          this.store.db.prepare('UPDATE log_query_progress SET payload=? WHERE user_id=?').run(next,row.user_id);
          snapshots+=candidate.count;payloadBytes+=Math.max(0,bytes(row.payload)-bytes(next));
        }
      }
      const value={cache,notifications,snapshots,payloadBytes,backups:0,backupBytes:0,skippedBackups:0,compacted:false};
      this.store.event(null,actor,'storage_cleanup',{options:plan.options,cache,notifications,snapshots,backupCandidates:plan.files.map(row=>row.name)});
      return value;
    });
    const allowed=new Map(this.backups().slice(3).map(row=>[row.name,row])),directory=this.backupDirectory();
    for(const file of plan.files){
      const current=allowed.get(file.name);
      if(!directory||current?.signature!==file.signature){result.skippedBackups++;continue;}
      try{
        const stat=lstatSync(join(directory,file.name));
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||signature(stat)!==file.signature){result.skippedBackups++;continue;}
        unlinkSync(join(directory,file.name));result.backups++;result.backupBytes+=file.size;
      }catch{result.skippedBackups++;}
    }
    if(plan.options.compact){
      try{this.store.db.exec('VACUUM');this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');result.compacted=true;}
      catch{result.compactError='记录清理完成，但空间整理未完成，请稍后重试';}
    }
    this.store.event(null,actor,'storage_cleanup_completed',result);
    // Include the audit write in measured size; payload removal is not a disk-space promise.
    result.physical={before,after:this.physical()};
    result.physicalReleasedBytes=Math.max(0,before.totalBytes-result.physical.after.totalBytes);
    return result;
  }
}
