'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const fault=(message,status=400)=>Object.assign(Error(message),{status});
const copy=x=>JSON.parse(JSON.stringify(x));
function createDevelopmentDispatch({dataDir,runTask,resolveProject,resolveSourceProject=()=>undefined,externalBusy=()=>false,onEvent=()=>{},checkRequest,tickMs=500,sessionRoots=[path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.pi','agent'),'sessions'),...(process.env.PI_CODING_AGENT_SESSION_DIR?[process.env.PI_CODING_AGENT_SESSION_DIR]:[])]}={}){
 if(!dataDir||typeof runTask!=='function'||typeof resolveProject!=='function')throw Error('Development dispatch dependencies required');
 fs.mkdirSync(dataDir,{recursive:true});const file=path.join(dataDir,'queue.json');let tasks=[],closed=false,active=null,blocked=false,checking=false;
 if(fs.existsSync(file)){const v=JSON.parse(fs.readFileSync(file,'utf8'));if(v.version!==1||!Array.isArray(v.tasks))throw Error('Invalid development queue');tasks=v.tasks;}
 function save(){const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify({version:1,tasks},null,2),{mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
 const now=()=>new Date().toISOString();
 function record(t,type,detail={}){t.updatedAt=now();t.events=[...(t.events||[]),{id:crypto.randomUUID(),type,at:t.updatedAt,...detail}].slice(-100);}
 function emit(type,t){try{onEvent({type,task:copy(t)})}catch{}}
 for(const t of tasks)if(['running','cancelling'].includes(t.status)){t.status='interrupted';t.finishedAt=now();t.error='后台重启，先核对已有开发会话的执行结果；此任务不会自动重放';t.executionUncertain=true;record(t,'interrupted');}
 // Unknown side effects require explicit acknowledgement before any new dispatch.
 blocked=tasks.some(t=>t.executionUncertain&&!t.uncertaintyAcknowledgedAt);save();
 const get=id=>{const t=tasks.find(t=>t.id===id);if(!t)throw fault('开发任务不存在',404);return t;};
 function sessionLink(id){
  const task=get(id),a=task.link||{},b=task.result||{};
  for(const key of ['sessionId','sessionFile','workbenchClientId'])if(a[key]&&b[key]&&a[key]!==b[key])throw fault('持久会话链接不一致，请核对任务记录',409);
  const sessionId=a.sessionId||b.sessionId,workbenchClientId=a.workbenchClientId||b.workbenchClientId;
  let sessionFile=a.sessionFile||b.sessionFile;
  if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)||typeof workbenchClientId!=='string'||!workbenchClientId)throw fault('任务尚未建立完整开发会话链接',409);
  const discovered=!sessionFile;
  if(discovered){
   const found=new Set();let visited=0;
   const readHeader=file=>{let fd;try{fd=fs.openSync(file,'r');const buf=Buffer.alloc(65536),n=fs.readSync(fd,buf,0,buf.length,0),line=buf.subarray(0,n).indexOf(10);if(line<0&&n===buf.length)return null;return JSON.parse(buf.subarray(0,line<0?n:line).toString('utf8').replace(/^\uFEFF/,''));}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}};
   const walk=(dir,depth)=>{if(depth>4)throw fault('会话目录层级超过扫描预算',409);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++visited>15000)throw fault('会话查找超过扫描预算',409);const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){walk(file,depth+1);continue;}if(!entry.isFile()||!entry.name.endsWith('.jsonl')||!entry.name.includes(sessionId))continue;const header=readHeader(file);if(header?.type==='session'&&header.id===sessionId)found.add(fs.realpathSync(file));}};
   for(const root of sessionRoots){let realRoot;try{realRoot=fs.realpathSync(root);}catch(e){if(e.code==='ENOENT')continue;throw e;}walk(realRoot,0);}
   if(!found.size)throw fault('尚未找到此任务的已持久化会话文件',409);
   if(found.size!==1)throw fault('同一会话标识匹配多个文件，请核对任务记录',409);
   sessionFile=[...found][0];
  }
  if(!path.isAbsolute(sessionFile)||path.extname(sessionFile).toLowerCase()!=='.jsonl')throw fault('开发会话文件路径不符合要求',403);
  let real;
  try{if(fs.lstatSync(sessionFile).isSymbolicLink())throw fault('开发会话文件不应为链接',403);real=fs.realpathSync(sessionFile);}catch(e){if(e.status)throw e;if(e.code==='ENOENT')throw fault('开发会话文件已不存在',410);throw fault('开发会话文件不可读取',403);}
  const contained=sessionRoots.some(root=>{try{const rel=path.relative(fs.realpathSync(root),real);return !!rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}catch{return false;}});
  if(!contained)throw fault('开发会话文件位于批准会话目录之外',403);
  let fd;
  try{
   fd=fs.openSync(real,'r');const stat=fs.fstatSync(fd);if(!stat.isFile())throw fault('开发会话路径不是文件',403);
   const buf=Buffer.alloc(65536),count=fs.readSync(fd,buf,0,buf.length,0),newline=buf.subarray(0,count).indexOf(10);
   if(newline<0&&stat.size>=buf.length)throw fault('开发会话头过大',409);
   let header;try{header=JSON.parse(buf.subarray(0,newline<0?count:newline).toString('utf8').replace(/^\uFEFF/,''));}catch{throw fault('开发会话头无效',409);}
   if(header.type!=='session'||header.id!==sessionId)throw fault('开发会话标识与持久任务不一致',409);
   if(discovered){task.link={...a,sessionId,sessionFile:real,workbenchClientId};if(task.result)task.result={...task.result,sessionFile:real};record(task,'session_link_resolved');save();emit('linked',task);}
   return{sessionId,sessionFile:real,workbenchClientId};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 const string=(v,max,name)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw fault(name+'无效');return v.trim();};
 function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fault('任务必须为对象');
  if(input.executionRequested!==true)throw fault('请明确确认执行开发任务');
  const prompt=string(input.prompt,8000,'任务内容'),sourceSessionId=string(input.sourceSessionId,200,'来源会话');
  const source=input.source||'manual';if(!['manual','jev','tool'].includes(source))throw fault('任务来源无效');
  const idempotencyKey=string(input.idempotencyKey,200,'幂等键');
  const projectId=string(input.projectId||resolveSourceProject(sourceSessionId)||'default',200,'项目');
  if(input.sandbox===true)throw fault('Docker 执行已停用，请重新创建轻量隔离任务');
  if(input.isolation!==undefined&&!['session','copy'].includes(input.isolation))throw fault('隔离模式无效');
  return{...(input.isolation==='copy'?{isolation:'copy'}:{}),title:input.title===undefined?prompt.slice(0,60):string(input.title,120,'标题'),prompt,sourceSessionId,source,projectId,idempotencyKey,executionRequested:true,...(input.sourceTurnId?{sourceTurnId:string(input.sourceTurnId,200,'来源轮次')}:{})};
 }
 async function create(input){
  if(closed)throw fault('开发队列已关闭',503);const v=validate(input);
  const hash=crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const existing=tasks.find(t=>t.sourceSessionId===v.sourceSessionId&&t.idempotencyKey===v.idempotencyKey);
  if(existing){if(existing.inputHash!==hash)throw fault('同一幂等键对应了不同任务',409);return{task:copy(existing),deduplicated:true};}
  const project=await resolveProject(v.projectId);const root=typeof project==='string'?project:project?.root;
  if(!root||!path.isAbsolute(root)||!fs.statSync(root).isDirectory())throw fault('请选择已注册且存在的项目');
  if(closed)throw fault('开发队列已关闭',503);
  // Recheck after async project lookup; simultaneous duplicate HTTP requests dispatch once.
  const duplicate=tasks.find(t=>t.sourceSessionId===v.sourceSessionId&&t.idempotencyKey===v.idempotencyKey);
  if(duplicate){if(duplicate.inputHash!==hash)throw fault('同一幂等键对应了不同任务',409);return{task:copy(duplicate),deduplicated:true};}
  if(tasks.length>=500)throw fault('开发任务存储已达500项上限',409);
  const t={...v,inputHash:hash,id:crypto.randomUUID(),harness:'development',status:'queued',createdAt:now(),updatedAt:now(),events:[]};record(t,'queued');tasks.push(t);
  try{save()}catch(e){tasks.pop();throw e;}emit('queued',t);queueMicrotask(()=>pump());return{task:copy(t),deduplicated:false};
 }
 function sanitizeLink(value){const result={};for(const k of ['jobId','conversationId','workbenchConversationId','sessionId','workbenchClientId','sessionFile','workspace','sourceRoot','isolationMode'])if(typeof value?.[k]==='string')result[k]=value[k].slice(0,['sessionFile','workspace','sourceRoot'].includes(k)?2048:200);return result;}
 async function pump(){
  if(closed||active||checking||blocked)return;checking=true;
  try{if(await externalBusy())return;if(closed||active||blocked)return;const t=tasks.find(t=>t.status==='queued');if(!t)return;
   const controller=new AbortController(),entry={id:t.id,controller};active=entry;t.status='running';t.startedAt=now();record(t,'running');
   try{save()}catch{t.status='queued';active=null;blocked=true;return;}emit('running',t);
   entry.done=(async()=>{try{
    const result=await runTask(copy(t),{signal:controller.signal,runId:t.id,onLinked:link=>{t.link=sanitizeLink(link);record(t,'linked');save();emit('linked',t);},onEvent:event=>{
     if(!['tool_status','job_end','workbench_linked'].includes(event.type))return;
     record(t,event.type,{status:String(event.status||'').slice(0,100)});save();emit('progress',t);
    }});
    if(typeof result?.text!=='string'||!result.text.trim())throw Error('开发执行器未返回有效最终结果');
    t.result={...sanitizeLink(result),...(result.isolation?{isolation:result.isolation}:{}),text:result.text.slice(0,30000)};t.status=controller.signal.aborted?'cancelled':'completed';
   }catch(error){
    if(error?.code==='DEVELOPMENT_BUSY'&&!controller.signal.aborted){t.status='queued';delete t.startedAt;}
    else{t.status=controller.signal.aborted&&error?.code!=='TERMINATION_FAILED'?'cancelled':'failed';t.error=String(error?.message||'开发执行失败').slice(0,1000);if(error?.code==='TERMINATION_FAILED'){t.executionUncertain=true;blocked=true;}}
   }finally{
    if(t.status!=='queued')t.finishedAt=now();record(t,t.status);try{save();emit(t.status,t)}catch{blocked=true;emit('store_error',t)}
    if(active===entry)active=null;if(!closed&&!blocked&&t.status!=='queued')queueMicrotask(()=>pump());
   }})();
  }catch{blocked=true;}finally{checking=false;}
 }
 function cancel(id){const t=get(id);if(['queued','running','cancelling'].includes(t.status)){if(active?.id===id){t.status='cancelling';record(t,'cancelling');save();active.controller.abort();}else{t.status='cancelled';t.finishedAt=now();record(t,'cancelled');save();}emit(t.status,t);}return copy(t);}
 function acknowledge(id){const t=get(id);if(!t.executionUncertain)throw fault('任务没有待确认的执行状态',409);t.uncertaintyAcknowledgedAt=now();record(t,'uncertainty_acknowledged');save();blocked=tasks.some(x=>x.executionUncertain&&!x.uncertaintyAcknowledgedAt);emit('uncertainty_acknowledged',t);queueMicrotask(()=>pump());return copy(t);}
 const timer=setInterval(pump,Math.max(20,tickMs));timer.unref?.();queueMicrotask(()=>pump());
 async function close(){closed=true;clearInterval(timer);if(active){active.controller.abort();await active.done;}}
 async function handle(req,res,url){
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{if(typeof checkRequest!=='function')throw fault('缺少本机访问校验',503);checkRequest(req);
   const match=url.pathname.match(/^\/api\/development\/tasks(?:\/([a-f0-9-]+)(?:\/(events|cancel|acknowledge|session-link))?)?$/);if(!match)throw fault('开发任务路由不存在',404);
   const [,id,verb]=match;
   if(req.method==='GET'&&verb==='session-link'){send(200,sessionLink(id));return;}
   if(req.method==='GET'){if(verb&&verb!=='events')throw fault('该操作需要POST',405);if(id){const t=copy(get(id));send(200,verb==='events'?{events:t.events}:{task:t});}else{const source=url.searchParams.get('sourceSessionId');send(200,{tasks:tasks.filter(t=>!source||t.sourceSessionId===source).map(copy),blocked,externalBusy:!!(await externalBusy()),waitingReason:blocked?'有待核实的开发执行，请在任务详情确认后继续':(await externalBusy())?'开发执行器忙碌或存在未清理的历史任务，任务已保存并等待':''});}return;}
   if(req.method!=='POST')throw fault('仅支持GET和POST',405);
   if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw fault('需要JSON请求',415);
   let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>40000)throw fault('请求过大',413);chunks.push(b);}let input;try{input=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw fault('JSON格式错误');}
   if(!id){send(202,await create(input));return;}if(verb==='cancel'){send(200,{task:cancel(id)});return;}if(verb==='acknowledge'&&input.executionChecked===true){send(200,{task:acknowledge(id)});return;}throw fault('开发任务操作无效');
  }catch(e){send(e.status||500,{error:e.status?e.message:'开发任务队列操作失败'});}
 }
 return{create,get:id=>copy(get(id)),list:()=>tasks.map(copy),sessionLink,cancel,acknowledge,pump,close,handle,isBusy:()=>!!active,isBlocked:()=>blocked};
}
module.exports={createDevelopmentDispatch};
