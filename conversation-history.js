import './development-feedback.js';
import './development-history.js';
import './bot-conversations.js?v=20260923-write-1';
// Real Pi sessions and observed tool/agent activity; no seeded conversation entries.
const list=document.getElementById('historyList'),notice=document.getElementById('historyNotice');
let activeId=null, loadedInitial=false, refreshRevision=0;
async function request(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;}
async function refresh(){
 const revision=++refreshRevision;
 try{const data=await request('/api/sessions');if(revision!==refreshRevision)return;activeId=data.activeId;window.piActiveSessionId=activeId;window.dispatchEvent(new CustomEvent('pi-chat-source-changed',{detail:{sessionId:activeId}}));list.replaceChildren();
  for(const session of data.sessions){const button=document.createElement('button');button.className='history-item'+(session.id===activeId?' active':'');button.textContent=session.title;button.title=session.title;button.setAttribute('aria-current',String(session.id===activeId));button.onclick=()=>switchSession(session.id);
   const row=document.createElement('div');row.className='companion-history-row';
   const remove=document.createElement('button');remove.className='history-delete';remove.type='button';remove.title='删除对话';remove.setAttribute('aria-label','删除对话：'+session.title);
   remove.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
   remove.onclick=async()=>{if(remove.disabled||!window.confirm(`删除对话「${session.title}」？本地记录将移入回收目录，项目文件和记忆保留。`))return;remove.disabled=true;try{
    const result=await request('/api/sessions/'+encodeURIComponent(session.id),{method:'DELETE'});
    if(result.switched){loadedInitial=true;window.restoreConversation?.(result.messages||[]);}await refresh();
   }catch(error){notice.textContent=error.message;}finally{remove.disabled=false;}};
   row.append(button,remove);list.append(row);}
  window.piBotHistory?.renderInto(list);
  notice.textContent=data.sessions.length?'历史保存在本机':'还没有对话';
  if(!loadedInitial&&activeId&&!data.isStreaming){
   const selected=activeId;const current=await request(`/api/sessions/${encodeURIComponent(selected)}`);
   if(revision===refreshRevision&&selected===activeId&&!current.isStreaming){window.restoreConversation?.(current.messages||[]);loadedInitial=true;}
  }
 }catch(error){notice.textContent='历史服务：'+error.message;}
}
async function switchSession(id){window.piBotHistory?.hide();try{window.piWorkbench?.showCompanion();
 const data=id===activeId?await request(`/api/sessions/${id}`):await request(`/api/sessions/${id}/switch`,{method:'POST'});
 loadedInitial=true;window.restoreConversation?.(data.messages||[]);await refresh();
 }catch(error){notice.textContent=error.message;}
}
document.getElementById('newConversationBtn').onclick=async()=>{window.piBotHistory?.hide();try{window.piWorkbench?.showCompanion();const data=await request('/api/sessions',{method:'POST'});loadedInitial=true;window.restoreConversation?.(data.messages||[]);await refresh();}catch(error){notice.textContent=error.message;}};
document.getElementById('historyRefreshBtn').onclick=()=>{window.piBotHistory?.refresh();if(window.piHistory?.getMode()!=='development')refresh();};
window.addEventListener('pi-session-changed',event=>{loadedInitial=true;activity.clear();renderActivity();window.restoreConversation?.(event.detail.messages||[]);refresh();});
window.addEventListener('pi-sessions-changed',refresh);
const activity=new Map();
window.addEventListener('pi-live-event',event=>{
 const e=event.detail||{};
 if(e.type==='agent_end'){for(const item of activity.values())if(item.status==='运行中')item.status='已结束';renderActivity();}
 if(e.type==='agent_start'){activity.clear();renderActivity();}
 if(!/^tool_(execution_|call_)(start|update|end)$/.test(e.type)&&!/^subagent_/.test(e.type))return;
 const id=e.toolCallId||e.agentId||e.id;if(!id)return;
 const item=activity.get(id)||{name:e.toolName||e.agentName||e.name||'工具',detail:'',status:'运行中'};
 if(/_end$/.test(e.type))item.status=e.isError?'出错':'完成';
 const results=e.partialResult?.details?.results||e.result?.details?.results;
 if(Array.isArray(results))for(const r of results){if(r.agent||r.agentName){activity.set(`${id}:${r.agent||r.agentName}`,{name:r.agent||r.agentName,status:r.error||(typeof r.exitCode==='number'&&r.exitCode!==0)?'出错':r.exitCode===0?'完成':item.status,detail:String(r.task||r.status||'').slice(0,100)});}}
 item.detail=String(e.args?.task||e.args?.description||e.partialResult?.content?.find(c=>c.type==='text')?.text||item.detail).slice(-120);
 activity.set(id,item);renderActivity();
});
function renderActivity(){const target=document.getElementById('agentActivity');target.replaceChildren();
 if(!activity.size){const empty=document.createElement('p');empty.className='runtime-note';empty.textContent='暂无子 Agent 或工具活动';target.append(empty);return;}
 for(const item of [...activity.values()].slice(-8)){const row=document.createElement('div');row.className='agent-activity';const title=document.createElement('strong');title.textContent=item.name;const badge=document.createElement('small');badge.textContent=item.status;row.append(title,badge);if(item.detail){const detail=document.createElement('p');detail.textContent=item.detail;row.append(detail);}target.append(row);}
}
refresh();renderActivity();


