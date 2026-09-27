'use strict';
const fs=require('node:fs'),path=require('node:path');
function createMemoryContext({service,file,broadcast=()=>{},governance=null}){
 let scopes=Object.create(null);try{Object.assign(scopes,JSON.parse(fs.readFileSync(file,'utf8')));}catch{}
 const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
 function bind(sessionId,projectId,enabled=false){
  if(!validId(sessionId)||!validId(projectId))throw Error('无效的会话或项目标识');
  if(service.getProjects && !service.getProjects().some(p=>p.id===projectId))throw Error('项目不存在');
  scopes[sessionId]={projectId,enabled:enabled===true};
  const entries=Object.entries(scopes);if(entries.length>2000)scopes=Object.fromEntries(entries.slice(-2000));
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(scopes));fs.renameSync(tmp,file);
 }
 async function retrieve({sessionId,query,candidateComplete=true}){
  if(typeof query!=='string'||!query.trim())return {text:'',sources:[]};
  if(!validId(sessionId))return {text:'',sources:[]};
  const scope=scopes[sessionId];
  if(!scope||scope.enabled!==true)return {text:'',sources:[]};
  const projectId=scope.projectId;
  if(governance&&candidateComplete===true&&query.length<=4000)Promise.resolve().then(()=>governance.ingest({projectId,sessionId,text:query,role:'user',source:'conversation'})).catch(()=>{});
  const result=await service.context({projectId,query:query.slice(-500),maxChars:5000,sessionId});
  broadcast('memory_retrieval',{sessionId,projectId,count:result.sources?.length||0,sources:result.sources||[]});
  return result;
 }
 async function handle(req,res,url){
  if(!['/api/memory/context','/api/memory/session-project'].includes(url.pathname))return false;
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){json(403,{error:'仅限本地请求'});return true;}
  if(req.method!=='POST'){json(405,{error:'POST required'});return true;}
  if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)throw Error();}catch{json(403,{error:'跨站请求已拦截'});return true;}}
  try{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768){json(413,{error:'请求过大'});return true;}}
   const input=JSON.parse(body||'{}');
   if(url.pathname.endsWith('/context'))json(200,await retrieve(input));
   else{bind(input.sessionId,input.projectId,input.enabled);json(200,{ok:true});}
  }catch(error){json(400,{error:error.message});}
  return true;
 }
 return {bind,retrieve,handle,getScope:sessionId=>validId(sessionId)&&scopes[sessionId]?{...scopes[sessionId]}:null};
}
module.exports={createMemoryContext};
