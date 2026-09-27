import './development-tasks.js';
import {VoiceUIController} from './voice-ui.js';
// The upstream workbench is loaded on demand, without replacing the companion runtime.
const modes=document.createElement('div');modes.className='workspace-mode-switch';modes.setAttribute('role','group');modes.setAttribute('aria-label','首页模式');
const companion=document.createElement('button'),opener=document.createElement('button');companion.textContent='陪伴';opener.textContent='开发';companion.setAttribute('aria-pressed','true');opener.setAttribute('aria-pressed','false');modes.append(companion,opener);document.querySelector('.top-actions')?.append(modes);
const sheet=document.createElement('section');sheet.className='workbench-home';sheet.hidden=true;sheet.setAttribute('aria-label','开发工作区');
const bar=document.createElement('header'),state=document.createElement('span'),retry=document.createElement('button');state.textContent='按需启动';state.setAttribute('role','status');retry.textContent='重试连接';retry.hidden=true;retry.className='chip-btn';bar.append(state,retry);
const dictationButton=document.createElement('button');dictationButton.className='chip-btn workbench-dictation';dictationButton.textContent='语音输入';dictationButton.setAttribute('aria-pressed','false');dictationButton.title='只填入当前开发会话草稿，不自动发送';bar.append(dictationButton);
const mcpButton=document.createElement('button');mcpButton.className='chip-btn workbench-mcp';mcpButton.textContent='MCP 工具';mcpButton.title='查看与管理已连接的 MCP 工具及上下文资源';mcpButton.onclick=()=>window.mcpPanel?.open('tools');bar.append(mcpButton);
const dictationStatus=document.createElement('span');dictationStatus.className='dictation-status';dictationStatus.setAttribute('role','status');bar.append(dictationStatus);
const frame=document.createElement('iframe');frame.title='Pi 开发工作台';frame.hidden=true;sheet.append(bar,frame);document.body.append(sheet);
function setMode(development){if(!development)stopDictation(false);else window.voiceUI?.stopVoiceMode();document.body.classList.toggle('workbench-mode',development);sheet.hidden=!development;companion.setAttribute('aria-pressed',String(!development));opener.setAttribute('aria-pressed',String(development));window.piHistory?.show(development?'development':'chat');}
companion.onclick=()=>setMode(false);
const statusBox=document.createElement('div');statusBox.className='workbench-status';statusBox.textContent='开发工作台尚未启动';document.querySelector('.runtime-panel')?.append(statusBox);
const summary=document.createElement('div'),cards=document.createElement('div');statusBox.replaceChildren(summary,cards);summary.textContent='开发工作台尚未启动';
let pending=false,started=false;
opener.onclick=async()=>{setMode(true);window.piDevelopmentTasks.refresh();if(started||pending)return;pending=true;state.textContent='正在启动工作台…';retry.hidden=true;try{const response=await fetch('/api/workbench/start',{method:'POST'});const data=await response.json();if(!response.ok||!data.ready)throw Error(data.error||'工作台尚未就绪');frame.src='/workbench/';frame.hidden=false;started=true;bar.hidden=true;state.textContent='连接中';}catch(error){state.textContent=error.message;retry.hidden=false;bar.hidden=false;}finally{pending=false;}};
let inspectedTaskId=null;
async function inspectTask(task){
 if(!task?.id)throw Error('任务标识缺失');
 const response=await fetch('/api/development/tasks/'+encodeURIComponent(task.id));const data=await response.json();if(!response.ok)throw Error(data.error||'任务读取失败');
 const actual=data.task;if(!actual||actual.id!==task.id)throw Error('任务响应标识不匹配');const link=actual.link||actual.result;
 if(!link?.workbenchClientId||!link.conversationId){window.piDevelopmentTasks.open(task.id);return;}
 await opener.onclick();if(!started)throw Error('工作台尚未连接');
 stopDictation(false);inspectedTaskId=actual.id;dictationButton.disabled=['queued','running','cancelling'].includes(actual.status);frame.src='/workbench/?pichanTaskId='+encodeURIComponent(actual.id);state.textContent='正在连接任务的真实开发会话…';
}
window.piWorkbench={open:()=>opener.onclick(),showCompanion:()=>setMode(false),inspectTask,openTask:inspectTask,openMcp:()=>window.mcpPanel?.open()};
window.piDevelopmentTasks.subscribe(tasks=>{const current=tasks.find(t=>t.id===inspectedTaskId);if(current)dictationButton.disabled=['queued','running','cancelling'].includes(current.status)});
window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.source!=='pichan-workbench')return;
 const {event:kind,detail={}}=event.data;
 if(kind==='open-task'&&typeof detail.taskId==='string'){void inspectTask({id:detail.taskId}).catch(error=>{bar.hidden=false;state.textContent=error.message;});return;}
 if(kind==='history-error'){bar.hidden=false;state.textContent=detail.message||'任务查看失败，请重试';}
 if(detail.token===dictationToken){
  if(kind==='dictation-ready')beginResolve?.();
  if(kind==='dictation-applied'){pendingAppends=Math.max(0,pendingAppends-1);dictationStatus.textContent='已填入草稿，请检查后手动发送';if(asrFinished&&pendingAppends===0)stopDictation(false);}
  if(kind==='dictation-error'||kind==='dictation-invalidated'){beginReject?.(Error(detail.message||'会话已变化，请重新开始语音输入'));stopDictation(false);dictationStatus.textContent=detail.message||'会话已变化，已停止语音输入';}
 }
 if(kind==='connection'){bar.hidden=!!detail.connected;state.textContent=detail.connected?'已连接':'连接断开';summary.textContent='工作台 · '+state.textContent;retry.hidden=!!detail.connected;}
 if(kind==='status'){state.textContent=detail.isStreaming?'正在执行':'已连接 · 待机';summary.textContent='工作台 · '+state.textContent;}
 if(kind==='conversations'&&Array.isArray(detail.conversations)){
  cards.replaceChildren();const title=document.createElement('strong');title.textContent='工作台会话';cards.append(title);
  for(const c of detail.conversations.slice(0,12)){const row=document.createElement('div');row.className='activity-item';row.textContent=(c.isSubagent?'子 Agent · ':'')+String(c.name||c.title||c.id||'会话')+' · '+(c.error?'出错':c.canceled?'已取消':c.isStreaming?'运行中':'待机');cards.append(row);}
  if(!detail.conversations.length)cards.append(document.createTextNode('暂无运行会话'));
 }
});

