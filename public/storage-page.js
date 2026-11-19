const esc=value=>String(value??'').replace(/[&<>"']/g,char=>'&#'+char.charCodeAt(0)+';');
export function storageBytes(value){
  const bytes=Math.max(0,Number(value)||0),units=['B','KB','MB','GB','TB'];
  let amount=bytes,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++;}
  return (index?amount.toLocaleString('zh-CN',{maximumFractionDigits:2}):String(amount))+' '+units[index];
}
const categoryNotes={
  cache:'可清理过期缓存，下次查询自动重新生成。',
  snapshots:'仅精简已结案申请的旧副本；未申请日志、待审核证据和查询截止时间保留。',
  batches:'保留原始日志、批次身份及补偿金额。',
  claims:'保留申请、消费证据、审核结果与发放记录。',
  aiReviews:'保留模型判定依据和防重复审核记录。',
  audit:'保留管理员操作记录。',
  dingNotifications:'可清理已结束通知的正文；发送状态和去重标记保留。',
  emailNotifications:'可清理已结束邮件的正文及收件信息；发送状态和去重标记保留。',
  inbox:'保留用户可查看的审核与补偿消息。',
  system:'保留配置、补偿次数、处理中占位、AI 审核次数和通知去重标记。'
};
export function renderStoragePage(data,{num=value=>Number(value||0).toLocaleString('zh-CN'),date=value=>new Date(value).toLocaleString('zh-CN'),icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>'}={}){
  const physical=data.physical||{},categories=data.categories||[],total=Number(physical.totalBytes||0);
  const files=[['数据库文件',physical.databaseBytes,'database'],['写入日志 WAL',physical.walBytes,'file-clock'],['共享索引 SHM',physical.shmBytes,'layers-2'],['备份快照',physical.backupBytes,'archive']];
  const option=(name,label,description,daysName,days,min,checked=false,disabled=false)=>'<div class="storage-clean-row"><label class="storage-clean-choice"><input type="checkbox" name="'+name+'" '+(checked?'checked ':'')+(disabled?'disabled ':'')+'><span><strong>'+label+'</strong><small>'+description+'</small></span></label><label class="storage-retention">保留最近<span><input name="'+daysName+'" type="number" value="'+days+'" min="'+min+'" max="3650" step="1" required aria-label="'+label+'保留天数">天</span></label></div>';
  const rows=categories.map(row=>'<tr><td><strong>'+esc(row.label)+'</strong><span>'+esc(categoryNotes[row.key]||'')+'</span></td><td>'+esc(num(row.count))+'</td><td>'+esc(storageBytes(row.payloadBytes))+'</td><td><span class="storage-policy '+(row.cleanup==='retained'?'is-retained':'')+'">'+(row.cleanup==='retained'?'完整保留':row.cleanup==='contentOnly'?'仅清正文':row.cleanup==='settledCopies'?'仅旧副本':'可清理')+'</span></td></tr>').join('');
  return '<div class="storage-page"><section class="storage-overview"><div class="storage-overview-heading"><div><p class="eyebrow">存储概况</p><h2>'+esc(storageBytes(total))+'<small>实际文件合计</small></h2></div><span class="storage-persistence">'+icon(data.persistent?'hard-drive':'flask-conical')+(data.persistent?'持久数据库':'内存预览 · 无磁盘文件')+'</span></div><div class="storage-files">'+files.map(([label,value,name])=>'<div>'+icon(name)+'<span>'+label+'</span><strong>'+esc(storageBytes(value))+'</strong></div>').join('')+'</div><div class="storage-capacity-note"><span>数据库已分配 '+esc(storageBytes(data.logicalBytes??data.bytes))+'</span><span>可复用空闲页 '+esc(storageBytes(data.freeBytes))+'</span><span>统计时间 '+esc(date(data.observedAt))+'</span></div></section><section class="storage-categories"><div class="storage-section-heading"><h3>'+icon('chart-no-axes-combined')+'数据分类</h3><span>正文估算合计 '+esc(storageBytes(data.payloadBytes))+'</span></div><p class="storage-explanation">分类容量按正文的 UTF-8 字节估算。数据库还包含索引和页空间，因此分类合计与实际文件容量不同。</p><div class="storage-table-wrap"><table class="storage-table"><thead><tr><th>数据内容</th><th>记录数</th><th>正文估算</th><th>清理范围</th></tr></thead><tbody>'+rows+'</tbody></table></div></section><section class="storage-cleanup"><div class="storage-section-heading"><h3>'+icon('brush-cleaning')+'按保留期限清理</h3></div><form id="storage-form">'+option('cache','临时查询缓存','仅清理超过保留期限的缓存。','cacheDays',7,1,true)+option('snapshots','已结案日志副本','仅精简已补偿或已驳回申请的旧副本，原始证据保留。','snapshotDays',30,1)+option('notifications','已结束通知内容','清理钉钉与邮件正文，不删除去重记录；待发送和发送中的内容保留。','notificationDays',30,7)+option('backups','旧备份快照','始终保留最新 3 份，预览后变化的文件自动跳过。','backupDays',30,7,false,!data.backups?.available)+'<label class="storage-compact"><input type="checkbox" name="compact"><span><strong>清理后整理数据库空间</strong><small>整理期间会短暂占用数据库，完成后显示实际文件变化。</small></span></label><div class="storage-submit"><p>'+icon('shield-check')+'申请账本、查询截止时间和防重复记录始终保留。</p><button type="submit" class="primary">'+icon('scan-search')+'预览清理</button></div></form></section></div>';
}
export function readStorageOptions(form){
  const fields=new FormData(form),result={};
  for(const key of ['cache','snapshots','notifications','backups','compact'])result[key]=fields.has(key);
  for(const key of ['cacheDays','snapshotDays','notificationDays','backupDays'])result[key]=Number(fields.get(key));
  return result;
}
export function renderStoragePlan(plan,{num=value=>Number(value||0).toLocaleString('zh-CN'),date=value=>new Date(value).toLocaleString('zh-CN'),icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>'}={}){
  const rows=[['过期查询缓存',plan.cache,plan.breakdown?.cache?.payloadBytes],['已结案日志副本',plan.snapshots||0,plan.breakdown?.snapshots?.payloadBytes],['钉钉通知正文',plan.breakdown?.dingNotifications?.count||0,plan.breakdown?.dingNotifications?.payloadBytes],['邮件通知正文',plan.breakdown?.emailNotifications?.count||0,plan.breakdown?.emailNotifications?.payloadBytes],['旧备份快照',plan.backups.length,plan.backupBytes]];
  return '<div class="storage-plan"><p class="notice">仅执行下列预览范围，预览后更新的数据会自动跳过。</p><dl class="storage-plan-summary">'+rows.map(([label,count,bytes])=>'<div><dt>'+label+'</dt><dd><strong>'+esc(num(count))+'</strong><span>'+esc(storageBytes(bytes))+'</span></dd></div>').join('')+'</dl><p class="storage-explanation">正文估算减少 '+esc(storageBytes(plan.payloadBytes))+'，备份删除 '+esc(storageBytes(plan.backupBytes))+'。实际磁盘变化会在执行后重新测量。</p><p class="storage-plan-protected">'+icon('shield-check')+'补偿账本、原始证据、秒级查询进度及通知去重标记保留。</p><p class="storage-explanation">'+(plan.compact?'执行后整理数据库空间。':'本次不整理数据库空间。')+'预览有效至 '+esc(date(plan.expiresAt))+'。</p>'+(plan.backups.length?'<details class="storage-backup-list"><summary>查看将删除的备份</summary><ul>'+plan.backups.map(row=>'<li><span>'+esc(row.name)+'</span><strong>'+esc(storageBytes(row.size))+'</strong></li>').join('')+'</ul></details>':'')+'<div class="dialog-footer"><button type="button" id="storage-confirm" class="primary">'+icon('trash-2')+'确认清理</button></div></div>';
}
