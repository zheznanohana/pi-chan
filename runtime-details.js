import './development-tasks.js';
// Actual tool results and Jev telemetry, not predicted file changes.
const panel=document.querySelector('.runtime-panel');
function section(title){const box=document.createElement('section');box.className='runtime-details';const h=document.createElement('h3');h.textContent=title;const body=document.createElement('div');box.append(h,body);panel?.append(box);return body;}
const files=section('文件修改'),jev=section('Jev 判断'),memory=section('项目记忆引用'),skills=section('本轮技能');
skills.textContent='按任务自动选择 · 最多 3 个';
memory.textContent='未引用记忆';
const pending=new Map(),changes=new Map();let jevState='等待判断事件';
function renderFiles(){files.replaceChildren();if(!changes.size){files.textContent='暂无工具记录的文件修改';return;}for(const [path,status]of [...changes].slice(-12)){const row=document.createElement('div');row.className='runtime-file';const name=document.createElement('span');name.textContent=path;name.title=path;const tag=document.createElement('small');tag.textContent=status;row.append(name,tag);files.append(row);}}
function paths(e){const a=e.args||e.arguments||{};const result=[];if(/^(write|edit|edit_soft|write_file|edit_file)$/.test(e.toolName||'')){const p=a.path||a.file_path||a.filePath;if(typeof p==='string')result.push(p);}if(e.toolName==='apply_patch'){const patch=a.patch||a.input||'';for(const match of String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))result.push(match[1]);}return result;}
window.addEventListener('pi-live-event',({detail:e})=>{
 const id=e.toolCallId||e.id;
 if(/^tool_(execution_|call_)start$/.test(e.type)){const p=paths(e);if(p.length){pending.set(id,p);for(const path of p)changes.set(path,'修改中');renderFiles();}}
 if(/^tool_(execution_|call_)end$/.test(e.type)&&pending.has(id)){for(const p of pending.get(id))changes.set(p,e.isError?'失败':'已修改');pending.delete(id);renderFiles();}
 if(e.type==='agent_end'){for(const ps of pending.values())for(const p of ps)changes.set(p,'结果未确认');pending.clear();renderFiles();}
 if(e.type==='extension_ui_request'&&e.method==='setStatus'&&e.statusKey==='jev'){jevState=e.statusText||'状态未提供';jev.textContent=jevState;}
});
window.addEventListener('pi-runtime-event',({detail:{type,payload:p}})=>{
 if(type==='agent_status'&&p.jevStatus){jevState=p.jevStatus;jev.textContent=jevState;}
 if(p.sessionId&&window.piActiveSessionId&&p.sessionId!==window.piActiveSessionId)return;
 if(type==='jev_decision'){
  const c=p.companion,styles={listen:'先倾听',celebrate:'一起开心',chat:'轻松聊天',technical:'认真处理'},lengths={brief:'简短',normal:'适中',detailed:'详细'};
  jev.textContent=['任务分流：'+(p.tier||'未提供'),typeof p.confidence==='number'?'置信度 '+Math.round(p.confidence*100)+'%':'',c?.usable?`${styles[c.responseStyle]||c.responseStyle} · ${lengths[c.verbosity]||c.verbosity}`:'',Number.isFinite(p.latencyMs)?`${p.latencyMs}ms`:''].filter(Boolean).join(' · ');
  if(c?.usable&&c.expiresAt>Date.now()){
   // Acknowledge the user's affect without mirroring distress as an angry pose.
   const mood=c.emotion==='happy'?'happy':'neutral';
   window.live2d?.applyJevEmotion(mood,c.confidence);
   window.soullinkEmotion?.applyJevDecision({mood,intensity:c.emotion==='happy'?.5:.2,urgency:'normal'});
  }
 }
 if(type==='skills_selected')skills.textContent=p.selected?.length?p.selected.map(x=>x.id).join(' · '):p.status==='unavailable'?'技能判断暂未就绪 · 本轮未加载':'本轮无需额外技能';
 if(type==='memory_retrieval')memory.textContent=p.count?`本轮命中 ${p.count} 条 · ${p.sources.join(' · ')}`:'本轮无相关记忆';
 if(type==='jev_tools')jev.textContent=p.status==='ready'?`本轮工具：${p.selectedTools?.join('、')||'无 · 直接聊天'}${p.route==='development'?' · 建议交给开发':''}`:'工具判断暂未就绪 · 保留现有配置';
 if(type==='jev_judgment'){jev.textContent=p.status==='evaluating'?'正在判断…':p.status==='error'?'判断服务未就绪 / 本次判断失败':p.status;}
});
window.addEventListener('pi-session-changed',e=>{window.piActiveSessionId=e?.detail?.id;pending.clear();changes.clear();renderFiles();jev.textContent='等待当前对话判断';memory.textContent='未引用记忆';skills.textContent='按任务自动选择 · 最多 3 个';});
renderFiles();jev.textContent=jevState;

// Queue state is owned by development-tasks; this is a read-only projection.
const development=section('开发近况');
const developmentLabels={queued:'排队中',running:'执行中',cancelling:'正在取消',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断 · 待核实'};
let developmentSignature='';
function renderDevelopmentTasks(items){
 const tasks=(Array.isArray(items)?items:[]).filter(t=>t&&typeof t.id==='string');
 tasks.sort((a,b)=>{
  const active=t=>['queued','running','cancelling'].includes(t.status)?1:0;
  return active(b)-active(a)||String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''));
 });
 const signature=JSON.stringify(tasks.slice(0,6).map(t=>[t.id,t.title,t.status,t.uncertaintyAcknowledgedAt]));
 if(signature===developmentSignature)return;developmentSignature=signature;
 development.replaceChildren();
 if(!tasks.length){development.textContent='暂无后台开发任务';return;}
 for(const task of tasks.slice(0,6)){
  const row=document.createElement('div');row.className='runtime-development-task';
  const title=document.createElement('span');title.textContent=task.title||'开发任务';title.title=title.textContent;
  const badge=document.createElement('small');badge.textContent=task.status==='interrupted'&&task.uncertaintyAcknowledgedAt?'已中断 · 已核实':developmentLabels[task.status]||'状态待核实';
  const view=document.createElement('button');view.type='button';view.textContent='查看';view.setAttribute('aria-label','查看开发任务：'+title.textContent);
  view.onclick=()=>window.piDevelopmentTasks.open(task.id);
  row.append(title,badge,view);development.append(row);
 }
}
const runtimeDevelopmentCss=document.createElement('style');
runtimeDevelopmentCss.textContent='.runtime-development-task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:7px 0;border-bottom:1px solid var(--studio-line,#ddd)}.runtime-development-task>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;grid-column:1}.runtime-development-task>small{grid-column:1;color:var(--studio-muted,#666);font-size:11px}.runtime-development-task>button{grid-column:2;grid-row:1/3;align-self:center;min-height:32px;border:1px solid var(--studio-line,#ddd);border-radius:6px;background:transparent;color:inherit;padding:4px 8px}.runtime-development-task>button:focus-visible{outline:2px solid var(--studio-blue,#2754a0);outline-offset:2px}';
document.head.append(runtimeDevelopmentCss);
const stopDevelopmentSubscription=window.piDevelopmentTasks.subscribe(renderDevelopmentTasks);
renderDevelopmentTasks(window.piDevelopmentTasks.getTasks());
window.addEventListener('pagehide',()=>stopDevelopmentSubscription(),{once:true});
