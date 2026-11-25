import {notificationTitle} from './notification-titles.mjs';
import {formatQuota} from '../public/display.js';

const statusShort={
  pending:'待审核',approved:'已通过',executing:'执行中',
  succeeded:'已补回',failed:'失败',unknown:'待确认',rejected:'已驳回'
};

function safe(value,max=120){
  return String(value??'').replace(/[\\`*_{}\[\]()<>#!|@]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

function markdownValue(value){
  return String(value??'').replace(/\s+/g,' ').trim().replace(/([\\`*_{}\[\]()<>#!|@])/g,'\\$1');
}

export function modelNotificationText(claims,display){
  const models=new Map();
  let total=0;
  for(const claim of claims){
    const name=claim.log.model_name||'未知模型';
    const model=models.get(name)||{count:0,amount:0,statuses:{}};
    model.count++;
    model.statuses[claim.status]=(model.statuses[claim.status]||0)+1;
    if(claim.status==='succeeded'){model.amount+=claim.amount;total+=claim.amount;}
    models.set(name,model);
  }
  const quota=amount=>markdownValue(display?formatQuota(amount,display):amount.toLocaleString('zh-CN')+' 原始额度');
  const rows=[...models].map(([name,model])=>{
    const remaining=Object.entries(statusShort).filter(([status])=>status!=='succeeded'&&model.statuses[status])
      .map(([status,label])=>`${label} ${model.statuses[status]} 条`);
    return [`- **${markdownValue(name)}**：${model.count} 条`,quota(model.amount),...remaining].join(' · ');
  });
  return [
    `用户：${markdownValue(claims[0].username)}（ID ${claims[0].user_id}）`,
    `**合计补回：${quota(total)}**`,
    ...rows
  ].join('\n\n');
}

function keyValues(row){
  let parsed;try{parsed=JSON.parse(row.body);}catch{}
  if(parsed&&typeof parsed.title==='string'&&typeof parsed.text==='string')return {title:parsed.title,text:parsed.text,models:parsed.layout==='models',legacy:/^(?:云中猫API小站 |NewAPI )?补空回通知$|^空回补额度通知$/.test(parsed.title)};
  return {title:notificationTitle(row.event),text:String(row.body),legacy:false};
}

function compactBody(text,title){
  const lines=String(text).replace(/^#{1,6}\s+[^\n]*(?:\n|$)/,'').split(/\r?\n/).map(line=>line.trim())
    .filter(line=>line&&!/^#{1,6}\s+/.test(line))
    .map(line=>line.replace(/^-?\s*(?:\*\*)?([^*：:]+?)(?:\*\*)?\s*[：:]\s*(.*)$/,(_,key,value)=>`${key}: ${value}`))
    .map(line=>line.replace(/^\-\s*/,''))
    .map(line=>safe(line,180));
  const primary=lines.filter(line=>/^(用户|已确认补回|状态|模型):/i.test(line));
  return [`### ${title}`,...(primary.length?primary:lines.slice(0,1))].join('\n\n');
}

export function dingtalkPayload(row,origin){
  const {title,text,legacy,models}=keyValues(row);
  const finalTitle=legacy?notificationTitle(row.event):title;
  const body=models?`### ${finalTitle}\n\n${text}`:compactBody(text,finalTitle);
  return {
    msgtype:'actionCard',
    actionCard:{
      title:finalTitle,
      text:body,
      btnOrientation:'0',
      singleTitle:'打开云响工作台',
      singleURL:origin
    },
    at:{isAtAll:false}
  };
}
