export function displayConfig(status) {
  const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
  const type=status.quota_display_type||(status.display_in_currency===false?'TOKENS':'USD');
  if(!['USD','CNY','TOKENS','CUSTOM'].includes(type))throw Error('原站额度显示类型不受支持');
  const unit=positive(status.quota_per_unit);
  const rate=type==='CNY'?positive(status.usd_exchange_rate):type==='CUSTOM'?positive(status.custom_currency_exchange_rate):1;
  if(type!=='TOKENS'&&(!unit||!Number.isSafeInteger(unit)||!rate))throw Error('原站额度换算配置不完整');
  if(type!=='TOKENS'&&(!Number.isFinite(rate/unit)||rate/unit<=0))throw Error('原站额度换算比例无效');
  return {type,unit:type==='TOKENS'?1:unit,rate:type==='TOKENS'?1:rate,scale:type==='TOKENS'?1:rate/unit,symbol:{USD:'$',CNY:'¥',TOKENS:'',CUSTOM:String(status.custom_currency_symbol||'¤').replace(/[<>&"']/g,'')}[type],label:type==='TOKENS'?'额度':type==='CUSTOM'?String(status.custom_currency_symbol||'额度'):type};
}
export function formatQuota(raw,config){
  if(!config)return '—';
  const value=Number(raw||0)*config.scale;
  return config.symbol+value.toLocaleString('zh-CN',{minimumFractionDigits:config.type==='TOKENS'?0:2,maximumFractionDigits:config.type==='TOKENS'?0:6});
}
function decimal(value){
  const match=String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if(!match||String(value).length>400)throw Error('额度数值或换算配置无效');
  const shift=Number(match[3]||0)-(match[2]||'').length;
  if(Math.abs(shift)>400)throw Error('额度数值或换算配置无效');
  const digits=BigInt(match[1]+(match[2]||''));
  return shift<0?[digits,10n**BigInt(-shift)]:[digits*10n**BigInt(shift),1n];
}
export function inputQuota(raw,config){
  if(!config)return '';
  const [n,d]=decimal(raw),[rateN,rateD]=decimal(config.rate),[unitN,unitD]=decimal(config.unit);
  const numerator=n*rateN*unitD,denominator=d*rateD*unitN;
  if(denominator<=0n)throw Error('原站额度换算比例无效');
  let result=String(numerator/denominator),remainder=numerator%denominator;
  if(remainder)result+='.';
  for(let i=0;remainder&&i<400;i++){remainder*=10n;result+=String(remainder/denominator);remainder%=denominator;}
  if(remainder)throw Error('原站换算比例不能精确表示该笔额度');
  return result;
}
export function parseQuota(value,config){
  if(!config||!/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(value)))throw Error('请输入非负额度数值');
  const [n,d]=decimal(value),[rateN,rateD]=decimal(config.rate),[unitN,unitD]=decimal(config.unit);
  const numerator=n*rateD*unitN,denominator=d*rateN*unitD;
  if(denominator<=0n||numerator%denominator!==0n||numerator/denominator>BigInt(Number.MAX_SAFE_INTEGER))throw Error('额度精度超出原站最小计费单位');
  return Number(numerator/denominator);
}
