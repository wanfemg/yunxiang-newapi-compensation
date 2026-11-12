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
    return decision==='empty'?'初审结论：空回概率达到阈值，自动补偿':decision==='not_empty'?'初审结论：更倾向非空回，转人工审核':'初审结论：空回概率未达到阈值，转人工审核';
  }
  if(review.decision==='uncertain')return '初审结论：AI 未返回有效空回概率，转人工审核';
  return {empty:'初审结论：疑似空回',not_empty:'初审结论：非空回',uncertain:'初审结论：空回概率未达到阈值，转人工审核'}[review.decision]||'初审结果格式异常，需人工核实';
}
