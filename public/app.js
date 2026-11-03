import {formatQuota,inputQuota,parseQuota} from './display.js';
import {enhanceControls} from './controls.js';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const num = n => Number(n || 0).toLocaleString('zh-CN');
const date = t => t ? new Date(t).toLocaleString('zh-CN', {hour12:false}) : '—';
const s = { user:null, csrf:'', page:'overview', n:1, rules:null, challenge:'', busy:false };
const money=value=>formatQuota(value,s.display);
const quotaFields=new Set(['perRecordQuota','selfServiceMaxQuota','userDailyQuota','siteDailyQuota']);
let catalog=null,adminStatus='pending',adminDrill=null,pickedModels=new Set(),claimGroup=null;
let storagePlan=null;
const fundingLabel=source=>({subscription:'订阅额度 · 站长审批',wallet:'钱包余额',unknown:'资金来源待核实'}[source]||'资金来源待核实');
const statuses = {pending:'待审核',approved:'已通过 · 待执行',rejected:'已驳回',executing:'执行中',succeeded:'补偿成功',failed:'明确失败',unknown:'结果待确认'};
const pages = {overview:'我的概览',statistics:'数据统计',logs:'可补空回日志',claims:'我的申请',records:'补偿记录',rules:'补偿规则',adminOverview:'管理概览',adminLogs:'原始消费查询',adminClaims:'申请处理中心',stats:'补偿统计',settings:'补偿规则设置',notifications:'钉钉通知',audit:'操作记录'};
const eventNames = {application_pending:'申请待审核',review_result:'审核结果',compensation_success:'补偿成功',execution_failed:'执行失败',execution_unknown:'结果待确认'};
const filters = {model:'',requestId:'',channel:'',view:'eligible',status:'',start:'',end:''};
let statKind = 'users';
let currentLogs=[], operation=null;
const selectedLogs=new Set();
function updateLogSelection(){
  const available=currentLogs.filter(v=>v.assessment.canApply);
  document.querySelectorAll('[name="log-select"],[name="mobile-log-select"]').forEach(el=>{el.checked=selectedLogs.has(el.value);});
  const selected=available.filter(v=>selectedLogs.has(v.log.request_id));
  const toggle=$('#select-page');
  if(toggle){toggle.checked=available.length>0&&selected.length===available.length;toggle.indeterminate=selected.length>0&&selected.length<available.length;toggle.disabled=!available.length;}
  const summary=$('#selection-summary');if(summary)summary.textContent='已选 '+selected.length+' 笔 · 预计返还 '+money(selected.reduce((sum,v)=>sum+v.assessment.expectedQuota,0))+'';
  const submit=$('#batch-apply');if(submit){submit.disabled=!selected.length;submit.textContent=selected.length?'自助补额度（'+selected.length+'）':'自助补额度';}
}
const mobile = matchMedia('(max-width: 900px)');
let statisticsDays=30, statisticsAuto=false, statisticsTimer=null, statisticsRequest=0,refundQueried=false;
const loading=message=>'<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>'+esc(message)+'</div>';
function busyButton(button,busy){if(!button)return;button.classList.toggle('is-loading',busy);button.setAttribute('aria-busy',String(busy));}
const iconNames={overview:'house',statistics:'chart-no-axes-combined',logs:'refresh-cw',claims:'clipboard-list',records:'history',rules:'shield-check',adminOverview:'layout-dashboard',adminLogs:'search',adminClaims:'list-checks',stats:'chart-column',settings:'settings',notifications:'bell',audit:'file-clock'};
const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
function icons(){enhanceControls();window.lucide?.createIcons({attrs:{'stroke-width':1.7,'aria-hidden':'true'}});}
function theme(){const dark=document.documentElement.dataset.theme==='dark';$('#theme-toggle').innerHTML=icon(dark?'sun':'moon');$('#theme-toggle').setAttribute('aria-label',dark?'切换浅色模式':'切换深色模式');icons();}
function setDrawer(open, restore=true){
  const workspace=$('#workspace');
  if(mobile.matches){workspace.classList.toggle('drawer-open',open);workspace.classList.remove('nav-collapsed');$('#drawer-backdrop').hidden=!open;document.body.classList.toggle('drawer-lock',open);$('.sidebar').inert=!open;$('.main-shell').inert=open;$('.sidebar').setAttribute('role',open?'dialog':'complementary');if(open){$('.sidebar').setAttribute('aria-modal','true');$('#drawer-close').focus();}else{$('.sidebar').removeAttribute('aria-modal');if(restore)$('#menu-toggle').focus();}}
  else{workspace.classList.toggle('nav-collapsed',!open);workspace.classList.remove('drawer-open');$('#drawer-backdrop').hidden=true;document.body.classList.remove('drawer-lock');$('.sidebar').inert=!open;$('.main-shell').inert=false;$('.sidebar').removeAttribute('aria-modal');$('.sidebar').setAttribute('role','complementary');}
  $('#menu-toggle').setAttribute('aria-expanded',String(open));
}
mobile.addEventListener('change',()=>setDrawer(!mobile.matches,false));
function stopStatistics(){clearTimeout(statisticsTimer);statisticsTimer=null;statisticsRequest++;}
function availablePages(){return ['overview','statistics','logs','claims','records','rules',...(s.user?.role>=10?['adminOverview','adminLogs','adminClaims','stats','settings','notifications','audit']:[])];}
function searchPages(){const query=$('#page-search').value.trim().toLowerCase();$('#search-results').innerHTML=availablePages().filter(p=>pages[p].toLowerCase().includes(query)).map(navButton).join('')||empty('没有匹配页面');icons();}
async function navigate(page){if(!availablePages().includes(page))return;stopStatistics();if(page==='logs')refundQueried=false;s.page=page;s.n=1;$('#account-menu').hidden=true;$('#account-toggle').setAttribute('aria-expanded','false');$('#search-dialog').close();if(mobile.matches)setDrawer(false);await render();window.scrollTo({top:0});$('#page-title').tabIndex=-1;$('#page-title').focus({preventScroll:true});}
try{document.documentElement.dataset.theme=localStorage.getItem('huixiang-theme')==='light'?'light':'dark';}catch{}
theme();
function toast(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('#toast').hidden=true,6500); }
async function api(path, method='GET', body) {
  const owner=s.user,page=s.page;
  document.documentElement.classList.add('network-loading');api.pending=(api.pending||0)+1;
  try{
  const r=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await r.json();
  if(!path.startsWith('/api/auth/')&&(owner!==s.user||(method==='GET'&&page!==s.page)))throw Error('页面或账号已切换，已忽略旧请求');
  if(!r.ok||!value.success){if(r.status===401&&!path.startsWith('/api/auth/')) loginView();throw Error(value.message||'请求失败');}return value.data;
  }finally{api.pending--;if(!api.pending)document.documentElement.classList.remove('network-loading');}
}
function loginView(){stopStatistics();setDrawer(false,false);$('#search-dialog').close();$('#account-menu').hidden=true;s.user=null;s.csrf='';currentLogs=[];operation=null;for(const key of Object.keys(filters))filters[key]=key==='view'?'eligible':'';$('#content').replaceChildren();$('#detail-body').replaceChildren();$('#operation-body').replaceChildren();$('#operation-results').replaceChildren();$('#operation-dialog').close();$('#login').hidden=false;$('#workspace').hidden=true;$('#detail-dialog').close();}
function badge(v){return '<span class="badge '+(v==='succeeded'?'good':['failed','unknown','rejected'].includes(v)?'bad':'neutral')+'">'+esc(statuses[v]||v)+'</span>';}
function empty(v){return '<div class="empty"><div class="symbol">↺</div>'+esc(v)+'</div>';}
function panel(title,body,note=''){return '<section class="panel"><div class="panel-head"><div><h3>'+esc(title)+'</h3>'+(note?'<p class="muted">'+esc(note)+'</p>':'')+'</div></div>'+body+'</section>';}
function table(headers,rows){return '<div class="table-scroll"><table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
function metric(label,value,note,highlight=false){return '<div class="metric'+(highlight?' highlight':'')+'"><small>'+esc(label)+'</small><strong>'+(typeof value==='number'?(['累计补偿额度','今日剩余额度','空回补额度'].includes(label)?money(value):num(value)):esc(value))+'</strong><em>'+esc(note)+'</em></div>';}
function lines(rows){return '<div class="rule-lines">'+rows.map(([k,v])=>'<div class="rule-line"><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div>';}
function pager(total,count){return '<div class="pagination"><span>当前页 '+count+' 条 / 原始记录 '+num(total)+' 条</span><div><button class="ghost" data-turn="-1" '+(s.n<=1?'disabled':'')+'>上一页</button>'+s.n+'<button class="ghost" data-turn="1" '+(s.n*30>=total?'disabled':'')+'>下一页</button></div></div>';}
function nav(){const admin=['adminOverview','adminLogs','adminClaims','stats','settings','notifications','audit'];$('#nav').innerHTML=navButton('overview')+'<div class="nav-group">控制台</div>'+['statistics','logs'].map(navButton).join('')+'<div class="nav-group">个人中心</div>'+['claims','records','rules'].map(navButton).join('')+(s.user.role>=10?'<div class="nav-group">站长管理</div>'+admin.map(navButton).join(''):'');icons();}
function navButton(p){return '<button class="nav-button '+(s.page===p?'active':'')+'" data-nav="'+p+'" '+(s.page===p?'aria-current="page"':'')+'>'+icon(iconNames[p])+pages[p]+'</button>';}
async function enter(data){refundQueried=false;catalog=null;s.display=null;s.user=data.user;s.csrf=data.csrf;try{s.display=await api('/api/display');}catch(e){toast('站点额度配置读取失败：'+e.message);}s.page=s.user.role>=10?'adminOverview':'overview';$('#login').hidden=true;$('#workspace').hidden=false;$('#account-name').textContent=s.user.display_name+(s.user.role>=10?' · 站长':'');$('#account-toggle').textContent=(s.user.display_name||s.user.username).slice(0,1);setDrawer(!mobile.matches,false);await render();}
async function render(){
  const owner=s.user,page=s.page;
  $('#content').classList.remove('is-fetching');$('#content').removeAttribute('aria-busy');
  nav();$('#page-title').textContent=pages[s.page];$('#breadcrumb').textContent=pages[s.page];$('#page-subtitle').textContent=s.page==='statistics'?'查看当前账号的补回额度与每日趋势。':'正常自助返还，异常提交审批。每笔处理有据可查。';$('#page-kicker').textContent=['overview','statistics','logs','claims','records','rules'].includes(s.page)?'MY WORKSPACE':'ADMINISTRATION';$('#content').innerHTML=loading('正在读取记录…');$('#refresh').hidden=s.page==='statistics';
  try{if(s.page.endsWith('Overview')||s.page==='overview')await overview();else if(s.page==='statistics')await personalStatistics();else if(['logs','adminLogs'].includes(s.page))await logs();else if(['claims','records','adminClaims'].includes(s.page))await claims();else if(['rules','settings'].includes(s.page))await rules();else if(s.page==='stats')await stats();else if(s.page==='notifications')await notifications();else await audit();icons();}
  catch(e){if(owner!==s.user||page!==s.page)return;$('#content').innerHTML='<div class="notice warning">'+esc(e.message)+'</div><p class="muted">核对 NewAPI 连接与管理凭据后刷新。页面不使用示例数据替代真实记录。</p>';}
}
async function overview(){
  const admin=s.page==='adminOverview',p=admin?'/api/admin':'/api';
  const [o,r,c]=await Promise.all([api(p+'/overview'),api(p+'/rules'),api(p+'/claims')]);s.rules=r;
  if(admin){
    $('#content').innerHTML='<div class="metrics">'+metric('累计补回',money(o.compensatedQuota),'已确认到账',true)+metric('补偿用户',o.compensatedUsers,'按原站用户去重')+metric('待人工审核',o.pending,'异常记录')+metric('待对账 / 失败',o.unknown+o.failed,'返还状态待核实')+'</div>'+panel('最近申请',c.items.length?table(['申请用户','补偿额度','状态','申请时间',''],c.items.slice(0,8).map(v=>'<tr><td><strong>'+esc(v.username)+'</strong><span class="sub">ID '+v.user_id+'</span></td><td>'+money(v.amount||v.expectedAmount)+(v.status==='succeeded'?'':'<span class="sub">申请核验额度</span>')+'</td><td>'+badge(v.status)+'</td><td>'+date(v.created_at)+'</td><td><button class="ghost" data-detail="'+v.id+'">'+icon('chevron-right')+'<span>详情</span></button></td></tr>')):empty('暂无申请'))+'<div class="admin-shortcuts"><button class="secondary" data-nav="adminClaims">'+icon('list-checks')+'申请处理中心</button><button class="secondary" data-nav="stats">'+icon('chart-column')+'用户 / 模型 / 渠道统计</button></div>';return;
  }
  const cards=admin?metric('累计返还额度',o.compensatedQuota,'已确认成功',true)+metric('补偿用户数',o.compensatedUsers,'成功获得补偿的原用户')+metric('待审核申请',o.pending,'等待人工核实')+metric('待确认 / 失败',o.unknown+o.failed,'结果不明禁止直接重试'):metric('累计补偿额度',o.compensatedQuota,'已确认成功',true)+metric('待审核申请',o.pending,'逐笔独立处理')+metric('今日剩余额度',Math.max(0,o.personalLimit.quota-o.today.quota),'执行中和待确认会预占')+metric('今日剩余次数',Math.max(0,o.personalLimit.count-o.today.count),'按原消费笔数计算');
  const rows=c.items.slice(0,5).map(v=>'<tr><td>'+esc(v.log.model_name)+'<span class="sub">'+esc(v.request_id)+'</span></td><td>'+money(v.log.quota)+'</td><td>'+badge(v.status)+'</td><td><button class="ghost" data-detail="'+v.id+'">详情 →</button></td></tr>');
  $('#content').innerHTML='<div class="notice '+(!r.applicationsEnabled?'warning':'')+'">'+(r.applicationsEnabled?'● 申请已开放':'○ 申请尚未开放')+' · '+(r.executionEnabled?'执行已开放':'执行已暂停')+' · '+esc(o.timezone)+' · '+esc(o.day)+' · 每日 '+esc(o.dailyResetTime||'00:00')+' 重置。符合自助规则自动核验返还，仅异常申请进入审批。</div><div class="metrics">'+cards+'</div><div class="two-cols">'+panel('最近申请',rows.length?table(['模型 / 原请求','原消费','状态','操作'],rows):empty('还没有申请记录'))+panel('当前补偿规则','<div class="panel-body">'+lines([['处理方式',r.selfServiceEnabled?'正常自助 · 异常审批':'自助暂停 · 人工审批'],['读取范围','最近 '+(r.lookbackDays||Math.ceil(r.applicationHours/24))+' 天'],['返还比例',r.refundBasisPoints/100+'%'],['每日重置',r.dailyResetTime||'00:00'],['支持模型',r.restrictModels===false?'所选渠道全部模型':r.models.join('、')||'尚未设置'],['全站今日占用',money(o.siteToday.quota)+' / '+money(o.siteLimit.quota)+''],['全站今日笔数',num(o.siteToday.count)+' / '+num(o.siteLimit.count)]])+'</div>')+'</div>';
}
function filterInput(name,label,type='text'){return '<label>'+label+'<input name="'+name+'" type="'+type+'" value="'+esc(filters[name])+'"></label>';}
function refundRecordsMarkup(data){
  const format=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:data.timezone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(t);
  const records=data.items.map(record=>{
    const items=record.claims,amount=items.reduce((sum,c)=>sum+c.amount,0),models=new Set(items.map(c=>c.log.model_name)),days=new Map();
    const times=items.map(c=>c.log.created_at*1000).filter(Number.isFinite);
    for(const c of items){const day=new Intl.DateTimeFormat('sv-SE',{timeZone:data.timezone}).format(c.log.created_at*1000);if(!days.has(day))days.set(day,[]);days.get(day).push(c);}
    const breakdown=[...days].sort(([a],[b])=>b.localeCompare(a)).map(([day,claims])=>{
      const byModel=new Map();for(const c of claims){if(!byModel.has(c.log.model_name))byModel.set(c.log.model_name,{count:0,amount:0});const v=byModel.get(c.log.model_name);v.count++;v.amount+=c.amount;}
      return '<div class="refund-day"><div class="refund-day-total"><strong>'+esc(day.slice(5).replace('-','/'))+'</strong><span>'+money(claims.reduce((sum,c)=>sum+c.amount,0))+' · '+claims.length+'次</span></div><div class="history-models">'+[...byModel].map(([name,v])=>'<div><span>'+esc(name)+'</span><strong>'+money(v.amount)+' ('+v.count+'次)</strong></div>').join('')+'</div></div>';
    }).join('');
    return '<details class="history-group refund-record"><summary aria-label="展开补回记录"><span class="refund-record-top"><span class="amount">成功</span>'+icon('chevron-right')+'</span><span class="record-fields"><span>时间范围</span><strong>'+esc(times.length?format(Math.min(...times)).slice(0,-3)+' ~ '+format(Math.max(...times)).slice(0,-3):'未记录')+'</strong><span>补回额度</span><strong class="amount">'+money(amount)+'</strong><span>模型数量</span><strong>'+models.size+'</strong><span>创建时间</span><strong>'+esc(format(record.createdAt))+'</strong></span></summary><div class="record-breakdown">'+breakdown+'<div class="history-items">'+items.map(c=>'<div class="history-item"><span class="request-id">'+esc(c.request_id)+'</span><button class="ghost" data-detail="'+esc(c.id)+'">查看详情</button></div>').join('')+'</div></div></details>';
  }).join('');
  return '<section class="refund-history"><div class="refund-history-heading"><h3>补回记录</h3><span>'+num(data.total)+' 条记录</span></div>'+ (records||empty('暂无补回记录'))+(s.page==='logs'&&data.total>data.items.length?'<button class="ghost" data-nav="records">查看全部记录</button>':'')+'</section>';
}
async function refundMeta(){const [overview,records]=await Promise.all([api('/api/overview'),api('/api/refund-records')]);return {overview,records};}
function refundHeader(overview,queried=false){return '<div class="scope-strip"><span class="site-pill">'+icon('user-round')+' 当前账号：'+esc(s.user.display_name||s.user.username)+'</span></div><section class="refund-query"><p class="muted">'+(queried?'查询完成，查看下方可补额度与模型':'点击「查询空回」查看空回记录')+'</p><span class="refund-total">'+icon('circle-check')+' 累计补回：'+money(overview.compensatedQuota)+'</span><div class="action-row"><button class="primary" id="query-empty">'+icon('search')+' 查询空回</button></div></section>';}
async function refundLanding(){const owner=s.user,page=s.page,meta=await refundMeta();if(s.user!==owner||s.page!==page)return;currentLogs=[];selectedLogs.clear();$('#content').innerHTML=refundHeader(meta.overview)+refundRecordsMarkup(meta.records);icons();}
async function logs(){
  const owner=s.user,page=s.page;
  if(s.page==='logs'&&!refundQueried){await refundLanding();return;}
  if(s.page==='adminLogs'){await adminConsumption();return;}
  const admin=s.page==='adminLogs',q=new URLSearchParams({page:s.n,model:filters.model,requestId:filters.requestId,channel:admin?filters.channel:''});for(const k of ['start','end'])if(filters[k])q.set(k,Math.floor(new Date(filters[k]).getTime()/1000));
  const data=await api((admin?'/api/admin':'/api')+'/logs?'+q);
  if(s.user!==owner||s.page!==page)return;selectedLogs.clear();currentLogs=data.items;
  const shown=data.items.filter(v=>filters.view==='all'||(filters.view==='pending'?v.assessment.candidate&&v.assessment.evidence!=='empty_marked':v.assessment.eligible));
  const toolbar='<form id="log-filter" class="toolbar">'+filterInput('model','完整模型名')+filterInput('requestId','原请求标识')+(admin?filterInput('channel','渠道 ID','number'):'')+filterInput('start','消费起始','datetime-local')+filterInput('end','消费截止','datetime-local')+'<label>本页展示<select name="view">'+[['eligible','符合规则 / 可申请'],['pending','待核实候选'],['all','全部消费']].map(([v,t])=>'<option value="'+v+'" '+(filters.view===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label><button class="secondary">查询</button></form>';
  const rows=shown.map(v=>{const l=v.log,a=v.assessment;return '<tr><td><input type="checkbox" name="log-select" aria-label="选择消费" value="'+esc(l.request_id)+'" '+(!a.canApply?'disabled':'')+'></td><td>'+esc(l.model_name)+'<span class="sub">'+esc(l.request_id||'缺少可靠标识')+'</span></td>'+(admin?'<td>#'+esc(l.user_id)+'<span class="sub">'+esc(l.username)+' · 渠道 '+esc(l.channel)+'</span></td>':'')+'<td>'+money(l.quota)+'<span class="sub">预计返还 '+money(a.expectedQuota)+'</span></td><td>'+num(l.prompt_tokens)+' / '+num(l.completion_tokens)+'</td><td>'+(v.claim?badge(v.claim.status):'<span class="badge '+(a.canApply?'good':'neutral')+'">'+(a.canApply?(a.route==='automatic'?'自助返还':'异常审批'):'暂不可申请')+'</span>')+'<span class="sub" title="'+esc([...a.reasons,...(a.route==='review'?a.reviewReasons:[])].join('；'))+'">'+esc([...a.reasons,...(a.route==='review'?a.reviewReasons:[])].join('；')||({pending:'证据待核实',special:'特殊情形待核实',empty_marked:'有空响应标记'}[a.evidence]))+'</span></td><td>'+date(l.created_at*1000)+'<span class="sub">截止 '+date(a.deadline)+'</span></td><td>'+(v.claim?'<button class="ghost" data-detail="'+v.claim.id+'">进度 →</button>':'<button class="secondary" data-apply="'+esc(l.request_id)+'" '+(!a.canApply?'disabled':'')+'>'+(admin?'手动补偿':a.route==='automatic'?'自助补额度':'提交审批')+'</button>')+'</td></tr>';});
  const groups=new Map();shown.forEach((item,index)=>{const name=item.log.model_name;if(!groups.has(name))groups.set(name,[]);groups.get(name).push({item,row:rows[index]});});
  const available=shown.filter(v=>v.assessment.canApply),expected=available.reduce((sum,v)=>sum+v.assessment.expectedQuota,0);
  const grouped=[...groups].map(([name,entries])=>{const candidates=entries.filter(v=>v.item.assessment.canApply),quota=candidates.reduce((sum,v)=>sum+v.item.assessment.expectedQuota,0);return '<details class="model-group"><summary><span class="model-title"><span class="chevron">›</span>'+esc(name)+'</span><span class="model-stats"><span><small>本页记录</small><strong>'+entries.length+'</strong></span><span><small>可申请</small><strong>'+candidates.length+'</strong></span><span><small>预计返还</small><strong class="amount">'+money(quota)+'</strong></span></span></summary><div class="desktop-log-details">'+table(['选择','模型 / 原请求',...(admin?['用户 / 渠道']:[]),'原消费额度','输入 / 输出 token','资格 / 状态','消费时间 / 截止','操作'],entries.map(v=>v.row))+'</div><div class="mobile-log-details">'+entries.map(({item:v})=>{const l=v.log,a=v.assessment;return '<article class="consumption-card"><div class="consumption-top"><label class="check-label"><input type="checkbox" name="mobile-log-select" aria-label="选择消费 '+esc(l.request_id)+'" value="'+esc(l.request_id)+'" '+(!a.canApply?'disabled':'')+'><span class="request-id">'+esc(l.request_id||'缺少可靠标识')+'</span></label>'+(v.claim?badge(v.claim.status):'<span class="badge neutral">'+(a.canApply?(a.route==='automatic'?'自助返还':'异常审批'):'暂不可申请')+'</span>')+'</div><div class="consumption-info"><span>'+esc(date(l.created_at*1000))+'</span><span>原消费 <strong>'+money(l.quota)+'</strong></span><span>预计返还 <strong>'+money(a.expectedQuota)+'</strong></span><span>输入 / 输出 '+num(l.prompt_tokens)+' / '+num(l.completion_tokens)+'</span>'+(admin?'<span>用户 #'+esc(l.user_id)+' · 渠道 '+esc(l.channel)+'</span>':'')+'</div><p class="field-help">'+esc(a.reasons.join('；')||(a.route==='automatic'?'符合自助规则，将二次核验后返还':a.reviewReasons.join('；')))+'</p><div class="card-actions">'+(v.claim?'<button class="secondary" data-detail="'+esc(v.claim.id)+'">查看进度 →</button>':'<button class="secondary" data-apply="'+esc(l.request_id)+'" '+(!a.canApply?'disabled':'')+' >'+(a.route==='automatic'?'自助补额度':'提交审批')+'</button>')+'</div></article>';}).join('')+'</div></details>';}).join('');
  if(!admin){
    const meta=await refundMeta();if(s.user!==owner||s.page!==page)return;
    $('#content').innerHTML=refundHeader(meta.overview,true)+'<section class="refund-candidates"><div class="refund-history-heading"><h3>可补额度与模型</h3><span>当前查询页</span></div><div class="preview-summary"><div><small>可补额度</small><strong class="amount">'+money(expected)+' </strong></div><div><small>涉及模型</small><strong>'+new Set(available.map(v=>v.log.model_name)).size+'</strong></div><div><small>可申请记录</small><strong>'+available.length+' <em>笔</em></strong></div></div><div class="selection-bar"><label class="check-label"><input type="checkbox" id="select-page">全选本页可申请记录</label><span id="selection-summary" role="status" aria-live="polite"></span><button class="primary" id="batch-apply" disabled>自助补额度</button></div>'+grouped+'<details class="filter-disclosure"><summary>筛选条件</summary>'+toolbar+'</details>'+pager(data.total,shown.length)+'</section>'+refundRecordsMarkup(meta.records);
    currentLogs=shown;available.forEach(v=>selectedLogs.add(v.log.request_id));updateLogSelection();icons();return;
  }
  $('#content').innerHTML='<div class="scope-strip"><span class="site-pill"><i></i>当前 NewAPI 实例</span><span class="scope-caption">单实例 · 原站身份 · 异常审批</span></div><section class="panel refund-controls"><div><span class="badge neutral">本页查询预览</span><p>符合条件的消费自助返还，异常记录转审批。</p></div><div class="action-row"><button class="secondary" id="query-empty">'+icon('search')+' 查询空回</button><button class="primary" id="batch-apply" disabled>自助补额度</button></div></section><details class="filter-disclosure"><summary>筛选条件 <span>模型、请求标识与时间范围</span></summary>'+toolbar+'</details><div class="preview-summary"><div><small>本页展示</small><strong>'+shown.length+' <em>笔</em></strong></div><div><small>符合申请条件</small><strong>'+available.length+' <em>笔</em></strong></div><div><small>预计返还 · 非到账</small><strong class="amount">'+money(expected)+' </strong></div></div><div class="selection-bar"><label class="check-label"><input type="checkbox" id="select-page">全选本页可申请记录</label><span id="selection-summary" role="status" aria-live="polite"></span></div>'+panel('模型汇总',grouped||empty(data.items.length?'本页无匹配日志，调整筛选或翻页继续查看':'本页没有消费记录'),'仅当前页 · '+groups.size+' 个模型；展开后勾选具体消费')+'<div class="notice">零输出仅是候选。缺乏证据须人工核实；订阅消费转站长审批，审核通过后补入钱包余额。金额按原站配置显示。本页无匹配不代表全部历史无候选。</div>'+pager(data.total,shown.length);
  currentLogs=shown;updateLogSelection();icons();
}
async function claims(){
  if(s.page==='adminClaims'){await adminQueue();return;}
  if(s.page==='records'){const data=await api('/api/refund-records?page='+s.n);$('#content').innerHTML=refundRecordsMarkup(data)+pager(data.total,data.items.length);return;}
  const admin=s.page==='adminClaims',status=s.page==='records'?'succeeded':filters.status,data=await api((admin?'/api/admin':'/api')+'/claims?page='+s.n+'&status='+encodeURIComponent(status));
  const toolbar=s.page==='records'?'':'<form id="claim-filter" class="toolbar"><label>状态<select name="status"><option value="">全部状态</option>'+Object.entries(statuses).map(([k,v])=>'<option value="'+k+'" '+(k===status?'selected':'')+'>'+v+'</option>').join('')+'</select></label><button class="secondary">查询</button></form>';
  const batch=admin?'<div class="toolbar"><button class="secondary" data-batch="approve">批量通过</button><button class="danger" data-batch="reject">批量驳回</button><button class="primary" data-batch="execute">逐笔核验并批量执行</button></div>':'';
  const rows=data.items.map(c=>'<tr>'+(admin?'<td><input type="checkbox" name="claim-select" aria-label="选择申请" value="'+c.id+'"></td>':'')+'<td>'+esc(c.log.model_name)+'<span class="sub">'+esc(c.request_id)+'</span></td>'+(admin?'<td>#'+esc(c.user_id)+' '+esc(c.username)+'</td>':'')+'<td>'+money(c.log.quota)+'</td><td>'+money(c.amount)+'</td><td>'+badge(c.status)+'</td><td>'+date(c.created_at)+'</td><td><button class="ghost" data-detail="'+c.id+'">详情 →</button></td></tr>');
  $('#content').innerHTML=panel(admin?'申请处理队列':'申请与处理记录',toolbar+batch+(rows.length?table([...(admin?['选择']:[]),'模型 / 原请求',...(admin?['申请用户']:[]),'原消费','实际补偿','状态','申请时间','操作'],rows):empty('没有符合条件的申请'))+pager(data.total,data.items.length));
}
async function adminQueue(){
  const [data,counts,display]=await Promise.all([api('/api/admin/claim-groups?page='+s.n+'&status='+encodeURIComponent(adminStatus)),api('/api/admin/claim-counts'),api('/api/display')]);s.display=display;
  const count=Object.fromEntries(counts.map(v=>[v.status,v.count]));
  const tabs='<div class="status-sections" role="tablist">'+[['pending','待审核'],['succeeded','补偿成功'],['approved','待执行'],['unknown','待对账'],['failed','返还失败'],['rejected','已驳回'],['','全部']].map(([key,title])=>'<button role="tab" aria-selected="'+(key===adminStatus)+'" data-queue-status="'+key+'" class="status-section '+(key===adminStatus?'active':'')+'"><span>'+title+'</span><strong>'+num(key?count[key]||0:counts.reduce((n,v)=>n+v.count,0))+'</strong></button>').join('')+'</div>';
  const groups=data.items.map(g=>'<article class="claim-owner"><div class="claim-owner-identity">'+icon('user-round')+'<div><strong>'+esc(g.username)+'</strong><span class="sub">ID '+g.user_id+'</span></div></div><div class="claim-owner-amount"><small>'+(adminStatus==='succeeded'?'已补回额度':'本组额度 · 含待核验')+'</small><strong class="amount">'+money(g.expectedAmount)+'</strong></div><div class="claim-owner-models"><strong>'+g.models+' 个模型 · '+g.applications+' 笔申请</strong><div class="claim-status-list">'+Object.entries(g.statuses).map(([status,count])=>badge(status)+'<small>×'+count+'</small>').join('')+'</div></div><div class="claim-owner-end"><span class="muted">'+date(g.createdAt)+'</span><button class="secondary" data-owner="'+g.user_id+'">查看并处理 '+icon('chevron-right')+'</button></div></article>').join('');
  $('#content').innerHTML=tabs+'<div class="queue-heading"><h3>'+(adminStatus?statuses[adminStatus]:'全部申请')+'</h3><span class="muted">'+data.total+' 位用户</span></div><div class="claim-owner-list">'+(groups||empty('此板块暂无申请'))+'</div>'+pager(data.total,data.items.length);icons();
}
async function openClaimGroup(owner,page=1){
  const status=claimGroup?.owner===Number(owner)?claimGroup.status:adminStatus;
  claimGroup={owner:Number(owner),status,page};
  $('#detail-body').innerHTML=loading('正在读取用户申请');if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
  const query=new URLSearchParams({owner,status,page}),[data,summary,display]=await Promise.all([api('/api/admin/claims?'+query),api('/api/admin/claim-groups?'+new URLSearchParams({owner,status})),api('/api/display')]);s.display=display;
  if(claimGroup?.owner!==Number(owner)||claimGroup.page!==page||s.page!=='adminClaims')return;
  const group=summary.items[0];if(!group){$('#detail-body').innerHTML=empty('此用户在当前板块已无申请');return;}
  const models=new Map();for(const c of data.items){if(!models.has(c.log.model_name))models.set(c.log.model_name,[]);models.get(c.log.model_name).push(c);}
  const actions=status==='pending'?'<button class="secondary" data-batch="approve">审核所选</button><button class="danger" data-batch="reject">驳回所选</button>':status==='approved'?'<button class="primary" data-batch="execute">核验并执行所选申请</button>':'';
  const cards=[...models].map(([model,items])=>'<details class="claim-model" open><summary><span>'+icon('chevron-right')+esc(model)+'</span><small>本页 '+items.length+' 笔</small></summary><div class="claim-model-items">'+items.map(c=>'<div class="claim-line"><div class="claim-line-main">'+(['pending','approved'].includes(c.status)?'<label class="check-label"><input name="claim-select" type="checkbox" value="'+c.id+'" aria-label="选择申请 '+esc(c.request_id)+'" '+(c.status!==status?'disabled':'')+'></label>':'')+'<div><strong>'+money(c.status==='succeeded'?c.amount:c.amount||c.expectedAmount)+'</strong><span class="sub">'+fundingLabel(c.fundingSource)+'</span></div>'+badge(c.status)+'</div><div class="claim-request"><span>'+esc(c.request_id)+'</span><small>'+date(c.created_at)+'</small></div><button class="ghost" data-detail="'+c.id+'">核验详情 '+icon('chevron-right')+'</button></div>').join('')+'</div></details>').join('');
  $('#detail-body').innerHTML='<div class="detail-account">'+icon('user-round')+'<div><strong>'+esc(group.username)+'</strong><span class="sub">原站用户 ID '+group.user_id+'</span></div></div><div class="group-totals"><div><small>涉及模型</small><strong>'+group.models+'</strong></div><div><small>申请笔数</small><strong>'+group.applications+'</strong></div><div><small>本组额度</small><strong class="amount">'+money(group.expectedAmount)+'</strong></div></div><div class="group-action-bar">'+actions+'</div>'+cards+'<div class="group-pagination"><span>'+page+' / '+Math.max(1,Math.ceil(data.total/30))+'</span><button class="ghost" data-group-page="-1" '+(page<=1?'disabled':'')+'>'+icon('chevron-left')+'上一页</button><button class="ghost" data-group-page="1" '+(page*30>=data.total?'disabled':'')+'>下一页'+icon('chevron-right')+'</button></div>';icons();
}
async function adminConsumption(){
  const q=new URLSearchParams({page:s.n,model:filters.model,requestId:filters.requestId,channel:filters.channel});
  for(const key of ['start','end'])if(filters[key])q.set(key,Math.floor(new Date(filters[key]).getTime()/1000));
  const data=await api('/api/admin/logs?'+q);currentLogs=data.items;
  const form='<form id="log-filter" class="toolbar">'+filterInput('model','模型')+filterInput('requestId','请求标识')+filterInput('channel','渠道 ID','number')+filterInput('start','开始时间','datetime-local')+filterInput('end','结束时间','datetime-local')+'<button class="primary">查询消费</button></form>';
  const rows=data.items.map((v,index)=>'<tr><td><strong>'+esc(v.log.username)+'</strong><span class="sub">ID '+v.log.user_id+'</span></td><td>'+esc(v.log.model_name)+'</td><td>'+money(v.log.quota)+'</td><td>'+(v.claim?badge(v.claim.status):'<span class="badge neutral">未申请</span>')+'</td><td>'+date(v.log.created_at*1000)+'</td><td><button class="ghost" data-consumption="'+index+'">查看消费详情 '+icon('chevron-right')+'</button></td></tr>');
  $('#content').innerHTML='<p class="muted">核对原站扣费与空回证据。已补回的用户、模型和渠道汇总统一在补偿统计查看。</p>'+form+panel('原始消费',rows.length?table(['消费用户','模型','扣费额度','补偿状态','消费时间',''],rows):empty('暂无匹配的消费'))+pager(data.total,data.items.length);icons();
}
function consumptionDetail(index){
  const v=currentLogs[index];if(!v)return;
  $('#detail-body').innerHTML=lines([['用户',v.log.username+'（ID '+v.log.user_id+'）'],['模型',v.log.model_name],['扣费额度',money(v.log.quota)],['渠道 ID',v.log.channel],['请求标识',v.log.request_id],['输入 / 输出 token',v.log.prompt_tokens+' / '+v.log.completion_tokens],['消费时间',date(v.log.created_at*1000)],['可申请',v.assessment.canApply?'是':'否'],['核验说明',[...v.assessment.reasons,...v.assessment.reviewReasons].join('；')||'符合自动核验条件']])+(v.claim?'<button class="secondary" data-detail="'+esc(v.claim.id)+'">查看关联补偿申请</button>':'<button class="secondary" data-apply="'+esc(v.log.request_id)+'" '+(!v.assessment.canApply?'disabled':'')+'>发起人工补偿申请</button>');
  $('#detail-dialog').showModal();
}
async function detail(id){
  const admin=s.user.role>=10&&['adminOverview','adminClaims','adminLogs','stats'].includes(s.page),[c,display]=await Promise.all([api((admin?'/api/admin':'/api')+'/claims/'+id),api('/api/display')]);s.display=display;let actions=[];
  if(admin)actions=c.status==='pending'?[['approve',c.fundingSource==='subscription'?'审核通过并补入余额':'审核通过'],['reject','驳回申请']]:c.status==='approved'?[['execute','核验并执行返还']]:c.status==='unknown'?[['received','核对：已到账'],['not_received','核对：未到账']]:['failed','rejected'].includes(c.status)?[['reopen','补充依据并重新审核']]:[];
  const eventLabels={application_created:'提交补偿申请',self_service_routed:'自动核验分流',execution_reserved:'锁定本笔返还额度',...statuses};
  $('#detail-body').innerHTML=(admin&&s.page==='adminClaims'&&claimGroup?'<button class="ghost group-back" data-owner="'+c.user_id+'">'+icon('arrow-left')+'返回用户申请</button>':'')+'<div class="detail-status">'+badge(c.status)+'<span>'+esc(c.id)+'</span></div><div class="detail-amounts"><div><small>原消费</small><strong>'+money(c.log.quota)+'</strong></div><div><small>预计补偿</small><strong>'+money(c.expectedAmount)+'</strong></div><div><small>实际补偿</small><strong class="amount">'+money(c.amount)+'</strong></div></div>'+(c.fundingSource==='subscription'?'<div class="notice warning">订阅消费由站长审批并核实金额，审核通过后补入钱包余额，不恢复订阅额度。仅原站确认成功才标记到账。</div>':'')+'<div class="detail-facts">'+lines([['原请求',c.request_id],['模型',c.log.model_name],['资金来源',fundingLabel(c.fundingSource)],['申请理由',c.reason],['处理说明',c.review_note||'尚未处理'],['申请时间',date(c.created_at)],['更新时间',date(c.updated_at)]])+'</div><div class="action-row">'+actions.map(([a,t])=>'<button class="secondary" data-action="'+a+'" data-id="'+id+'">'+t+'</button>').join('')+'</div><h3 class="detail-section-title">处理时间线</h3><ol class="claim-timeline">'+c.events.map(e=>'<li><strong>'+esc(eventLabels[e.action]||e.action)+'</strong><span>'+date(e.created_at)+(admin?' · 操作人 #'+esc(e.actor_id):'')+'</span></li>').join('')+'</ol>'+(admin?'<details class="audit-snapshot"><summary>'+icon('file-json')+'原消费与规则快照'+icon('chevron-down')+'</summary><pre>'+esc(JSON.stringify({log:c.log,rules:c.rules,verification_note:c.verification_note,attempt_id:c.attempt_id},null,2))+'</pre></details>':'');
  if(admin)$('#detail-body').insertAdjacentHTML('afterbegin','<div class="detail-account">'+icon('user-round')+'<div><strong>'+esc(c.username)+'</strong><span class="sub">原站用户 ID '+c.user_id+' · '+esc(c.source==='manual'?'人工申请':'用户自助申请')+'</span></div></div>');
  icons();if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
const numeric=[['userDailyQuota','每用户每日可补额度'],['userDailyCount','每用户每日最多补偿笔数'],['siteDailyQuota','全站每日可补额度'],['siteDailyCount','全站每日最多补偿笔数'],['perRecordQuota','单笔补回上限（0 为不额外限制）'],['selfServiceMaxQuota','自动审批单笔原消费上限'],['selfServiceMinAgeSeconds','结算等待秒数（30–86400）'],['refundBasisPoints','返还比例（10000 为 100%）'],['maxPending','每用户最多待处理申请']];
async function rules(){
  const admin=s.page==='settings',r=await api(admin?'/api/admin/rules':'/api/rules');s.rules=r;
  if(admin){await settingsPage(r);return;}
  if(!admin){$('#content').innerHTML=panel('补偿规则 · v'+r.version,'<div class="panel-body">'+lines([['处理方式',r.selfServiceEnabled?'正常自助 · 异常审批':'自助暂停 · 人工审批'],['自助单笔上限',money(r.selfServiceMaxQuota)],['结算等待',r.selfServiceMinAgeSeconds+' 秒'],['申请状态',r.applicationsEnabled?'开放':'暂停'],['执行状态',r.executionEnabled?'开放':'暂停'],['支持模型',r.restrictModels===false?'全部可补模型':r.models.join('、')||'未配置'],['返还比例',r.refundBasisPoints/100+'%'],['单笔上限',r.perRecordQuota?money(r.perRecordQuota):'不额外截断'],['每日可补额度',money(r.userDailyQuota)],['每日最多补偿笔数',r.userDailyCount],['待处理数量上限',r.maxPending],['日志读取范围','最近 '+(r.lookbackDays||Math.ceil(r.applicationHours/24))+' 天'],['每日重置时间',r.dailyResetTime||'00:00'],['结算时区',r.timezone]])+'</div>')+'<div class="notice">零输出仅是候选条件。缺失证据、工具调用、多模态、拦截和中断均需人工核实。结果不明不自动重试，订阅消费转站长审批，审核通过后补入钱包余额。</div>';return;}
}
async function settingsPage(r){
  s.display=await api('/api/display');
  const storage=await api('/api/admin/storage');
  let error='',groups=[];try{catalog=await api('/api/admin/catalog');groups=(await api('/api/admin/groups')).groups;}catch(e){catalog=null;error=e.message;}
  pickedModels=new Set(r.models);
  const amountLabels={};
  const numericInputs=numeric.map(([key,label])=>'<label>'+esc(amountLabels[key]||label)+'<input name="'+key+'" type="number" min="0" step="'+(quotaFields.has(key)?'any':'1')+'" required value="'+(quotaFields.has(key)?inputQuota(r[key],s.display):r[key])+'" '+(quotaFields.has(key)&&!s.display?'disabled':'')+'></label>').join('');
  const channels=catalog?.channels||[],channelSelector='<div class="catalog-options">'+channels.map(c=>'<label class="catalog-choice"><input type="checkbox" name="channel-choice" value="'+c.id+'" '+(r.channels.includes(c.id)?'checked':'')+'><span><strong>'+esc(c.name)+'</strong><small>ID '+c.id+' · '+(c.status===1?'运行中':'停用 · 仅人工审核')+' · '+c.models.length+' 个模型</small></span></label>').join('')+r.channels.filter(id=>!channels.some(c=>c.id===id)).map(id=>'<label class="catalog-choice"><input type="checkbox" name="channel-choice" value="'+id+'" checked><span>渠道 #'+id+'<small>已删除 · 保留历史补偿审核</small></span></label>').join('')+'</div>';
  const groupSelector='<div class="catalog-options">'+groups.map(group=>'<label class="catalog-choice"><input name="group-choice" type="checkbox" value="'+esc(group)+'" '+(r.userGroups.includes(group)?'checked':'')+'><span>'+esc(group)+'</span></label>').join('')+'</div>';
  $('#content').innerHTML=(error?'<div class="notice warning">原站渠道或用户组读取失败：'+esc(error)+'。保存已禁用，刷新后重试。</div>':'')+'<form id="rules-form"><section class="settings-band"><h3>开放与自动审批</h3><div class="settings-switches">'+['applicationsEnabled','executionEnabled','selfServiceEnabled'].map((key,i)=>'<label class="switch-line"><span>'+['开放补偿申请','开放额度返还','正常记录自动审批'][i]+'</span><input role="switch" name="'+key+'" type="checkbox" '+(r[key]?'checked':'')+'></label>').join('')+'</div></section><section class="settings-band"><h3>日志与每日重置</h3><div class="form-grid"><label>最多读取最近多少天的日志<input name="lookbackDays" type="number" min="1" max="3650" step="1" required value="'+Math.ceil(r.applicationHours/24)+'"></label><label>每日额度与次数重置时间<input name="dailyResetTime" type="time" value="'+(r.dailyResetTime||'00:00')+'" required></label><label>结算时区<select name="timezone">'+[...new Set([r.timezone,'Asia/Shanghai','UTC','Asia/Hong_Kong','Asia/Tokyo','America/New_York','Europe/London'])].map(zone=>'<option value="'+esc(zone)+'" '+(zone===r.timezone?'selected':'')+'>'+esc(zone)+'</option>').join('')+'</select></label></div></section><section class="settings-band"><h3>额度与次数</h3><div class="form-grid">'+numericInputs+'</div><p class="field-help">额度单位：'+esc(s.display?.label||'未读取')+' · 每笔原消费计一次，执行中与待对账金额预占限额。</p></section><section class="settings-band"><h3>可补用户组</h3>'+groupSelector+'<p class="field-help">未选择表示全部原站用户组。</p></section><section class="settings-band"><h3>可补渠道</h3><input id="channel-search" type="search" placeholder="搜索渠道名称或 ID" aria-label="搜索渠道">'+channelSelector+'</section><section class="settings-band"><h3>可补模型</h3><label class="switch-line"><span>限定模型范围</span><input role="switch" type="checkbox" name="restrictModels" '+(r.restrictModels?'checked':'')+'></label><input id="model-search" type="search" placeholder="搜索所选渠道的模型" aria-label="搜索模型"><div id="catalog-models"></div><p class="field-help">下架、删除模型或停用渠道的历史空回进入人工审核。</p></section><section class="settings-band"><h3>其他设置</h3><div class="form-grid"><label>排除用户 ID（逗号分隔）<input name="blockedUsers" value="'+esc(r.blockedUsers.join(','))+'"></label><label class="check-label"><input type="checkbox" name="notificationsEnabled" '+(r.notifications.enabled?'checked':'')+'>开启钉钉通知</label></div></section><div class="form-actions"><button class="primary" '+(!catalog||!s.display?'disabled':'')+'>保存规则</button></div></form>';
  $('#content').insertAdjacentHTML('beforeend','<section class="settings-band"><h3>本地数据存储</h3>'+lines([['数据库',storage.engine+' · '+(storage.persistent?'持久化存储':'内存演示，重启清空')],['日志模式',storage.journalMode],['申请账本',storage.claims+' 笔'],['日志缓存范围',storage.logs],['审计记录',storage.events],['数据库大小',num(storage.bytes)+' 字节']])+'<p class="field-help">'+(storage.persistent?'更新镜像保留数据卷。数据库快照与机器人加密密钥需一起备份，恢复旧账本前须对账。':'当前为本地演示预览。正式启动自动创建独立 SQLite 数据库，申请与发放去重记录持久保存。')+'</p></section>');
  $('#content').insertAdjacentHTML('beforeend','<section class="settings-band storage-management"><h3>数据库清理</h3><div class="preview-summary"><div><small>通知记录</small><strong>'+num(storage.notifications)+'</strong></div><div><small>本地快照</small><strong>'+num(storage.backups.count)+'</strong></div><div><small>库内可回收空间</small><strong>'+num(storage.freeBytes)+' <em>字节</em></strong></div></div><form id="storage-form"><div class="form-grid">'+[['cache','过期查询缓存','cacheDays',7,1],['notifications','已结束通知记录','notificationDays',30,7],['backups','旧数据库快照','backupDays',30,7]].map(([key,label,days,value,min])=>'<div class="storage-option"><label class="check-label"><input type="checkbox" name="'+key+'" '+(key==='backups'?'':'checked')+'>清理'+label+'</label><label>保留最近天数<input type="number" name="'+days+'" min="'+min+'" max="3650" step="1" required value="'+value+'"></label></div>').join('')+'</div><label class="check-label storage-compact"><input type="checkbox" name="compact">整理数据库空间</label><p class="field-help">申请、发放去重账本、审计、待发送通知及密钥不清理。快照至少保留最新 3 份。空间整理可能短暂阻塞查询，请在低峰执行。</p><button type="submit" class="secondary">'+icon('scan-search')+'预览清理</button></form></section>');
  renderCatalogModels();icons();
}
function renderCatalogModels(){
  const root=$('#catalog-models');if(!root)return;
  const ids=[...document.querySelectorAll('[name=channel-choice]:checked')].map(el=>Number(el.value)),models=[...new Set((catalog?.channels||[]).filter(c=>ids.includes(c.id)).flatMap(c=>c.models))].sort();
  const query=$('#model-search').value.trim().toLowerCase(),restricted=$('[name=restrictModels]').checked;
  root.innerHTML=restricted?'<div class="catalog-options">'+models.filter(m=>m.toLowerCase().includes(query)).map(m=>'<label class="catalog-choice"><input name="model-choice" type="checkbox" value="'+esc(m)+'" '+(pickedModels.has(m)?'checked':'')+'><span>'+esc(m)+'</span></label>').join('')+'</div>'+[...pickedModels].filter(m=>!models.includes(m)).map(m=>'<label class="catalog-choice historical-model"><input name="model-choice" type="checkbox" value="'+esc(m)+'" checked><span>'+esc(m)+'<small>历史选择 · 不在当前渠道模型目录，需人工审核</small></span></label>').join(''):'<div class="notice">所选渠道全部模型参与；下架或删除模型仍需人工审核。</div>';
}
async function personalStatistics(){
  clearTimeout(statisticsTimer);const request=++statisticsRequest,owner=s.user;
  $('#content').setAttribute('aria-busy','true');$('#content').classList.add('is-fetching');
  let data;
  try{data=await api('/api/statistics?days='+statisticsDays);}catch(e){if(request!==statisticsRequest||owner!==s.user||s.page!=='statistics')return;scheduleStatistics();throw e;}finally{if(request===statisticsRequest){$('#content').removeAttribute('aria-busy');$('#content').classList.remove('is-fetching');}}
  if(request!==statisticsRequest||owner!==s.user||s.page!=='statistics')return;
  const points=data.trend,max=Math.ceil(Math.max(2,...points.map(p=>p.quota))/2)*2,x=i=>48+i*672/(points.length-1),y=q=>190-q/max*158;
  const polyline=points.map((p,i)=>x(i)+','+y(p.quota)).join(' ');
  const chart='<div class="trend-chart"><div class="trend-plot"><svg id="refund-trend" viewBox="0 0 750 235" role="group" tabindex="0" aria-label="近'+data.days+'天已确认补偿额度趋势，原站显示单位；方向键查看日期">'+[0,.25,.5,.75,1].map(t=>'<line x1="48" x2="720" y1="'+y(t*max)+'" y2="'+y(t*max)+'" class="chart-grid"/><text x="38" y="'+(y(t*max)+4)+'" text-anchor="end">'+(s.display?(t*max*s.display.scale).toLocaleString('zh-CN',{maximumFractionDigits:6}):'—')+'</text>').join('')+'<polyline points="'+polyline+'" class="chart-line"/>'+points.map((p,i)=>'<circle cx="'+x(i)+'" cy="'+y(p.quota)+'" r="4" class="chart-point"/>').join('')+points.map((p,i)=>i%Math.ceil(points.length/7)===0||i===points.length-1?'<text x="'+x(i)+'" y="220" text-anchor="middle">'+p.day.slice(5)+'</text>':'').join('')+'<line id="chart-crosshair" x1="720" x2="720" y1="32" y2="190"/><circle id="chart-active" r="6" cx="720" cy="190"/></svg><div id="chart-tooltip" class="chart-tooltip" hidden></div></div><div class="chart-legend"><span></span>当前账号</div><label class="trend-scrubber">查看日期<input id="trend-day" type="range" min="0" max="'+(points.length-1)+'" value="'+(points.length-1)+'" aria-label="趋势日期"></label><output id="trend-value" aria-live="polite"></output></div>';
  const unconnected=(title,message,name)=>'<section class="trend-panel"><h3>'+title+'</h3><div class="trend-empty">'+icon(name)+'<p>'+message+'</p></div></section>';
  $('#content').innerHTML='<div class="statistics-toolbar"><label>时间范围<select id="statistics-days">'+[7,30,90].map(d=>'<option value="'+d+'" '+(d===statisticsDays?'selected':'')+'>近 '+d+' 天</option>').join('')+'</select></label><span class="updated-at">最后更新：'+esc(new Date(data.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}))+'</span><label class="auto-refresh"><input id="statistics-auto" type="checkbox" role="switch" '+(statisticsAuto?'checked':'')+'>自动刷新</label><button id="statistics-refresh" class="secondary">'+icon('refresh-cw')+'刷新</button></div><div class="metrics statistics-metrics">'+metric('钱包余额','—','钱包数据未接入')+metric('空回补额度',data.quota,'近 '+data.days+' 天 · 共 '+data.count+' 笔成功',true)+metric('总提现金额','—','提现数据未接入')+metric('额度转移','—','额度转移未接入')+'</div><div class="statistics-charts"><section class="trend-panel"><h3>我的空回补额度趋势（近'+data.days+'天）</h3>'+chart+'<details class="trend-data"><summary>查看每日明细</summary>'+table(['日期','成功笔数','返还额度'],points.map(p=>'<tr><td>'+p.day+'</td><td>'+p.count+'</td><td>'+money(p.quota)+'</td></tr>'))+'</details></section>'+unconnected('我的提现趋势（近'+data.days+'天）','提现数据未接入','chart-no-axes-column')+unconnected('我的额度转移趋势（近'+data.days+'天）','额度转移数据未接入','arrow-right-left')+'</div><div class="notice">统计范围：'+esc(points[0].day)+' 至 '+esc(points.at(-1).day)+' · '+esc(data.timezone)+'。仅计算当前账号已确认成功的补偿，金额按原站配置显示。</div>';
  const showPoint=index=>{const i=Math.max(0,Math.min(points.length-1,index)),p=points[i];$('#trend-day').value=i;$('#trend-value').textContent=p.day+' · '+money(p.quota)+' · '+p.count+' 笔成功';const tooltip=$('#chart-tooltip');tooltip.hidden=false;tooltip.textContent=p.day+'\n当前账号  '+money(p.quota)+'\n'+p.count+' 笔成功';tooltip.style.left=Math.max(2,Math.min(65,x(i)/750*100-10))+'%';$('#chart-crosshair').setAttribute('x1',x(i));$('#chart-crosshair').setAttribute('x2',x(i));$('#chart-active').setAttribute('cx',x(i));$('#chart-active').setAttribute('cy',y(p.quota));};
  const svg=$('#refund-trend');
  const pointer=event=>{const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const local=point.matrixTransform(svg.getScreenCTM().inverse());showPoint(Math.round((local.x-48)/672*(points.length-1)));};
  svg.addEventListener('pointermove',pointer);svg.addEventListener('pointerdown',pointer);
  svg.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();showPoint(event.key==='Home'?0:event.key==='End'?points.length-1:Number($('#trend-day').value)+(event.key==='ArrowRight'?1:-1));}});
  $('#trend-day').addEventListener('input',()=>showPoint(Number($('#trend-day').value)));showPoint(points.length-1);icons();
  scheduleStatistics();
}
function scheduleStatistics(){clearTimeout(statisticsTimer);if(statisticsAuto&&s.page==='statistics'&&s.user)statisticsTimer=setTimeout(()=>{if(document.hidden){scheduleStatistics();return;}personalStatistics().catch(e=>toast(e.message));},60000);}
async function stats(){
  if(!catalog)try{catalog=await api('/api/admin/catalog');}catch{}
  const data=await api('/api/admin/stats?kind='+statKind+'&page='+s.n);
  const name=v=>statKind==='users'?esc(v.username)+'<span class="sub">ID '+esc(v.name)+'</span>':statKind==='channels'?esc(catalog?.channels.find(c=>String(c.id)===v.name)?.name||'渠道 #'+v.name):esc(v.name);
  const tabs='<div class="segmented" role="tablist">'+[['users','用户统计'],['models','模型统计'],['channels','渠道统计']].map(([k,t])=>'<button role="tab" aria-selected="'+(statKind===k)+'" class="'+(statKind===k?'active':'')+'" data-stats="'+k+'">'+t+'</button>').join('')+'</div>';
  const rows=data.items.map(v=>'<tr><td><strong>'+name(v)+'</strong></td><td>'+v.applications+'</td><td>'+v.users+' / '+v.models+' / '+v.channels+'</td><td>'+v.succeeded+'</td><td>'+money(v.quota)+'</td><td>'+v.pending+'</td><td>'+v.unknown+'</td><td><button class="ghost" data-drill="'+esc(v.name)+'">逐笔明细 '+icon('chevron-right')+'</button></td></tr>');
  $('#content').innerHTML=tabs+panel({users:'按用户汇总',models:'按模型汇总',channels:'按渠道汇总'}[statKind],rows.length?table(['统计对象','申请笔数','用户 / 模型 / 渠道数','成功笔数','成功补回额度','待审核','待对账',''],rows):empty('暂无补偿记录'))+pager(data.total,data.items.length);icons();
}
async function statisticsDrill(value){
  adminDrill={key:{users:'owner',models:'model',channels:'channel'}[statKind],value,page:1};await renderStatisticsDrill();$('#detail-dialog').showModal();
}
async function renderStatisticsDrill(){
  const d=adminDrill,data=await api('/api/admin/claims?'+new URLSearchParams({[d.key]:d.value,page:d.page}));
  $('#detail-body').innerHTML='<h3>'+esc(d.value)+' · 补偿明细</h3>'+table(['用户','模型','补偿额度','状态',''],data.items.map(c=>'<tr><td>'+esc(c.username)+'<span class="sub">ID '+c.user_id+'</span></td><td>'+esc(c.log.model_name)+'</td><td>'+money(c.amount)+'</td><td>'+badge(c.status)+'</td><td><button class="ghost" data-detail="'+c.id+'">申请详情</button></td></tr>'))+'<div class="pagination"><span>共 '+data.total+' 笔</span><div><button class="ghost" data-drill-turn="-1" '+(d.page<=1?'disabled':'')+'>上一页</button><span>'+d.page+'</span><button class="ghost" data-drill-turn="1" '+(d.page*30>=data.total?'disabled':'')+'>下一页</button></div></div>';icons();
}
async function notifications(){
  const [n,r]=await Promise.all([api('/api/admin/notifications'),api('/api/admin/rules')]);s.rules=r;
  const template='### 空回补额度成功\n- **申请号**：实际申请号\n- **用户**：原站用户名（ID 原站用户 ID）\n- **类型**：空回补额度\n- **模型**：原消费模型\n- **原请求**：原请求标识\n- **补回额度**：'+money(500)+'\n- **状态**：已补回\n- **处理说明**：NewAPI 明确返回成功\n- **时间**：'+new Date().toLocaleString('zh-CN',{timeZone:r.timezone,hour12:false});
  $('#content').innerHTML='<div class="notice">配置只在服务端加密保存，密钥不回显。失败最多重试 5 次；超时可能造成通知重复，不会重复执行补偿。</div>'+panel('钉钉加签机器人','<form id="notification-form" class="panel-body"><div class="form-grid"><label class="full">Webhook 地址<input name="webhook" type="password" autocomplete="off" placeholder="'+(n.config.configured?'已配置，留空保持':'输入钉钉官方机器人地址')+'"></label><label class="full">加签密钥<input name="secret" type="password" autocomplete="off" placeholder="'+(n.config.signed?'已配置，留空保持':'输入加签密钥')+'"></label><label class="check-label"><input name="enabled" type="checkbox" '+(r.notifications.enabled?'checked':'')+'>通知总开关</label>'+Object.entries(eventNames).map(([k,v])=>'<label class="check-label"><input name="events" type="checkbox" value="'+k+'" '+(r.notifications.events.includes(k)?'checked':'')+'>'+v+'</label>').join('')+'</div><div class="form-actions"><button class="primary">保存通知设置</button><button type="button" id="test-notification" class="secondary">发送测试</button></div></form>')+panel('发送记录',n.items.length?table(['事件','状态','尝试次数','结果','时间'],n.items.map(v=>'<tr><td>'+esc(eventNames[v.event]||v.event)+'</td><td>'+esc(v.status)+'</td><td>'+v.attempts+'</td><td>'+esc(v.result||'等待发送')+'</td><td>'+date(v.created_at)+'</td></tr>')):empty('还没有发送记录'));
  $('#content').insertAdjacentHTML('beforeend',panel('Markdown 通知预览','<div class="panel-body"><pre class="notification-preview">'+esc(template)+'</pre></div>'));
}
async function audit(){const data=await api('/api/admin/audit');$('#content').innerHTML=panel('最近 100 条操作',data.length?table(['操作人','动作','关联申请','时间','详情'],data.map(v=>'<tr><td>#'+esc(v.actor_id)+'</td><td>'+esc(v.action)+'</td><td>'+esc(v.claim_id||'配置操作')+'</td><td>'+date(v.created_at)+'</td><td><details><summary>查看</summary><pre>'+esc(JSON.stringify(JSON.parse(v.detail),null,2))+'</pre></details></td></tr>')):empty('暂无操作记录'));}
function showOperation(title,body,op){operation=op;$('#operation-title').textContent=title;$('#operation-body').hidden=false;$('#operation-body').innerHTML=body;$('#operation-error').textContent='';$('#operation-results').replaceChildren();$('#operation-submit').hidden=false;$('#operation-submit').disabled=false;$('#operation-submit').textContent=op.kind==='apply'?(op.automatic?'确认核验并返还':'确认提交审批'):'确认处理';$('#operation-form .dialog-footer [data-close-operation]').textContent='取消';$('#detail-dialog').close();$('#operation-dialog').showModal();}
const operationNote=(label,required=true)=>{if(s.page==='logs'){required=false;label='补充说明（选填）';}return '<label class="operation-note">'+label+'<textarea name="note" '+(required?'required':'')+' maxlength="2000" placeholder="'+(required?'填写核验依据':'补充说明（选填）')+'"></textarea></label>';};
async function apply(ids){
  if(!ids.length)return toast('先展开模型并勾选消费记录');if(ids.length>30)return toast('每批最多 30 笔');const items=ids.map(id=>currentLogs.find(v=>v.log.request_id===id));if(items.some(v=>!v?.assessment.canApply))throw Error('所选记录已不可申请，请刷新核验');
  const manual=s.page==='adminLogs',automatic=manual?0:items.filter(v=>v.assessment.route==='automatic').length;
  showOperation(manual?'确认补偿申请':'确认自助补额度','<div class="notice">'+(manual?'站长手动申请进入审核流程。':'确认后将逐笔核验并返还符合条件的额度；异常记录转审批。预计自助 '+automatic+' 笔，审批 '+(ids.length-automatic)+' 笔，以服务端二次核验为准。')+'</div><div class="preview-summary compact"><div><small>消费笔数</small><strong>'+ids.length+' <em>笔</em></strong></div><div><small>涉及模型</small><strong>'+new Set(items.map(v=>v.log.model_name)).size+'</strong></div><div><small>预计返还</small><strong class="amount">'+money(items.reduce((sum,v)=>sum+v.assessment.expectedQuota,0))+' </strong></div></div><div class="operation-list">'+items.map(v=>'<p><strong>'+esc(v.log.model_name)+'</strong><span>'+esc(v.log.request_id)+' · '+(manual?'人工审批':v.assessment.route==='automatic'?'自助返还':'异常审批：'+esc(v.assessment.reviewReasons.join('；')))+'</span></p>').join('')+'</div>'+operationNote(automatic===ids.length?'补偿说明（选填）':'异常补偿依据',automatic!==ids.length),{kind:'apply',ids:[...ids],automatic,endpoint:(manual?'/api/admin':'/api')+'/claims'});
}
async function action(name,ids){
  if(!ids.length)return toast('先勾选申请');if(ids.length>30)throw Error('每批最多 30 笔');const items=[];let body='';
  if(['execute','approve'].includes(name)){
    s.display=await api('/api/display');
    for(const id of ids){const c=await api('/api/admin/claims/'+id);if(c.status!==(name==='execute'?'approved':'pending'))throw Error('申请状态已变化，请刷新后处理：'+id);items.push({id,quota:c.log.quota,requestId:c.request_id,confirmAmount:name==='execute'||c.fundingSource==='subscription'});}
    const crediting=items.filter(item=>item.confirmAmount).length;
    body='<div class="notice '+(crediting?'warning':'')+'">本次处理 '+items.length+' 笔申请。'+(crediting?'其中 '+crediting+' 笔将核验并补入用户钱包余额。订阅申请审批通过即发起余额补偿，不恢复订阅额度；须核实原扣费及历史退款，结果不明禁止直接重试。':'审核通过后等待核验执行。')+'</div>'+items.map((c,i)=>c.confirmAmount?'<label class="amount-entry">'+esc(c.requestId)+'<span class="field-help">原消费 '+money(c.quota)+'，填写已核实未返还金额</span><input name="amount-'+i+'" type="number" min="0" max="'+inputQuota(c.quota,s.display)+'" step="any" required placeholder="逐笔核实后填写"></label>':'').join('');
  }
  else{for(const id of ids)items.push({id,outcome:name});body='<div class="notice">本次处理 '+ids.length+' 笔申请。'+(['received','not_received'].includes(name)?'仅登记核对结果，不发放额度。':'操作会记录审计。')+'</div>';}
  const crediting=items.some(item=>item.confirmAmount);
  showOperation(name==='execute'?'核验并确认返还':name==='approve'&&crediting?'审核并确认补入余额':({approve:'审核通过',reject:'驳回申请',reopen:'重新审核',received:'登记已到账',not_received:'登记未到账'}[name]||'确认处理'),body+operationNote(crediting?'核验说明：实际扣费、历史退款及无有效输出依据':'审核 / 核对依据'),{kind:'action',name,items,display:structuredClone(s.display)});
  if(name==='approve'&&crediting)$('#operation-submit').textContent='确认审核并补入余额';
}
async function submitOperation(form){
  if(!operation)return;const op=operation,f=new FormData(form),note=String(f.get('note')||'').trim()||(op.kind==='apply'?'申请自动核验空回补偿':'');if(!note)throw Error('请填写依据');let payload;
  if(op.kind==='apply')payload={requestIds:op.ids,reason:note};else{const items=op.items.map((item,i)=>{if(!item.confirmAmount)return {id:item.id,outcome:item.outcome};const displayedAmount=String(f.get('amount-'+i)),verifiedAmount=parseQuota(displayedAmount,op.display);if(!Number.isSafeInteger(verifiedAmount)||verifiedAmount<=0||verifiedAmount>item.quota)throw Error('额度必须大于零且不超过原消费，并符合原站最小精度');return {id:item.id,displayedAmount};});payload={action:['received','not_received'].includes(op.name)?'reconcile':op.name,items,note,displayRevision:op.display?.revision};}
  const button=$('#operation-submit');button.textContent=op.kind==='apply'?'正在自动审批与返还…':'正在逐笔处理…';let data;
  try{data=await api(op.kind==='apply'?op.endpoint:'/api/admin/actions','POST',payload);}catch(error){if(op.kind==='action'||op.automatic){button.hidden=true;operation=null;$('#operation-error').textContent='请求未确认，请关闭窗口并刷新申请状态后核对，禁止直接重复发放。'+error.message;return;}button.textContent='确认提交申请';throw error;}
  await render();
  $('#operation-title').textContent=op.kind==='apply'?'补额度处理结果':'处理结果';$('#operation-body').hidden=true;$('#operation-form .dialog-footer [data-close-operation]').textContent='完成';
  const summary=op.kind==='apply'?'<div class="preview-summary compact"><div><small>已确认返还</small><strong class="amount">'+money(data.reduce((sum,v)=>sum+(v.status==='succeeded'?v.claim.amount:0),0))+' </strong></div><div><small>转入审批</small><strong>'+data.filter(v=>v.status==='pending').length+' <em>笔</em></strong></div><div><small>失败 / 待确认</small><strong>'+data.filter(v=>!v.success||['failed','unknown','executing'].includes(v.status)).length+' <em>笔</em></strong></div></div>':'';
  const successes=data.filter(v=>v.success&&v.status==='succeeded');
  const successAnimation=successes.length?'<div class="refund-success" role="status"><div class="refund-success-check">'+icon('circle-check')+'</div><div><h3>补额度成功</h3><p>'+successes.length+' 笔已确认补回'+(op.kind==='apply'?' · '+money(successes.reduce((sum,v)=>sum+v.claim.amount,0))+'':'')+'</p></div></div>':'';
  $('#operation-results').innerHTML=successAnimation+summary+'<h3>逐笔处理结果</h3>'+data.map(v=>'<div class="result-row">'+badge(v.success?(v.status||'pending'):'failed')+'<span>'+esc(v.requestId||v.id)+'</span><p>'+esc(v.success?(op.kind==='apply'?(v.claim?.review_note||statuses[v.status]||'已提交，等待审批'):statuses[v.status]||'已处理'):v.message)+'</p></div>').join('');
  icons();
  button.hidden=true;operation=null;form.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
}
document.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b||s.busy)return;busyButton(b,true);try{
  if(b.id==='storage-confirm'){
    if(!storagePlan)throw Error('请重新预览清理');
    s.busy=true;b.disabled=true;
    const result=await api('/api/admin/storage/cleanup','POST',{token:storagePlan.token,confirmation:'确认清理'});storagePlan=null;
    $('#detail-body').innerHTML='<div class="notice">清理完成，补偿账本与去重记录已保留。</div>'+lines([['清理查询缓存',result.cache],['清理通知记录',result.notifications],['删除旧快照',result.backups],['释放快照空间',num(result.backupBytes)+' 字节'],['跳过变化文件',result.skippedBackups],['数据库整理',result.compacted?'已完成':result.compactError||'未执行']]);
    await rules();return;
  }
  if(b.hasAttribute('data-queue-status')){adminStatus=b.dataset.queueStatus;claimGroup=null;s.n=1;await adminQueue();return;}
  if(b.hasAttribute('data-owner')){await openClaimGroup(Number(b.dataset.owner));return;}
  if(b.hasAttribute('data-group-page')&&claimGroup){await openClaimGroup(claimGroup.owner,claimGroup.page+Number(b.dataset.groupPage));return;}
  if(b.hasAttribute('data-consumption')){consumptionDetail(Number(b.dataset.consumption));return;}
  if(b.hasAttribute('data-drill')){await statisticsDrill(b.dataset.drill);return;}
  if(b.dataset.drillTurn){adminDrill.page+=Number(b.dataset.drillTurn);await renderStatisticsDrill();return;}
  if(b.id==='menu-toggle'){setDrawer($('#menu-toggle').getAttribute('aria-expanded')!=='true');return;}
  if(['drawer-close','drawer-backdrop'].includes(b.id)){setDrawer(false);return;}
  if(b.id==='account-toggle'){const open=$('#account-menu').hidden;$('#account-menu').hidden=!open;b.setAttribute('aria-expanded',String(open));return;}
  if(b.id==='search-toggle'){$('#search-dialog').showModal();$('#page-search').value='';searchPages();$('#page-search').focus();return;}
  if(b.id==='search-close'){$('#search-dialog').close();return;}
  if(b.id==='statistics-refresh'){b.disabled=true;try{await personalStatistics();}finally{b.disabled=false;}return;}
  if(b.dataset.nav){await navigate(b.dataset.nav);return;}
  if(b.id==='account-logout'){$('#logout').click();return;}
  if(b.id==='theme-toggle'){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('huixiang-theme',document.documentElement.dataset.theme);}catch{}theme();return;}
  if(b.hasAttribute('data-close-operation')){$('#operation-dialog').close();operation=null;return;}
  if(b.id==='query-empty'){s.busy=true;b.disabled=true;b.textContent='正在查询…';refundQueried=true;await logs();return;}
  if(b.dataset.turn){s.n+=Number(b.dataset.turn);await render();}else if(b.dataset.detail)await detail(b.dataset.detail);else if(b.dataset.apply){s.busy=true;await apply([b.dataset.apply]);}else if(b.id==='batch-apply'){s.busy=true;await apply([...new Set([...document.querySelectorAll('[name="log-select"]:checked,[name="mobile-log-select"]:checked')].map(v=>v.value))]);}else if(b.dataset.action){s.busy=true;await action(b.dataset.action,[b.dataset.id]);}else if(b.dataset.batch){s.busy=true;await action(b.dataset.batch,[...document.querySelectorAll('[name="claim-select"]:checked')].map(v=>v.value));}else if(b.dataset.stats){statKind=b.dataset.stats;s.n=1;await stats();}else if(b.id==='refresh')await render();else if(b.id==='close-dialog')$('#detail-dialog').close();else if(b.id==='logout'){await api('/api/auth/logout','POST',{});loginView();}else if(b.id==='test-notification'){await api('/api/admin/notifications/test','POST',{});toast('测试已入队，刷新查看发送结果');}
}catch(e){toast(e.message);}finally{s.busy=false;busyButton(b,false);if(b.id==='query-empty'&&b.isConnected){b.disabled=false;b.textContent='查询空回';}}});

