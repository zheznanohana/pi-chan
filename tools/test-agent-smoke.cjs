const fs=require('fs');
(async()=>{
 const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),45000);
 let text='',done=false;
 try{
 const response=await fetch('http://127.0.0.1:31415/api/stream',{signal:ac.signal});
 const reader=response.body.getReader();
 const prompt=await fetch('http://127.0.0.1:31415/api/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'请仅回复：语音连接正常。不要调用任何工具。'})});
 if(!prompt.ok)throw new Error(await prompt.text());
 let buffer='';const decoder=new TextDecoder();
 while(!done){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let index;
 while((index=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,index);buffer=buffer.slice(index+2);for(const line of packet.split('\n')){if(!line.startsWith('data: '))continue;const event=JSON.parse(line.slice(6));if(event.type!=='pi_event')continue;const ev=event.payload;if(ev.type==='message_update'&&ev.assistantMessageEvent?.type==='text_delta')text+=ev.assistantMessageEvent.delta;if(ev.type==='agent_end'){done=true;}}}}
 console.log(JSON.stringify({agentCompleted:done,text}));
 fs.writeFileSync('voice-fix-agent-result.json',JSON.stringify({at:new Date().toISOString(),agentCompleted:done,text},null,2));
 if(!done||!text)process.exitCode=1;
 }finally{clearTimeout(timer);ac.abort();}
})().catch(e=>{console.error(e);process.exitCode=1});
