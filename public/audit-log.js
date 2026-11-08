const esc=value=>String(value??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const definitions={
  application_created:['提交补偿申请','neutral','file-plus'],
  ai_review_started:['开始 AI 空回审查','neutral','sparkles'],
  ai_reviewed:['AI 空回判定完成','neutral','sparkles'],
  admin_ai_reviewed:['管理员 AI 二次复核','neutral','sparkles'],
  self_service_routed:['核验完成并分流','neutral','git-branch'],
  execution_reserved:['开始补偿执行','neutral','loader'],
  pending:['转入人工审核','neutral','clock'],
  approved:['审核通过 · 等待补偿','good','check'],
  rejected:['审核未通过','bad','x'],
  executing:['正在执行补偿','neutral','loader'],
  succeeded:['补偿成功','good','circle-check'],
  failed:['补偿失败','bad','circle-x'],
  unknown:['到账结果待核对','warning','triangle-alert'],
  rules_updated:['更新补偿规则','neutral','sliders-horizontal'],
  ai_config_updated:['更新 AI 审查配置','neutral','settings'],
  notification_config_updated:['更新钉钉通知配置','neutral','bell'],
  email_notification_config_updated:['更新邮箱通知配置','neutral','mail'],
  email_notification_enqueue_failed:['邮件通知入队失败','bad','mail'],
  storage_cleanup:['开始清理缓存','neutral','database'],
  storage_cleanup_completed:['缓存清理完成','good','database']
};
Object.assign(definitions,{
  batch_executing:['整批补额度中','neutral','loader'],
  batch_succeeded:['整批补偿成功','good','circle-check'],
  batch_failed:['整批补偿失败','bad','circle-x'],
  batch_unknown:['整批到账待核对','warning','triangle-alert']
});
const decisions={empty:'判为空回',not_empty:'判为非空回',uncertain:'无法确定空回'};
const ruleLabels={applicationsEnabled:'申请开关',executionEnabled:'补偿执行开关',applicationHours:'允许查询时长',aiEnabled:'AI 审查开关',aiAutoThreshold:'AI 自动通过阈值',aiDailyLimit:'AI 每日次数',models:'参与模型',channels:'参与渠道',excludedModels:'排除模型',perRecordQuota:'单笔上限',selfServiceMaxQuota:'自助额度上限',userDailyQuota:'用户每日额度',userDailyCount:'用户每日次数',siteDailyQuota:'全站每日额度',siteDailyCount:'全站每日次数',notifications:'钉钉通知',emailNotifications:'邮箱通知',timezone:'时区',openStart:'开放起始时间',openEnd:'开放截止时间'};
function detailOf(event){try{const value=typeof event.detail==='string'?JSON.parse(event.detail):event.detail;return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
export function describeAuditEvent(event,{formatQuota=n=>String(n)}={}){
  const d=detailOf(event),[title,tone,icon]=definitions[event.action]||['其他操作','neutral','info'];
  let summary=d.note||d.reason||'';
  if(event.action==='application_created')summary=(d.source==='manual'?'管理员发起人工补偿':'用户提交补偿申请')+(d.reason?' · '+d.reason:'');
  if(event.action==='ai_review_started')summary='正在结合消费日志与补偿规则判断是否空回';
  if(['ai_reviewed','admin_ai_reviewed'].includes(event.action)){
    const confidence=typeof d.confidence==='number'&&Number.isFinite(d.confidence)?' · 置信度 '+Math.round(d.confidence*100)+'%':'';
    summary=(d.status==='failed'?'AI 审查失败':decisions[d.decision]||'判定已记录')+confidence+(d.reason?' · '+d.reason:'');
  }
  if(event.action==='self_service_routed')summary=(d.route==='automatic'?'符合自动补偿条件':'转管理员人工审核')+(Array.isArray(d.reasons)&&d.reasons.length?' · '+d.reasons.join('；'):'');
  if(event.action==='execution_reserved')summary='已锁定本笔额度，正在核验并提交补偿'+(Number.isFinite(d.amount)?' · '+formatQuota(d.amount):'');
  if(event.action==='succeeded')summary='原站已确认补偿成功'+(Number.isFinite(event.amount)?' · 补回 '+formatQuota(event.amount):'')+(summary?' · '+summary:'');
  if(event.action.startsWith('batch_'))summary=(d.note||'全部审核完成，正在合并补额度')+(Number.isFinite(d.amount)?' · 合计 '+formatQuota(d.amount):'')+(event.action==='batch_succeeded'?' · 计 1 次补偿':'');
  if(event.action==='approved')summary='已通过审核，实际到账以补偿成功为准'+(summary?' · '+summary:'');
  if(event.action==='unknown')summary=summary||'尚无法确认原站是否到账，需要人工核对，禁止重复补偿';
  if(event.action==='rules_updated'){
    const keys=Object.keys(d.after||{}).filter(k=>k!=='version'&&JSON.stringify(d.before?.[k])!==JSON.stringify(d.after[k]));
    summary=keys.length?'已调整：'+keys.map(k=>ruleLabels[k]||k).join('、'):'补偿规则已保存';
  }
  if(event.action==='ai_config_updated')summary=[d.aiEnabled===undefined?'AI 配置已保存':d.aiEnabled?'AI 审查已开启':'AI 审查已关闭',d.model?'模型 '+d.model:'',Number.isFinite(d.aiAutoThreshold)?'自动通过阈值 '+d.aiAutoThreshold+'%':'',d.apiKeyChanged?'已更新密钥':''].filter(Boolean).join(' · ');
  if(event.action==='notification_config_updated')summary='钉钉通知配置已保存';
  if(event.action==='email_notification_config_updated')summary=(d.enabled?'邮箱通知已开启':'邮箱通知已关闭')+(d.host?' · '+d.host:'');
  if(event.action==='email_notification_enqueue_failed')summary='补偿处理已记录，邮件未能加入发送队列，请检查邮件配置';
  if(event.action==='storage_cleanup')summary='开始清理可过期缓存和通知发送记录';
  if(event.action==='storage_cleanup_completed')summary='缓存维护完成，申请记录与查询进度保留';
  return {title,tone,icon,summary:summary||'操作已记录，展开原始记录查看详情'};
}
export function groupAuditEvents(events){
  const groups=new Map();
  for(const event of [...events].sort((a,b)=>b.id-a.id)){
    const key=event.batchId?'batch:'+event.batchId:event.claim_id?'claim:'+event.claim_id:'event:'+event.id;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(event);
  }
  return [...groups.values()];
}
export function renderAuditLog(events,options={}){
  const date=options.date||(value=>new Date(value).toLocaleString('zh-CN',{hour12:false}));
  const groups=groupAuditEvents(events),count=actions=>groups.filter(g=>actions.includes(g[0].action)).length;
  const metrics=[['处理记录',groups.length],['补偿成功',count(['succeeded','batch_succeeded'])],['审核未通过',count(['rejected'])],['异常待处理',count(['failed','unknown','batch_failed','batch_unknown','email_notification_enqueue_failed'])]];
  return '<div class="audit-metrics">'+metrics.map(([label,n])=>'<div><span>'+label+'</span><strong>'+n+'</strong></div>').join('')+'</div><ol class="audit-list" aria-label="最近操作记录">'+groups.map(group=>{
    const event=group[0],item=describeAuditEvent(event,options),linked=group.find(e=>e.claim_id),target=event.targetUsername||linked?.targetUsername||('用户 #'+event.targetUserId);
    const models=[...new Set(group.flatMap(e=>e.models?.length?e.models:e.model?[e.model]:[]))];
    const process=group.map(e=>{
      const raw=detailOf(e),formatted=Object.keys(raw).length?JSON.stringify(raw,null,2):typeof e.detail==='string'?e.detail:JSON.stringify(e.detail??{});
      const step=describeAuditEvent(e,options);
      return '<li><div class="audit-step-heading"><strong>'+esc(step.title)+'</strong><time>'+esc(date(e.created_at))+'</time></div><p>'+esc(step.summary)+'</p><details class="audit-raw"><summary>原始记录 #'+esc(e.id)+'</summary><dl><dt>动作代码</dt><dd>'+esc(e.action)+'</dd>'+(e.claim_id?'<dt>申请编号</dt><dd>'+esc(e.claim_id)+'</dd>':'')+(e.requestId?'<dt>原请求标识</dt><dd>'+esc(e.requestId)+'</dd>':'')+'</dl><pre>'+esc(formatted)+'</pre></details></li>';
    }).join('');
    return '<li class="audit-entry audit-'+item.tone+'"><div class="audit-symbol" aria-hidden="true"><i data-lucide="'+item.icon+'"></i></div><div class="audit-content"><div class="audit-heading"><h3>'+esc(item.title)+'</h3><time>'+esc(date(event.created_at))+'</time></div><div class="audit-target">'+(event.claim_id||event.batchId?'<strong>申请用户：'+esc(target)+'</strong>'+models.map(model=>'<span class="audit-model">'+esc(model)+'</span>').join(''):'<span class="audit-scope">系统配置 / 维护</span>')+'</div><p class="audit-summary">'+esc(item.summary)+'</p><div class="audit-bottom"><span class="audit-meta">操作人：'+esc(event.actorName||'#'+event.actor_id)+'</span>'+(linked?'<button class="ghost" data-detail="'+esc(linked.claim_id)+'">查看申请 →</button>':'')+'<details class="audit-process"><summary>处理过程 · '+group.length+' 条</summary><ol>'+process+'</ol></details></div></div></li>';
  }).join('')+'</ol>';
}