retry.onclick=()=>{started=false;opener.click();};
// Header controls wrap at smaller widths; never put the development conversation
// underneath a hard-coded 78px/150px header offset.
const navigation=document.querySelector('.top-nav');
if(navigation){const measure=()=>document.documentElement.style.setProperty('--workbench-top',`${Math.ceil(navigation.getBoundingClientRect().bottom)}px`);const observer=new ResizeObserver(measure);observer.observe(navigation);measure();window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});}

// Isolated dictation reuses only capture/resampling, never VoiceUI auto-send/TTS.
let dictation=null,dictationToken=null,beginResolve=null,beginReject=null,finishingTimer=null,pendingAppends=0,asrFinished=false;
function sendDictation(command,text){frame.contentWindow?.postMessage({source:'pichan-dictation',command,token:dictationToken,text},location.origin);}
function stopDictation(flush=false){
 const current=dictation;if(!current)return;
 if(flush&&current.isRecording){current.stopMicRecording(true);dictationButton.disabled=true;dictationStatus.textContent='正在收尾识别…';finishingTimer=setTimeout(()=>{stopDictation(false);dictationStatus.textContent='收尾识别超时，部分末尾语音可能未填入；已填草稿保留，请检查';},10000);return;}
 clearTimeout(finishingTimer);sendDictation('cancel');dictationToken=null;dictation=null;
 current.stopMicRecording(false);current.wsReady=false;
 if(current.ws){current.ws.onclose=null;current.ws.onmessage=null;current.ws.close();}
 clearTimeout(current.reconnectTimer);beginReject?.(Error('语音输入已结束'));beginResolve=beginReject=null;
 window.piShared?.update({captureOwner:null});dictationButton.disabled=false;dictationButton.setAttribute('aria-pressed','false');dictationButton.textContent='语音输入';
}
async function startDictation(){
 if(!started||frame.hidden){dictationStatus.textContent='请等待开发工作台连接';return;}
 const current=new VoiceUIController();dictation=current;pendingAppends=0;asrFinished=false;dictationToken=crypto.randomUUID();const token=dictationToken;
 current.connectWebSocket=()=>{}; // No reconnect loop, playback path, or global DOM binding.
 current.setStatus=text=>{if(dictation===current)dictationStatus.textContent=text};
 current.showNotice=text=>{if(dictation===current)dictationStatus.textContent=text};
 current.log=()=>{};
 const prefs=(()=>{try{return JSON.parse(localStorage.getItem('pichan_voice_settings')||'{}')}catch{return {}}})();
 current.inputDeviceId=prefs.inputDeviceId||'default';
 current.currentAsrProvider=prefs.asrProvider==='token-plan'?'token-plan':'local';
 current.asrProviderSent=null;current.asrProviderConfirmed=null;
 dictationButton.textContent='取消语音';dictationButton.setAttribute('aria-pressed','true');dictationStatus.textContent='准备语音输入…';
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('开发会话尚未响应，请重试')),3500);beginResolve=()=>{clearTimeout(timer);beginResolve=beginReject=null;resolve()};beginReject=error=>{clearTimeout(timer);beginResolve=beginReject=null;reject(error)};sendDictation('begin');});
  if(dictation!==current)return;
  window.voiceUI?.stopVoiceMode();window.piShared?.update({captureOwner:'dashboard'});
  const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/audio`);current.ws=ws;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('语音识别连接超时')),6000);
   ws.onopen=()=>{current.wsReady=true;};
   ws.onerror=()=>{clearTimeout(timer);reject(Error('语音识别连接失败'));};
   ws.onclose=()=>{clearTimeout(timer);reject(Error('语音识别连接断开'));if(dictation===current){stopDictation(false);dictationStatus.textContent='语音连接断开，请重试';}};
   ws.onmessage=event=>{
    if(dictation!==current||dictationToken!==token||typeof event.data!=='string')return;
    let message;try{message=JSON.parse(event.data)}catch{return;}
    if(message.type==='asr_ready'){
     current.asrProviderConfirmed=message.provider||'local';
     if(current.asrProviderSent!==current.currentAsrProvider)current.setAsrProvider(current.currentAsrProvider);
     current.asrAvailable=current.asrProviderConfirmed===current.currentAsrProvider;
     if(current.asrAvailable){clearTimeout(timer);resolve();}else dictationStatus.textContent='正在确认识别服务…';
    }
    else if(message.type==='asr_partial'&&current.asrAvailable)dictationStatus.textContent=message.text||'正在识别…';
    else if(message.type==='asr_final'&&current.asrAvailable){
     if(message.text?.trim()){pendingAppends++;sendDictation('append',message.text);dictationStatus.textContent='正在填入草稿…';}
    }else if(message.type==='asr_finished'){
     asrFinished=true;if(pendingAppends===0)stopDictation(false);
    }else if(message.type==='asr_error'){clearTimeout(timer);reject(Error(message.error||'语音识别失败'));stopDictation(false);dictationStatus.textContent=message.error||'语音识别失败，请重试';}
   };
  });
  if(dictation!==current)return;
  await current.startMicRecording();
  if(dictation!==current)return;
  if(!current.isRecording)throw Error('麦克风权限未授予或设备不可用，请检查语音设置后重试');
  dictationButton.textContent='停止并填入';dictationStatus.textContent=current.currentAsrProvider==='token-plan'?'本地预览 · 句尾录音发送套餐识别 · 不自动发送草稿':'本地实时听写 · 不会自动发送';
 }catch(error){if(dictation===current){stopDictation(false);dictationStatus.textContent=error.message;}}
}
dictationButton.onclick=()=>{if(dictation)stopDictation(true);else startDictation();};
frame.addEventListener('load',()=>{if(dictation)stopDictation(false);});
window.addEventListener('pagehide',()=>stopDictation(false));
