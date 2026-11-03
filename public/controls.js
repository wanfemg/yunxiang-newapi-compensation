// Keep native form values and change events while presenting a consistent popup.
export function enhanceControls(root=document){
  enhanceDateInputs(root);
  for(const summary of root.querySelectorAll('details>summary:not([data-disclosure])')){
    summary.dataset.disclosure='true';
    if(summary.querySelector('svg,i[data-lucide],.chevron'))continue;
    const chevron=document.createElement('i');chevron.dataset.lucide='chevron-down';chevron.className='disclosure-chevron';chevron.setAttribute('aria-hidden','true');summary.append(chevron);
  }
  for(const select of root.querySelectorAll('select:not([data-enhanced])')){
    select.dataset.enhanced='true';select.classList.add('native-value');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    const wrapper=document.createElement('div');wrapper.className='glass-select';
    const trigger=document.createElement('button');trigger.type='button';trigger.className='glass-select-trigger';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    const menu=document.createElement('div');menu.className='glass-options';menu.setAttribute('popover','auto');menu.id='options-'+crypto.randomUUID();menu.setAttribute('role','listbox');
    trigger.setAttribute('aria-controls',menu.id);trigger.setAttribute('popovertarget',menu.id);
    const label=select.labels?.[0]?.childNodes[0]?.textContent?.trim()||select.getAttribute('aria-label')||'选择选项';trigger.setAttribute('aria-label',label);
    select.before(wrapper);wrapper.append(select,trigger,menu);
    const sync=()=>{trigger.textContent=select.selectedOptions[0]?.textContent||'请选择';trigger.disabled=select.disabled;for(const option of menu.children)option.setAttribute('aria-selected',String(option.dataset.value===select.value));};
    for(const option of select.options){const button=document.createElement('button');button.type='button';button.textContent=option.textContent;button.dataset.value=option.value;button.disabled=option.disabled;button.setAttribute('role','option');button.addEventListener('click',()=>{select.value=option.value;sync();menu.hidePopover();trigger.focus();select.dispatchEvent(new Event('change',{bubbles:true}));});menu.append(button);}
    menu.addEventListener('toggle',event=>{trigger.setAttribute('aria-expanded',String(event.newState==='open'));if(event.newState==='open'){const rect=trigger.getBoundingClientRect();menu.style.width=rect.width+'px';menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-rect.width-8))+'px';menu.style.top=Math.min(rect.bottom+6,innerHeight-180)+'px';menu.querySelector('[aria-selected=true]')?.focus();}});
    menu.addEventListener('keydown',event=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();}});
    select.addEventListener('change',sync);sync();
  }
}

function enhanceDateInputs(root){
  const pad=value=>String(value).padStart(2,'0');
  for(const input of root.querySelectorAll('input[type=date]:not([data-calendar]),input[type=datetime-local]:not([data-calendar]),input[type=time]:not([data-calendar])')){
    input.dataset.calendar='true';input.classList.add('glass-date-value');
    const wrapper=document.createElement('div');wrapper.className='glass-date-field';input.before(wrapper);wrapper.append(input);
    const trigger=document.createElement('button');trigger.type='button';trigger.className='glass-date-trigger';trigger.title=input.type==='time'?'选择时间':'选择日期与时间';trigger.setAttribute('aria-label',trigger.title);
    trigger.innerHTML='<i data-lucide="'+(input.type==='time'?'clock-3':'calendar-days')+'"></i>';
    const menu=document.createElement('div');menu.className='glass-calendar';menu.popover='auto';menu.id='calendar-'+crypto.randomUUID();menu.setAttribute('role','dialog');menu.setAttribute('aria-label',trigger.title);trigger.setAttribute('popovertarget',menu.id);trigger.setAttribute('aria-controls',menu.id);trigger.setAttribute('aria-expanded','false');wrapper.append(trigger,menu);
    let view=new Date(),selected='',hour='00',minute='00';
    const write=()=>{input.value=input.type==='time'?hour+':'+minute:selected+(input.type==='datetime-local'&&selected?'T'+hour+':'+minute:'');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
    const render=()=>{
      menu.replaceChildren();
      const button=(text,label,fn)=>{const el=document.createElement('button');el.type='button';el.textContent=text;el.setAttribute('aria-label',label);el.addEventListener('click',fn);return el;};
      if(input.type!=='time'){
        const head=document.createElement('div');head.className='calendar-heading';
        head.append(button('‹','上个月',()=>{view.setMonth(view.getMonth()-1);render();}));const title=document.createElement('strong');title.textContent=view.getFullYear()+' 年 '+(view.getMonth()+1)+' 月';head.append(title,button('›','下个月',()=>{view.setMonth(view.getMonth()+1);render();}));menu.append(head);
        const grid=document.createElement('div');grid.className='calendar-grid';grid.setAttribute('role','group');grid.setAttribute('aria-label','日期');
        for(const name of ['日','一','二','三','四','五','六']){const el=document.createElement('small');el.textContent=name;grid.append(el);}
        const year=view.getFullYear(),month=view.getMonth(),first=new Date(year,month,1).getDay(),last=new Date(year,month+1,0).getDate();
        for(let i=0;i<first;i++)grid.append(document.createElement('span'));
        for(let day=1;day<=last;day++){
          const value=year+'-'+pad(month+1)+'-'+pad(day),el=button(String(day),value,()=>{selected=value;write();render();});
          el.classList.toggle('selected',selected===value);el.setAttribute('aria-pressed',String(selected===value));
          const min=input.min?.slice(0,10),max=input.max?.slice(0,10);el.disabled=Boolean(min&&value<min||max&&value>max);grid.append(el);
        }
        menu.append(grid);
      }
      if(input.type!=='date'){
        const time=document.createElement('div');time.className='calendar-time';
        for(const [name,value,max] of [['小时',hour,23],['分钟',minute,59]]){
          const label=document.createElement('label');label.textContent=name;const number=document.createElement('input');number.type='number';number.min='0';number.max=String(max);number.step='1';number.value=value;number.setAttribute('aria-label',name);
          number.addEventListener('change',()=>{if(!number.validity.valid||number.value==='')return;if(name==='小时')hour=pad(Number(number.value));else minute=pad(Number(number.value));write();});label.append(number);time.append(label);
        }
        menu.append(time);
      }
      const footer=document.createElement('div');footer.className='calendar-footer';footer.append(button('清空','清空日期时间',()=>{input.value='';input.dispatchEvent(new Event('change',{bubbles:true}));menu.hidePopover();trigger.focus();}),button('完成','完成选择',()=>{menu.hidePopover();trigger.focus();}));menu.append(footer);
    };
    menu.addEventListener('toggle',event=>{
      trigger.setAttribute('aria-expanded',String(event.newState==='open'));if(event.newState!=='open')return;
      const now=new Date();selected=input.type==='time'?'':input.value.slice(0,10);view=selected?new Date(selected+'T12:00:00'):new Date(now.getFullYear(),now.getMonth(),1);view.setDate(1);
      const time=input.type==='time'?input.value:input.value.split('T')[1];[hour,minute]=(time||'00:00').split(':');render();
      const rect=trigger.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.right-304,innerWidth-312))+'px';menu.style.top=Math.max(8,Math.min(rect.bottom+6,innerHeight-menu.offsetHeight-8))+'px';
      menu.querySelector('button.selected,button,input')?.focus();
    });
    trigger.disabled=input.disabled;
  }
}
