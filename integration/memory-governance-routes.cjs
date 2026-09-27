'use strict';
function createMemoryGovernanceRoutes({manager,checkRequest}){
 return async function handle(req,res,url){
  if(!url.pathname.startsWith('/api/memory/governance'))return false;
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   checkRequest(req);
   const projectId=url.searchParams.get('projectId')||'default';
   if(req.method==='GET'&&url.pathname==='/api/memory/governance'){send(200,{...manager.status(),candidates:manager.list({projectId,limit:100})});return true;}
   if(req.method!=='POST'){send(405,{error:'POST required'});return true;}
   let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>12000)throw Object.assign(Error('请求过大'),{status:413});parts.push(chunk);}
   const input=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
   if(url.pathname==='/api/memory/governance/maintain')send(200,await manager.maintain({projectId,retry:true,limit:20}));
   else if(url.pathname==='/api/memory/governance/review')send(200,await manager.review({id:input.id,projectId,action:input.action}));
   else send(404,{error:'记忆管理接口不存在'});
  }catch(e){send(e.status||400,{error:e.status?e.message:'记忆整理未完成，请检查候选状态后重试'});}
  return true;
 };
}
module.exports={createMemoryGovernanceRoutes};
