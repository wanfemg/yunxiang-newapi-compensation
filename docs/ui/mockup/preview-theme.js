(()=>{
  const root=document.documentElement,system=matchMedia('(prefers-color-scheme: light)');
  let preference=null;try{preference=localStorage.getItem('yunxiang-preview-theme')}catch{}
  if(!['light','dark'].includes(preference))preference=null;
  function apply(theme){root.dataset.theme=theme;const button=document.querySelector('#preview-theme');if(button){button.textContent=theme==='dark'?'☀ 亮色':'☾ 暗色';button.setAttribute('aria-label',theme==='dark'?'切换到亮色主题':'切换到暗色主题')}}
  apply(preference||(system.matches?'light':'dark'));
  const button=document.createElement('button');button.id='preview-theme';button.type='button';button.className='theme-toggle';
  (document.querySelector('.top-actions')||document.querySelector('header')).append(button);
  button.onclick=()=>{preference=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('yunxiang-preview-theme',preference)}catch{}apply(preference)};
  system.addEventListener('change',event=>{if(!preference)apply(event.matches?'light':'dark')});
  apply(root.dataset.theme);
})();
