'use strict';
function createWorkbenchActivity({status,now=()=>Date.now()}){
 const clients=new Map();let lastHealthAt=-Infinity,lastReady=false;
 function update(value){
  if(typeof value?.clientId!=='string'||value.clientId.length>100)throw Error('Invalid activity client');
  if(clients.size>100)clients.delete(clients.keys().next().value);
  clients.set(value.clientId,{connected:value.connected===true,busy:value.isStreaming===true||value.othersBusy===true,at:now()});
 }
 async function isBusy(){
  if(now()-lastHealthAt>5000){lastReady=!!(await status()).ready;lastHealthAt=now();}
  if(!lastReady)return false;
  const fresh=[...clients.values()].filter(x=>now()-x.at<30000&&x.connected);
  // If a live backend has no observer, don't assume its invisible jobs are idle.
  return !fresh.length||fresh.some(x=>x.busy);
 }
 return {update,isBusy};
}
module.exports={createWorkbenchActivity};
