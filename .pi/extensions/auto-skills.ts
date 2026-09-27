import router from '../../integration/skill-router.cjs';
// Transient context only: switching topics removes the previous turn's selected skills.
export default function autoSkills(pi){
 pi.on('context',async(event,ctx)=>{
  const messages=router.applySelection(event.messages,null);
  const latest=[...messages].reverse().find(m=>m.role==='user');
  const text=typeof latest?.content==='string'?latest.content:(latest?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if(!text.trim())return {messages};
  try{
   const port=Number(process.env.PICHAN_MEMORY_PORT||process.env.PORT||31415);
   if(!Number.isInteger(port)||port<1||port>65535)return {messages};
   const response=await fetch(`http://127.0.0.1:${port}/api/skills/context`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,sessionId:ctx.sessionManager.getSessionId(),cwd:ctx.cwd}),signal:AbortSignal.timeout(6500)});
   if(!response.ok)return {messages};
   const result=await response.json();return {messages:router.applySelection(messages,result.selection||result)};
  }catch{return {messages};}
 });
}
