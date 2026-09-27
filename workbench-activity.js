// Read-only execution telemetry for the cross-harness scheduler; no prompts/drafts.
const clientId=crypto.randomUUID();let state=null;
function report(){if(!state)return;fetch('/api/workbench/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,...state}),keepalive:true}).catch(()=>{});}
window.addEventListener('message',event=>{
 const frame=document.querySelector('.workbench-home iframe');
 if(event.origin!==location.origin||event.source!==frame?.contentWindow||event.data?.source!=='pichan-workbench')return;
 const {event:kind,detail={}}=event.data;
 if(kind==='status'){state={...state,connected:true,isStreaming:!!detail.isStreaming};report();}
 if(kind==='conversations'){state={...state,othersBusy:[...(detail.conversations||[]),...(detail.elsewhere||[])].some(c=>c.isStreaming)};report();}
 if(kind==='connection'){state={...state,connected:!!detail.connected};report();}
});
const timer=setInterval(report,10000);
window.addEventListener('pagehide',()=>{clearInterval(timer);state={connected:false,isStreaming:false};report();});
