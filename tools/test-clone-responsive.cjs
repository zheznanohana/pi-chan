const WebSocket=require('ws');
const ws=new WebSocket('ws://127.0.0.1:31416/ws/audio');
const start=Date.now();let requested=false;let bytes=0;let heartbeat=false;
const timer=setTimeout(()=>{console.error('clone test timeout');ws.close();process.exitCode=1},180000);
ws.on('message',async(data,binary)=>{
 if(binary){bytes+=data.length;return;}
 const m=JSON.parse(data);
 if(m.type==='tts_ready'&&!requested){requested=true;ws.send(JSON.stringify({type:'tts_speak',text:'你好呀，我是小派。',voice:'gpt-sovits-klee'}));
 setTimeout(async()=>{const t=Date.now();try{const r=await fetch('http://127.0.0.1:31416/api/tts/info',{signal:AbortSignal.timeout(3000)});heartbeat=r.ok;console.log('HTTP responsive during clone:',r.status,Date.now()-t,'ms')}catch(e){console.error(e.message)}},1500);}
 if(m.type==='tts_end'||m.type==='tts_error'){console.log(JSON.stringify({event:m,pcmBytes:bytes,heartbeat,wallMs:Date.now()-start}));clearTimeout(timer);ws.close();if(m.type==='tts_error'||!bytes||!heartbeat)process.exitCode=1;}
});
