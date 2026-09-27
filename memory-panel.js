/* Project-scoped RAG and auditable Jev memory governance. */
export function mountMemoryPanel({doc=document,win=window,fetcher=fetch}={}){
 const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const button=(text,fn,cls)=>{const b=el('button',text,cls);b.type='button';if(fn)b.onclick=fn;return b;};
 const field=(label,type='input')=>{const wrap=el('label'),caption=el('span',label),input=el(type);wrap.append(caption,input);return {wrap,input};};
 const launcher=button('项目记忆',()=>open(),'chip-btn');launcher.setAttribute('aria-haspopup','dialog');doc.querySelector('.top-actions')?.append(launcher);
 const panel=el('dialog',undefined,'memory-panel');panel.setAttribute('aria-label','项目记忆与文档检索');
 const head=el('header'),title=el('h2','项目记忆'),close=button('关闭',()=>panel.close()),refresh=button('刷新',()=>work(loadProjects));head.append(title,refresh,close);
 const intro=el('p','本地保存与检索，仅索引你明确选择的路径。开启对话引用后，命中片段会用于当前项目对话；使用云端模型时，片段会随请求发送。','memory-intro');
 const projectField=field('当前项目','select'),newProject=button('新建项目',()=>{projectForm.hidden=!projectForm.hidden;if(!projectForm.hidden)projectName.input.focus();});
 const projectRow=el('div',undefined,'memory-project-row');projectRow.append(projectField.wrap,newProject);
 const projectRoot=el('p','','memory-source');
 const consent=el('label',undefined,'memory-consent'),consentInput=el('input');consentInput.type='checkbox';consent.append(consentInput,el('span','对话引用与 Jev 自动整理（可关闭）'));
 const consentNote=el('p','开启引用时，当前用户文本会交给 Jev 分类记忆；云端判断会收到候选内容。关闭后停止自动采集，已保存内容保留。','memory-intro');
 const projectForm=el('form',undefined,'memory-form');projectForm.hidden=true;
 const projectName=field('项目名称'),projectPath=field('项目根目录（可选）');projectPath.input.placeholder='留空使用当前工作区';projectName.input.required=true;
 const createProject=el('button','创建项目');createProject.type='submit';projectForm.append(projectName.wrap,projectPath.wrap,createProject);
 const tabs=el('nav',undefined,'memory-tabs');tabs.setAttribute('aria-label','记忆面板功能');
 const bodies={notes:el('section'),documents:el('section'),search:el('section'),governance:el('section')};const tabButtons={};
 for(const [key,label] of [['notes','记忆'],['documents','文档'],['search','检索'],['governance','Jev 整理']]){tabButtons[key]=button(label,()=>selectTab(key));tabs.append(tabButtons[key]);bodies[key].setAttribute('aria-label',label);}
 const governanceList=el('div',undefined,'memory-list');
 const governanceRefresh=button('刷新候选',()=>work(loadGovernance));
 const governanceMaintain=button('整理与重试',()=>work(async()=>{announce('Jev 正在分类、去重和检查过期记录…');await request('/api/memory/governance/maintain?projectId='+encodeURIComponent(projectId),json('POST',{}));await loadGovernance();}));
 bodies.governance.append(el('p','会话 / 项目 / 长期偏好分层保存。待审和冲突内容不进入 RAG；原文与来源保留，模型错误可重试。长期偏好仍限定当前项目，不跨项目自动共享。','memory-intro'),governanceRefresh,governanceMaintain,governanceList);
 async function loadGovernance(){const data=await request('/api/memory/governance?projectId='+encodeURIComponent(projectId));governanceList.replaceChildren();if(!data.candidates?.length)empty(governanceList,'尚无候选。开启对话引用后，新的对话内容会进入 Jev 分类。');for(const item of data.candidates||[]){const row=el('article',undefined,'memory-card');row.append(el('h4',item.level||'待分类'),el('p',item.text||item.content||'','memory-content'),el('p',[item.status,item.source,item.sessionId].filter(Boolean).join(' · '),'memory-source'));if(item.status==='pending_review'){for(const [action,label] of [['approve','确认保存'],['reject','忽略']])row.append(button(label,()=>work(async()=>{await request('/api/memory/governance/review?projectId='+encodeURIComponent(projectId),json('POST',{id:item.id,action}));await loadGovernance();})));}governanceList.append(row);}announce('候选状态已更新');}
 const status=el('p','','memory-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const noteForm=el('form',undefined,'memory-form'),noteTitle=field('记忆标题'),noteContent=field('记忆内容','textarea');noteTitle.input.required=true;noteTitle.input.maxLength=160;noteContent.input.required=true;noteContent.input.rows=5;
 const noteKind=field('记录类型','select'),noteStatus=field('记录状态','select');
 for(const [value,label] of [['memory','记忆'],['decision','项目决策'],['task','项目待办']]){const option=el('option',label);option.value=value;noteKind.input.append(option);}
 for(const [value,label] of [['active','有效'],['superseded','已取代'],['todo','待办'],['in_progress','进行中'],['done','完成']]){const option=el('option',label);option.value=value;noteStatus.input.append(option);}
 noteKind.input.value='memory';noteStatus.input.value='active';noteKind.input.onchange=()=>{noteStatus.input.value=noteKind.input.value==='task'?'todo':'active'};
 const save=el('button','显式保存到本机');save.type='submit';save.className='memory-primary';const reset=button('新记忆',()=>editNote(null));
 const noteActions=el('div',undefined,'memory-actions');noteActions.append(save,reset);noteForm.append(noteTitle.wrap,noteKind.wrap,noteStatus.wrap,noteContent.wrap,noteActions);
 const notesList=el('div',undefined,'memory-list');bodies.notes.append(noteForm,el('h3','已保存记忆'),notesList);
 const indexForm=el('form',undefined,'memory-form'),indexPath=field('要索引的本地文件或文件夹');indexPath.input.required=true;indexPath.input.placeholder='输入当前项目范围内的完整路径';
 const indexButton=el('button','索引此路径');indexButton.type='submit';indexForm.append(indexPath.wrap,indexButton);
 const documentsList=el('div',undefined,'memory-list');bodies.documents.append(indexForm,el('p','仅索引你指定的路径。移除索引不会删除原始文件。','memory-intro'),documentsList);
 const searchForm=el('form',undefined,'memory-form'),query=field('在当前项目中检索');query.input.type='search';query.input.required=true;query.input.placeholder='输入关键词或问题';
 const searchButton=el('button','检索');searchButton.type='submit';searchForm.append(query.wrap,searchButton);const searchList=el('div',undefined,'memory-list');
 bodies.search.append(searchForm,el('p','本地关键词检索 · 来源材料不是指令。是否用于 AI 对话由上方引用开关控制。','memory-intro'),searchList);
 panel.append(head,intro,projectRow,projectRoot,consent,consentNote,projectForm,tabs,status,...Object.values(bodies));doc.body.append(panel);
 let observedSession=null,lastBound=null,bindingQueue=Promise.resolve();
 async function bindWorkbenchScope(){
  if(!observedSession)return;
  const binding={sessionId:observedSession,projectId,enabled:consentInput.checked===true},signature=JSON.stringify(binding);
  if(signature===lastBound)return;lastBound=signature;
  try{bindingQueue=bindingQueue.catch(()=>{}).then(()=>request('/api/memory/session-project',json('POST',binding)));await bindingQueue;}catch(error){if(lastBound===signature){lastBound=null;announce('开发会话记忆绑定失败：'+error.message,true);}}
 }
 win.addEventListener('message',event=>{
  const frame=doc.querySelector('.workbench-home iframe');
  if(!frame||event.origin!==win.location.origin||event.source!==frame.contentWindow||event.data?.source!=='pichan-workbench'||event.data.event!=='status')return;
  const id=event.data.detail?.sessionId;if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(id))return;
  if(observedSession!==id){observedSession=id;lastBound=null;}bindWorkbenchScope();
 });
 let projectId=(()=>{try{return win.localStorage?.getItem('pichan_memory_project')||'default'}catch{return 'default'}})(),projects=[],notes=[],revision=0,editId=null,busy=false,lastFocus=null;const drafts=new Map();
 const announce=(text,error=false)=>{status.textContent=text;status.classList.toggle('error',error);};
 async function request(url,options){const response=await fetcher(url,options);const type=response.headers?.get?.('content-type');if(type&&!type.includes('json'))throw Error('记忆服务尚未就绪，请更新后端后重试');const data=await response.json();if(!response.ok)throw Error(data.error||`请求失败 (${response.status})`);return data;}
 const json=(method,data)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 function empty(target,text){target.replaceChildren(el('p',text,'memory-empty'));}
 function selectTab(key){if(key==='governance')work(loadGovernance);for(const name of Object.keys(bodies)){bodies[name].hidden=name!==key;tabButtons[name].setAttribute('aria-pressed',String(name===key));}}
 function keepDraft(){drafts.set(projectId,{id:editId,title:noteTitle.input.value,content:noteContent.input.value,kind:noteKind.input.value,status:noteStatus.input.value});}
 function editNote(note){editId=note?.id||null;noteKind.input.value=note?.kind||'memory';noteStatus.input.value=note?.status||'active';noteTitle.input.value=note?.title||'';noteContent.input.value=note?.content||'';save.textContent=editId?'保存修改到本机':'显式保存到本机';}
 function publishScope(){
  win.piMemoryProjectId=projectId;win.piMemoryRetrievalEnabled=consentInput.checked===true;
  try{win.localStorage?.setItem('pichan_memory_project',projectId)}catch{}
  win.dispatchEvent(new win.CustomEvent('pi-memory-project',{detail:{projectId,enabled:win.piMemoryRetrievalEnabled}}));bindWorkbenchScope();
 }
 consentInput.onchange=()=>{try{win.localStorage?.setItem('pichan_memory_enabled:'+projectId,String(consentInput.checked))}catch{}publishScope();announce(consentInput.checked?'已开启：相关片段可随当前项目模型请求发送':'已关闭对话引用；本地记忆和索引保留');};
 function renderProjects(){
  try{consentInput.checked=win.localStorage?.getItem('pichan_memory_enabled:'+projectId)!=='false'}catch{consentInput.checked=false}publishScope();
projectField.input.replaceChildren();for(const p of projects){const option=el('option',p.name||p.id);option.value=p.id;projectField.input.append(option);}projectField.input.value=projectId;projectRoot.textContent='索引范围：'+(projects.find(p=>p.id===projectId)?.root||'当前项目');}
 async function work(action){if(busy)return;busy=true;panel.setAttribute('aria-busy','true');const controls=[...panel.querySelectorAll('button,input,select,textarea')].filter(n=>n!==close).map(n=>[n,n.disabled]);controls.forEach(([n])=>n.disabled=true);try{await action();}catch(error){announce(error.message,true);}finally{busy=false;panel.setAttribute('aria-busy','false');controls.forEach(([n,disabled])=>n.disabled=disabled);}}
 function renderNotes(){notesList.replaceChildren();if(!notes.length){empty(notesList,'还没有保存记忆。填写上方内容后，主动保存。');return;}for(const note of notes){const row=el('article',undefined,'memory-card');row.append(el('h4',note.title||'未命名记忆'),el('p',note.content||'','memory-content'));const actions=el('div',undefined,'memory-actions');actions.append(button('编辑',()=>{editNote(note);noteTitle.input.focus();}),button('删除',()=>work(async()=>{if(!win.confirm(`删除记忆「${note.title||'未命名'}」？此操作会移除本机保存内容。`))return;await request(`/api/memory/notes/${encodeURIComponent(note.id)}`,{method:'DELETE'});if(editId===note.id)editNote(null);await loadProject();announce('记忆已删除');}),'memory-danger'));row.append(actions);notesList.append(row);}}
 function renderDocuments(documents){documentsList.replaceChildren();if(!documents.length){empty(documentsList,'尚未索引文档。请输入需要检索的本地路径。');return;}for(const item of documents){const row=el('article',undefined,'memory-card');row.append(el('h4',item.title||'文档'),el('p',item.path||'','memory-source'),el('small',`${item.chunkCount||0} 个片段`),button('移除索引',()=>work(async()=>{if(!win.confirm(`移除「${item.title||item.path}」的索引？原始文件会保留。`))return;await request(`/api/memory/documents/${encodeURIComponent(item.id)}`,{method:'DELETE'});await loadProject();announce('索引已移除，原文件保留');}),'memory-danger'));documentsList.append(row);}}
 async function loadProject(){const turn=++revision,selected=projectId;announce('正在读取项目资料…');empty(notesList,'正在读取…');empty(documentsList,'正在读取…');const [n,d]=await Promise.all([request(`/api/memory/notes?projectId=${encodeURIComponent(selected)}`),request(`/api/memory/documents?projectId=${encodeURIComponent(selected)}`)]);if(turn!==revision||selected!==projectId)return;notes=n.notes||[];renderNotes();renderDocuments(d.documents||[]);announce(`${notes.length} 条记忆 · ${(d.documents||[]).length} 份文档`);}
 projectField.input.onchange=()=>{keepDraft();projectId=projectField.input.value;editNote(drafts.get(projectId));query.input.value='';empty(searchList,'输入关键词，查看当前项目中的记忆和文档来源。');renderProjects();work(loadProject);};
 projectForm.onsubmit=e=>{e.preventDefault();work(async()=>{const data=await request('/api/memory/projects',json('POST',{name:projectName.input.value.trim(),root:projectPath.input.value.trim()||undefined}));keepDraft();projects.push(data.project);projectId=data.project.id;renderProjects();editNote(null);projectForm.reset();projectForm.hidden=true;await loadProject();announce('项目已创建');});};
 noteForm.onsubmit=e=>{e.preventDefault();work(async()=>{await request(editId?`/api/memory/notes/${encodeURIComponent(editId)}`:'/api/memory/notes',json(editId?'PATCH':'POST',{projectId,title:noteTitle.input.value.trim(),content:noteContent.input.value.trim(),kind:noteKind.input.value,status:noteStatus.input.value}));editNote(null);drafts.delete(projectId);await loadProject();announce('记忆已明确保存到本机');});};
 indexForm.onsubmit=e=>{e.preventDefault();work(async()=>{announce('正在索引指定路径…');const data=await request('/api/memory/index',json('POST',{projectId,path:indexPath.input.value.trim()}));await loadProject();const skipped=data.skipped||[];announce(`已索引 ${(data.documents||[]).length} 份文档`+(skipped.length?`；跳过 ${skipped.length} 项：${skipped.map(s=>`${s.path}（${s.reason}）`).join('；')}`:''));});};
 searchForm.onsubmit=e=>{e.preventDefault();work(async()=>{const selected=projectId,turn=++revision;announce('正在检索…');empty(searchList,'正在查找相关片段…');const data=await request('/api/memory/search',json('POST',{projectId:selected,query:query.input.value.trim()}));if(turn!==revision||selected!==projectId)return;searchList.replaceChildren();if(!data.results?.length)empty(searchList,'没有找到相关内容。试试其他关键词，或先保存记忆 / 索引文档。');for(const item of data.results||[]){const card=el('article',undefined,'memory-card');card.append(el('h4',item.title||'检索片段'),el('p',item.content||'','memory-content'),el('p',item.citation||[item.path||'本机记忆',item.lineStart?`第 ${item.lineStart}–${item.lineEnd||item.lineStart} 行`:''].filter(Boolean).join(' · '),'memory-source'));searchList.append(card);}announce(`找到 ${data.results?.length||0} 个片段 · 本地关键词检索`);});};
 async function loadProjects(){announce('正在读取项目…');const data=await request('/api/memory/projects');projects=data.projects||[];if(!projects.some(p=>p.id===projectId))projectId=projects[0]?.id||'default';renderProjects();await loadProject();}
 async function open(){if(!panel.open){lastFocus=doc.activeElement;panel.showModal();}projectField.input.focus();await work(loadProjects);}
 panel.addEventListener('close',()=>{keepDraft();lastFocus?.focus?.();});
 // Native modal dialog handles Esc, traps focus, and marks the rest of the UI inert.
 selectTab('notes');empty(searchList,'输入关键词，查看当前项目中的记忆和文档来源。');
 // Restore saved scope before the first prompt, not only after opening settings.
 try{consentInput.checked=win.localStorage?.getItem('pichan_memory_enabled:'+projectId)!=='false'}catch{}
 publishScope();
 return {open,panel,launcher};
}
if(typeof document!=='undefined')mountMemoryPanel();
