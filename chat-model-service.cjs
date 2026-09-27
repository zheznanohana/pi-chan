'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function createChatModelService({rpc,file,acquireMutation,releaseMutation,onActive=()=>{}}){
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 const identity=m=>m&&typeof m.provider==='string'&&typeof m.id==='string'?{provider:m.provider,modelId:m.id}:null;
 const publicModel=m=>({provider:m.provider,id:m.id,name:typeof m.name==='string'?m.name:m.id,reasoning:!!m.reasoning,contextWindow:Number(m.contextWindow)||0,maxTokens:Number(m.maxTokens)||0,input:Array.isArray(m.input)?m.input.filter(x=>['text','image','audio'].includes(x)):[]});
 function validate(value){if(!value||typeof value!=='object'||Array.isArray(value)||!['provider','modelId'].every(k=>typeof value[k]==='string'&&value[k].trim()&&value[k].length<=250))throw fail('需要有效的provider和modelId');return{provider:value.provider,modelId:value.modelId};}
 async function current(){const state=await rpc('get_state');return{active:identity(state.model),harness:'pi-rpc',busy:!!(state.isStreaming||state.isCompacting||state.pendingMessageCount>0)};}
 async function list(){const [available,state]=await Promise.all([rpc('get_available_models'),rpc('get_state')]);const models=(available.models||[]).filter(identity).map(publicModel);const active=identity(state.model);return{models,active,busy:!!(state.isStreaming||state.isCompacting||state.pendingMessageCount>0)};}
 async function select(value,{persist=true}={}){
  const requested=validate(value);
  if(!acquireMutation())throw fail('聊天正在运行或切换会话，请稍后选择模型',409);
  try{
   const state=await rpc('get_state');
   if(state.isStreaming||state.isCompacting||state.pendingMessageCount>0)throw fail('聊天正在运行，请先结束当前回复',409);
   const available=await rpc('get_available_models');
   const model=(available.models||[]).find(m=>m.provider===requested.provider&&m.id===requested.modelId);
   if(!model)throw fail('所选模型不在Pi当前可用列表中',400);
   // Lock spans both verification and RPC mutation; prompt/session entrypoints share it.
   await rpc('set_model',requested);
   const after=await rpc('get_state'),active=identity(after.model);
   if(active?.provider!==requested.provider||active?.modelId!==requested.modelId)throw fail('Pi尚未确认所选模型，请刷新当前状态',502);
   onActive(active);
   let warning;
   if(persist){let tmp;try{fs.mkdirSync(path.dirname(file),{recursive:true});tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(active,null,2));fs.renameSync(tmp,file);}catch{warning='模型已切换，但偏好保存失败；重启后可能恢复旧设置';if(tmp)try{fs.unlinkSync(tmp);}catch{}}}
   return{active,model:publicModel(model),...(warning?{warning}:{})};
  }finally{releaseMutation();}
 }
 async function restore(){let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return{restored:false};return{restored:false,error:'保存的聊天模型配置无效'};}
  try{return{restored:true,...await select(saved,{persist:false})};}catch(e){return{restored:false,error:e.message};}
 }
 function checkOrigin(req){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw fail('仅限本机访问',403);
  let host;try{host=new URL('http://'+req.headers.host);}catch{throw fail('无效Host',403);}
  if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname))throw fail('仅接受本机Host',403);
  if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{throw fail('来源无效',403);}if(origin.origin!==host.origin)throw fail('跨来源请求已拦截',403);}
  if(req.headers['sec-fetch-site']==='cross-site')throw fail('跨站请求已拦截',403);
 }
 async function handle(req,res,url){
  if(!['/api/chat/models','/api/chat/model'].includes(url.pathname))return false;
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{checkOrigin(req);
   if(url.pathname==='/api/chat/model'&&req.method==='GET'){send(200,await current());return true;}
   if(url.pathname==='/api/chat/models'&&req.method==='GET'){send(200,await list());return true;}
   if(url.pathname!=='/api/chat/model'||req.method!=='POST'){send(405,{error:'请求方法不支持'});return true;}
   if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw fail('需要application/json',415);
   const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>4096)throw fail('模型选择请求过大',413);chunks.push(Buffer.from(chunk));}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('JSON格式无效');}
   send(200,await select(body));
  }catch(e){send(e.status||503,{error:e.message||'Pi模型服务暂不可用'});}
  return true;
 }
 return{handle,current,list,select,restore};
}
module.exports={createChatModelService};
