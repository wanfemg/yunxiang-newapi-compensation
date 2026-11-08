import {inputQuota,parseQuota} from './display.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
export function renderAmountPanel(items,display,money){
  const groups=new Map();
  items.forEach((item,i)=>{if(!item.confirmAmount)return;if(!groups.has(item.model))groups.set(item.model,[]);groups.get(item.model).push({...item,index:i});});
  return '<section class="amount-panel" data-amount-panel><div class="amount-summary" role="status" aria-live="polite"></div><p class="field-help">普通钱包记录预填预计补偿；订阅及来源不明的记录须人工核实。统一填入仅作用于当前模型，不会截断超额数值。</p>'+[...groups].map(([name,rows],group)=>'<section class="amount-model" data-amount-group="'+group+'"><h3>'+esc(name)+' <small>'+rows.length+' 笔</small></h3><div class="amount-tools"><button type="button" class="ghost" data-amount-action="expected">填入钱包预计额</button><button type="button" class="ghost" data-amount-action="clear">清空本组</button><label>本组每笔额度<input data-amount-common inputmode="decimal" type="number" min="0" step="any" placeholder="已核实金额"></label><button type="button" class="secondary" data-amount-action="common">应用到本组</button></div>'+rows.map(item=>'<label class="amount-entry"><span>'+esc(item.requestId)+'</span><span class="field-help">原消费 '+esc(money(item.quota))+' · 预计补偿 '+esc(money(item.expectedAmount))+(item.safeDefault?'':' · 需核实未退款金额')+'</span><input data-amount-index="'+item.index+'" name="amount-'+item.index+'" type="number" inputmode="decimal" min="0" max="'+esc(inputQuota(item.quota,display))+'" step="any" required value="'+(item.safeDefault?esc(inputQuota(item.expectedAmount,display)):'')+'" placeholder="填写已核实未返还金额"></label>').join('')+'</section>').join('')+'<p class="field-help error" data-amount-error role="alert"></p></section>';
}
export function bindAmountPanel(root,items,display,rules,money){
  const panel=root.querySelector('[data-amount-panel]');if(!panel)return;
  const inputs=[...panel.querySelectorAll('[data-amount-index]')],error=panel.querySelector('[data-amount-error]');
  function validate(input,value=input.value){
    const item=items[Number(input.dataset.amountIndex)],amount=parseQuota(value,display);
    if(amount<=0||amount>item.quota)throw Error('核实额度须大于零且不能超过原消费：'+item.requestId);
    return Math.min(amount,item.expectedAmount);
  }
  function update(){
    let filled=0,total=0;const batches=new Map();
    error.textContent='';
    for(const input of inputs){input.setCustomValidity('');if(!input.value)continue;try{const amount=validate(input),item=items[Number(input.dataset.amountIndex)];filled++;total+=amount;const key=item.batchId||item.id;batches.set(key,(batches.get(key)||0)+amount);}catch(e){input.setCustomValidity(e.message);error.textContent=e.message;}}
    if(rules?.perBatchQuota>0&&[...batches.values()].some(n=>n>rules.perBatchQuota)){error.textContent='本次选择的同批额度已超过单次补偿上限';inputs[0]?.setCustomValidity(error.textContent);}
    panel.querySelector('.amount-summary').textContent='已填写 '+filled+' / '+inputs.length+' 笔 · 预计本次发放 '+money(total)+(rules?.perBatchQuota?' · 同批累计上限 '+money(rules.perBatchQuota):'')+'（历史到账及每日限额由服务端最终核验）';
  }
  panel.addEventListener('input',update);
  panel.addEventListener('click',event=>{
    const button=event.target.closest('[data-amount-action]');if(!button)return;event.stopPropagation();
    const group=button.closest('[data-amount-group]'),fields=[...group.querySelectorAll('[data-amount-index]')];
    try{
      const action=button.dataset.amountAction,value=group.querySelector('[data-amount-common]').value;
      if(action==='common')for(const input of fields)validate(input,value);
      for(const input of fields){const item=items[Number(input.dataset.amountIndex)];if(action==='clear')input.value='';else if(action==='common')input.value=value;else if(item.safeDefault)input.value=inputQuota(item.expectedAmount,display);}
      update();
    }catch(e){error.textContent=e.message;}
  });
  update();
}
