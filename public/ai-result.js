export function aiResultLabel(review,mode='automatic'){
  if(!review)return '尚未进行 AI 判定';
  if(review.status!=='completed')return review.status==='failed'?'AI 请求失败，转人工审核':'AI 服务未完成判定，转人工审核';
  if(mode==='admin')return {approve:'建议通过并补额度',reject:'建议驳回申请',manual:'证据需人工核实'}[review.analysis?.recommendation]||'二次复核未提供建议，需人工核实';
  return {empty:'初审结论：疑似空回',not_empty:'初审结论：非空回',uncertain:'初审结论：证据不足，无法确定'}[review.decision]||'初审结果格式异常，需人工核实';
}
