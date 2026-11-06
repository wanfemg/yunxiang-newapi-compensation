const statusTitles={
  pending:'申请待审核',approved:'审核通过 · 待补偿',executing:'补偿执行中',
  succeeded:'补偿成功',failed:'补偿失败',unknown:'结果待确认',rejected:'审核已驳回'
};
const eventTitles={
  application_pending:statusTitles.pending,review_result:'申请审核结果',
  compensation_success:statusTitles.succeeded,execution_failed:statusTitles.failed,
  execution_unknown:statusTitles.unknown,ai_reviewing:'AI 审核进行中',
  ai_reviewed:'AI 判定结果',ai_auto_compensation:'AI 审核通过 · 自动补偿成功',
  ai_manual_review:'AI 判定待确认 · 转人工审核',batch_result:'申请处理汇总',
  notification_test:'钉钉机器人连接测试'
};
export function notificationTitle(event,status){
  return event==='review_result'&&statusTitles[status]?statusTitles[status]:eventTitles[event]||'申请处理通知';
}
export function batchNotificationTitle(claims,hasAI=false){
  const counts=new Map();
  for(const claim of claims)counts.set(claim.status,(counts.get(claim.status)||0)+1);
  const summary=counts.size===1?statusTitles[claims[0]?.status]||'申请处理结果'
    :['unknown','failed','pending','approved','executing','rejected','succeeded'].filter(status=>counts.has(status)).map(status=>(status==='pending'?'待审核':status==='approved'?'审核通过':statusTitles[status])+' '+counts.get(status)).join(' / ');
  return (hasAI?'AI 审核 · ':'')+summary+'（'+claims.length+' 笔）';
}
export function notificationMarkdown(row){
  let markdown;try{markdown=JSON.parse(row.body);}catch{}
  if(markdown&&typeof markdown.title==='string'&&typeof markdown.text==='string'){
    if(/^(?:云中猫API小站 |NewAPI )?补空回通知$|^空回补额度通知$/.test(markdown.title)){
      const title=notificationTitle(row.event);
      const text=/^### [^\n]*(?:\n|$)/.test(markdown.text)
        ?markdown.text.replace(/^### [^\n]*(?:\n|$)/,'### '+title+'\n')
        :'### '+title+'\n\n'+markdown.text;
      return {title,text};
    }
    return {title:markdown.title,text:markdown.text};
  }
  const title=notificationTitle(row.event);
  return {title,text:'### '+title+'\n\n'+String(row.body).replace(/[<>@]/g,' ')};
}
