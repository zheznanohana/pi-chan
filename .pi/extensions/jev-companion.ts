import policy from '../../jev-companion-policy.cjs';
export default function jevCompanion(pi) {
 pi.on('context',async(event,ctx)=>{
  const messages=event.messages.filter(m=>m.customType!=='pichan-jev-companion');
  const latest=[...messages].reverse().find(m=>m.role==='user');
  const text=typeof latest?.content==='string'?latest.content:(latest?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  if(!text.trim())return {messages};
  try {
   const port=Number(process.env.PICHAN_MEMORY_PORT||process.env.PORT||31415);
   if(!Number.isInteger(port)||port<1||port>65535)return {messages};
   const sessionId=ctx.sessionManager.getSessionId(),inputHash=policy.hashInput(text);
   const params=new URLSearchParams({sessionId,inputHash});
   const response=await fetch(`http://127.0.0.1:${port}/api/jev/companion?${params}`,{signal:AbortSignal.timeout(600)});
   if(!response.ok)return {messages};
   const {companion}=await response.json();
   if(!policy.isFresh(companion,{inputHash,sessionId}))return {messages};
   const content=policy.companionHint(companion);
   if(content)messages.push({role:'custom',customType:'pichan-jev-companion',content,display:false,timestamp:Date.now()});
  }catch{} // Optional style hints never block ordinary conversation.
  return {messages};
 });
}
