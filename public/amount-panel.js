import {inputQuota,parseQuota} from './display.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const buttonIcon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
export function renderAmountPanel(items,display,money){
  const groups=new Map();
  items.forEach((item,i)=>{if(!item.confirmAmount)return;if(!groups.has(item.model))groups.set(item.model,[]);groups.get(item.model).push({...item,index:i});});
  const needsVerification=items.some(item=>item.confirmAmount&&!item.safeDefault);
  return '<section class="amount-panel" data-amount-panel><div class="amount-summary" role="status" aria-live="polite"></div><div class="amount-panel-actions"><button type="button" class="secondary" data-amount-action="expected" data-amount-all>'+buttonIcon('wand-sparkles')+'按每笔预计额填写</button><button type="button" class="ghost" data-amount-action="clear" data-amount-all>'+buttonIcon('eraser')+'清空全部</button></div>'+(needsVerification?'<label class="amount-verification check-label"><input type="checkbox" data-amount-verified><span>已核实订阅及来源不明记录的实际扣费，确认这些额度尚未退回<small>勾选后可批量填写这些记录；仍可逐笔手动输入核实金额。</small></span></label>':'')+'<p class="amount-feedback field-help" data-amount-feedback role="status" aria-live="polite"></p>'+[...groups].map(([name,rows],group)=>'<section class="amount-model" data-amount-group="'+group+'"><div class="amount-model-heading"><h3>'+esc(name)+'</h3><span>'+rows.length+' 笔</span><button type="button" class="ghost" data-amount-action="expected">'+buttonIcon('list-checks')+'填本模型预计额</button></div><div class="amount-tools"><label>本模型统一填写<input data-amount-common inputmode="decimal" type="number" min="0" step="any" placeholder="已核实的每笔金额"></label><button type="button" class="secondary" data-amount-action="common">应用到本模型</button><span class="field-help">每笔原消费不同，超出该笔上限时会保留原值并单独提示。</span></div><div class="amount-entries">'+rows.map(item=>'<div class="amount-entry" data-amount-row="'+item.index+'"><div class="amount-entry-main"><strong>'+esc(item.requestId)+'</strong><span class="field-help">'+(item.safeDefault?'钱包扣费':item.fundingSource==='subscription'?'订阅消费 · 补入钱包余额':'来源待核实')+'</span></div><div class="amount-entry-values"><span>原消费<strong>'+esc(money(item.quota))+'</strong></span><span>预计补偿<strong>'+esc(money(item.expectedAmount))+'</strong></span></div><label class="amount-entry-control">核实未返还额<input data-amount-index="'+item.index+'" name="amount-'+item.index+'" aria-describedby="amount-hint-'+item.index+'" type="number" inputmode="decimal" min="0" max="'+esc(inputQuota(item.quota,display))+'" step="any" required value="'+(item.safeDefault?esc(inputQuota(item.expectedAmount,display)):'')+'" placeholder="输入核实金额"></label><p id="amount-hint-'+item.index+'" class="amount-entry-feedback" data-amount-row-feedback></p></div>').join('')+'</div></section>').join('')+'<p class="field-help amount-limit-note">实际发放取核实金额与规则允许金额的较小值；历史到账及每日限额将在提交时再次核验。</p><p class="field-help error" data-amount-error role="alert"></p></section>';
}
export function bindAmountPanel(root,items,display,rules,money){
  const panel=root.querySelector('[data-amount-panel]');if(!panel)return;
  const inputs=[...panel.querySelectorAll('[data-amount-index]')],error=panel.querySelector('[data-amount-error]'),feedback=panel.querySelector('[data-amount-feedback]'),rowMessages=new Map();
  function validate(input,value=input.value){
    const item=items[Number(input.dataset.amountIndex)],amount=parseQuota(value,display);
    if(amount<=0)throw Error('核实金额要大于 0');
    if(amount>item.quota)throw Error('超过这笔原消费，最多填写 '+money(item.quota));
    return Math.min(amount,item.expectedAmount);
  }
  function update(){
    let filled=0,total=0;const batches=new Map();
    error.textContent='';
    for(const input of inputs){
      const index=Number(input.dataset.amountIndex),row=input.closest('[data-amount-row]'),message=row.querySelector('[data-amount-row-feedback]');
      input.setCustomValidity('');input.removeAttribute('aria-invalid');row.dataset.amountState=input.value?'filled':'missing';
      message.textContent=input.value?'':'待填写核实金额';
      if(input.value)try{const amount=validate(input),item=items[index];filled++;total+=amount;const key=item.batchId||item.id;batches.set(key,(batches.get(key)||0)+amount);message.textContent='本笔预计发放 '+money(amount);}catch(e){input.setCustomValidity(e.message);input.setAttribute('aria-invalid','true');row.dataset.amountState='invalid';message.textContent=e.message;error.textContent='有金额需要修正，请查看对应记录下方的提示。';}
      if(rowMessages.has(index)){message.textContent=rowMessages.get(index);row.dataset.amountState='warning';}
    }
    if(rules?.perBatchQuota>0&&[...batches.values()].some(n=>n>rules.perBatchQuota)){error.textContent='同一查询批次的补偿合计超过 '+money(rules.perBatchQuota)+'，请调低该批次中的金额后提交。';inputs[0]?.setCustomValidity(error.textContent);}
    panel.querySelector('.amount-summary').innerHTML='<div><span>已填写</span><strong>'+filled+' <small>/ '+inputs.length+' 笔</small></strong></div><div><span>待填写</span><strong>'+Math.max(0,inputs.length-filled)+' <small>笔</small></strong></div><div><span>预计本次发放</span><strong>'+esc(money(total))+'</strong></div>';
  }
  panel.addEventListener('input',event=>{if(event.target.matches('[data-amount-index]'))rowMessages.delete(Number(event.target.dataset.amountIndex));feedback.textContent='';update();});
  panel.addEventListener('click',event=>{
    const button=event.target.closest('[data-amount-action]');if(!button)return;event.stopPropagation();
    const group=button.closest('[data-amount-group]'),fields=button.hasAttribute('data-amount-all')?inputs:[...group.querySelectorAll('[data-amount-index]')],action=button.dataset.amountAction;
    const common=group?.querySelector('[data-amount-common]')?.value;
    if(action==='common'&&!common){feedback.textContent='先填写本模型要统一使用的金额。';group.querySelector('[data-amount-common]').focus();return;}
    let filled=0,skipped=0;
    for(const input of fields){
      const index=Number(input.dataset.amountIndex),item=items[index];rowMessages.delete(index);
      if(action==='clear'){input.value='';continue;}
      if(!item.safeDefault&&!panel.querySelector('[data-amount-verified]')?.checked){rowMessages.set(index,'尚未批量填写：请先勾选上方的扣费与退款核实确认，或手动输入本笔金额。');skipped++;continue;}
      try{const value=action==='common'?common:inputQuota(item.expectedAmount,display);validate(input,value);input.value=value;filled++;}
      catch(e){rowMessages.set(index,'本次未填写：'+e.message+'。原有金额已保留。');skipped++;}
    }
    update();feedback.textContent=action==='clear'?'已清空 '+fields.length+' 笔金额。':'已填写 '+filled+' 笔'+(skipped?'，另有 '+skipped+' 笔需处理，原因已显示在对应记录下方。':'，可逐笔调整。');
    if(skipped)panel.querySelector('[data-amount-state="warning"]')?.scrollIntoView({block:'nearest',behavior:'auto'});
  });
  update();
}
