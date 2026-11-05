const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const labels = {
  log:'原消费',rules:'补偿规则',other:'扩展信息',verification_note:'核验说明',attempt_id:'执行尝试 ID',
  id:'ID',request_id:'请求 ID',upstream_request_id:'上游请求 ID',user_id:'用户 ID',username:'用户名',
  model_name:'模型',channel:'渠道 ID',channel_id:'渠道 ID',group:'用户组',quota:'原消费额度',
  prompt_tokens:'输入 Token',completion_tokens:'输出 Token',created_at:'消费时间',use_time:'耗时（秒）',
  billing_source:'扣费来源',billing_mode:'计费模式',billing_unit:'计费单位',subscription_id:'订阅 ID',
  subscription_plan_id:'订阅套餐 ID',subscription_plan_title:'订阅套餐',subscription_consumed:'订阅已消费额度',
  subscription_remain:'订阅剩余额度',subscription_total:'订阅总额度',stream_status:'流式响应状态',
  end_error:'结束错误',end_reason:'结束原因',status:'状态',request_policy:'请求调度',admin_info:'管理信息',
  attempt:'尝试次数',elapsed_ms:'耗时（毫秒）',decision:'调度决策',action:'动作',reason:'原因',source:'来源',
  version:'规则版本',applicationsEnabled:'开放申请',executionEnabled:'开放返还',selfServiceEnabled:'自动审批',
  selfServiceMaxQuota:'自动审批单笔上限',selfServiceMinAgeSeconds:'结算等待（秒）',timezone:'结算时区',
  channels:'可补渠道',models:'可补模型',excludedModels:'排除模型',restrictModels:'限定模型',userGroups:'可补用户组',
  blockedUsers:'排除用户 ID',refundBasisPoints:'返还比例',perRecordQuota:'单笔上限',userDailyQuota:'用户每日额度',
  userDailyCount:'用户每日笔数',siteDailyQuota:'全站每日额度',siteDailyCount:'全站每日笔数',maxPending:'最多待审核申请',
  applicationHours:'申请有效期（小时）',consumptionStart:'消费开始时间',consumptionEnd:'消费结束时间',
  openStart:'开放开始时间',openEnd:'开放结束时间',dailyResetTime:'每日重置时间',notifications:'通知配置',enabled:'启用',events:'通知事件'
};
const quotaKeys = new Set(['quota','selfServiceMaxQuota','perRecordQuota','userDailyQuota','siteDailyQuota','subscription_consumed','subscription_remain','subscription_total']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value,key) => Object.hasOwn(value,key);
const number = value => typeof value==='number'&&Number.isFinite(value);
const icon = name => '<i data-lucide="'+name+'" aria-hidden="true"></i>';

// Decode object/array strings only; identifiers and scalar strings must stay unchanged.
export function parseSnapshotValue(value) {
  const original=value;
  for(let i=0;i<3&&typeof value==='string';i++) {
    const text=value.trim();
    if(!['{','[','"'].includes(text[0]))break;
    try {
      const parsed=JSON.parse(text);
      if(parsed===null||!['object','string'].includes(typeof parsed))break;
      if(typeof parsed==='object')return parsed;
      value=parsed;
    } catch { break; }
  }
  return original;
}

