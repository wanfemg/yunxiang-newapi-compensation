import {formatQuota,inputQuota,parseQuota} from './display.js';
import {enhanceControls} from './controls.js';
import {renderSnapshot,bindSnapshot} from './snapshot.js';
import {notificationCenter,emailPreview} from './notification-center.js';
import {watchUIVersion} from './ui-version.js';
import {userInbox} from './user-inbox.js';
import {renderAuditLog} from './audit-log.js';
import {renderQueryBatch,batchStatus} from './query-batches.js';
const canonicalOrigin = document.querySelector('meta[name="application-origin"]')?.content;
if (canonicalOrigin && new URL(canonicalOrigin).protocol === 'https:' && location.origin !== canonicalOrigin) {
  location.replace(canonicalOrigin + '/');
  throw new Error('正在转到 HTTPS 登录入口');
}
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const num = n => Number(n || 0).toLocaleString('zh-CN');
const date = t => t ? new Date(t).toLocaleString('zh-CN', {hour12:false}) : '—';
const s = { user:null, csrf:'', page:'overview', n:1, rules:null, challenge:'', busy:false };
const money=value=>formatQuota(value,s.display);
const quotaFields=new Set(['perRecordQuota','perBatchQuota','selfServiceMaxQuota','userDailyQuota','siteDailyQuota']);
let catalog=null,aiConfig=null,adminStatus='pending',adminDrill=null,pickedModels=new Set(),claimGroup=null;
let excludedModels=new Map();
const modelRuleKey=(channelId,model)=>JSON.stringify([channelId,model]);
let storagePlan=null,notificationTab='ding';
let inboxUnreadOnly=false,inboxTimer=null,aiSettingsSave=null;
const fundingLabel=source=>({subscription:'订阅额度 · 站长审批',wallet:'钱包余额',unknown:'资金来源待核实'}[source]||'资金来源待核实');
const compensationLabel=c=>c?.compensationLabel||(c?.fundingSource==='subscription'?'订阅空回 · 余额补偿':c?.source==='manual'?'人工空回补偿':'空回补偿');
const statuses = {pending:'待审核',approved:'已通过 · 待执行',rejected:'已驳回',executing:'执行中',succeeded:'补偿成功',failed:'明确失败',unknown:'结果待确认'};
const pages = {overview:'我的概览',statistics:'数据统计',logs:'可补空回日志',claims:'我的申请',records:'补偿记录',rules:'补偿规则',help:'使用教程与答疑',adminOverview:'管理概览',adminLogs:'原始消费查询',adminClaims:'申请处理中心',stats:'补偿统计',settings:'补偿规则设置',notifications:'钉钉通知',audit:'操作记录'};
const eventNames = {application_pending:'申请待审核',review_result:'审核结果',compensation_success:'补偿成功',execution_failed:'执行失败',execution_unknown:'结果待确认',ai_reviewing:'AI 审查开始',ai_reviewed:'AI 判定结果',ai_auto_compensation:'AI 审查通过 · 自动补额度',ai_manual_review:'AI 不确定 · 转人工审核',batch_result:'批量申请汇总'};
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
const loading=message=>'<div class="loading liquid-loading" role="status" aria-busy="true"><span class="liquid-loader" aria-hidden="true"><i></i><b></b></span><span>'+esc(message)+'</span></div>';
function busyButton(button,busy){if(!button)return;button.classList.toggle('is-loading',busy);button.setAttribute('aria-busy',String(busy));}
const iconNames={overview:'house',statistics:'chart-no-axes-combined',logs:'refresh-cw',claims:'clipboard-list',records:'history',rules:'shield-check',help:'circle-help',adminOverview:'layout-dashboard',adminLogs:'search',adminClaims:'list-checks',stats:'chart-column',settings:'settings',notifications:'bell',audit:'file-clock'};
const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
$('#search-toggle').insertAdjacentHTML('beforebegin','<button id="inbox-toggle" class="ghost icon-button" data-nav="inbox" aria-label="站内通知" title="站内通知">'+icon('bell')+'<span id="inbox-badge" class="inbox-badge" hidden></span></button>');
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
function availablePages(){return ['overview','statistics','logs','claims','records','rules','help','inbox',...(s.user?.role>=10?['adminOverview','adminLogs','adminClaims','stats','settings','notifications','audit']:[])];}
function searchPages(){const query=$('#page-search').value.trim().toLowerCase();$('#search-results').innerHTML=availablePages().filter(p=>pages[p].toLowerCase().includes(query)).map(navButton).join('')||empty('没有匹配页面');icons();}
async function navigate(page){if(!availablePages().includes(page))return;stopStatistics();if(page==='logs')refundQueried=false;s.page=page;s.n=1;$('#account-menu').hidden=true;$('#account-toggle').setAttribute('aria-expanded','false');$('#search-dialog').close();if(mobile.matches)setDrawer(false);await render();window.scrollTo({top:0});$('#page-title').tabIndex=-1;$('#page-title').focus({preventScroll:true});}
try{document.documentElement.dataset.theme=localStorage.getItem('huixiang-theme')==='light'?'light':'dark';}catch{}
theme();
function toast(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('#toast').hidden=true,6500); }
async function api(path, method='GET', body) {
  const owner=s.user,page=s.page;
  document.documentElement.classList.add('network-loading');api.pending=(api.pending||0)+1;
  try{
  const r=await fetch(path,{method,cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await r.json();
  if(!path.startsWith('/api/auth/')&&(owner!==s.user||(method==='GET'&&page!==s.page)))throw Error('页面或账号已切换，已忽略旧请求');
  if(!r.ok||!value.success){if(r.status===401&&!path.startsWith('/api/auth/')) loginView();throw Error(value.message||'请求失败');}return value.data;
  }finally{api.pending--;if(!api.pending)document.documentElement.classList.remove('network-loading');}
}
function loginView(){stopStatistics();clearInterval(inboxTimer);inboxTimer=null;inboxUnreadOnly=false;syncInboxBadge(0);setDrawer(false,false);$('#search-dialog').close();$('#account-menu').hidden=true;s.user=null;s.csrf='';currentLogs=[];operation=null;for(const key of Object.keys(filters))filters[key]=key==='view'?'eligible':'';$('#content').replaceChildren();$('#detail-body').replaceChildren();$('#operation-body').replaceChildren();$('#operation-results').replaceChildren();$('#operation-dialog').close();$('#login').hidden=false;$('#workspace').hidden=true;$('#detail-dialog').close();}
function badge(v){return '<span class="badge '+(v==='succeeded'?'good':['failed','unknown','rejected'].includes(v)?'bad':'neutral')+'">'+esc(statuses[v]||v)+'</span>';}
function empty(v){return '<div class="empty"><div class="symbol">↺</div>'+esc(v)+'</div>';}
function panel(title,body,note=''){return '<section class="panel"><div class="panel-head"><div><h3>'+esc(title)+'</h3>'+(note?'<p class="muted">'+esc(note)+'</p>':'')+'</div></div>'+body+'</section>';}
function table(headers,rows){return '<div class="table-scroll"><table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
function metric(label,value,note,highlight=false){return '<div class="metric'+(highlight?' highlight':'')+'"><small>'+esc(label)+'</small><strong>'+(typeof value==='number'?(['累计补偿额度','今日剩余额度','空回补额度'].includes(label)?money(value):num(value)):esc(value))+'</strong><em>'+esc(note)+'</em></div>';}
function lines(rows){return '<div class="rule-lines">'+rows.map(([k,v])=>'<div class="rule-line"><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div>';}
function pager(total,count){return '<div class="pagination"><span>当前页 '+count+' 条 / 原始记录 '+num(total)+' 条</span><div><button class="ghost" data-turn="-1" '+(s.n<=1?'disabled':'')+'>上一页</button>'+s.n+'<button class="ghost" data-turn="1" '+(s.n*30>=total?'disabled':'')+'>下一页</button></div></div>';}
function nav(){const admin=['adminOverview','adminLogs','adminClaims','stats','settings','notifications','audit'];$('#nav').innerHTML=navButton('overview')+'<div class="nav-group">控制台</div>'+['statistics','logs'].map(navButton).join('')+'<div class="nav-group">个人中心</div>'+['claims','records','inbox','rules','help'].map(navButton).join('')+(s.user.role>=10?'<div class="nav-group">站长管理</div>'+admin.map(navButton).join(''):'');icons();}
function navButton(p){return '<button class="nav-button '+(s.page===p?'active':'')+'" data-nav="'+p+'" '+(s.page===p?'aria-current="page"':'')+'>'+icon(iconNames[p])+pages[p]+'</button>';}
async function enter(data){refundQueried=false;catalog=null;s.display=null;s.user=data.user;s.csrf=data.csrf;try{s.display=await api('/api/display');}catch(e){toast('站点额度配置读取失败：'+e.message);}s.page=s.user.role>=10?'adminOverview':'overview';$('#login').hidden=true;$('#workspace').hidden=false;$('#account-name').textContent=s.user.display_name+(s.user.role>=10?' · 站长':'');$('#account-toggle').textContent=(s.user.display_name||s.user.username).slice(0,1);setDrawer(!mobile.matches,false);await render();clearInterval(inboxTimer);inboxTimer=setInterval(()=>{if(s.user&&!s.busy&&!api.pending&&!document.hidden)refreshInboxBadge().catch(()=>{});},30000);}
async function render(){
  const owner=s.user,page=s.page;
  $('#content').classList.remove('is-fetching');$('#content').removeAttribute('aria-busy');
  nav();$('#page-title').textContent=pages[s.page];$('#breadcrumb').textContent=pages[s.page];$('#page-subtitle').textContent=s.page==='statistics'?'查看当前账号的补回额度与每日趋势。':s.page==='help'?'了解查询、审核、补偿和失败处理流程。':'正常自助返还，异常提交审批。每笔处理有据可查。';$('#page-kicker').textContent=['overview','statistics','logs','claims','records','rules','help'].includes(s.page)?'MY WORKSPACE':'ADMINISTRATION';$('#content').innerHTML=loading('正在读取记录…');$('#refresh').hidden=s.page==='statistics';
  try{if(s.page.endsWith('Overview')||s.page==='overview')await overview();else if(s.page==='statistics')await personalStatistics();else if(['logs','adminLogs'].includes(s.page))await logs();else if(['claims','records','adminClaims'].includes(s.page))await claims();else if(['rules','settings'].includes(s.page))await rules();else if(s.page==='help')help();else if(s.page==='inbox')await inbox();else if(s.page==='stats')await stats();else if(s.page==='notifications')await notifications();else await audit();icons();if(s.page!=='inbox')refreshInboxBadge().catch(()=>{});}
  catch(e){if(owner!==s.user||page!==s.page)return;$('#content').innerHTML='<div class="notice warning">'+esc(e.message)+'</div><p class="muted">核对 云中猫API小站 连接与管理凭据后刷新。页面不使用示例数据替代真实记录。</p>';}
}
async function overview(){
  const admin=s.page==='adminOverview',p=admin?'/api/admin':'/api';
  const [o,r,c]=await Promise.all([api(p+'/overview'),api(p+'/rules'),api(p+'/claims')]);s.rules=r;
  if(admin){
    const recent=new Map();
    c.items.slice(0,8).forEach(v=>{const key=String(v.user_id);if(!recent.has(key))recent.set(key,{user_id:v.user_id,username:v.username,items:[]});recent.get(key).items.push(v);});
    const recentRows=[...recent.values()].map(group=>{
      const models=[...new Set(group.items.map(v=>v.log.model_name))],amount=group.items.reduce((sum,v)=>sum+Number(v.amount||v.expectedAmount||0),0),statuses=[...new Set(group.items.map(v=>v.status))],latest=group.items[0],status=statuses.length===1?statuses[0]:'unknown';
      return '<tr><td><strong>'+esc(group.username)+'</strong><span class="sub">ID '+group.user_id+' · '+group.items.length+' 笔申请</span></td><td><div class="recent-user-models">'+models.map(model=>'<span>'+esc(model)+'</span>').join('')+'</div><span class="sub">'+models.length+' 个模型 · 合计 '+money(amount)+'</span></td><td>'+badge(status)+(statuses.length>1?'<span class="sub">包含 '+statuses.map(v=>esc(statuses[v]||v)).join('、')+'</span>':'')+'</td><td>'+date(latest.created_at)+'</td><td><button class="ghost" data-nav="adminClaims">'+icon('chevron-right')+'<span>查看申请</span></button></td></tr>';
    });
    $('#content').innerHTML='<div class="metrics">'+metric('累计补回',money(o.compensatedQuota),'已确认到账',true)+metric('补偿用户',o.compensatedUsers,'按原站用户去重')+metric('待人工审核',o.pending,'异常记录')+metric('待对账 / 失败',o.unknown+o.failed,'返还状态待核实')+'</div>'+panel('最近申请',recentRows.length?table(['申请用户','涉及模型 / 合计额度','状态','最近申请时间',''],recentRows):empty('暂无申请'))+'<div class="admin-shortcuts"><button class="secondary" data-nav="adminClaims">'+icon('list-checks')+'申请处理中心</button><button class="secondary" data-nav="stats">'+icon('chart-column')+'用户 / 模型 / 渠道统计</button></div>';return;
  }
  const cards=admin?metric('累计返还额度',o.compensatedQuota,'已确认成功',true)+metric('补偿用户数',o.compensatedUsers,'成功获得补偿的原用户')+metric('待审核申请',o.pending,'等待人工核实')+metric('待确认 / 失败',o.unknown+o.failed,'结果不明禁止直接重试'):metric('累计补偿额度',o.compensatedQuota,'已确认成功',true)+metric('待审核记录',o.pending,'审核完成后整批补偿')+metric('今日剩余额度',Math.max(0,o.personalLimit.quota-o.today.quota),'执行中和待确认会预占')+metric('今日剩余次数',Math.max(0,o.personalLimit.count-o.today.count),'一次查询合并补偿计一次');
  const rows=c.items.slice(0,5).map(v=>'<tr><td>'+esc(v.log.model_name)+'<span class="sub">'+esc(v.request_id)+'</span></td><td>'+money(v.log.quota)+'</td><td>'+badge(v.status)+'</td><td><button class="ghost" data-detail="'+v.id+'">详情 →</button></td></tr>');
  $('#content').innerHTML='<section class="user-welcome"><div><span class="user-welcome-kicker">补偿服务 · '+esc(o.day)+'</span><h2>你好，'+esc(s.user.display_name||s.user.username)+'</h2><p>查看异常消费记录，符合规则的申请将自动核验；处理进度和补回结果都可追溯。</p><div class="user-service-state"><span class="state-dot '+(r.applicationsEnabled?'is-open':'is-closed')+'"></span>'+(r.applicationsEnabled?'当前开放申请':'当前暂停申请')+'<span>·</span>'+(r.executionEnabled?'自动核验可用':'自动核验暂停')+'<span>·</span>'+esc(o.timezone)+' '+esc(r.dailyResetTime||'00:00')+' 重置</div></div><div class="user-welcome-actions"><button class="primary" data-nav="logs">'+icon('search')+' 查询空回</button><button class="secondary" data-nav="claims">'+icon('list-checks')+' 我的申请</button></div></section><div class="metrics user-metrics">'+cards+'</div><div class="two-cols user-overview-grid">'+panel('最近申请',rows.length?table(['模型 / 原请求','原消费','状态','操作'],rows):empty('还没有申请记录'))+panel('当前补偿规则','<div class="panel-body">'+lines([['处理方式',r.selfServiceEnabled?'正常自助 · 异常审批':'自助暂停 · 人工审批'],['读取范围','最近 '+(r.lookbackDays||Math.ceil(r.applicationHours/24))+' 天'],['返还比例',r.refundBasisPoints/100+'%'],['每日重置',r.dailyResetTime||'00:00'],['支持模型',r.restrictModels===false?'所选渠道全部模型':r.models.join('、')||'尚未设置'],['全站今日占用',money(o.siteToday.quota)+' / '+money(o.siteLimit.quota)+''],['全站今日笔数',num(o.siteToday.count)+' / '+num(o.siteLimit.count)]])+'</div>')+'</div>';
}
function help(){
  const steps=[
    ['1','登录工作台','使用 云中猫API小站 原账号登录；勾选“保持登录”后，本工作台会保持 30 天。'],
    ['2','查询空回','进入“可补空回日志”，查询从上次成功截止到本次点击时间的新增消费。首次按管理员设置的天数查询。'],
    ['3','核对内容','每次查询形成独立补偿批次。展开模型查看原请求、预计补偿额度及处理状态。'],
    ['4','提交申请','点击整批核验并补额度。所有记录审核完成后，通过部分合并补偿一次；有待人工审核的记录时整批等待。'],
    ['5','跟踪结果','在“我的申请”和“补偿记录”查看 AI 审查、人工审核、到账或失败原因。']
  ];
  const faqs=[
    ['为什么查不到消费记录？','检查管理员允许的查询天数和模型范围。已覆盖的时间不回扫，原站延迟写入旧时段的日志不会再次查询。'],
    ['补偿次数怎么计算？','一次查询的全部模型合并补额度，成功后计一次。执行中与到账待核对预占一次；全部驳回或明确失败不占成功次数。'],
    ['为什么没有自动补偿？','零输出只是候选条件。模型、渠道、资金来源、额度、等待时间或每日限额任一项不符合，都会转人工审核。'],
    ['AI 审查失败怎么办？','系统会显示具体失败原因，并将记录转人工处理；AI 关闭或暂时不可用不会改变原有人工审核路径。'],
    ['为什么进入人工审核？','AI 置信度不足、判定为非空回、日志证据不完整、订阅额度或金额需要核对时，系统会冻结自动发放并等待管理员判断。'],
    ['“结果待确认”是什么意思？','原站增额请求的结果无法确认。额度已冻结，禁止重复提交，管理员核对原站账单后再决定是否重试。'],
    ['失败后能否重复提交？','同一日志不会重复创建 AI 审查或补偿任务。先阅读失败原因；只有管理员确认未到账并重新开放后，才允许再次执行。'],
    ['订阅额度为什么需要管理员核验？','订阅消费不直接恢复订阅额度，需管理员核对金额后从钱包余额补偿，避免改变原站订阅状态。'],
    ['钉钉通知没有收到怎么办？','管理员可检查通知开关、事件类型、机器人配置和发送记录；发送失败会显示重试次数与具体结果。'],
    ['保持登录有效多久？','普通登录默认保持 8 小时；勾选“保持登录”后保持 30 天。退出登录会立即使当前会话失效。'],
    ['如何切换暗色和亮色？','点击右上角主题按钮即可切换，选择会保存在当前浏览器。']
  ];
  $('#content').innerHTML='<div class="help-hero"><div><span class="eyebrow">GUIDE & FAQ</span><h2>使用教程与问题答疑</h2><p>从查询空回到补偿到账，每一步都能查看依据、状态和处理结果。</p></div><button class="secondary" data-nav="logs">'+icon('search')+'开始查询空回</button></div>'+panel('快速上手','<div class="help-steps">'+steps.map(([n,t,d])=>'<div class="help-step"><span>'+n+'</span><div><strong>'+t+'</strong><p>'+d+'</p></div></div>').join('')+'</div>')+panel('常见问题','<div class="help-faq">'+faqs.map(([q,a])=>'<details><summary>'+esc(q)+icon('chevron-down')+'</summary><p>'+esc(a)+'</p></details>').join('')+'</div>')+'<div class="notice">处理结果以 云中猫API小站 原站记录和管理员核验为准。任何显示“失败”或“结果待确认”的记录都不会自动重复发放。</div>';
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
      return '<div class="refund-day"><div class="refund-day-total"><strong>'+esc(day.slice(5).replace('-','/'))+'</strong><span>'+money(claims.reduce((sum,c)=>sum+c.amount,0))+' · '+claims.length+' 条消费</span></div><div class="history-models">'+[...byModel].map(([name,v])=>'<div><span>'+esc(name)+'</span><strong>'+money(v.amount)+' ('+v.count+' 条)</strong></div>').join('')+'</div></div>';
    }).join('');
    const labels=[...new Set(items.map(compensationLabel))];
    return '<details class="history-group refund-record"><summary aria-label="展开空回补偿记录"><span class="refund-record-top"><span class="amount">空回补偿 · 成功</span>'+icon('chevron-right')+'</span><span class="record-fields"><span>补偿类型</span><strong>'+esc(labels.join('、'))+'</strong><span>时间范围</span><strong>'+esc(times.length?format(Math.min(...times)).slice(0,-3)+' ~ '+format(Math.max(...times)).slice(0,-3):'未记录')+'</strong><span>补回额度</span><strong class="amount">'+money(amount)+'</strong><span>模型数量</span><strong>'+models.size+'</strong><span>创建时间</span><strong>'+esc(format(record.createdAt))+'</strong></span></summary><div class="record-breakdown">'+breakdown+'<div class="history-items">'+items.map(c=>'<div class="history-item"><span class="request-id">'+esc(c.request_id)+'</span><span class="sub">'+esc(compensationLabel(c))+'</span><button class="ghost" data-detail="'+esc(c.id)+'">查看详情</button></div>').join('')+'</div></div></details>';
  }).join('');
  return '<section class="refund-history"><div class="refund-history-heading"><h3>补回记录</h3><span>'+num(data.total)+' 条记录</span></div>'+ (records||empty('暂无补回记录'))+(s.page==='logs'&&data.total>data.items.length?'<button class="ghost" data-nav="records">查看全部记录</button>':'')+'</section>';
}
async function refundMeta(){const [overview,records]=await Promise.all([api('/api/overview'),api('/api/refund-records')]);return {overview,records};}
function refundHeader(overview,queried=false){return '<section class="user-welcome user-query-welcome"><div><span class="user-welcome-kicker">空回查询 · 原账号记录</span><h2>把每笔异常消费看清楚</h2><p>'+(queried?'查询完成。核对原消费、预计补回额度与处理资格后再提交。':'查询原账号近期消费记录，逐笔查看可申请额度和处理状态。')+'</p></div><div class="user-query-summary"><small>累计补回</small><strong>'+money(overview.compensatedQuota)+'</strong><button class="primary" id="query-empty">'+icon('search')+(queried?'重新查询':'查询空回')+'</button></div></section>';}
function skippedModelsMarkup(data){
  if(!data.skippedModels?.length)return '';
  return '<section class="skipped-models" aria-label="已跳过的模型"><div class="refund-history-heading"><h3>已跳过的模型</h3><span>'+num(data.skippedCount)+' 笔记录</span></div><ul>'+data.skippedModels.map(entry=>'<li><strong>'+esc(entry.model)+'</strong><span>'+num(entry.count)+' 笔 · '+esc(entry.reason)+'</span></li>').join('')+'</ul></section>';
}
async function refundLanding(){const owner=s.user,page=s.page,[meta,batches]=await Promise.all([refundMeta(),api('/api/batches')]);if(s.user!==owner||s.page!==page)return;currentLogs=[];selectedLogs.clear();$('#content').innerHTML=refundHeader(meta.overview)+batches.map(batch=>renderQueryBatch(batch,{money,date})).join('')+refundRecordsMarkup(meta.records);icons();}
async function logs({refresh=false}={}){
  const owner=s.user,page=s.page;
  if(s.page==='logs'&&!refundQueried){await refundLanding();return;}
  if(s.page==='adminLogs'){await adminConsumption();return;}
  const q=new URLSearchParams({page:s.n,view:'eligible'});
  if(refresh)q.set('refresh','1');
  const data=await api('/api/logs?'+q);
  if(s.user!==owner||s.page!==page)return;selectedLogs.clear();currentLogs=data.items;
  const meta=await refundMeta();if(s.user!==owner||s.page!==page)return;
  const progress=data.queryProgress;
  $('#content').innerHTML=refundHeader(meta.overview,true)+'<section class="refund-candidates"><div class="refund-history-heading"><h3>按查询补偿</h3><span>全部模型审核完成后统一补额度</span></div>'+(data.batches?.length?data.batches.map(batch=>renderQueryBatch(batch,{money,date})).join(''):empty('暂无待处理的补偿批次'))+(progress?'<div class="query-progress" role="status"><strong>已成功查询至 '+esc(date(progress.end*1000))+'</strong><span>'+(progress.scanned?'本次新增 '+num(progress.added)+' 条消费':'当前显示已保存的查询结果')+'</span><p>再次查询仅接续新增时间，已覆盖时段不再回扫。原站延迟写入已覆盖时段的日志不会补查。</p></div>':'')+'</section>'+skippedModelsMarkup(data)+refundRecordsMarkup(meta.records);
  icons();return;
}
async function claims(){
  if(s.page==='adminClaims'){await adminQueue();return;}
  if(s.page==='records'){const data=await api('/api/refund-records?page='+s.n);$('#content').innerHTML=refundRecordsMarkup(data)+pager(data.total,data.items.length);return;}
  const admin=s.page==='adminClaims',status=s.page==='records'?'succeeded':filters.status,data=await api((admin?'/api/admin':'/api')+'/claims?page='+s.n+'&status='+encodeURIComponent(status));
  const toolbar=s.page==='records'?'':'<form id="claim-filter" class="toolbar"><label>状态<select name="status"><option value="">全部状态</option>'+Object.entries(statuses).map(([k,v])=>'<option value="'+k+'" '+(k===status?'selected':'')+'>'+v+'</option>').join('')+'</select></label><button class="secondary">查询</button></form>';
  const batch=admin?'<div class="toolbar"><button class="secondary" data-batch="approve">批量通过</button><button class="danger" data-batch="reject">批量驳回</button><button class="primary" data-batch="execute">逐笔核验并批量执行</button></div>':'';
  const rows=data.items.map(c=>'<tr>'+(admin?'<td><input type="checkbox" name="claim-select" aria-label="选择申请" value="'+c.id+'"></td>':'')+'<td>'+esc(c.log.model_name)+'<span class="sub">'+esc(c.request_id)+'</span><span class="sub compensation-type">'+esc(compensationLabel(c))+'</span></td>'+(admin?'<td>#'+esc(c.user_id)+' '+esc(c.username)+'</td>':'')+'<td>'+money(c.log.quota)+'</td><td>'+money(c.amount)+'</td><td>'+badge(c.status)+'</td><td>'+date(c.created_at)+'</td><td><button class="ghost" data-detail="'+c.id+'">详情 →</button></td></tr>');
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
  const selectable=data.items.filter(c=>c.status===status&&['pending','approved'].includes(c.status));
  const actions=(selectable.length?'<label class="check-label claim-select-all"><input type="checkbox" data-select-all>全选本页</label>':'')+(status==='pending'?'<button class="secondary" data-batch="approve">审核所选</button><button class="danger" data-batch="reject">驳回所选</button>':status==='approved'?'<button class="primary" data-batch="execute">核验并执行所选申请</button>':'');
  const cards=[...models].map(([model,items])=>{const eligible=items.filter(c=>c.status===status&&['pending','approved'].includes(c.status));return '<details class="claim-model" open><summary><span>'+icon('chevron-right')+'<label class="check-label model-select-label"><input type="checkbox" data-model-select="'+esc(model)+'" aria-label="选择模型 '+esc(model)+'" '+(!eligible.length?'disabled':'')+'> '+esc(model)+'</label></span><small>本页 '+items.length+' 笔</small></summary><div class="claim-model-items">'+items.map(c=>'<div class="claim-line"><div class="claim-line-main">'+(['pending','approved'].includes(c.status)?'<label class="check-label"><input name="claim-select" type="checkbox" value="'+c.id+'" data-claim-model="'+esc(model)+'" aria-label="选择申请 '+esc(c.request_id)+'" '+(c.status!==status?'disabled':'')+'></label>':'')+'<div><strong>'+money(c.status==='succeeded'?c.amount:c.amount||c.expectedAmount)+'</strong><span class="sub">'+esc(compensationLabel(c))+'</span></div>'+badge(c.status)+'</div><div class="claim-request"><span>'+esc(c.request_id)+'</span><small>'+date(c.created_at)+'</small></div><button class="ghost" data-detail="'+c.id+'">核验详情 '+icon('chevron-right')+'</button></div>').join('')+'</div></details>';}).join('');
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
  const eventLabels={application_created:'提交补偿申请',ai_review_started:'开始 AI 空回审查',ai_reviewed:'AI 空回判定',admin_ai_reviewed:'管理员 AI 辅助审核',self_service_routed:'自动核验分流',execution_reserved:'锁定本笔返还额度',...statuses};
  const ai=c.aiReview,aiReviewMode=c.aiReviewMode;
  const aiAnalysis=ai?.analysis;
  const recommendationLabel={approve:'建议通过并补额度',reject:'建议驳回申请',manual:'建议转人工核实'}[aiAnalysis?.recommendation]||'建议不明确，按人工流程处理';
  $('#detail-body').innerHTML=(admin&&s.page==='adminClaims'&&claimGroup?'<button class="ghost group-back" data-owner="'+c.user_id+'">'+icon('arrow-left')+'返回用户申请</button>':'')+'<div class="detail-status">'+badge(c.status)+'<span>'+esc(c.id)+'</span></div><div class="detail-amounts"><div><small>原消费</small><strong>'+money(c.log.quota)+'</strong></div><div><small>预计补偿</small><strong>'+money(c.expectedAmount)+'</strong></div><div><small>实际补偿</small><strong class="amount">'+money(c.amount)+'</strong></div></div><div class="notice compensation-banner">'+esc(compensationLabel(c))+' · 本记录属于空回补偿流水</div>'+(ai?'<div class="notice '+(ai.decision==='empty'?'success':'warning')+'">AI 判定：'+esc(ai.decision==='empty'?'疑似空回':ai.decision==='not_empty'?'非空回':'无法确定')+' · 置信度 '+Math.round(ai.confidence*100)+'%<br>'+esc(ai.reason)+(ai.evidence?.length?'<br>依据：'+esc(ai.evidence.join('；')):'')+'</div>':'')+(c.fundingSource==='subscription'?'<div class="notice warning">订阅消费由站长审批并核实金额，审核通过后补入钱包余额，不恢复订阅额度。仅原站确认成功才标记到账。</div>':'')+'<div class="detail-facts">'+lines([['补偿类型',compensationLabel(c)],['原请求',c.request_id],['模型',c.log.model_name],['资金来源',fundingLabel(c.fundingSource)],['申请理由',c.reason],['处理说明',c.review_note||'尚未处理'],['申请时间',date(c.created_at)],['更新时间',date(c.updated_at)]])+'</div><div class="action-row">'+actions.map(([a,t])=>'<button class="secondary" data-action="'+a+'" data-id="'+id+'">'+t+'</button>').join('')+'</div><h3 class="detail-section-title">处理时间线</h3><ol class="claim-timeline">'+c.events.map(e=>'<li><strong>'+esc(eventLabels[e.action]||e.action)+'</strong><span>'+date(e.created_at)+(admin?' · 操作人 #'+esc(e.actor_id):'')+'</span></li>').join('')+'</ol>'+(admin?renderSnapshot({log:c.log,rules:c.rules,verification_note:c.verification_note,attempt_id:c.attempt_id},{formatQuota:money}):'');
  if(admin)$('#detail-body').insertAdjacentHTML('afterbegin','<div class="detail-account">'+icon('user-round')+'<div><strong>'+esc(c.username)+'</strong><span class="sub">原站用户 ID '+c.user_id+' · '+esc(c.source==='manual'?'人工申请':'用户自助申请')+'</span></div></div>');
  if(admin){
    const enabled=Boolean(s.rules?.aiEnabled);
    if(c.batch_id)document.querySelector('#detail-body').insertAdjacentHTML('afterbegin','<div class="notice">本记录属于查询批次 '+esc(c.batch_id.slice(0,8))+'。全部审核结束后统一补额度，计 1 次补偿；对账作用于整批。</div>');
    const historical=ai&&!c.aiReviewIsCurrent;
    const canAccept=enabled&&c.status==='pending'&&c.aiReviewIsCurrent&&ai?.status==='completed'&&aiAnalysis?.recommendation==='approve'&&ai.decision==='empty'&&ai.confidence*100>=s.rules.aiAutoThreshold&&c.fundingSource!=='subscription';
    const detail=ai?'<div class="ai-review-result"><strong>'+esc(aiReviewMode==='admin'?'二次复核 · ':'初始判定 · ')+esc(recommendationLabel)+' · '+Math.round(ai.confidence*100)+'%</strong>'+(aiAnalysis?.summary?'<p><b>综合判断：</b>'+esc(aiAnalysis.summary)+'</p>':'')+'<p><b>判断原因：</b>'+esc(ai.reason)+'</p>'+(ai.evidence?.length?'<p><b>判断依据：</b>'+esc(ai.evidence.join('；'))+'</p>':'')+(aiReviewMode!=='admin'&&ai.status==='completed'?'<p>点击 AI 辅助分析进行独立二次复核。</p>':'')+'</div>':'';
    const accept=canAccept?'<button type="button" class="primary" data-ai-approve="'+esc(id)+'">'+icon('check')+'采纳建议并通过补额度</button>':'';
    const subscriptionHint=enabled&&c.status==='pending'&&c.fundingSource==='subscription'?'<p class="field-help">订阅消费需逐笔核实未退款金额，保留原审批与金额确认流程。</p>':'';
    $('#detail-body .detail-facts').insertAdjacentHTML('beforebegin','<section class="admin-ai-assist"><div class="ai-assist-heading"><h3>AI 辅助审核</h3><div>'+(enabled&&['pending','approved'].includes(c.status)?'<button type="button" class="secondary" data-ai-assist="'+esc(id)+'">'+icon('sparkles')+(aiReviewMode==='admin'&&c.aiReviewIsCurrent?'查看当前复核':historical?'按当前提示词复核':'AI 二次复核')+'</button>':'')+accept+'</div></div>'+detail+'<p class="field-help">'+(historical?'上方为旧提示词版本的分析结果，已保留审核依据。':enabled?'AI 独立复核日志、补偿规则和初始判定，给出综合建议；仅管理员明确采纳后才会执行补偿。':'AI 辅助审核未开启，在补偿规则设置中开启并保存后使用。')+'</p>'+subscriptionHint+'<p data-ai-assist-feedback class="field-help" role="status"></p></section>');
  }
  bindSnapshot($('#detail-body'));icons();if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
const numeric=[['userDailyQuota','每用户每日可补额度'],['userDailyCount','每用户每日最多补偿次数'],['siteDailyQuota','全站每日可补额度'],['siteDailyCount','全站每日最多补偿次数'],['perBatchQuota','单次补偿总额上限（0 为不额外限制）'],['perRecordQuota','单条消费补回上限（0 为不额外限制）'],['selfServiceMaxQuota','自动审批单条原消费上限'],['selfServiceMinAgeSeconds','结算等待秒数（30–86400）'],['refundBasisPoints','返还比例（10000 为 100%）'],['maxPending','每用户最多待处理补偿次数']];
async function rules(){
  const admin=s.page==='settings',r=await api(admin?'/api/admin/rules':'/api/rules');s.rules=r;
  if(admin){await settingsPage(r);return;}
  if(!admin){$('#content').innerHTML=panel('补偿规则 · v'+r.version,'<div class="panel-body">'+lines([['处理方式',r.selfServiceEnabled?'正常自助 · 异常审批':'自助暂停 · 人工审批'],['自动审批单条上限',money(r.selfServiceMaxQuota)],['结算等待',r.selfServiceMinAgeSeconds+' 秒'],['申请状态',r.applicationsEnabled?'开放':'暂停'],['执行状态',r.executionEnabled?'开放':'暂停'],['支持模型',r.restrictModels===false?'全部可补模型':r.models.join('、')||'未配置'],['返还比例',r.refundBasisPoints/100+'%'],['单条消费补回上限',r.perRecordQuota?money(r.perRecordQuota):'不额外限制'],['单次补偿总额上限',r.perBatchQuota?money(r.perBatchQuota):'不额外限制'],['每日可补额度',money(r.userDailyQuota)],['每日最多补偿次数',r.userDailyCount],['待处理补偿次数上限',r.maxPending],['日志读取范围','最近 '+(r.lookbackDays||Math.ceil(r.applicationHours/24))+' 天'],['每日重置时间',r.dailyResetTime||'00:00'],['结算时区',r.timezone]])+'</div>')+'<div class="notice">一次查询的记录全部审核结束后，通过部分统一补额度，计一次补偿。到账结果不明时整批锁定，等待管理员核对。</div>';return;}
}
async function settingsPage(r){
  s.display=await api('/api/display');
  const storage=await api('/api/admin/storage');
  let error='',groups=[];try{[catalog,groups,aiConfig]=await Promise.all([api('/api/admin/catalog'),api('/api/admin/groups').then(v=>v.groups),api('/api/admin/ai-config')]);}catch(e){catalog=null;error=e.message;try{aiConfig=await api('/api/admin/ai-config');}catch{}}
  pickedModels=new Set(r.models);
  excludedModels=new Map((r.excludedModels||[]).map(entry=>[modelRuleKey(entry.channelId,entry.model),entry]));
  const amountLabels={};
  const numericInputs=numeric.map(([key,label])=>'<label>'+esc(amountLabels[key]||label)+'<input name="'+key+'" type="number" min="0" step="'+(quotaFields.has(key)?'any':'1')+'" required value="'+(quotaFields.has(key)?inputQuota(r[key],s.display):r[key])+'" '+(quotaFields.has(key)&&!s.display?'disabled':'')+'></label>').join('');
  const channels=catalog?.channels||[],channelSelector='<div class="catalog-options">'+channels.map(c=>'<label class="catalog-choice"><input type="checkbox" name="channel-choice" value="'+c.id+'" '+(r.channels.includes(c.id)?'checked':'')+'><span><strong>'+esc(c.name)+'</strong><small>ID '+c.id+' · '+(c.status===1?'运行中':'停用 · 仅人工审核')+' · '+c.models.length+' 个模型</small></span></label>').join('')+r.channels.filter(id=>!channels.some(c=>c.id===id)).map(id=>'<label class="catalog-choice"><input type="checkbox" name="channel-choice" value="'+id+'" checked><span>渠道 #'+id+'<small>已删除 · 保留历史补偿审核</small></span></label>').join('')+'</div>';
  const groupSelector='<div class="catalog-options">'+groups.map(group=>'<label class="catalog-choice"><input name="group-choice" type="checkbox" value="'+esc(group)+'" '+(r.userGroups.includes(group)?'checked':'')+'><span>'+esc(group)+'</span></label>').join('')+'</div>';
  $('#content').innerHTML=(error?'<div class="notice warning">原站渠道或用户组读取失败：'+esc(error)+'。保存已禁用，刷新后重试。</div>':'')+'<form id="rules-form"><section class="settings-band"><h3>开放与自动审批</h3><div class="settings-switches">'+['applicationsEnabled','executionEnabled','selfServiceEnabled'].map((key,i)=>'<label class="switch-line"><span>'+['开放补偿申请','开放额度返还','正常记录自动审批'][i]+'</span><input role="switch" name="'+key+'" type="checkbox" '+(r[key]?'checked':'')+'></label>').join('')+'</div></section><section class="settings-band"><h3>日志与每日重置</h3><div class="form-grid"><label>最多读取最近多少天的日志<input name="lookbackDays" type="number" min="1" max="3650" step="1" required value="'+Math.ceil(r.applicationHours/24)+'"></label><label>每日额度与次数重置时间<input name="dailyResetTime" type="time" value="'+(r.dailyResetTime||'00:00')+'" required></label><label>结算时区<select name="timezone">'+[...new Set([r.timezone,'Asia/Shanghai','UTC','Asia/Hong_Kong','Asia/Tokyo','America/New_York','Europe/London'])].map(zone=>'<option value="'+esc(zone)+'" '+(zone===r.timezone?'selected':'')+'>'+esc(zone)+'</option>').join('')+'</select></label></div></section><section class="settings-band"><h3>额度与次数</h3><div class="form-grid">'+numericInputs+'</div><p class="field-help">额度单位：'+esc(s.display?.label||'未读取')+' · 每笔原消费计一次，执行中与待对账金额预占限额。</p></section><section class="settings-band"><h3>可补用户组</h3>'+groupSelector+'<p class="field-help">未选择表示全部原站用户组。</p></section><section class="settings-band"><h3>可补渠道</h3><input id="channel-search" type="search" placeholder="搜索渠道名称或 ID" aria-label="搜索渠道">'+channelSelector+'</section><section class="settings-band"><h3>可补模型</h3><label class="switch-line"><span>限定模型范围</span><input role="switch" type="checkbox" name="restrictModels" '+(r.restrictModels?'checked':'')+'></label><input id="model-search" type="search" placeholder="搜索所选渠道的模型" aria-label="搜索模型"><div id="catalog-models"></div><p class="field-help">下架、删除模型或停用渠道的历史空回进入人工审核。</p></section><section class="settings-band"><h3>其他设置</h3><div class="form-grid"><label>排除用户 ID（逗号分隔）<input name="blockedUsers" value="'+esc(r.blockedUsers.join(','))+'"></label><label class="check-label"><input type="checkbox" name="notificationsEnabled" '+(r.notifications.enabled?'checked':'')+'>开启钉钉通知</label></div></section><div class="form-actions"><button class="primary" '+(!catalog||!s.display?'disabled':'')+'>保存规则</button></div></form>';
  const defaultPrompt='你是额度补偿审核助手。只根据提供的日志和规则判断是否疑似空回，不决定金额，不执行任何操作。必须只返回 JSON：{"decision":"empty|not_empty|uncertain","confidence":0到1,"reason":"简短中文理由","evidence":["证据"]}。证据不足必须返回 uncertain。';
  $('#content').insertAdjacentHTML('afterbegin','<section class="settings-band ai-settings"><div class="settings-title-row"><div><h3>AI 空回判定</h3><p class="field-help">AI 根据日志与当前规则综合分析空回；高置信度空回才自动补偿，其余结果转管理员。关闭后继续使用原有空回规则。</p></div><span class="config-state '+(aiConfig?.configured?'is-ready':'')+'">'+(aiConfig?.configured?'已配置':'未配置')+'</span></div><label class="switch-line"><span>启用 AI 辅助判定</span><input form="rules-form" role="switch" name="aiEnabled" type="checkbox" '+(r.aiEnabled?'checked':'')+'></label><div class="form-grid"><label>自动通过置信度（%）<input form="rules-form" name="aiAutoThreshold" type="number" min="70" max="100" step="1" value="'+(r.aiAutoThreshold||90)+'"></label><label>单用户每日 AI 审核次数<input form="rules-form" name="aiDailyLimit" type="number" min="1" max="1000" step="1" value="'+(r.aiDailyLimit||30)+'"></label></div><div class="ai-config-grid"><label>API 地址<input id="ai-base-url" value="'+esc(aiConfig?.baseUrl||'')+'" placeholder="https://api.example.com/v1"></label><label>拉取模型<select id="ai-model-pick"><option value="">先拉取模型</option>'+(aiConfig?.model?'<option selected value="'+esc(aiConfig.model)+'">'+esc(aiConfig.model)+'</option>':'')+'</select></label><label>当前使用模型名称<input id="ai-model" value="'+esc(aiConfig?.model||'')+'" placeholder="手动输入模型 ID"></label><label>API 密钥<input id="ai-api-key" type="password" placeholder="'+esc(aiConfig?.apiKeyMasked?'保持不变 · '+aiConfig.apiKeyMasked:'服务端密钥')+'" autocomplete="new-password"></label><label>超时时间（毫秒）<input id="ai-timeout" type="number" min="3000" max="120000" step="1000" value="'+(aiConfig?.timeoutMs||15000)+'"></label></div><label class="full ai-prompt-field">AI 判定提示词<textarea id="ai-prompt" rows="7" maxlength="12000">'+esc(aiConfig?.prompt||defaultPrompt)+'</textarea><small class="field-help">提示词会随日志与规则发送给 AI；修改后会生成新的判定版本，不会复用旧结果。</small></label><div class="ai-config-actions"><button type="button" class="secondary" id="ai-fetch-models">'+icon('download')+'拉取模型</button><button type="button" class="secondary" id="ai-test-config">'+icon('plug-zap')+'测试模型调用</button><button type="button" class="primary" id="ai-save-config">'+icon('save')+'保存 AI 设置</button><span id="ai-config-message" class="field-help" role="status"></span></div></section>');
  $('#content').insertAdjacentHTML('beforeend','<section class="settings-band"><h3>本地数据存储</h3>'+lines([['数据库',storage.engine+' · '+(storage.persistent?'持久化存储':'内存演示，重启清空')],['日志模式',storage.journalMode],['申请账本',storage.claims+' 笔'],['日志缓存范围',storage.logs],['审计记录',storage.events],['数据库大小',num(storage.bytes)+' 字节']])+'<p class="field-help">'+(storage.persistent?'更新镜像保留数据卷。数据库快照与机器人加密密钥需一起备份，恢复旧账本前须对账。':'当前为本地演示预览。正式启动自动创建独立 SQLite 数据库，申请与发放去重记录持久保存。')+'</p></section>');
  $('#content').insertAdjacentHTML('beforeend','<section class="settings-band storage-management"><h3>数据库清理</h3><div class="preview-summary"><div><small>通知记录</small><strong>'+num(storage.notifications)+'</strong></div><div><small>本地快照</small><strong>'+num(storage.backups.count)+'</strong></div><div><small>库内可回收空间</small><strong>'+num(storage.freeBytes)+' <em>字节</em></strong></div></div><form id="storage-form"><div class="form-grid">'+[['cache','过期查询缓存','cacheDays',7,1],['notifications','已结束通知记录','notificationDays',30,7],['backups','旧数据库快照','backupDays',30,7]].map(([key,label,days,value,min])=>'<div class="storage-option"><label class="check-label"><input type="checkbox" name="'+key+'" '+(key==='backups'?'':'checked')+'>清理'+label+'</label><label>保留最近天数<input type="number" name="'+days+'" min="'+min+'" max="3650" step="1" required value="'+value+'"></label></div>').join('')+'</div><label class="check-label storage-compact"><input type="checkbox" name="compact">整理数据库空间</label><p class="field-help">申请、发放去重账本、审计、待发送通知及密钥不清理。快照至少保留最新 3 份。空间整理可能短暂阻塞查询，请在低峰执行。</p><button type="submit" class="secondary">'+icon('scan-search')+'预览清理</button></form></section>');
  $('#model-search').closest('.settings-band').querySelector('.field-help').textContent='不可补规则优先；下架、删除模型未被排除时进入人工审核。';
  renderCatalogModels();icons();
  document.querySelector('[name="perBatchQuota"]').closest('.settings-band').querySelector('.field-help').textContent='额度单位：'+(s.display?.label||'未读取')+'。一次查询合并补额度计一次；执行中与待对账的整批额度和次数会预占限额。';
}
function renderCatalogModels(){
  const root=$('#catalog-models');if(!root)return;
  const ids=[...document.querySelectorAll('[name=channel-choice]:checked')].map(el=>Number(el.value));
  const query=$('#model-search').value.trim().toLowerCase(),restricted=$('[name=restrictModels]').checked;
  const openChannels=new Set([...root.querySelectorAll('details[open][data-model-channel]')].map(el=>Number(el.dataset.modelChannel)));
  const existingChannels=new Set([...root.querySelectorAll('[data-model-channel]')].map(el=>Number(el.dataset.modelChannel)));
  const choice=(channelId,model,historical=false)=>{
    const blocked=excludedModels.has(modelRuleKey(channelId,model));
    return '<div class="channel-model-row'+(blocked?' is-excluded':'')+'"><div><strong>'+esc(model)+'</strong>'+(historical?'<small>历史模型</small>':'')+'</div><div class="model-policy-options">'+(restricted?'<label class="check-label"><input name="model-choice" type="checkbox" data-channel="'+channelId+'" value="'+esc(model)+'" '+(pickedModels.has(model)&&!blocked?'checked':'')+'>允许补偿</label>':'')+'<label class="check-label"><input name="excluded-model-choice" type="checkbox" data-channel="'+channelId+'" value="'+esc(model)+'" '+(blocked?'checked':'')+'>不可补</label></div></div>';
  };
  const groups=ids.map(id=>{
    const channel=catalog?.channels.find(c=>c.id===id),current=channel?.models||[];
    const models=[...new Set([...current,...[...excludedModels.values()].filter(entry=>entry.channelId===id).map(entry=>entry.model)])].sort();
    const matches=models.filter(model=>model.toLowerCase().includes(query));
    if(query&&!matches.length)return '';
    const excluded=models.filter(model=>excludedModels.has(modelRuleKey(id,model))).length;
    return '<details class="channel-model-group" data-model-channel="'+id+'" '+(!existingChannels.has(id)||openChannels.has(id)?'open':'')+'><summary><span>'+icon('chevron-right')+'<strong>'+esc(channel?.name||'历史渠道 #'+id)+'</strong></span><small>'+models.length+' 个模型 · '+excluded+' 个不可补</small></summary><div class="channel-model-actions"><button type="button" class="ghost" data-model-batch="exclude" data-channel="'+id+'" title="排除本渠道当前搜索匹配的全部模型">'+icon('ban')+'排除匹配项</button><button type="button" class="ghost" data-model-batch="restore" data-channel="'+id+'" title="取消本渠道当前搜索匹配模型的排除规则">'+icon('rotate-ccw')+'取消排除</button></div>'+matches.map(model=>choice(id,model,!current.includes(model))).join('')+(matches.length?'':empty('该渠道暂无模型'))+'</details>';
  }).join('');
  const outside=[...excludedModels.values()].filter(entry=>!ids.includes(entry.channelId)&&entry.model.toLowerCase().includes(query));
  const currentModels=(catalog?.channels||[]).filter(c=>ids.includes(c.id)).flatMap(c=>c.models);
  const historical=restricted?[...pickedModels].filter(model=>!currentModels.includes(model)&&model.toLowerCase().includes(query)):[];
  root.innerHTML=groups||empty(ids.length?'没有匹配的模型':'尚未选择可补渠道');
  if(outside.length)root.insertAdjacentHTML('beforeend','<details class="channel-model-group"><summary>未选渠道的排除规则 · '+outside.length+' 项</summary>'+outside.map(entry=>choice(entry.channelId,entry.model,true)).join('')+'</details>');
  if(historical.length)root.insertAdjacentHTML('beforeend','<details class="channel-model-group"><summary>历史允许模型 · '+historical.length+' 项</summary>'+historical.map(model=>'<label class="catalog-choice historical-model"><input name="model-choice" type="checkbox" value="'+esc(model)+'" checked><span>'+esc(model)+'<small>不在当前渠道目录，需人工审核</small></span></label>').join('')+'</details>');
  icons();
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
function syncInboxBadge(unread){
  const badge=$('#inbox-badge');badge.hidden=!unread;badge.textContent=unread>99?'99+':String(unread);
  $('#inbox-toggle').setAttribute('aria-label','站内通知'+(unread?'，'+unread+' 条未读':''));
}
async function refreshInboxBadge(){const data=await api('/api/inbox');syncInboxBadge(data.unread);}
async function inbox(){
  const data=await api('/api/inbox?page='+s.n+(inboxUnreadOnly?'&unread=1':''));
  if(!data.items.length&&s.n>1){s.n=Math.max(1,Math.ceil(data.total/30));return inbox();}
  syncInboxBadge(data.unread);
  $('#page-kicker').textContent='MY WORKSPACE';
  $('#page-subtitle').textContent='查看申请审核、额度补偿与异常处理结果。';
  $('#content').innerHTML=userInbox({data,unreadOnly:inboxUnreadOnly,esc,date,icon,badge,pager,empty});icons();
}
async function notifications(){
  const [n,r,e]=await Promise.all([api('/api/admin/notifications'),api('/api/admin/rules'),api('/api/admin/email-notifications')]);s.rules=r;
  $('#content').innerHTML=notificationCenter({n,r,e,esc,panel,table,empty,money,date,icon,eventNames,tab:notificationTab});
  $('#email-template-preview').innerHTML=emailPreview('approved',money,esc);
  icons();
}
async function audit(){const data=await api('/api/admin/audit');$('#content').innerHTML='<section class="audit-workspace"><p class="audit-caption">最近 100 条事件 · 同一补偿集中展示 · 最新处理结果在前</p>'+(data.length?renderAuditLog(data,{formatQuota:money,date}):empty('暂无操作记录'))+'</section>';}
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
  if(operation?.kind==='queryBatch'){await submitQueryBatch(form);return;}
  if(!operation)return;const op=operation,f=new FormData(form),note=String(f.get('note')||'').trim()||(op.kind==='apply'?'申请自动核验空回补偿':'');if(!note)throw Error('请填写依据');let payload;
  if(op.kind==='apply')payload={requestIds:op.ids,reason:note};else{const items=op.items.map((item,i)=>{if(!item.confirmAmount)return {id:item.id,outcome:item.outcome};const displayedAmount=String(f.get('amount-'+i)),verifiedAmount=parseQuota(displayedAmount,op.display);if(!Number.isSafeInteger(verifiedAmount)||verifiedAmount<=0||verifiedAmount>item.quota)throw Error('额度必须大于零且不超过原消费，并符合原站最小精度');return {id:item.id,displayedAmount};});payload={action:['received','not_received'].includes(op.name)?'reconcile':op.name,items,note,displayRevision:op.display?.revision};}
  const button=$('#operation-submit');
  const aiActive=op.kind==='apply'&&s.page!=='adminLogs'&&Boolean(s.rules?.aiEnabled);
  const processingMessage=op.kind==='apply'
    ? (aiActive?'正在进行 AI 空回审查…':'正在自动审批与返还…')
    : '正在逐笔处理…';
  button.textContent=processingMessage;
  if(op.kind==='apply'){
    $('#operation-body').hidden=false;
    $('#operation-body').innerHTML=loading(aiActive?'AI 正在综合日志与补偿规则，请稍候…':'正在核验消费记录并准备补额度…');
    $('#operation-results').replaceChildren();
  }
  let data;
  try{data=await api(op.kind==='apply'?op.endpoint:'/api/admin/actions','POST',payload);}catch(error){if(op.kind==='action'||op.automatic){button.hidden=true;operation=null;$('#operation-error').textContent='请求未确认，请关闭窗口并刷新申请状态后核对，禁止直接重复发放。'+error.message;return;}button.textContent='确认提交申请';throw error;}
  await render();
  $('#operation-title').textContent=op.kind==='apply'?'补额度处理结果':'处理结果';$('#operation-body').hidden=true;$('#operation-form .dialog-footer [data-close-operation]').textContent='完成';
  const summary=op.kind==='apply'?'<div class="preview-summary compact"><div><small>已确认返还</small><strong class="amount">'+money(data.reduce((sum,v)=>sum+(v.status==='succeeded'?v.claim.amount:0),0))+' </strong></div><div><small>转入审批</small><strong>'+data.filter(v=>v.status==='pending').length+' <em>笔</em></strong></div><div><small>失败 / 待确认</small><strong>'+data.filter(v=>!v.success||['failed','unknown','executing'].includes(v.status)).length+' <em>笔</em></strong></div></div>':'';
  const successes=data.filter(v=>v.success&&v.status==='succeeded');
  const failures=data.filter(v=>!v.success||['failed','unknown'].includes(v.status));
  const failureReason=(v)=>v.message||v.claim?.review_note||({failed:'原站明确拒绝或返还失败，请根据处理说明核查。',unknown:'请求结果未确认，已冻结本笔额度，禁止直接重复发放。'}[v.status]||'处理未完成，请查看逐笔处理说明。');
  const successAnimation=successes.length?'<div class="refund-success" role="status"><div class="refund-success-check">'+icon('circle-check')+'</div><div><h3>'+(aiActive?'AI 审查通过，空回补偿成功':'空回补偿成功')+'</h3><p>'+successes.length+' 笔已确认补回'+(op.kind==='apply'?' · '+money(successes.reduce((sum,v)=>sum+v.claim.amount,0))+'':'')+'</p></div></div>':'';
  const failureAnimation=failures.length?'<div class="refund-failure" role="alert"><div class="refund-failure-mark">'+icon('circle-alert')+'</div><div><h3>处理失败</h3><p>'+failures.length+' 笔未完成，失败原因已列出，请按逐笔说明处理。</p><ul>'+failures.slice(0,3).map(v=>'<li><strong>'+esc(v.requestId||v.id)+'</strong><span>'+esc(failureReason(v))+'</span></li>').join('')+(failures.length>3?'<li>其余失败原因请查看下方逐笔处理结果。</li>':'')+'</ul></div></div>':'';
  $('#operation-results').innerHTML=successAnimation+failureAnimation+summary+'<h3>逐笔处理结果</h3>'+data.map(v=>'<div class="result-row '+(v.success&&v.status!=='failed'&&v.status!=='unknown'?'':'result-failed')+'">'+badge(v.success?(v.status||'pending'):'failed')+'<span>'+esc(v.requestId||v.id)+'</span><p>'+esc(v.success?(op.kind==='apply'?(v.claim?.review_note||statuses[v.status]||'已提交，等待审批'):statuses[v.status]||'已处理'):failureReason(v))+'</p></div>').join('');
  icons();
  button.hidden=true;operation=null;form.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
}
async function openQueryBatch(id){
  const batch=await api('/api/batches/'+id);
  showOperation(batch.status==='open'?'确认整批补偿':'查询批次处理进度',renderQueryBatch(batch,{money,date,result:true})+(batch.status==='open'?operationNote('补充说明（选填）',false):''),{kind:'queryBatch',id});
  $('#operation-submit').textContent='确认整批核验';
  $('#operation-submit').hidden=batch.status!=='open';
}
async function submitQueryBatch(form){
  const id=operation.id,note=String(new FormData(form).get('note')||'').trim()||'申请整批核验空回补偿';
  $('#operation-submit').hidden=true;
  let polling=false;
  const showProgress=async()=>{
    if(polling)return;polling=true;
    try{
      const batch=await api('/api/batches/'+id);
      if(operation?.id===id)$('#operation-body').innerHTML=loading((s.rules?.aiEnabled?'正在进行 AI 审查':'正在核验消费')+' · 已处理 '+batch.judged+' / '+batch.records+' 条')+'<progress class="batch-progress" max="'+Math.max(1,batch.records)+'" value="'+batch.judged+'" aria-label="整批审查进度"></progress>';
    }catch{}finally{polling=false;}
  };
  $('#operation-body').innerHTML=loading(s.rules?.aiEnabled?'正在进行 AI 审查，全部审核后合并补额度…':'正在逐条核验，全部审核后合并补额度…');
  const timer=setInterval(showProgress,2000);
  try{
    const result=await api('/api/batches/'+id+'/submit','POST',{reason:note});
    clearInterval(timer);
    $('#operation-title').textContent=batchStatus[result.status]||'整批处理结果';
    $('#operation-body').hidden=true;
    $('#operation-results').innerHTML=renderQueryBatch(result,{money,date,result:true});
    $('#operation-form .dialog-footer [data-close-operation]').textContent='完成';
    operation=null;
    await render();icons();
  }catch(error){
    $('#operation-error').textContent='处理请求未确认。关闭窗口后查看整批进度，禁止重复加额度。'+error.message;
    operation=null;
  }finally{clearInterval(timer);}
}
document.addEventListener('change',event=>{if(event.target.id==='ai-model-pick'&&event.target.value){const input=$('#ai-model');if(input)input.value=event.target.value;}});
document.addEventListener('change',async event=>{if(event.target.id!=='inbox-unread-only')return;inboxUnreadOnly=event.target.checked;s.n=1;await render();});
document.addEventListener('change',async event=>{
  const input=event.target;if(!['aiEnabled','aiAutoThreshold','aiDailyLimit'].includes(input.name))return;
  const controls=['aiEnabled','aiAutoThreshold','aiDailyLimit'].map(name=>$('[name='+name+']'));
  const restore=()=>{if(input.name==='aiEnabled')input.checked=s.rules.aiEnabled;else input.value=s.rules[input.name];};
  if(s.busy){restore();return;}
  if(!input.checkValidity()){input.reportValidity();return;}
  const message=$('#ai-config-message');
  const payload={aiEnabled:controls[0].checked,aiAutoThreshold:Number(controls[1].value),aiDailyLimit:Number(controls[2].value),rulesVersion:s.rules.version};
  s.busy=true;controls.forEach(el=>el.disabled=true);message.className='field-help';message.textContent='正在保存 AI 判定规则…';
  aiSettingsSave=api('/api/admin/ai-settings','PUT',payload);
  try{
    const saved=await aiSettingsSave;
    Object.assign(s.rules,{version:saved.rulesVersion,aiEnabled:saved.aiEnabled,aiAutoThreshold:saved.aiAutoThreshold,aiDailyLimit:saved.aiDailyLimit});
    if(aiConfig)Object.assign(aiConfig,saved);
    message.className='field-help success-text';message.textContent='已自动保存 · AI '+(saved.aiEnabled?'已开启':'已关闭')+' · 自动通过阈值 '+saved.aiAutoThreshold+'% · 每日 '+saved.aiDailyLimit+' 次';
  }catch(error){restore();message.className='field-help error';message.textContent=error.message;toast(error.message);}
  finally{aiSettingsSave=null;controls.forEach(el=>el.disabled=false);s.busy=false;}
});
document.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b)return;if(aiSettingsSave){try{await aiSettingsSave;}catch{return;}}if(s.busy)return;busyButton(b,true);try{
  if(b.dataset.inboxRead||b.dataset.inboxOpen||b.id==='inbox-read-all'){
    s.busy=true;
    const payload=b.id==='inbox-read-all'?{throughId:Number(b.dataset.throughId)}:{id:Number(b.dataset.inboxRead||b.dataset.inboxOpen)};
    const result=await api('/api/inbox/read','POST',payload);syncInboxBadge(result.unread);
    await inbox();if(b.dataset.inboxOpen)await detail(b.dataset.claimId);return;
  }
  if(['ai-fetch-models','ai-test-config','ai-save-config'].includes(b.id)){
    const message=$('#ai-config-message'),payload={baseUrl:$('#ai-base-url')?.value.trim(),model:$('#ai-model')?.value.trim(),prompt:$('#ai-prompt')?.value.trim(),apiKey:$('#ai-api-key')?.value,timeoutMs:Number($('#ai-timeout')?.value||15000)};
    Object.assign(payload,{aiEnabled:$('[name=aiEnabled]').checked,aiAutoThreshold:Number($('[name=aiAutoThreshold]').value),aiDailyLimit:Number($('[name=aiDailyLimit]').value),rulesVersion:s.rules.version});
    s.busy=true;b.disabled=true;message.className='field-help';
    message.textContent=b.id==='ai-fetch-models'?'正在保存配置并拉取模型列表…':b.id==='ai-test-config'?'正在保存配置并请求所选模型，等待模型回复…':'正在保存 API 配置…';
    try{
      if(b.id==='ai-test-config'&&!payload.model)throw Error('请先选择或输入模型名称，再测试模型调用。');
      aiConfig=await api('/api/admin/ai-config','PUT',payload);
      Object.assign(s.rules,{version:aiConfig.rulesVersion,aiEnabled:aiConfig.aiEnabled,aiAutoThreshold:aiConfig.aiAutoThreshold,aiDailyLimit:aiConfig.aiDailyLimit});
      $('#ai-base-url').value=aiConfig.baseUrl;
      const keyInput=$('#ai-api-key');keyInput.value='';keyInput.placeholder=aiConfig.apiKeyMasked?'保持不变 · '+aiConfig.apiKeyMasked:'服务端密钥';
      const badge=$('.ai-settings .config-state');badge.textContent=aiConfig.configured?'已配置':'未配置';badge.classList.toggle('is-ready',aiConfig.configured);
      if(b.id==='ai-save-config')message.textContent='AI 设置已保存 · '+(aiConfig.aiEnabled?'辅助审核已开启':'辅助审核已关闭')+'；尚未验证模型调用。';
      else if(b.id==='ai-test-config'){
        const result=await api('/api/admin/ai-config/test','POST',{});
        message.textContent='模型 '+result.model+' 调用成功 · '+result.elapsedMs+' 毫秒 · 回复：'+result.reply;
      }else{
        const data=await api('/api/admin/ai-config/models'),select=$('#ai-model-pick');
        const items=[...data.items];
        if(payload.model&&!items.some(item=>item.id===payload.model))items.unshift({id:payload.model,name:payload.model+'（当前手动配置）'});
        select.innerHTML='<option value="">'+(data.items.length?'选择模型':'接口未返回模型')+'</option>'+items.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('');
        select.value=payload.model||'';
        const wrapper=select.closest('.glass-select'),trigger=wrapper?.querySelector('.glass-select-trigger'),menu=wrapper?.querySelector('.glass-options');
        if(trigger)trigger.textContent=select.selectedOptions[0]?.textContent||'选择模型';
        if(menu)menu.replaceChildren(...[...select.options].map(option=>{
          const button=document.createElement('button');button.type='button';button.textContent=option.textContent;button.dataset.value=option.value;button.setAttribute('role','option');
          button.addEventListener('click',()=>{select.value=option.value;if(option.value)$('#ai-model').value=option.value;trigger.textContent=option.textContent;menu.hidePopover();select.dispatchEvent(new Event('change',{bubbles:true}));});return button;
        }));
        message.textContent=data.items.length?'已拉取 '+data.items.length+' 个模型；选择模型后保存或测试模型调用。':'接口返回空模型列表，请检查令牌分组、模型权限及渠道；仍可手动输入模型名称进行测试。';
      }
      message.className='field-help success-text';icons();
    }catch(error){message.className='field-help error';message.textContent=error.message;throw error;}
    finally{b.disabled=false;}
    return;
  }
  if(b.dataset.aiAssist){
    s.busy=true;b.disabled=true;
    const feedback=$('[data-ai-assist-feedback]');feedback.className='field-help';feedback.textContent='正在分析申请日志与补偿规则，等待 AI 审核依据…';
    try{
      const result=await api('/api/admin/claims/'+b.dataset.aiAssist+'/ai-review','POST',{});
      await detail(b.dataset.aiAssist);
      const current=$('[data-ai-assist-feedback]');
      if(current){current.className=result.aiReview?.status==='completed'?'field-help success-text':'field-help error';current.textContent=result.aiReview?.status==='completed'?'AI 依据已更新，申请状态和额度未改变。':'AI 未完成有效判定，请根据上方原因继续人工审核。';}
    }catch(error){feedback.className='field-help error';feedback.textContent=error.message;throw error;}
    finally{b.disabled=false;}
    return;
  }
  if(b.dataset.aiApprove){
    s.busy=true;b.disabled=true;
    const feedback=$('[data-ai-assist-feedback]');feedback.className='field-help';feedback.textContent='正在执行 AI 建议复核、原消费核验与额度补偿…';
    try{
      const result=await api('/api/admin/claims/'+b.dataset.aiApprove+'/ai-approve','POST',{});
      await detail(b.dataset.aiApprove);
      const current=$('[data-ai-assist-feedback]');
      if(current){current.className=result.status==='succeeded'?'field-help success-text':'field-help error';current.textContent=result.status==='succeeded'?'已采纳 AI 建议，补偿成功。':result.status==='unknown'?'已采纳 AI 建议，但原站到账结果待核对；不要重复提交。':'已采纳 AI 建议，当前状态：'+(statuses[result.status]||result.status)+'。';}
    }catch(error){feedback.className='field-help error';feedback.textContent=error.message;throw error;}
    finally{b.disabled=false;}
    return;
  }
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
  if(b.dataset.notificationTab){
    notificationTab=b.dataset.notificationTab;
    document.querySelectorAll('[data-notification-tab]').forEach(el=>{const selected=el.dataset.notificationTab===notificationTab;el.setAttribute('aria-selected',String(selected));el.tabIndex=selected?0:-1;});
    for(const key of ['ding','email'])$('#notify-panel-'+key).hidden=key!==notificationTab;return;
  }
  if(b.id==='account-logout'){$('#logout').click();return;}
  if(b.id==='theme-toggle'){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('huixiang-theme',document.documentElement.dataset.theme);}catch{}theme();return;}
  if(b.hasAttribute('data-close-operation')){$('#operation-dialog').close();operation=null;return;}
  if(b.dataset.submitBatch){await openQueryBatch(b.dataset.submitBatch);return;}
  if(b.id==='query-empty'||(b.id==='refresh'&&s.page==='logs'&&refundQueried)){const original=b.innerHTML;s.busy=true;b.disabled=true;b.textContent='正在查询…';refundQueried=true;s.n=1;try{await logs({refresh:true});}finally{if(b.isConnected){b.disabled=false;b.innerHTML=original;icons();}}return;}
  if(b.dataset.turn){s.n+=Number(b.dataset.turn);await render();}else if(b.dataset.detail)await detail(b.dataset.detail);else if(b.dataset.apply){s.busy=true;await apply([b.dataset.apply]);}else if(b.id==='batch-apply'){s.busy=true;await apply([...new Set([...document.querySelectorAll('[name="log-select"]:checked,[name="mobile-log-select"]:checked')].map(v=>v.value))]);}else if(b.dataset.action){s.busy=true;await action(b.dataset.action,[b.dataset.id]);}else if(b.dataset.batch){s.busy=true;await action(b.dataset.batch,[...document.querySelectorAll('[name="claim-select"]:checked')].map(v=>v.value));}else if(b.dataset.stats){statKind=b.dataset.stats;s.n=1;await stats();}else if(b.id==='refresh')await render();else if(b.id==='close-dialog')$('#detail-dialog').close();else if(b.id==='logout'){await api('/api/auth/logout','POST',{});loginView();}else if(b.id==='test-notification'){await api('/api/admin/notifications/test','POST',{});toast('测试已入队，刷新查看发送结果');}
}catch(e){toast(e.message);}finally{s.busy=false;busyButton(b,false);if(b.id==='query-empty'&&b.isConnected){b.disabled=false;b.textContent='查询空回';}}});

