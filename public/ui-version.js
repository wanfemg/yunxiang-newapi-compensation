export function watchUIVersion({isBusy,notify}){
  const version=document.querySelector('meta[name="ui-version"]')?.content;
  if(!version)return;
  let checking=false,lastCheck=0,pending='';
  const notices=[];
  for(const parent of [document.querySelector('main'),document.querySelector('.login-card')]){
    if(!parent)continue;
    const notice=document.createElement('div');notice.className='ui-update notice';notice.hidden=true;notice.setAttribute('role','status');
    const message=document.createElement('span');message.textContent='界面已有新版本，完成当前操作后刷新即可使用。';
    const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='刷新到新版';
    button.addEventListener('click',()=>{
      if(isBusy()){notify('当前请求尚未结束，请等待处理结果后刷新。');return;}
      const dirty=[...document.querySelectorAll('form[data-edited="true"]')].some(form=>!form.closest('#login[hidden], #workspace[hidden]')&&(!form.closest('dialog')||form.closest('dialog').open));
      if((dirty||document.querySelector('dialog[open]'))&&!window.confirm('刷新将关闭弹窗并清除未保存的输入。确认刷新到新版？'))return;
      const url=new URL(location.href);url.searchParams.set('ui',pending);location.replace(url.href);
    });
    notice.append(message,button);parent.prepend(notice);notices.push(notice);
  }
  const label=document.createElement('small');label.className='ui-version-label';label.textContent='界面版本 '+version.slice(0,8);document.querySelector('footer')?.append(label);
  const markEdited=event=>{const form=event.target.closest('form');if(form)form.dataset.edited='true';};
  document.addEventListener('input',markEdited);document.addEventListener('change',markEdited);
  async function check(){
    if(checking||document.hidden||Date.now()-lastCheck<15000)return;checking=true;lastCheck=Date.now();
    try{
      const response=await fetch('/api/ui-version?t='+Date.now(),{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});
      if(!response.ok)return;const result=await response.json(),next=result?.data?.version;
      if(result.success&&/^[a-f0-9]{16}$/.test(next)){pending=next;notices.forEach(notice=>notice.hidden=next===version);}
    }catch{}finally{checking=false;}
  }
  window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);window.addEventListener('online',check);
  setInterval(check,60000);check();
}
