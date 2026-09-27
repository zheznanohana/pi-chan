'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const readline=require('node:readline');
function findCli(){
 const candidates=[process.env.PI_TASK_CLI,path.join(path.dirname(process.execPath),'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),path.join(process.env.APPDATA||'','npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')];
 return candidates.find(p=>p&&fs.existsSync(p));
}
function createTaskRunner(options={}){
 const jobsDir=path.resolve(options.jobsDir||path.join(__dirname,'data/task-runs'));
 const launch=options.spawn||spawn;
 const kill=options.killTree||((child)=>{
  if(!child?.pid||child.exitCode!=null)return;
  if(process.platform==='win32'){const result=spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(result.error||result.status!==0)throw Object.assign(new Error('Owned worker termination failed'),{code:'TERMINATION_FAILED'});}
  else if(!child.kill('SIGKILL'))throw Object.assign(new Error('Owned worker termination failed'),{code:'TERMINATION_FAILED'});
 });
 async function runTask(task,{signal,onEvent=()=>{}}={}){
  if(signal?.aborted)throw Object.assign(new Error('Task cancelled'),{code:'ABORTED'});
  const mode=task.harnessId||task.targetHarnessId||task.harness||task.mode;
  if(!['chat','dev','development'].includes(mode))throw new Error('Task requires explicit chat/dev harnessId');
  const harnessId=mode==='development'?'dev':mode;
  const prompt=task.prompt||task.text;
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw new Error('Task prompt must be self-contained, 1..100000 characters');
  if(typeof options.resolveProject!=='function')throw new Error('resolveProject is required');
  const project=await options.resolveProject(task.projectId);
  const root=typeof project==='string'?project:project?.root;
  if(!root||!path.isAbsolute(root))throw new Error('Project is not registered');
  const cwd=fs.realpathSync(root);if(!fs.statSync(cwd).isDirectory())throw new Error('Project root is not a directory');
  if(signal?.aborted)throw Object.assign(new Error('Task cancelled'),{code:'ABORTED'});
  const cli=options.cliPath||findCli();if(!cli||!fs.existsSync(cli))throw new Error('Pi CLI entry missing; configure PI_TASK_CLI');
  const jobId=crypto.randomUUID(),sessionId=crypto.randomUUID(),turnId=crypto.randomUUID();
  const jobDir=path.join(jobsDir,jobId);fs.mkdirSync(jobDir,{recursive:true});
  if(task.sandbox===true)throw Error('Docker 执行已停用，请重新创建轻量隔离任务');
  const sessionFile=path.join(jobDir,'session.jsonl'),logFile=path.join(jobDir,'events.jsonl');
  const meta={jobId,sessionId,turnId,harnessId,sessionFile,logFile,projectId:task.projectId,sourceSessionId:task.sourceSessionId||task.sessionId||null,sourceConversationId:task.conversationId||null};
  fs.writeFileSync(path.join(jobDir,'job.json'),JSON.stringify({...meta,taskId:task.id||null,startedAt:new Date().toISOString(),status:'running'},null,2));
  const args=[cli,'--mode','rpc','--session',sessionFile,'--session-dir',jobDir,'--no-extensions'];
  // No user extension startup hooks in a scheduled process. Dev retains Pi built-in tools.
  if(harnessId==='chat')args.push('--no-tools','--no-skills','--no-prompt-templates','--append-system-prompt',path.join(__dirname,'companion-prompt.md'));
  if(harnessId==='chat'&&task.socialCapabilities===true)args.push('--extension',path.join(__dirname,'.pi/extensions/bot-web.ts'),'--tools','web_search');
  if(task.model){if(typeof task.model!=='string'||task.model.length>200)throw new Error('Invalid model');args.push('--model',task.model);}
  const timeoutMs=Math.max(1,Math.min(options.timeoutMs||900000,900000));
  const maxTools=Math.max(1,Math.min(options.maxTools||40,40));
  return new Promise((resolve,reject)=>{
   let child,done=false,prompted=false,started=false,tools=0,lastAssistant=null,lineBytes=0;
   const startedAt=Date.now();let timer;
   function record(event){try{fs.appendFileSync(logFile,JSON.stringify({at:new Date().toISOString(),...event})+'\n');}catch(e){if(!done)finish(Object.assign(new Error('Task event log write failed'),{code:'STORE_FAILED'}));return;}try{onEvent({...meta,...event});}catch{}}
   function send(value){if(child?.stdin?.writable)child.stdin.write(JSON.stringify(value)+'\n');}
   function finish(error,result){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    try{send({id:'stop',type:'abort'});}catch{}
    try{kill(child)}catch(e){error=e;}const status=error?(error.code==='ABORTED'?'cancelled':'failed'):'completed';
    const final={...meta,status,durationMs:Date.now()-startedAt,toolCalls:tools,...result};
    if(error){error.code=error.code||'TASK_FAILED';error.job=final;final.error=error.message;}
    try{fs.writeFileSync(path.join(jobDir,'result.json'),JSON.stringify(final,null,2));}catch(e){error=Object.assign(new Error('Task result write failed'),{code:'STORE_FAILED',job:final});}
    record({type:'job_end',status,error:error?.message});error?reject(error):resolve(final);
   }
   function fail(message,code){finish(Object.assign(new Error(message),{code}));}
   function cancel(){fail('Task cancelled','ABORTED');}
   try{child=launch(process.execPath,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PI_CODING_AGENT_SESSION_DIR:jobDir}});}catch(e){finish(e);return;}
   timer=setTimeout(()=>fail('Task exceeded execution timeout','TIMEOUT'),timeoutMs);
   signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
   child.on('error',e=>finish(e));child.on('exit',code=>{if(!done)fail('Pi exited before agent_end: '+code,'EARLY_EXIT');});
   child.stdin.on('error',e=>finish(e));
   child.stderr.on('data',data=>{if(!done)record({type:'stderr',text:String(data).slice(0,8000)});});
   // get_state is an RPC readiness handshake; its ACK is never task completion.
   const lines=readline.createInterface({input:child.stdout});
   child.stdout.on('data',data=>{lineBytes+=data.length;if(lineBytes>32*1024*1024)fail('RPC output exceeded 32 MiB','OUTPUT_LIMIT');});
   lines.on('line',line=>{
    if(done)return;let ev;try{ev=JSON.parse(line);}catch{return;}
    record(ev);if(done)return;
    if(ev.type==='response'&&ev.id==='ready'){
     if(!ev.success){fail(ev.error||'RPC readiness failed');return;}
     if(ev.data?.sessionId)meta.sessionId=ev.data.sessionId;if(ev.data?.sessionFile)meta.sessionFile=ev.data.sessionFile;
     if(!prompted){prompted=true;send({id:turnId,type:'prompt',message:prompt});}return;
    }
    if(ev.type==='response'&&ev.id===turnId&&ev.success===false){fail(ev.error||'Prompt rejected');return;}
    if(ev.type==='agent_start')started=true;
    if(ev.type==='tool_execution_start'){
     tools++;if(harnessId==='chat'&&!(task.socialCapabilities===true&&ev.toolName==='web_search')){fail('Chat task attempted a disabled tool','TOOL_POLICY');return;}
     if(tools>maxTools){fail('Task exceeded tool-call budget','TOOL_LIMIT');return;}
    }
    if(ev.type==='message_end'&&ev.message?.role==='assistant')lastAssistant=ev.message;
    if(ev.type==='agent_end'&&prompted&&started){
     const assistants=(ev.messages||[]).filter(m=>m.role==='assistant');const last=assistants.at(-1)||lastAssistant;
     if(!last){fail('agent_end without assistant output','EMPTY_RESULT');return;}
     if(!['stop','length'].includes(last.stopReason)){fail(last.errorMessage||('Unsuccessful stopReason: '+String(last.stopReason)),'MODEL_ERROR');return;}
     if(last.stopReason==='length'){fail('Model output was truncated','TRUNCATED');return;}
     const text=(Array.isArray(last.content)?last.content:[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');
     if(!text.trim()){fail('Assistant returned no final text','EMPTY_RESULT');return;}
     finish(null,{text,stopReason:last.stopReason});
    }
   });
   send({id:'ready',type:'get_state'});
  });
 }
 return {runTask};
}
module.exports={createTaskRunner,findCli};
