'use strict';
// Native workbench protocol adapter. A dedicated client owns each scheduled run;
// it never switches, aborts or takes over an interactive browser's conversation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const WebSocket=require('ws');
const fault=(message,code='WORKBENCH_TASK_FAILED')=>Object.assign(new Error(message),{code});
function createWorkbenchTaskRunner({resolveProject,ensureReady,url='ws://127.0.0.1:31417/ws',dataDir=path.join(__dirname,'../data/workbench-task-runs'),timeoutMs=900000,WebSocketImpl=WebSocket}={}){
 const endpoint=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.protocol!=='ws:')throw Error('Workbench must be local');
 fs.mkdirSync(dataDir,{recursive:true});const inflight=new Map();
 function runTask(task,options={}){
  const runId=options.runId||task.history?.[0]?.id||crypto.randomUUID();
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(runId))return Promise.reject(fault('Invalid run ID'));
  if(inflight.has(runId))return inflight.get(runId);
  const pending=execute(task,{...options,runId}).finally(()=>inflight.delete(runId));inflight.set(runId,pending);return pending;
 }
 async function execute(task,{signal,runId,workspaceIsolation,onEvent=()=>{},onLinked=()=>{}}){
  if(signal?.aborted)throw fault('Task cancelled','ABORTED');
  if(task.sandbox===true)throw fault('Docker 执行已停用，请重新创建轻量隔离任务');
  if(task.harness!=='development')throw fault('Workbench runner accepts development tasks only');
  if(typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>8000)throw fault('Invalid task prompt');
  const recordFile=path.join(dataDir,runId+'.json');
  if(fs.existsSync(recordFile)){
   const prior=JSON.parse(fs.readFileSync(recordFile,'utf8'));
   if(prior.status==='completed')return prior.result;
   throw fault('This run was already dispatched; inspect its workbench conversation instead of replaying','DUPLICATE_RUN');
  }
  const project=await resolveProject(task.projectId);const root=typeof project==='string'?project:project?.root;
  if(!root||!path.isAbsolute(root))throw fault('Project root is not registered');
  if(!fs.statSync(root).isDirectory())throw fault('Project root is not a directory');
  const isolation=workspaceIsolation||require('./task-isolation.cjs').prepareWorkspace({source:root,directory:path.join(dataDir,runId,'workspace'),mode:task.isolation||'session'});
  const cwd=isolation.workspace;
  if(signal?.aborted)throw fault('Task cancelled','ABORTED');
  await ensureReady();if(signal?.aborted)throw fault('Task cancelled','ABORTED');
  const clientId='pichan-task-'+runId,meta={isolation,isolationMode:isolation.mode,workspace:cwd,sourceRoot:isolation.sourceRoot,jobId:runId,workbenchClientId:clientId,projectId:task.projectId||'default'};
  const samePath=value=>{try{return fs.realpathSync(value)===cwd}catch{return false}};
  let record={taskId:task.id,runId,cwd,clientId,status:'connecting',startedAt:new Date().toISOString()};
  function persist(update){record={...record,...update};const tmp=recordFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(record,null,2),{mode:0o600});fs.renameSync(tmp,recordFile);}
  persist({});
  return new Promise((resolve,reject)=>{
   const connectStartedAt=Date.now();
   let ws,done=false,phase='hello',state=null,promptSent=false,accepted=false,stopError=null,stopRev=-1,stopTimer,deadline,poll,previousConversation=null,previousBlank=false,lastSnapshotRev=-1;
   const emit=ev=>{try{onEvent({...meta,...ev})}catch{}};
   const send=msg=>{if(ws?.readyState!==WebSocketImpl.OPEN)throw fault('Workbench socket is disconnected');ws.send(JSON.stringify(msg));};
   function finish(error,result){
    if(done)return;done=true;clearTimeout(deadline);clearTimeout(stopTimer);clearInterval(poll);signal?.removeEventListener('abort',cancel);
    if(error)error.job={...meta};
    try{persist({status:error?'failed':'completed',finishedAt:new Date().toISOString(),error:error?.message,...(result?{result}:{})})}catch(e){error=fault('Task result persistence failed: '+e.message,'STORE_FAILED')}
    ws?.close();emit({type:'job_end',status:error?'failed':'completed',error:error?.message});error?reject(error):resolve(result);
   }
   function stop(error){
    if(done||stopError)return;
    if(!promptSent){finish(error);return;}
    stopError=error;stopRev=state?.rev??-1;
    try{send({type:'abort'});send({type:'get_state'});}catch{finish(fault('Lost owned workbench session; termination is unconfirmed','TERMINATION_FAILED'));return;}
    stopTimer=setTimeout(()=>finish(fault('Workbench abort did not confirm idle; inspect the linked conversation before restoring tasks','TERMINATION_FAILED')),10000);
   }
   function cancel(){stop(fault('Task cancelled','ABORTED'))}
   function snapshot(next){
    if(done)return;state=next;
    if(phase==='hello'){
     if(samePath(next.cwd)&&!next.isStreaming){previousConversation=next.conversationId;previousBlank=Array.isArray(next.messages)&&next.messages.length===0;phase='new';if(previousBlank)snapshot(next);else send({type:'new_chat'});return;}
     phase='cwd';send({type:'set_cwd',path:cwd});return;
    }
    if(phase==='cwd'){
     if(!samePath(next.cwd))return;
     if(next.isStreaming)throw fault('New task client unexpectedly busy');
     previousConversation=next.conversationId;previousBlank=Array.isArray(next.messages)&&next.messages.length===0;phase='new';if(previousBlank)snapshot(next);else send({type:'new_chat'});return;
    }
    if(phase==='new'){
     if(!samePath(next.cwd)||next.isStreaming||!next.conversationId||!next.sessionId||(next.conversationId===previousConversation&&!previousBlank)||!Array.isArray(next.messages))return;
     if((next.messages||[]).length)throw fault('Workbench did not create an empty owned conversation');
     Object.assign(meta,{conversationId:next.conversationId,workbenchConversationId:next.conversationId,sessionId:next.sessionId,sessionFile:next.sessionFile||''});
     // Persist dispatch intent before sending: reconnect/restart never retries an ambiguous prompt.
     persist({status:'dispatching',...meta});onLinked({...meta});emit({type:'workbench_linked',status:'running'});
     if(signal?.aborted){finish(fault('Task cancelled','ABORTED'));return;}
     phase='running';
     if(task.title)send({type:'rename_conversation',id:meta.conversationId,name:String(task.title).slice(0,100)});
     promptSent=true;send({type:'prompt',text:task.prompt,queue:false});return;
    }
    if(phase!=='running')return;
    if(next.conversationId!==meta.conversationId||next.sessionId!==meta.sessionId||!samePath(next.cwd)){
     // Never issue abort against a different active conversation.
     finish(fault('Owned conversation identity changed; inspect its run before resuming','TERMINATION_FAILED'));return;
    }
    if(next.rev!==lastSnapshotRev){lastSnapshotRev=next.rev;emit({type:'workbench_snapshot',payload:{conversationId:meta.conversationId,isStreaming:!!next.isStreaming,messages:next.messages||[],streamingMessage:next.streamingMessage||null}});}
    const messages=next.messages||[];
    const userIndex=messages.findIndex(m=>m.role==='user'&&(m.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n')===task.prompt);
    accepted=accepted||userIndex>=0;
    if(stopError){if(accepted&&!next.isStreaming&&next.rev>stopRev)finish(stopError);return;}
    if(!accepted||next.isStreaming)return;
    const assistant=messages.slice(userIndex+1).filter(m=>m.role==='assistant').at(-1);
    if(next.errorMessage){finish(fault(String(next.errorMessage),'MODEL_ERROR'));return;}
    if(!assistant)return;
    if(assistant.stopReason!=='stop'){finish(fault(assistant.errorMessage||('Unsuccessful stop: '+assistant.stopReason),'MODEL_ERROR'));return;}
    const text=(assistant.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');
    if(!text.trim()){finish(fault('Workbench returned no final text','EMPTY_RESULT'));return;}
    finish(null,{...meta,text:text.slice(0,20000),status:'completed'});
   }
   try{ws=new WebSocketImpl(url,{origin:'http://127.0.0.1:31415',maxPayload:32*1024*1024});}catch(e){finish(e);return;}
   deadline=setTimeout(()=>stop(fault('Workbench task execution timed out','TIMEOUT')),Math.max(1000,Math.min(timeoutMs,900000)));
   // Full snapshots provide recovery from dropped deltas without replaying the prompt.
   poll=setInterval(()=>{if(!promptSent&&Date.now()-connectStartedAt>30000){stop(fault('Workbench session initialization timed out','CONNECT_TIMEOUT'));return;}if(ws.readyState===WebSocketImpl.OPEN)try{send({type:'get_state'})}catch(e){stop(e)}},2000);poll.unref?.();
   ws.on('open',()=>{if(!done)send({type:'hello',clientId,locale:'zh'})});
   ws.on('message',raw=>{
    if(done)return;let msg;try{msg=JSON.parse(String(raw))}catch{return;}
    try{
     if(msg.type==='snapshot')snapshot(msg.state);
     else if(msg.type==='snapshot_delta')send({type:'get_state'});
     else if(['message_delta','tool_delta','tool_status'].includes(msg.type)){
      if(!msg.conversationId||msg.conversationId===meta.conversationId)emit({type:msg.type,payload:msg});
     }else if(msg.type==='notice'&&msg.level==='error'){
      const text=String(msg.text||'Workbench error');
      // This extension explicitly continued; it is not a failed model/tool run.
      if(/^pi-jev: [\s\S]*\(failing open\)\s*$/.test(text))emit({type:'jev_degraded',status:'warning',message:'Jev 判断暂不可用，开发继续执行'});
      else stop(fault(text));
     }
    }catch(e){stop(e)}
   });
   const lost=()=>{if(!done)finish(fault(promptSent?'Workbench connection lost; execution status is unconfirmed':'Workbench connection failed',promptSent?'TERMINATION_FAILED':'CONNECT_FAILED'))};
   ws.on('error',lost);ws.on('close',lost);
   signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
  });
 }
 return {runTask};
}
module.exports={createWorkbenchTaskRunner};

