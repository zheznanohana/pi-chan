// Consolidate existing controls; keep their original handlers and live state.
const make=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
const bar=document.querySelector('.top-actions');
if(bar){
 document.body.classList.add('simplified-studio');
 const group=(name)=>{const root=make('details');root.className='studio-action-group';const summary=make('summary',name),content=make('div');content.className='studio-action-popover';root.append(summary,content);bar.append(root);return{root,summary,content};};
 const tasks=group('任务'),more=group('更多');
 const settings=make('button','语音设置');settings.type='button';settings.onclick=()=>document.getElementById('voiceSettingsBtn')?.click();more.content.append(settings);
 const mcpBtn=make('button','外部连接');mcpBtn.type='button';mcpBtn.id='studioMcpBtn';mcpBtn.onclick=()=>window.mcpPanel?.open();more.content.append(mcpBtn);
 window.addEventListener('pichan_mcp_event',e=>{const p=e.detail?.payload;if(p?.toolsCount!==undefined)mcpBtn.textContent=`外部连接 (${p.toolsCount} 工具)`;});
 const diagnostics=make('details');diagnostics.className='studio-system-details';diagnostics.append(make('summary','连接与 Jev 状态'));more.content.append(diagnostics);
 const dictation=document.querySelector('.workbench-dictation');if(dictation){dictation.classList.add('studio-dev-only');dictation.textContent='开发语音输入';more.content.insertBefore(dictation,diagnostics);}
 const groups=[tasks,more];
 for(const g of groups){g.root.addEventListener('toggle',()=>{if(g.root.open)for(const other of groups)if(other!==g)other.root.open=false;});g.content.addEventListener('click',event=>{if(event.target.closest('button'))g.root.open=false;});}
 document.addEventListener('click',event=>{for(const g of groups)if(!g.root.contains(event.target))g.root.open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const g of groups)if(g.root.open){g.root.open=false;g.summary.focus();event.preventDefault();}});
 function arrange(){
  for(const node of [...bar.children]){
   if(node.matches('.workspace-mode-switch')){if(bar.firstElementChild!==node)bar.prepend(node);continue;}
   if(node.id==='harnessBadge'||node.id==='jevDirectorBadge'){diagnostics.append(node);continue;}
   if(node.id==='mcpTopBadge'){node.style.display='none';continue;}
   if(node.tagName!=='BUTTON')continue;
   const label=node.textContent.trim();
   if(['后台任务','定时任务','交给开发'].includes(label)){tasks.content.append(node);continue;}
   if(label==='外部连接'||label==='项目记忆'||node.id==='viewToggleBtn'||node.getAttribute('aria-label')==='切换人物取景'||label.includes('MCP')){more.content.insertBefore(node,diagnostics);}
  }
 }
 const observer=new MutationObserver(arrange);observer.observe(bar,{childList:true});arrange();
 window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
}
const model=document.querySelector('.chat-model-picker');
if(model){const fold=make('details');fold.className='studio-model-options';const summary=make('summary','模型与语音');fold.append(summary);model.before(fold);fold.append(model);}
const runtime=document.querySelector('.runtime-panel');
if(runtime){const toggle=make('button','详细状态');toggle.type='button';toggle.className='studio-detail-toggle';toggle.setAttribute('aria-pressed','false');toggle.onclick=()=>{const expanded=runtime.classList.toggle('show-all-status');toggle.setAttribute('aria-pressed',String(expanded));toggle.textContent=expanded?'收起详情':'详细状态';};runtime.querySelector('header')?.append(toggle);}
