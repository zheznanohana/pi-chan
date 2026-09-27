// Durable task results are projected into the source chat without starting another agent turn.
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const panel=el('section');panel.className='development-feedback';panel.setAttribute('aria-label','本会话的后台开发反馈');
const style=el('style');style.textContent='.development-feedback{margin:12px 0;padding:10px;border:1px solid var(--studio-line,#ddd);border-radius:10px;min-width:0}.development-feedback h3{font-size:12px;margin:0 0 8px}.development-feedback article{border-top:1px solid var(--studio-line,#ddd);padding:8px 0;font-size:12px;overflow-wrap:anywhere}.development-feedback pre{white-space:pre-wrap;max-height:240px;overflow:auto;font:inherit}.development-feedback button{min-height:32px;border:1px solid var(--studio-line,#ddd);border-radius:6px;background:transparent;color:inherit}.development-feedback small{display:block;opacity:.7}';document.head.append(style);
let source=null,revision=0,tasks=[],error='',renderKey='';
const status={queued:'排队中',running:'后台执行中',cancelling:'正在取消',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'中断'};
function deliverReports(){
 if(source!==window.piActiveSessionId)return;
 for(const task of [...tasks].sort((a,b)=>String(a.finishedAt||a.updatedAt).localeCompare(String(b.finishedAt||b.updatedAt)))){
  if(['completed','failed','cancelled','interrupted'].includes(task.status))window.dispatchEvent(new CustomEvent('pi-development-report',{detail:task}));
 }
}
window.addEventListener('pi-conversation-restored',()=>{void refresh();});
function render(){
 deliverReports();
 const host=document.getElementById('chatHistoryPanel');if(!host)return;if(panel.parentNode!==host)host.append(panel);
 const nextKey=JSON.stringify([source,tasks,error]);if(nextKey===renderKey)return;renderKey=nextKey;
 panel.replaceChildren();panel.hidden=!tasks.length&&!error;
 if(panel.hidden)return;panel.append(el('h3','本会话 · 开发反馈'));
 if(error){panel.append(el('small',error));const retry=el('button','重新读取');retry.onclick=refresh;panel.append(retry);}
 for(const task of tasks.slice(0,20)){
  const card=el('article');card.append(el('strong',task.title||'开发任务'),el('small',status[task.status]||task.status));
  const text=task.result?.text||task.error||task.lastError;
  if(text){const details=el('details'),summary=el('summary','查看结果');details.append(summary,el('pre',String(text)));card.append(details);}
  const open=el('button','查看开发任务');open.onclick=()=>window.piDevelopmentTasks?.open(task.id);card.append(open);panel.append(card);
 }
}
async function refresh(){
 const selected=window.piActiveSessionId||null,version=++revision;if(source!==selected){source=selected;tasks=[];}error='';render();if(!selected)return;
 try{const response=await fetch('/api/development/tasks?sourceSessionId='+encodeURIComponent(selected),{signal:AbortSignal.timeout(6000)});const data=await response.json();if(!response.ok)throw Error(data.error||'后台开发反馈暂未就绪');if(version!==revision||selected!==window.piActiveSessionId)return;tasks=(data.tasks||[]).filter(t=>t.sourceSessionId===selected);render();}
 catch(e){if(version===revision){error='开发反馈读取失败，可稍后重试';render();}}
}
window.addEventListener('pi-chat-source-changed',refresh);
window.addEventListener('pi-runtime-event',({detail})=>{
 if(detail?.type!=='development_task')return;
 const task=detail.payload?.task;if(!task?.id||task.sourceSessionId!==window.piActiveSessionId)return;
 if(source!==task.sourceSessionId){refresh();return;}
 ++revision;tasks=[task,...tasks.filter(t=>t.id!==task.id)];render();
 // A passive UI event, not sendPrompt, agent-message, or a TTS request.
 if(['completed','failed','cancelled','interrupted'].includes(task.status))window.dispatchEvent(new CustomEvent('pi-development-feedback',{detail:{taskId:task.id,sourceSessionId:task.sourceSessionId,status:task.status}}));
});
window.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh();
