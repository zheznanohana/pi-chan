/* Observe only the real workbench wire events. Explicit confirmed handoffs submit to the real workbench; dictation remains draft-only. */
(() => {
  function applyDefaultTheme(){
    try{
      if(localStorage.getItem('pi-web-ui:theme')!==null)return;
      const link=document.createElement('link');link.rel='stylesheet';link.href='/workbench/pichan-theme.css';link.id='pichan-workbench-theme';document.head.appendChild(link);
      const watch=new MutationObserver(records=>{const themeChanged=records.some(r=>r.target?.id==='theme-stylesheet'||[...r.addedNodes,...r.removedNodes].some(n=>n.id==='theme-stylesheet'));if(themeChanged||localStorage.getItem('pi-web-ui:theme')!==null){link.remove();watch.disconnect();}});watch.observe(document.head,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
    }catch{}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyDefaultTheme,{once:true});else applyDefaultTheme();
  let context={sessionId:null,conversationId:null,isStreaming:false,cwd:null}, dictation=null, handoff=null, wire=null, history=null, selection=null, submission=null;
  const usedHandoffs=new Set();
  const scope=()=>`${context.conversationId||''}:${context.sessionId||''}`;
  function invalidate(){if(handoff){publish('handoff-invalidated',{token:handoff.token});handoff=null;}if(dictation){publish('dictation-invalidated',{token:dictation.token});dictation=null;}}
  function updateContext(state){const before=scope();for(const key of ['sessionId','conversationId','isStreaming','cwd','model','queue','rev','messages','errorMessage'])if(Object.prototype.hasOwnProperty.call(state,key))context[key]=state[key];if(scope()!==before)invalidate();}
  function finishSelection(error){if(!selection)return;const pending=selection;selection=null;clearTimeout(pending.timer);publish(error?'history-error':'history-selected',{requestId:pending.requestId,conversationId:context.conversationId,sessionId:context.sessionId,...(error?{message:error}:{})});}
  window.addEventListener('message',event=>{
    if(event.source!==window.parent||event.origin!==location.origin)return;
    const msg=event.data||{};
    if(taskId&&taskLocked&&msg.source==='pichan-handoff'){publish('handoff-error',{token:msg.token,message:'后台任务运行中，当前会话只读'});return;}
    if(msg.source==='pichan-history'){
      if(typeof msg.requestId!=='string'||!msg.requestId||msg.requestId.length>100)return;
      if(!wire||wire.readyState!==NativeWebSocket.OPEN){publish('history-error',{requestId:msg.requestId,message:'开发工作台未连接'});return;}
      if(msg.command==='refresh'){
        if(history)publish('conversations',{...history,cached:true,requestId:msg.requestId});
        wire.send(JSON.stringify({type:'get_state'}));return;
      }
      if(msg.command==='select-task'){
        const local=history?.conversations?.find(x=>x.id===msg.conversationId);
        const remote=history?.elsewhere?.find(x=>x.convId===msg.conversationId&&x.owner===msg.workbenchClientId);
        if(local){msg.command='select';}
        else if(!remote){publish('history-error',{requestId:msg.requestId,message:'工作台尚未返回此任务会话，请刷新；不会重新执行任务'});return;}
        else if(remote.isStreaming||msg.takeOver!==true){publish('history-inspected',{requestId:msg.requestId,conversationId:remote.convId,workbenchClientId:remote.owner,title:remote.title,cwd:remote.cwd,isStreaming:remote.isStreaming,canTakeOver:!remote.isStreaming,message:remote.isStreaming?'任务正在原工作台会话执行，仅查看状态，不接管':'任务已空闲，可明确确认后接管此会话'});return;}
        else{
          if(selection||submission){publish('history-error',{requestId:msg.requestId,message:'已有切换或派发正在进行'});return;}
          selection={requestId:msg.requestId,conversationId:msg.conversationId,timer:setTimeout(()=>finishSelection('任务会话接管未确认，请刷新查看，不要重复运行'),8000)};
          wire.send(JSON.stringify({type:'take_over_conversation',owner:remote.owner,id:remote.convId}));return;
        }
      }
      if(msg.command!=='select')return;
      const item=history?.conversations?.find(x=>x.id===msg.conversationId);
      if(!item||!context.cwd||item.cwd!==context.cwd){publish('history-error',{requestId:msg.requestId,message:'目标不在当前项目已确认开发会话列表，请在工作台切换项目'});return;}
      if(selection){publish('history-error',{requestId:msg.requestId,message:'已有会话切换正在确认'});return;}
      selection={requestId:msg.requestId,conversationId:msg.conversationId,timer:setTimeout(()=>finishSelection('开发会话切换未确认，请重试'),8000)};
      wire.send(JSON.stringify({type:'switch_conversation',id:msg.conversationId}));return;
    }
    if(msg.source==='pichan-handoff')publish('handoff-error',{token:msg.token,message:'旧直连派发入口已停用，请使用统一后台任务队列'});
  });
  window.addEventListener('message',event=>{
    if(event.source!==window.parent||event.origin!==location.origin||event.data?.source!=='pichan-dictation')return;
    const {command,token,text}=event.data;
    if(taskId&&taskLocked){publish('dictation-error',{token,message:'后台任务运行中，当前会话只读'});return;}
    if(typeof token!=='string'||token.length>100)return;
    const input=document.querySelector('[data-pi-anchor="composer"] textarea');
    if(command==='begin'){
      invalidate();
      if(!wire||wire.readyState!==NativeWebSocket.OPEN||!context.sessionId||!input||input.disabled){publish('dictation-error',{token,message:'请先连接一个可编辑的开发会话'});return;}
      dictation={token,scope:scope(),input};publish('dictation-ready',{token});return;
    }
    if(!dictation||dictation.token!==token)return;
    if(command==='cancel'){dictation=null;return;}
    if(command!=='append'||typeof text!=='string'||!text.trim())return;
    if(dictation.scope!==scope()||dictation.input!==input||!input?.isConnected||input.disabled){invalidate();return;}
    // React's native setter + bubbling input event updates its controlled state,
    // including existing draft persistence; never clicks Send or dispatches Enter.
    const previous=input.value, addition=text.trim().slice(0,12000);
    const value=previous+(previous&&!/\s$/.test(previous)?'\n':'')+addition;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    publish('dictation-applied',{token});
  });
  const NativeWebSocket = window.WebSocket;
  const taskId=new URL(location.href).searchParams.get('pichanTaskId');
  let taskView=null,taskLocked=!!taskId,taskPoll,taskVerified=false,taskRestore=null,taskRestoreTimer,taskCurrentIdle=false;
  let taskGuardStyle=null,taskGuard=null,taskGuardMessage='正在核对任务历史，请稍候…';
  function showTaskGuard(message){
    taskGuardMessage=message;
    if(!document.createElement)return;
    if(!taskGuardStyle){taskGuardStyle=document.createElement('style');taskGuardStyle.textContent='body > :not(#pichan-task-session-guard){visibility:hidden!important}#pichan-task-session-guard{position:fixed;inset:0;display:grid;place-content:center;padding:32px;background:#faf9f6;color:#252722;font:14px system-ui;line-height:1.7;z-index:2147483647;white-space:pre-wrap}';document.head.append(taskGuardStyle);}
    if(document.body&&!taskGuard){taskGuard=document.createElement('div');taskGuard.id='pichan-task-session-guard';taskGuard.setAttribute('role','status');document.body.append(taskGuard);}
    if(taskGuard)taskGuard.textContent=taskGuardMessage;
  }
  function hideTaskGuard(){taskGuardStyle?.remove();taskGuardStyle=null;taskGuard?.remove();taskGuard=null;}
  if(taskId){showTaskGuard(taskGuardMessage);document.addEventListener('DOMContentLoaded',()=>{if(!taskVerified)showTaskGuard(taskGuardMessage);},{once:true});}
  async function loadTaskView(){
    if(!taskId||!/^[A-Za-z0-9_-]{1,128}$/.test(taskId))throw Error('开发任务标识无效');
    const response=await fetch('/api/development/tasks/'+encodeURIComponent(taskId),{cache:'no-store'});
    if(!response.ok)throw Error('任务会话映射尚未就绪');
    const data=await response.json(),task=data.task||data;
    const owner=task.workbenchClientId||task.link?.workbenchClientId||task.result?.workbenchClientId;
    const conversationId=task.conversationId||task.link?.conversationId||task.result?.conversationId;
    if(typeof owner!=='string'||!owner.startsWith('pichan-task-')||!conversationId)throw Error('开发会话正在创建，请稍后重新打开');
    if(taskView&&taskView.owner!==owner)throw Error('任务会话归属已变化，请重新打开');
    const sessionId=task.sessionId||task.link?.sessionId||task.result?.sessionId;
    if(typeof sessionId!=='string'||!sessionId)throw Error('任务缺少持久会话标识，停止展示以免打开其他任务');
    if(taskView&&taskView.sessionId!==sessionId)throw Error('任务会话标识已变化，请重新打开');
    taskView={owner,conversationId,sessionId,sessionFile:task.link?.sessionFile||task.result?.sessionFile||task.sessionFile||null,status:task.status};
    taskLocked=!taskVerified||!['completed','cancelled'].includes(task.status);
    publish('task-view',{taskId,status:task.status,readOnly:taskLocked,conversationId});
    return taskView;
  }
  if(taskId)window.addEventListener('pagehide',()=>{clearTimeout(taskPoll);clearTimeout(taskRestoreTimer);},{once:true});
  function pollTaskView(){taskPoll=setTimeout(async()=>{try{await loadTaskView();}catch{taskLocked=true;}if(taskLocked)pollTaskView();},2000);}
  function taskMismatch(message){showTaskGuard(message+'\n当前未展示其他任务。请关闭此视图后重新打开。');taskVerified=false;taskLocked=true;clearTimeout(taskRestoreTimer);taskRestore='failed';publish('history-error',{taskId,message});}
  function verifyTaskSnapshot(state,event){
    if(!taskId)return true;
    if(!taskView){event.stopImmediatePropagation?.();return false;}
    if(state.sessionId===taskView.sessionId){
      taskVerified=true;hideTaskGuard();taskCurrentIdle=state.isStreaming===false;clearTimeout(taskRestoreTimer);taskRestore=null;
      taskLocked=!['completed','cancelled'].includes(taskView.status);
      publish('task-view',{taskId,status:taskView.status,readOnly:taskLocked,conversationId:state.conversationId,sessionId:state.sessionId,verified:true});return true;
    }
    event.stopImmediatePropagation?.();showTaskGuard('正在核对并恢复指定任务历史…');taskVerified=false;taskLocked=true;taskCurrentIdle=state.isStreaming===false;
    if(!['completed','cancelled'].includes(taskView.status)||!taskCurrentIdle){taskMismatch('任务持久会话与工作台当前会话不一致，且任务或当前会话尚未确认空闲；未切换任何会话。');return false;}
    if(!taskRestore){
      taskRestore='mapping';
      taskRestoreTimer=setTimeout(()=>taskMismatch('目标任务历史恢复超时，未展示其他会话；请重新打开'),10000);
      void beginTaskRestore(wire,taskView);
    }

    return false;
  }
  async function beginTaskRestore(socket,expected){
    try{
      const response=await fetch('/api/development/tasks/'+encodeURIComponent(taskId)+'/session-link',{cache:'no-store',signal:AbortSignal.timeout(8000)});
      if(socket!==wire||taskRestore!=='mapping')return;
      if(!taskCurrentIdle||!['completed','cancelled'].includes(taskView?.status)||taskView.sessionId!==expected.sessionId)throw Error('任务状态已变化，停止恢复');
      if(response.status===404&&!expected.sessionFile){
        // Compatibility path only for older records lacking a stored file.
        taskRestore='listing';NativeWebSocket.prototype.send.call(socket,JSON.stringify({type:'list_sessions'}));return;
      }
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'服务端尚未验证此任务的持久历史路径');
      if(data.sessionId!==expected.sessionId||data.workbenchClientId!==expected.owner||typeof data.sessionFile!=='string'||!data.sessionFile)throw Error('持久任务映射核验失败，停止恢复');
      if(socket!==wire||taskRestore!=='mapping'||!taskCurrentIdle||!['completed','cancelled'].includes(taskView?.status)) return;
      taskRestore='loading';
      NativeWebSocket.prototype.send.call(socket,JSON.stringify({type:'switch_session',path:data.sessionFile}));
    }catch(error){if(socket===wire&&taskRestore==='mapping')taskMismatch(error.message||'任务历史恢复失败');}
  }
  function restoreTaskSession(message,event){
    if(!taskId||taskVerified||taskRestore!=='listing')return;
    event.stopImmediatePropagation?.();
    if(!taskCurrentIdle||!['completed','cancelled'].includes(taskView?.status)){taskMismatch('任务状态已变化，历史恢复已停止');return;}
    const expected=taskView.sessionId;
    const matches=[...new Map((message.sessions||[]).filter(item=>typeof item.path==='string'&&(item.sessionId?item.sessionId===expected:item.path.replace(/\\/g,'/').split('/').pop().endsWith('_'+expected+'.jsonl'))).map(item=>[item.path.replace(/\\/g,'/').toLowerCase(),item])).values()];
    if(matches.length!==1){taskMismatch('未找到唯一匹配的任务历史，未展示或修改其他会话');return;}
    taskRestore='loading';
    // Only a path returned by the upstream catalog is used. A matching snapshot
    // sessionId remains mandatory before the React UI receives transcript data.
    NativeWebSocket.prototype.send.call(wire,JSON.stringify({type:'switch_session',path:matches[0].path}));
  }
  function publish(event, detail) { if (window.parent !== window) window.parent.postMessage({source:'pichan-workbench',event,detail},window.location.origin); }
  // History is a viewer entry point, not permission to create another writer.
  let historyOpenRevision=0;
  async function routeHistoryOpen(socket,message,raw){
    const revision=++historyOpenRevision;
    try{
      const response=await fetch('/api/development/tasks',{cache:'no-store',signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw Error('任务映射读取失败，请稍后重试');
      const data=await response.json();
      const normalize=value=>String(value||'').replace(/\\/g,'/').toLowerCase();
      const matches=(data.tasks||[]).filter(task=>{
        const link=task.link||task.result||{};
        if(message.type==='take_over_conversation')return link.workbenchClientId===message.owner&&link.conversationId===message.id;
        const file=link.sessionFile||task.result?.sessionFile;
        return file&&normalize(file)===normalize(message.path);
      });
      if(revision!==historyOpenRevision||socket!==wire||socket.readyState!==NativeWebSocket.OPEN)return;
      if(matches.length>1)throw Error('该会话匹配多个任务，请从任务列表核对后打开');
      if(matches.length===1){publish('open-task',{taskId:matches[0].id});return;}
      NativeWebSocket.prototype.send.call(socket,raw);
    }catch(error){if(revision===historyOpenRevision)publish('history-error',{message:error.message||'读取任务失败，请重试'});}
  }
  class ObservedWebSocket extends NativeWebSocket {
    send(data){
      if(!taskId&&window.parent!==window){
        let message;try{message=JSON.parse(data);}catch{}
        if(['switch_session','take_over_conversation'].includes(message?.type)){
          void routeHistoryOpen(this,message,data);return;
        }
      }
      if(taskId){
        let m;try{m=JSON.parse(data);}catch{return;}
        if(m.type==='hello'){
          if(this.taskHelloStarted)return;this.taskHelloStarted=true;
          loadTaskView().then(view=>{
            if(this.readyState!==NativeWebSocket.OPEN)return;
            NativeWebSocket.prototype.send.call(this,JSON.stringify({...m,clientId:view.owner}));
            clearTimeout(taskPoll);pollTaskView();
          }).catch(error=>{taskMismatch(error.message);this.close();});
          return;
        }
        if(!taskView)return;
        if(taskLocked&&!['get_state','ping'].includes(m.type)){
          publish('history-error',{message:'后台正在执行此任务；当前原生对话为只读，避免切换或重复提交。'});return;
        }
      }
      try{const m=JSON.parse(data);if(this===wire&&['switch_conversation','switch_session','new_chat','edit_message','fork','prompt','steer','follow_up'].includes(m.type))invalidate();}catch{}
      return super.send(data);
    }
    constructor(...args) {
      super(...args);
      if(!new URL(String(args[0]),location.href).pathname.endsWith('/ws')) return;
      this.addEventListener('open',()=>{if(taskId){taskVerified=false;taskLocked=true;taskRestore=null;showTaskGuard('正在核对任务历史，请稍候…');}wire=this;publish('connection',{connected:true});});
      this.addEventListener('close',()=>{if(wire!==this)return;wire=null;history=null;finishSelection('开发连接已断开');invalidate();publish('connection',{connected:false});});
      this.addEventListener('message',e=>{
        if(wire!==this)return;
        try {
          const m=JSON.parse(e.data);
          if(taskId&&m.type==='sessions'){restoreTaskSession(m,e);if(!taskVerified)return;}
          if(taskId&&m.type==='snapshot_delta'){
            // Omitted fields inherit only from a verified same-conversation,
            // contiguous snapshot. A gap/switch never inherits another identity.
            if(!taskVerified||context.rev!==m.baseRev||(m.conversationId&&m.conversationId!==context.conversationId)){
              e.stopImmediatePropagation?.();NativeWebSocket.prototype.send.call(this,JSON.stringify({type:'get_state'}));return;
            }
          }
          if(taskId&&(m.type==='snapshot'||m.type==='snapshot_delta')&&!verifyTaskSnapshot(m.type==='snapshot_delta'?{...context,...(m.state||{})}:m.state||{},e))return;
          if(taskId&&!taskVerified&&!['snapshot','snapshot_delta','sessions','notice'].includes(m.type)){e.stopImmediatePropagation?.();return;}
          if(m.type==='snapshot'||m.type==='snapshot_delta') {
            const s=m.state || {};
            if(m.type==='snapshot_delta'){
              if(context.rev!==m.baseRev){wire.send(JSON.stringify({type:'get_state'}));return;}
              s.messages=[...(context.messages||[]),...(Array.isArray(m.appended)?m.appended:[])];
            }
            updateContext(s);if(selection&&s.conversationId===selection.conversationId&&s.sessionId)finishSelection();
            publish('status',{...context,messages:undefined});
            if(submission&&submission.scope===scope()){
              const run=submission;
              const matchIndex=(context.messages||[]).findIndex(x=>x.role==='user'&&!run.baseline.has(x.id)&&x.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n').trim()===run.text);
              const matched=matchIndex>=0;
              const completedMessage=matched&&(context.messages||[]).slice(matchIndex+1).some(x=>x.role==='assistant'&&!run.baseline.has(x.id));
              const queued=(context.queue?.followUp||[]).includes(run.text);
              if(!run.started&&((matched&&context.isStreaming)||queued||completedMessage)){
                run.started=matched&&(context.isStreaming||completedMessage);clearTimeout(run.timer);
                publish(run.started?'handoff-started':'handoff-queued',{token:run.token,conversationId:run.conversationId,sessionId:run.sessionId,status:run.started?'running':'queued'});
              }
              if(run.started&&!context.isStreaming){
                publish('handoff-finished',{token:run.token,conversationId:run.conversationId,sessionId:run.sessionId,status:context.errorMessage?'error':'finished',message:context.errorMessage||''});
                submission=null;
              }
            }
          } else if(m.type==='notice'&&['error','warning'].includes(m.level)){
            if(selection)finishSelection(m.text||'工作台拒绝了会话切换');
            if(submission&&!submission.started){clearTimeout(submission.timer);publish('handoff-uncertain',{token:submission.token,conversationId:submission.conversationId,sessionId:submission.sessionId,message:m.text||'工作台返回提示，请核实任务状态后再操作'});}
          } else if(m.type==='conversations'){if(m.activeId!==undefined)updateContext({conversationId:m.activeId});history={activeId:m.activeId,conversations:m.conversations,elsewhere:m.elsewhere||[]};publish('conversations',history);}
        }catch{}
      });
    }
  }
  window.WebSocket=ObservedWebSocket;
  publish('ready',{});
})();



