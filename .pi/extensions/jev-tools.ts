// Jev selects from the real enabled catalog; no chat/dev hard-coded tool list.
import {createHash} from 'node:crypto';
import {Type} from 'typebox';
export default function jevTools(pi) {
 if(process.env.PICHAN_HARNESS_KIND!=='chat')return;
 let generation=0,baseline=null,applied=null,turnContext=null;
 const port=Number(process.env.PORT||31415);
 const api=`http://127.0.0.1:${port}`;
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 async function enqueue(text,title,source,ctx,signal){
  const sessionId=ctx.sessionManager.getSessionId();
  if(!turnContext||turnContext.sessionId!==sessionId)throw Error('来源话轮已变化，请重新请求派发');
  if(turnContext.task)return turnContext.task;
  if(signal?.aborted)throw Error('派发已取消');
  turnContext.dispatchAttempted=true;
  const response=await fetch(api+'/api/development/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,prompt:text,sourceSessionId:sessionId,sourceTurnId:turnContext.turnId,idempotencyKey:turnContext.key,source,executionRequested:true}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'开发队列暂未就绪');
  if(!data.task?.id)throw Error('开发队列未返回任务凭据');
  if(turnContext?.sessionId===sessionId)turnContext.task=data.task;
  return data.task;
 }
 pi.registerTool({name:'dispatch_development_task',label:'派发后台开发任务',description:'用户明确要求执行开发/实现/修复时，将自足任务提交持久开发队列。任务后台执行，前台继续聊天。仅讨论想法、询问可行性、要求解释时不要调用。不要同时自行执行已经派发的工作。',
  parameters:Type.Object({title:Type.Optional(Type.String({maxLength:120})),prompt:Type.String({minLength:1,maxLength:8000})},{additionalProperties:false}),
  async execute(_id,args,signal,_update,ctx){
   const task=await enqueue(args.prompt,args.title||args.prompt.slice(0,80),'tool',ctx,signal);
   return {content:[{type:'text',text:JSON.stringify({taskId:task.id,status:task.status,message:'已进入持久后台开发队列；这是接收状态，不代表完成。无需在陪伴会话重复执行。'})}],details:{taskId:task.id,status:task.status}};
  }
 });
 function restore(){generation++;if(baseline){if(JSON.stringify(pi.getActiveTools())===JSON.stringify(applied))pi.setActiveTools(baseline);baseline=null;applied=null;}}
 pi.on('before_agent_start',async(event,ctx)=>{
  restore();const turn=++generation,sessionId=ctx.sessionManager.getSessionId();
  const turnId=ctx.sessionManager.getLeafId()||hash(event.prompt);
  turnContext={sessionId,turnId,key:'companion-'+hash([sessionId,turnId,event.prompt]),task:null};
  const original=[...pi.getActiveTools()],names=new Set(original);
  const catalog=pi.getAllTools().filter(tool=>names.has(tool.name)).map(tool=>({name:tool.name,description:tool.description||''}));
  try{
   const port=Number(process.env.PORT||31415);if(!Number.isInteger(port)||port<1||port>65535)throw Error('port');
   const response=await fetch(`http://127.0.0.1:${port}/api/jev/tools`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:event.prompt,tools:catalog,sessionId}),signal:AbortSignal.timeout(1800)});
   if(!response.ok)throw Error('service');const plan=await response.json();
   if(generation!==turn||ctx.sessionManager.getSessionId()!==sessionId)return;
   if(plan.status!=='ready'||plan.sessionId!==sessionId||plan.expiresAt<=Date.now()||!Number.isFinite(plan.expiresAt)||plan.inputHash!==hash(event.prompt)||plan.catalogHash!==hash(catalog)||!Array.isArray(plan.selectedTools)||plan.selectedTools.some(name=>!names.has(name)))throw Error('unavailable');
   // A stale external extension/catalog update wins over this delayed result.
   if(JSON.stringify(pi.getActiveTools())!==JSON.stringify(original))return;
   // Keep the already-enabled handoff bridge available even if semantic tool ranking
   // omits it. It queues work; it does not grant new filesystem/tool permissions.
   baseline=original;applied=[...new Set([...plan.selectedTools,...(names.has('dispatch_development_task')?['dispatch_development_task']:[])])];pi.setActiveTools(applied);
   ctx.ui?.setStatus?.('jev-tools',applied.length?'Jev 本轮工具：'+applied.join('、'):'Jev：本轮直接聊天');
   if(plan.dispatchUsable&&plan.executionRequested&&plan.source==='jev'&&plan.route==='development'){
    const task=await enqueue(event.prompt,event.prompt.slice(0,80),'jev',ctx);
    ctx.ui?.setStatus?.('jev-handoff','开发任务已进入后台队列：'+task.id);
    return {systemPrompt:event.systemPrompt+'\n本轮用户要求的开发工作已经进入持久后台队列。可信任务凭据：'+JSON.stringify({id:task.id,status:task.status})+'。只简短确认已派发并继续陪伴对话；不要再次调用工具执行同一任务，不要把queued/running说成完成。任务结果会回到来源会话的开发反馈区。'};
   }
   ctx.ui?.setStatus?.('jev-handoff',undefined);

  }catch{
   if(generation===turn&&turnContext?.dispatchAttempted){
    ctx.ui?.setStatus?.('jev-handoff','开发队列接收状态待核实，请查看开发任务列表');
    return {systemPrompt:event.systemPrompt+'\n本轮开发派发请求已经尝试提交，但尚未取得确定的接收凭据。不得声称已启动或完成，不要改在前台重复执行；简短说明需核实开发队列状态。'};
   }
   if(generation===turn)ctx.ui?.setStatus?.('jev-tools','Jev 工具判断暂未就绪 · 保留现有工具配置');
  }
 });
 pi.on('agent_end',restore);
 pi.on('session_switch',restore);
 pi.on('session_shutdown',restore);
}
