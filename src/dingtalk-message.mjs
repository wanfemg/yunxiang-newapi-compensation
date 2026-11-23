import {notificationTitle} from './notification-titles.mjs';

const statusShort={
  pending:'待审核',approved:'已通过',executing:'执行中',
  succeeded:'已补回',failed:'失败',unknown:'待确认',rejected:'已驳回'
};

function safe(value,max=120){
  return String(value??'').replace(/[\\`*_{}\[\]()<>#!|@]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

function keyValues(row){
  let parsed;try{parsed=JSON.parse(row.body);}catch{}
  if(parsed&&typeof parsed.title==='string'&&typeof parsed.text==='string')return {title:parsed.title,text:parsed.text,legacy:/^(?:云中猫API小站 |NewAPI )?补空回通知$|^空回补额度通知$/.test(parsed.title)};
  return {title:notificationTitle(row.event),text:String(row.body),legacy:false};
}

function compactBody(text,title){
  const lines=String(text).replace(/^#{1,6}\s+[^\n]*(?:\n|$)/,'').split(/\r?\n/).map(line=>line.trim())
    .filter(line=>line&&!/^#{1,6}\s+/.test(line))
    .map(line=>line.replace(/^-?\s*(?:\*\*)?([^*：:]+?)(?:\*\*)?\s*[：:]\s*(.*)$/,(_,key,value)=>`${key}: ${value}`))
    .map(line=>line.replace(/^\-\s*/,''))
    .map(line=>safe(line,180));
  const primary=lines.filter(line=>/^(用户|申请号|申请笔数|已确认补回|状态|模型|原请求|整批处理说明|时间):/i.test(line));
  const hidden=lines.filter(line=>/^(逐笔结果|处理说明):?\s*$/.test(line));
  const detail=lines.filter(line=>!primary.includes(line)&&!hidden.includes(line)).slice(0,5);
  return [
    `### ${title}`,
    ...primary.slice(0,6),
    ...(detail.length?['','**明细**',...detail]:[]),
    ...(lines.length>primary.length+detail.length?['',`其余 ${lines.length-primary.length-detail.length} 条明细已省略，打开工作台查看。`]:[])
  ].join('\n');
}

export function dingtalkPayload(row,origin){
  const {title,text,legacy}=keyValues(row);
  const finalTitle=legacy?notificationTitle(row.event):title;
  const body=compactBody(text,finalTitle);
  return {
    msgtype:'actionCard',
    actionCard:{
      title:finalTitle,
      text:`${body}\n\n---\n\n> 云响会按用户合并通知，避免逐笔刷屏。`,
      btnOrientation:'0',
      singleTitle:'打开云响工作台',
      singleURL:origin
    },
    at:{isAtAll:false}
  };
}
