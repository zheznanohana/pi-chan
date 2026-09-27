import './development-tasks.js';
// One deliberate enqueue action; never opens the iframe or changes the source chat.
const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const dialog=make('dialog');dialog.className='task-handoff';dialog.setAttribute('aria-label','交给开发');
const title=make('h2','把想法交给开发'),description=make('p','只转交你确认的任务，不复制整段聊天。任务进入统一后台队列，自动创建开发会话；你可以继续当前聊天。');
const status=make('p');status.setAttribute('role','status');const preview=make('pre');preview.className='handoff-preview';preview.hidden=true;
const field=label=>{const wrap=make('label',label),input=make('textarea');input.setAttribute('aria-label',label);input.rows=3;input.maxLength=5000;wrap.append(input);return{wrap,input}};
const isolationWrap=make('label'),isolation=make('input');isolation.type='checkbox';isolationWrap.append(isolation,make('span','使用独立项目副本（不自动合并）'));
const isolationState=make('small','每个任务使用独立开发会话；项目副本隔离文件修改，但不限制系统权限。');isolationWrap.append(isolationState);
const goal=field('任务目标'),constraints=field('约束与范围'),acceptance=field('验收要求');
const prepare=make('button','预览任务'),confirm=make('button','确认加入后台队列'),close=make('button','关闭');confirm.hidden=true;
const view=make('button','查看后台任务');view.hidden=true;const actions=make('div');actions.className='handoff-actions';actions.append(prepare,confirm,view,close);dialog.append(title,description,goal.wrap,constraints.wrap,acceptance.wrap,isolationWrap,preview,status,actions);document.body.append(dialog);
const launcher=make('button','交给开发');launcher.className='chip-btn';launcher.setAttribute('aria-haspopup','dialog');document.querySelector('.top-actions')?.append(launcher);
let pending=null,sourceSession=null,lastFocus=null,revision=0;
function invalidate(message='任务已变化，请重新预览'){revision++;pending=null;view.hidden=true;confirm.hidden=true;preview.hidden=true;prepare.disabled=false;confirm.disabled=false;if(dialog.open)status.textContent=message;}
for(const input of [goal.input,constraints.input,acceptance.input,isolation])input.addEventListener('input',()=>invalidate());
launcher.onclick=async()=>{lastFocus=document.activeElement;sourceSession=window.piActiveSessionId;invalidate('填写目标，再确认加入后台队列。');if(!goal.input.value)goal.input.value=(String(window.getSelection?.()||'').trim()||document.getElementById('promptInput')?.value||'').slice(0,5000);dialog.showModal();goal.input.focus();};
close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{invalidate('');lastFocus?.focus()});
prepare.onclick=()=>{invalidate('');if(!goal.input.value.trim()){status.textContent='先写清楚要做什么。';return;}if(!sourceSession){status.textContent='当前聊天尚未就绪，请稍后重试。';return;}
 const prompt=['# 开发任务',goal.input.value.trim(),constraints.input.value.trim()?'## 约束与范围\n'+constraints.input.value.trim():'',acceptance.input.value.trim()?'## 验收要求\n'+acceptance.input.value.trim():''].filter(Boolean).join('\n\n');
 if(prompt.length>8000){status.textContent='任务总长度请控制在 8000 字以内。';return;}
 pending={...(isolation.checked?{isolation:'copy'}:{}),prompt,sourceSessionId:sourceSession,projectId:window.piMemoryProjectId||'default',idempotencyKey:crypto.randomUUID(),source:'manual',executionRequested:true};preview.textContent=prompt;preview.hidden=false;confirm.hidden=false;confirm.disabled=false;status.textContent='确认后开始排队；不需要选择或打开开发会话。';};
confirm.onclick=async()=>{if(!pending||pending.sending)return;const body=pending,seq=revision;body.sending=true;confirm.disabled=true;prepare.disabled=true;status.textContent='正在加入后台队列…';try{const{sending,...payload}=body;const task=await window.piDevelopmentTasks.enqueue(payload);window.dispatchEvent(new CustomEvent('pi-handoff-applied',{detail:{...task,taskId:task.id,sourceSessionId:body.sourceSessionId}}));if(seq!==revision)return;pending=null;confirm.hidden=true;status.textContent='已加入后台任务。你可以继续聊天。';view.hidden=false;view.onclick=()=>{dialog.close();window.piDevelopmentTasks.open(task.id)};}catch(e){if(seq!==revision)return;body.sending=false;confirm.disabled=false;status.textContent=e.message+'；重试使用同一个任务凭据，避免重复入队。';}finally{if(seq===revision)prepare.disabled=false;}};
window.addEventListener('pi-session-changed',event=>{invalidate('来源聊天已切换，请重新填写任务。');goal.input.value='';constraints.input.value='';acceptance.input.value='';sourceSession=event.detail?.id||window.piActiveSessionId;});
window.addEventListener('pi-memory-project',()=>invalidate('项目已变化，请重新预览任务。'));

