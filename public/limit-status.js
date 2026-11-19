const esc=value=>String(value??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');

export function limitMessage(limit,{money=String,date=String}={}){
  if(!limit)return '';
  const amount=limit.kind==='quota'||/quota/i.test(limit.code||'');
  const format=amount?money:value=>String(value)+' 次';
  const scope=limit.scope==='site'?'全站':'用户';
  const title=limit.code==='PER_BATCH_QUOTA_LIMIT'?'本次应补额度超过单次补偿上限'
    :/DAILY_QUOTA_LIMIT$/.test(limit.code||'')?scope+'当日可补额度不足，申请已保留'
    :/DAILY_COUNT_LIMIT$/.test(limit.code||'')?scope+'当日补偿次数已达上限'
    :limit.message||'本次处理暂受补偿限制';
  const parts=[title];
  if(Number.isFinite(limit.used)&&Number.isFinite(limit.limit))parts.push('已使用 '+format(limit.used)+' / '+format(limit.limit));
  if(Number.isFinite(limit.remaining))parts.push('剩余 '+format(Math.max(0,limit.remaining)));
  if(amount&&Number.isFinite(limit.required))parts.push('本次需要 '+format(limit.required));
  if(limit.nextResetAt){
    const reset=limit.timezone?new Intl.DateTimeFormat('zh-CN',{timeZone:limit.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(limit.nextResetAt)):date(limit.nextResetAt);
    parts.push('下次恢复：'+reset+(limit.timezone?'（'+limit.timezone+'）':''));
  }else if(/_LIMIT$/.test(limit.code||''))parts.push('当前上限不足，需管理员调整后继续');
  return parts.join('；');
}

export function renderLimitNotice(limit,options={}){
  return limit?'<div class="notice warning batch-limit" role="status">'+esc(limitMessage(limit,options))+'</div>':'';
}
