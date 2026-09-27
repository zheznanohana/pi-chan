'use strict';
const {randomUUID,createHash}=require('node:crypto');
function createJevRuntime({agent,broadcast=()=>{}}){
 const turns=new Map();
 function analyze(message,sessionId){
  const correlationId=randomUUID(),inputHash=createHash('sha256').update(message.trim()).digest('hex');
  const turn={correlationId,inputHash,started:Date.now(),companion:null};turns.set(sessionId,turn);
  if(turns.size>1000)turns.delete(turns.keys().next().value);
  broadcast('jev_judgment',{status:'evaluating',sessionId,correlationId});
  turn.promise=Promise.resolve().then(()=>agent.routeTask(message,{sessionId,correlationId})).then(route=>{
   if(turns.get(sessionId)!==turn)return;
   turn.companion=route.companion||null;
   broadcast('jev_decision',{...route,sessionId,correlationId,latencyMs:Date.now()-turn.started});
  }).catch(()=>{if(turns.get(sessionId)===turn)broadcast('jev_judgment',{status:'error',sessionId,correlationId});});
  return correlationId;
 }
 async function profile(sessionId,inputHash,waitMs=0){
  const turn=turns.get(sessionId);if(!turn||turn.inputHash!==inputHash)return null;
  if(!turn.companion&&waitMs>0)await Promise.race([turn.promise,new Promise(r=>setTimeout(r,Math.min(400,waitMs)))]);
  if(turns.get(sessionId)!==turn)return null;
  const p=turn.companion;
  return p&&p.usable&&p.expiresAt>Date.now()&&p.inputHash===inputHash?p:null;
 }
 return {analyze,profile};
}
module.exports={createJevRuntime};
