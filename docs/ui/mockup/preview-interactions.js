(()=>{
 const select=document.querySelector('select.select');if(!select)return;
 const wrapper=document.createElement('div');wrapper.className='range-picker';
 select.replaceWith(wrapper);wrapper.innerHTML='<button class="select range-trigger" aria-haspopup="listbox" aria-expanded="false">近 30 天 <span>⌄</span></button><div class="range-options" role="listbox" aria-label="时间范围" hidden></div>';
 const trigger=wrapper.firstElementChild,menu=wrapper.lastElementChild,options=['近 30 天','近 7 天','今日'];let chosen=0;
 const chart=document.querySelector('.chart'),trend=document.querySelector('.trend');
 const tip=document.createElement('div');tip.className='chart-tooltip';tip.hidden=true;trend.append(tip);
 const NS='http://www.w3.org/2000/svg';
 const cursor=document.createElementNS(NS,'line');cursor.setAttribute('class','chart-cursor');cursor.setAttribute('y1','15');cursor.setAttribute('y2','134');cursor.style.display='none';chart.append(cursor);
 let values=[],labels=[];
 function render(){
  const count=chosen===0?30:chosen===1?7:12;
  values=Array.from({length:count},(_,i)=>Math.round(18+((i*37+13)%113)+(i%3)*12));
  labels=Array.from({length:count},(_,i)=>chosen===2?String(i*2).padStart(2,'0')+':00':'第 '+(i+1)+' 天');
  const max=Math.ceil(Math.max(...values)/50)*50,points=values.map((v,i)=>[34+i*656/(count-1),134-v/max*114]);
  const path=points.map(([x,y],i)=>(i?'L':'M')+x+' '+y).join(' ');
  chart.querySelector('.chart-line').setAttribute('d',path);chart.querySelector('.chart-fill').setAttribute('d',path+' L690 134 L34 134Z');
  const point=chart.querySelector('.chart-point');point.setAttribute('cx',points.at(-1)[0]);point.setAttribute('cy',points.at(-1)[1]);
  chart.querySelectorAll('.chart-label').forEach((el,i)=>{el.textContent=i<3?labels[[0,Math.floor((count-1)/2),count-1][i]]:i===3?'¥'+max:'¥0'});
  trend.querySelector('p').textContent='已完成补偿金额 · '+options[chosen]+' · 演示数据';
  tip.hidden=true;cursor.style.display='none';
 }
 function close(){menu.hidden=true;trigger.setAttribute('aria-expanded','false')}
 options.forEach((label,i)=>{const b=document.createElement('button');b.role='option';b.textContent=label;b.setAttribute('aria-selected',String(i===chosen));b.onclick=()=>{chosen=i;trigger.innerHTML=label+' <span>⌄</span>';[...menu.children].forEach((el,n)=>el.setAttribute('aria-selected',String(n===i)));render();close();trigger.focus()};menu.append(b)});
 trigger.onclick=()=>{menu.hidden=!menu.hidden;trigger.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden)menu.children[chosen].focus()};
 wrapper.onkeydown=e=>{if(e.key==='Escape'){close();trigger.focus()}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();menu.hidden=false;trigger.setAttribute('aria-expanded','true');const current=[...menu.children].indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?2:(current+(e.key==='ArrowDown'?1:-1)+3)%3;menu.children[next].focus()}};
 document.addEventListener('click',e=>{if(!wrapper.contains(e.target))close()});
 function inspect(index){const i=Math.max(0,Math.min(values.length-1,index)),rect=chart.getBoundingClientRect();const x=34+i*656/(values.length-1);cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);cursor.style.display='';tip.hidden=false;tip.textContent=labels[i]+' · 补回 ¥'+values[i].toFixed(2);tip.style.left=Math.min(Math.max(12,x/700*rect.width),Math.max(12,trend.clientWidth-180))+'px';tip.style.top='64px';chart.setAttribute('aria-label',tip.textContent)}
 chart.style.touchAction='pan-y';chart.tabIndex=0;chart.addEventListener('pointermove',e=>{const rect=chart.getBoundingClientRect();inspect(Math.round(((e.clientX-rect.left)/rect.width*700-34)/656*(values.length-1)))});
 chart.addEventListener('pointerleave',()=>{tip.hidden=true;cursor.style.display='none'});
 let keyboardIndex=0;chart.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();keyboardIndex=Math.max(0,Math.min(values.length-1,keyboardIndex+(e.key==='ArrowRight'?1:-1)));inspect(keyboardIndex)}};
 render();
})();
