export function formatAIProbability(value){
  if(!Number.isFinite(value)||value<0||value>1)return null;
  // Truncate so a score below the threshold never appears to have reached it.
  return String(Math.trunc(value*1_000_000)/10_000);
}
export function aiDecisionForThreshold(review,threshold=90){
  const probability=review?.analysis?.emptyProbability;
  if(review?.status==='completed'&&Number.isFinite(probability)){
    const cutoff=Math.max(0,Math.min(100,Number(threshold)||90))/100;
    return probability>=cutoff?'empty':probability<=1-cutoff?'not_empty':'uncertain';
  }
  return review?.decision||'uncertain';
}
export function aiResultLabel(review,mode='automatic',threshold=90){
  if(!review)return '尚未进行 AI 判定';
  if(review.status!=='completed')return review.status==='failed'?'AI 请求失败，转人工审核':'AI 服务未完成判定，转人工审核';
  if(mode==='admin')return {approve:'建议通过并补额度',reject:'建议驳回申请',manual:'证据需人工核实'}[review.analysis?.recommendation]||'二次复核未提供建议，需人工核实';
  const probability=review.analysis?.emptyProbability;
  if(Number.isFinite(probability)){
    const decision=aiDecisionForThreshold(review,threshold);
    const prefix=mode==='historical'?'历史审核参考：':'初审结论：';
    return prefix+(decision==='empty'?'达到 AI 自动补偿标准':decision==='not_empty'?'更倾向已有有效回答，转人工审核':'空回概率未达到阈值，转人工审核');
  }
  if(review.decision==='uncertain')return '初审结论：AI 未返回有效空回概率，转人工审核';
  return {empty:'初审结论：疑似空回',not_empty:'初审结论：非空回',uncertain:'初审结论：空回概率未达到阈值，转人工审核'}[review.decision]||'初审结果格式异常，需人工核实';
}