$('#operation-dialog').addEventListener('cancel',event=>{if(s.busy)event.preventDefault();else operation=null;});
$('#detail-dialog').addEventListener('close',()=>{$('#detail-title').textContent='申请详情与处理';storagePlan=null;});
$('#page-search').addEventListener('input',searchPages);
document.addEventListener('toggle',event=>{if(event.target.matches?.('.refund-record'))event.target.querySelector('summary').setAttribute('aria-label',event.target.open?'收起补回记录':'展开补回记录');},true);
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='email-preview-event')$('#email-template-preview').innerHTML=emailPreview(el.value,money,esc);
  if(el.matches('[data-select-all]')){
    document.querySelectorAll('#detail-body [name="claim-select"]:not(:disabled)').forEach(input=>{input.checked=el.checked;});
  }
  if(el.matches('[data-model-select]')){
    document.querySelectorAll('#detail-body [name="claim-select"][data-claim-model="'+CSS.escape(el.dataset.modelSelect)+'"]:not(:disabled)').forEach(input=>{input.checked=el.checked;});
    const all=document.querySelector('[data-select-all]'),selectable=[...document.querySelectorAll('#detail-body [name="claim-select"]:not(:disabled)')];
    if(all)all.checked=selectable.length>0&&selectable.every(input=>input.checked);
  }
  if(el.name==='claim-select'){
    const model=el.dataset.claimModel,modelBox=model?document.querySelector('[data-model-select="'+CSS.escape(model)+'"]'):null;
    if(modelBox){const items=[...document.querySelectorAll('#detail-body [name="claim-select"][data-claim-model="'+CSS.escape(model)+'"]:not(:disabled)')];modelBox.checked=items.length>0&&items.every(input=>input.checked);}
    const all=document.querySelector('[data-select-all]'),selectable=[...document.querySelectorAll('#detail-body [name="claim-select"]:not(:disabled)')];
    if(all)all.checked=selectable.length>0&&selectable.every(input=>input.checked);
  }
  if(el.name==='model-choice'){
    if(el.checked){
      pickedModels.add(el.value);
      if(el.dataset.channel)excludedModels.delete(modelRuleKey(Number(el.dataset.channel),el.value));
    }else pickedModels.delete(el.value);
    renderCatalogModels();
  }
  if(el.name==='excluded-model-choice'){
    const channelId=Number(el.dataset.channel),key=modelRuleKey(channelId,el.value);
    if(el.checked)excludedModels.set(key,{channelId,model:el.value});else excludedModels.delete(key);
    renderCatalogModels();
  }
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
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-model-batch]');if(!button)return;
  const channelId=Number(button.dataset.channel),group=button.closest('[data-model-channel]');
  group.querySelectorAll('[name=excluded-model-choice]').forEach(input=>{
    const key=modelRuleKey(channelId,input.value);
    if(button.dataset.modelBatch==='exclude')excludedModels.set(key,{channelId,model:input.value});else excludedModels.delete(key);
  });
  renderCatalogModels();
});
document.addEventListener('change',async event=>{try{if(event.target.id==='statistics-days'){statisticsDays=Number(event.target.value);await personalStatistics();}else if(event.target.id==='statistics-auto'){statisticsAuto=event.target.checked;if(statisticsAuto)scheduleStatistics();else stopStatistics();}}catch(e){toast(e.message);}});
document.addEventListener('click',event=>{if(!event.target.closest('.account')){$('#account-menu').hidden=true;$('#account-toggle').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',event=>{
  const tab=event.target.closest('[data-notification-tab]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'ding':event.key==='End'?'email':tab.dataset.notificationTab==='ding'?'email':'ding';const button=document.querySelector('[data-notification-tab='+target+']');button.click();button.focus();return;}
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
      if(form.id==='login-form'){const password=f.get('password');form.elements.password.value='';data=await api('/api/auth/login','POST',{username:f.get('username'),password,remember:f.has('remember')});}
      else data=await api('/api/auth/verify','POST',{challengeId:s.challenge,code:f.get('code')});
      if(data.requireVerification){s.challenge=data.challengeId;$('#login-form').hidden=true;$('#verify-form').hidden=false;toast('原站要求二次验证，输入动态验证码。Passkey 等方式尚未接入。');}
      else{$('#verify-form').reset();$('#verify-form').hidden=true;$('#login-form').hidden=false;await enter(data);}
    }else if(form.id==='log-filter'){for(const k of Object.keys(filters))if(f.has(k))filters[k]=f.get(k);s.n=1;await logs({refresh:true});}
    else if(form.id==='claim-filter'){filters.status=f.get('status');s.n=1;await claims();}
    else if(form.id==='rules-form'){
      const r=structuredClone(s.rules),displayedQuotas={};for(const [k]of numeric){if(quotaFields.has(k))displayedQuotas[k]=String(f.get(k));else r[k]=Number(f.get(k));}for(const k of ['applicationsEnabled','executionEnabled','selfServiceEnabled','restrictModels','aiEnabled'])r[k]=f.has(k);for(const k of ['aiAutoThreshold','aiDailyLimit'])r[k]=Number(f.get(k));r.channels=f.getAll('channel-choice').map(Number);r.blockedUsers=String(f.get('blockedUsers')).split(/[,，\s]+/).filter(Boolean).map(Number);r.models=[...pickedModels];r.excludedModels=[...excludedModels.values()];r.userGroups=f.getAll('group-choice');r.timezone=f.get('timezone');r.dailyResetTime=f.get('dailyResetTime');r.notifications.enabled=f.has('notificationsEnabled');await api('/api/admin/rules','PUT',{...r,lookbackDays:Number(f.get('lookbackDays')),displayedQuotas,displayRevision:s.display?.revision});toast('规则已保存并记录新版本');await rules();
    }else if(form.id==='email-notification-form'){
      const events=f.getAll('events');
      await api('/api/admin/email-notifications','PUT',{version:s.rules.version,host:f.get('host'),port:Number(f.get('port')),security:f.get('security'),username:f.get('username'),password:f.get('password'),fromEmail:f.get('fromEmail'),fromName:f.get('fromName'),enabled:f.has('enabled'),events});
      toast('邮箱通知设置已保存');await notifications();
    }else if(form.id==='email-test-form'){
      const feedback=form.querySelector('[data-form-feedback]');feedback.className='muted';feedback.textContent='正在连接 SMTP 并发送测试邮件…';
      const result=await api('/api/admin/email-notifications/test','POST',{to:String(f.get('to')).trim()});
      feedback.textContent='SMTP 已接受发往 '+result.to+' 的测试邮件，请检查收件箱与垃圾邮件。';
      delete form.dataset.edited;
    }else if(form.id==='notification-form'){
      const webhook=f.get('webhook').trim(),secret=f.get('secret').trim();if(webhook||secret)await api('/api/admin/notifications','PUT',{...(webhook?{webhook}:{}),...(secret?{secret}:{})});const r=structuredClone(s.rules);r.notifications={enabled:f.has('enabled'),events:f.getAll('events')};await api('/api/admin/rules','PUT',r);toast('通知设置已保存');await notifications();
    }
  }catch(e){if(['login-form','verify-form'].includes(form.id)){$('#login-message').textContent=e.message;$('#login-form').hidden=false;$('#verify-form').hidden=true;}else if(form.id==='operation-form')$('#operation-error').textContent=e.message;else {const feedback=form.querySelector('[data-form-feedback]');if(feedback){feedback.className='error';feedback.textContent=e.message;}toast(e.message);}}
  finally{s.busy=false;if(b){b.disabled=false;busyButton(b,false);}}
});
async function loadBrand(){
  try{
    const brand=await api('/api/brand');
    document.title='云响 · 云中猫API小站 补空回';
    const mobile=document.querySelector('.mobile-brand');if(mobile)mobile.textContent='云响';
    if(brand.logo)for(const root of document.querySelectorAll('[data-brand-logo]')){
      const img=new Image();img.alt='云响 Logo';img.referrerPolicy='no-referrer';
      img.addEventListener('load',()=>{root.replaceChildren(img);root.classList.add('has-logo');});img.src=brand.logo;
    }
  }catch{}
}
loadBrand();
pages.notifications='通知中心';
pages.inbox='站内通知';iconNames.inbox='bell';
watchUIVersion({isBusy:()=>s.busy||api.pending>0,notify:toast});
try{await enter(await api('/api/me'));}catch{loginView();}