$('#operation-dialog').addEventListener('cancel',event=>{if(s.busy)event.preventDefault();else operation=null;});
$('#detail-dialog').addEventListener('close',()=>{$('#detail-title').textContent='申请详情与处理';storagePlan=null;});
$('#page-search').addEventListener('input',searchPages);
document.addEventListener('toggle',event=>{if(event.target.matches?.('.refund-record'))event.target.querySelector('summary').setAttribute('aria-label',event.target.open?'收起补回记录':'展开补回记录');},true);
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.name==='model-choice'){if(el.checked)pickedModels.add(el.value);else pickedModels.delete(el.value);}
  if(['channel-choice','restrictModels'].includes(el.name))renderCatalogModels();
  if(el.id==='select-page'){
    selectedLogs.clear();if(el.checked)currentLogs.filter(v=>v.assessment.canApply).forEach(v=>selectedLogs.add(v.log.request_id));
    updateLogSelection();
  }else if(['log-select','mobile-log-select'].includes(el.name)){
    if(el.checked)selectedLogs.add(el.value);else selectedLogs.delete(el.value);
    updateLogSelection();
  }
});
document.addEventListener('input',event=>{if(event.target.id==='model-search')renderCatalogModels();if(event.target.id==='channel-search'){const q=event.target.value.toLowerCase();document.querySelectorAll('[name=channel-choice]').forEach(el=>el.closest('label').hidden=!el.closest('label').textContent.toLowerCase().includes(q));}});
document.addEventListener('change',async event=>{try{if(event.target.id==='statistics-days'){statisticsDays=Number(event.target.value);await personalStatistics();}else if(event.target.id==='statistics-auto'){statisticsAuto=event.target.checked;if(statisticsAuto)scheduleStatistics();else stopStatistics();}}catch(e){toast(e.message);}});
document.addEventListener('click',event=>{if(!event.target.closest('.account')){$('#account-menu').hidden=true;$('#account-toggle').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if($('#workspace').classList.contains('drawer-open')){setDrawer(false);event.preventDefault();}if(!$('#account-menu').hidden){$('#account-menu').hidden=true;$('#account-toggle').setAttribute('aria-expanded','false');$('#account-toggle').focus();}}
  if(event.key==='Tab'&&$('#workspace').classList.contains('drawer-open')){const items=[...$('.sidebar').querySelectorAll('button:not([disabled])')],first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();if(s.busy)return;s.busy=true;const form=event.target,f=new FormData(form),b=form.querySelector('button[type="submit"]')||form.querySelector('button');if(b){b.disabled=true;busyButton(b,true);}
  try{
    if(form.id==='storage-form'){
      const options={};for(const key of ['cache','notifications','backups','compact'])options[key]=f.has(key);for(const key of ['cacheDays','notificationDays','backupDays'])options[key]=Number(f.get(key));
      storagePlan=await api('/api/admin/storage/preview','POST',options);
      $('#detail-title').textContent='数据库清理';
      $('#detail-body').innerHTML='<h3>清理预览</h3>'+lines([['过期查询缓存',storagePlan.cache],['已结束通知',storagePlan.notifications],['旧快照',storagePlan.backups.length],['快照空间',num(storagePlan.backupBytes)+' 字节'],['数据库整理',storagePlan.compact?'执行':'不执行']])+(storagePlan.backups.length?'<details><summary>快照文件</summary><ul>'+storagePlan.backups.map(file=>'<li>'+esc(file.name)+'</li>').join('')+'</ul></details>':'')+'<p class="field-help">仅清理本次预览范围，5 分钟内有效；不可撤销。申请、发放账本、审计和密钥保留。</p><button type="button" class="danger" id="storage-confirm">确认清理</button>';
      icons();$('#detail-dialog').showModal();
    }else if(form.id==='operation-form'){await submitOperation(form);} else if(['login-form','verify-form'].includes(form.id)){
      $('#login-message').textContent='';let data;
      if(form.id==='login-form'){const password=f.get('password');form.elements.password.value='';data=await api('/api/auth/login','POST',{username:f.get('username'),password});}
      else data=await api('/api/auth/verify','POST',{challengeId:s.challenge,code:f.get('code')});
      if(data.requireVerification){s.challenge=data.challengeId;$('#login-form').hidden=true;$('#verify-form').hidden=false;toast('原站要求二次验证，输入动态验证码。Passkey 等方式尚未接入。');}
      else{$('#verify-form').reset();$('#verify-form').hidden=true;$('#login-form').hidden=false;await enter(data);}
    }else if(form.id==='log-filter'){for(const k of Object.keys(filters))if(f.has(k))filters[k]=f.get(k);s.n=1;await logs();}
    else if(form.id==='claim-filter'){filters.status=f.get('status');s.n=1;await claims();}
    else if(form.id==='rules-form'){
      const r=structuredClone(s.rules),displayedQuotas={};for(const [k]of numeric){if(quotaFields.has(k))displayedQuotas[k]=String(f.get(k));else r[k]=Number(f.get(k));}for(const k of ['applicationsEnabled','executionEnabled','selfServiceEnabled','restrictModels'])r[k]=f.has(k);r.channels=f.getAll('channel-choice').map(Number);r.blockedUsers=String(f.get('blockedUsers')).split(/[,，\s]+/).filter(Boolean).map(Number);r.models=[...pickedModels];r.userGroups=f.getAll('group-choice');r.timezone=f.get('timezone');r.dailyResetTime=f.get('dailyResetTime');r.notifications.enabled=f.has('notificationsEnabled');await api('/api/admin/rules','PUT',{...r,lookbackDays:Number(f.get('lookbackDays')),displayedQuotas,displayRevision:s.display?.revision});toast('规则已保存并记录新版本');await rules();
    }else if(form.id==='notification-form'){
      const webhook=f.get('webhook').trim(),secret=f.get('secret').trim();if(webhook||secret)await api('/api/admin/notifications','PUT',{...(webhook?{webhook}:{}),...(secret?{secret}:{})});const r=structuredClone(s.rules);r.notifications={enabled:f.has('enabled'),events:f.getAll('events')};await api('/api/admin/rules','PUT',r);toast('通知设置已保存');await notifications();
    }
  }catch(e){if(['login-form','verify-form'].includes(form.id)){$('#login-message').textContent=e.message;$('#login-form').hidden=false;$('#verify-form').hidden=true;}else if(form.id==='operation-form')$('#operation-error').textContent=e.message;else toast(e.message);}
  finally{s.busy=false;if(b){b.disabled=false;busyButton(b,false);}}
});
async function loadBrand(){
  try{
    const brand=await api('/api/brand');
    document.title='云响 · NewAPI 补空回';
    const mobile=document.querySelector('.mobile-brand');if(mobile)mobile.textContent='云响';
    if(brand.logo)for(const root of document.querySelectorAll('[data-brand-logo]')){
      const img=new Image();img.alt='云响 Logo';img.referrerPolicy='no-referrer';
      img.addEventListener('load',()=>{root.replaceChildren(img);root.classList.add('has-logo');});img.src=brand.logo;
    }
  }catch{}
}
loadBrand();
try{await enter(await api('/api/me'));}catch{loginView();}