export function renderSnapshot(snapshot, {formatQuota=String}={}) {
  let remaining=2000;
  const scalar=(value,key)=>{
    if(value===null||value===undefined)return '<span class="snapshot-muted">未记录</span>';
    if(typeof value==='boolean')return '<span class="snapshot-boolean '+(value?'is-true':'')+'">'+(value?'是':'否')+'</span>';
    if(value==='')return '<span class="snapshot-muted">空字符串</span>';
    let text=typeof value==='object'?JSON.stringify(value):String(value);
    if(typeof value==='number'&&Number.isFinite(value)) {
      if(quotaKeys.has(key))text=formatQuota(value)+' · 原始值 '+value;
      else if(key==='refundBasisPoints')text=value/100+'%';
      else if(['created_at','consumptionStart','consumptionEnd'].includes(key)) {
        const time=new Date(value*1000);
        if(Number.isFinite(time.getTime()))text=time.toLocaleString('zh-CN',{hour12:false});
      }
    }
    return '<span class="snapshot-value">'+escape(text)+'</span>';
  };
  const fields=(value,depth=0)=>{
    const entries=Object.entries(value);
    if(!entries.length)return '<p class="snapshot-muted">'+(Array.isArray(value)?'空列表':'空对象')+'</p>';
    let html='';
    for(const [key,raw] of entries) {
      if(remaining--<=0){html+='<p class="snapshot-muted">其余字段见原始 JSON</p>';break;}
      const parsed=parseSnapshotValue(raw),compound=parsed!==null&&typeof parsed==='object';
      const label=Array.isArray(value)?'第 '+(Number(key)+1)+' 项':labels[key]||key;
      const heading='<span class="snapshot-label">'+escape(label)+(labels[key]?'<code>'+escape(key)+'</code>':'')+'</span>';
      if(compound&&depth<8)html+='<details class="snapshot-node"><summary>'+heading+'<span class="snapshot-count">'+Object.keys(parsed).length+' 项</span></summary><div class="snapshot-children">'+fields(parsed,depth+1)+'</div></details>';
      else html+='<div class="snapshot-row">'+heading+scalar(compound?JSON.stringify(parsed):parsed,key)+'</div>';
    }
    return html;
  };
  const section=(title,value,open=false)=>'<details class="snapshot-section" '+(open?'open':'')+'><summary>'+escape(title)+icon('chevron-down')+'</summary><div class="snapshot-fields">'+(value!==null&&typeof value==='object'?fields(value):scalar(value))+'</div></details>';
  const metric=(title,value,caption='',warning=false)=>'<div><small>'+escape(title)+'</small><strong'+(warning?' class="snapshot-zero"':'')+'>'+escape(value??'未记录')+'</strong>'+(caption?'<span>'+escape(caption)+'</span>':'')+'</div>';
  const fact=(title,value)=>'<div class="snapshot-fact"><small>'+escape(title)+'</small>'+value+'</div>';
  const log=record(snapshot.log)?snapshot.log:{},rules=record(snapshot.rules)?snapshot.rules:{};
  const parsedOther=parseSnapshotValue(log.other),other=record(parsedOther)?parsedOther:{};
  const parsedAdmin=parseSnapshotValue(other.admin_info),admin=record(parsedAdmin)?parsedAdmin:{};
  const parsedStream=parseSnapshotValue(other.stream_status??admin.stream_status),stream=record(parsedStream)?parsedStream:{};
  const policy=parseSnapshotValue(other.request_policy??admin.request_policy);
  const billingSource=other.billing_source;
  const funding=billingSource==='wallet'?'钱包余额':billingSource==='subscription'?'订阅额度':null;
  const streamFields=Object.entries(stream);
  const streamError=stream.status==='error'||Boolean(stream.end_error);
  const streamInfo=streamFields.length?'<section class="snapshot-stream '+(streamError?'has-error':'')+'"><h4>'+escape(streamError?'流式响应异常':'流式响应状态')+'</h4><div class="snapshot-stream-fields">'+streamFields.map(([key,value])=>fact(labels[key]||key,scalar(value,key))).join('')+'</div></section>':'';
  const timeline=Array.isArray(policy)&&policy.length?'<details class="snapshot-section" open><summary>请求调度过程<span class="snapshot-count">'+policy.length+' 次事件</span>'+icon('chevron-down')+'</summary><ol class="snapshot-timeline">'+policy.slice(0,100).map(raw=>{
    const event=parseSnapshotValue(raw),entry=record(event)?event:{};
    const parsedDecision=parseSnapshotValue(entry.decision),decision=record(parsedDecision)?parsedDecision:{};
    const reason=decision.reason??entry.reason;
    const channel=entry.channel_id??entry.channel;
    const title=reason==='channel_selected'?'已选择渠道'+(channel!==undefined?' #'+channel:''):reason==='stream_not_successful'?'请求终止 · '+reason:reason??decision.action??entry.action??'调度事件';
    const caption=[own(entry,'attempt')?'第 '+entry.attempt+' 次尝试':null,entry.group,number(entry.elapsed_ms)?entry.elapsed_ms.toLocaleString('zh-CN')+' ms':null].filter(v=>v!==undefined&&v!==null).join(' · ');
    return '<li><details class="snapshot-event"><summary><span class="snapshot-event-title"><span>'+escape(title)+'</span>'+(caption?'<small>'+escape(caption)+'</small>':'')+'</span>'+icon('chevron-down')+'</summary><div class="snapshot-fields">'+(record(event)?fields(event):scalar(event))+'</div></details></li>';
  }).join('')+'</ol>'+(policy.length>100?'<p class="snapshot-muted">其余调度事件见原始 JSON</p>':'')+'</details>':(own(other,'request_policy')||own(admin,'request_policy')?section('请求调度',policy):'');
  const billing=Object.fromEntries(Object.entries(other).filter(([key])=>key.startsWith('subscription_')||key.startsWith('billing_')||['usage_billing_path','use_channel'].includes(key)));
  const extras=Object.fromEntries(Object.entries(other).filter(([key])=>!own(billing,key)&&!['stream_status','request_policy'].includes(key)));
  const primaryLogKeys=new Set(['quota','prompt_tokens','completion_tokens','use_time','is_stream','model_name','created_at','channel','group','request_id','other']);
  const remainingLog=Object.fromEntries(Object.entries(log).filter(([key])=>!primaryLogKeys.has(key)));
  const logSummary='<div class="snapshot-metrics">'+metric('原消费额度',number(log.quota)?formatQuota(log.quota):null,number(log.quota)?'原始额度 '+log.quota:'')+metric('输出 Token',number(log.completion_tokens)?log.completion_tokens.toLocaleString('zh-CN'):null,number(log.prompt_tokens)?'输入 '+log.prompt_tokens.toLocaleString('zh-CN')+' Token':'输入未记录',log.completion_tokens===0)+metric('请求耗时',number(log.use_time)?log.use_time.toLocaleString('zh-CN')+' 秒':null,log.is_stream===true?'流式请求':log.is_stream===false?'非流式请求':'')+'</div>';
  const logFacts='<div class="snapshot-facts">'+fact('模型',scalar(log.model_name))+fact('扣费来源',funding?escape(funding):billingSource?scalar(billingSource):scalar(null))+fact('消费时间',scalar(log.created_at,'created_at'))+fact('用户组 / 渠道',escape((log.group??'未记录')+' / '+(log.channel===undefined?'未记录':'#'+log.channel)))+fact('原请求 ID',scalar(log.request_id))+'</div>';
  const logBody=logSummary+logFacts+streamInfo+timeline+(Object.keys(billing).length?section('订阅与计费',billing):'')+(Object.keys(extras).length?section('其他扩展字段',extras):'')+(own(log,'other')&&!record(parsedOther)?section('扩展信息原文',parsedOther):'')+(Object.keys(remainingLog).length?section('其他消费字段',remainingLog):'');
  const ruleSummary='<div class="snapshot-metrics">'+metric('返还比例',number(rules.refundBasisPoints)?rules.refundBasisPoints/100+'%':null)+metric('单笔上限',number(rules.perRecordQuota)?rules.perRecordQuota===0?'不额外限制':formatQuota(rules.perRecordQuota):null)+metric('结算等待',number(rules.selfServiceMinAgeSeconds)?rules.selfServiceMinAgeSeconds+' 秒':null)+'</div>';
  const ruleBody='<h4 class="snapshot-heading">申请时生效规则'+(own(rules,'version')?'<span>版本 #'+escape(rules.version)+'</span>':'')+'</h4>'+ruleSummary+'<div class="snapshot-fields">'+fields(rules)+'</div>'+section('核验信息',{verification_note:snapshot.verification_note,attempt_id:snapshot.attempt_id},true);
  const panels=[['log','原消费',logBody],['rules','规则快照',ruleBody],['raw','原始 JSON','<pre>'+escape(JSON.stringify(snapshot,null,2))+'</pre>']];
  return '<details class="audit-snapshot"><summary>'+icon('file-json')+'原消费与规则快照'+icon('chevron-down')+'</summary><div class="snapshot-tabs" role="tablist" aria-label="快照内容">'+panels.map(([key,title],i)=>'<button type="button" role="tab" id="snapshot-tab-'+key+'" aria-controls="snapshot-panel-'+key+'" aria-selected="'+(i===0)+'" tabindex="'+(i===0?'0':'-1')+'">'+title+'</button>').join('')+'</div>'+panels.map(([key,,body],i)=>'<div class="snapshot-panel" role="tabpanel" id="snapshot-panel-'+key+'" aria-labelledby="snapshot-tab-'+key+'" '+(i?'hidden':'')+'>'+body+'</div>').join('')+'<div class="snapshot-footer"><span>'+escape(own(rules,'version')?'规则版本 #'+rules.version:'规则版本未记录')+'</span><span>申请时快照</span></div></details>';
}

export function bindSnapshot(root) {
  for(const tabs of root.querySelectorAll('.snapshot-tabs:not([data-bound])')) {
    tabs.dataset.bound='true';
    const buttons=[...tabs.querySelectorAll('[role=tab]')],snapshot=tabs.closest('.audit-snapshot');
    const select=button=>{
      for(const tab of buttons) {
        const active=tab===button;
        tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
        snapshot.querySelector('#'+tab.getAttribute('aria-controls')).hidden=!active;
      }
    };
    tabs.addEventListener('click',event=>{const button=event.target.closest('[role=tab]');if(buttons.includes(button))select(button);});
    tabs.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const current=buttons.indexOf(event.target);if(current<0)return;
      event.preventDefault();
      const next=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length];
      select(next);next.focus();
    });
  }
}
