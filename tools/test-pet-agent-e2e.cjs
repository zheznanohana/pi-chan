const fs=require('fs'),vm=require('vm'),WebSocket=require('ws'),assert=require('node:assert/strict');
const path=require('path');const root=path.resolve(__dirname,'..');
const context=vm.createContext({console,WebSocket,performance,setTimeout,clearTimeout,window:{},document:{},cancelAnimationFrame(){}});
vm.runInContext(fs.readFileSync(path.join(root,'voice-ui.js'),'utf8').replace('export class','class')+'\nglobalThis.Voice=VoiceUIController',context);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const voice=new context.Voice();voice.isVoiceModeActive=true;voice.currentVoiceKey='gpt-sovits-klee';voice.initTtsAudioContext=()=>{};
 const ws=new WebSocket('ws://127.0.0.1:31415/ws/audio');voice.ws=ws;
 const metrics={firstTextMs:null,firstSpeechRequestMs:null,firstPcmMs:null,agentEndMs:null,pcmBytes:0,phrases:[],speechVoices:[]};let start=null,ready=false,text='';
 const send=ws.send.bind(ws);ws.send=data=>{const m=JSON.parse(data);if(m.type==='tts_speak'){if(metrics.firstSpeechRequestMs===null)metrics.firstSpeechRequestMs=Math.round(performance.now()-start);metrics.phrases.push(m.text);metrics.speechVoices.push(m.voice)}return send(data)};
 ws.on('message',(data,binary)=>{if(binary){if(metrics.firstPcmMs===null)metrics.firstPcmMs=Math.round(performance.now()-start);metrics.pcmBytes+=data.length;}else{const m=JSON.parse(data);if(m.type==='tts_ready')ready=true;voice.handleIncomingMessage(m)}});
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});while(!ready)await wait(10);
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),60000);
 try{
 const response=await fetch('http://127.0.0.1:31415/api/stream',{signal:abort.signal});const reader=response.body.getReader();
 start=performance.now();voice.speechEndTimestamp=start;
 const prompt=await fetch('http://127.0.0.1:31415/api/agent/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'pet-wake',message:'不要调用任何工具。请用八句简短中文介绍春天散步的感受，每句约十五个字，不要编号。第一句直接说你好，今天我们一起去公园散步。'})});
 assert.equal(prompt.status,200);let buffer='';const decoder=new TextDecoder();
 while(metrics.agentEndMs===null){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let n;
 while((n=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,n);buffer=buffer.slice(n+2);for(const line of packet.split('\n')){
 if(!line.startsWith('data: '))continue;const message=JSON.parse(line.slice(6));if(message.type!=='pi_event')continue;const e=message.payload;
 assert.equal(e.source,'pet-wake');if(e.type==='agent_start')voice.beginAgentSpeech();
 if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta'){if(metrics.firstTextMs===null)metrics.firstTextMs=Math.round(performance.now()-start);text+=e.assistantMessageEvent.delta;voice.onAgentTextDelta(e.assistantMessageEvent.delta)}
 if(e.type==='agent_end'){metrics.agentEndMs=Math.round(performance.now()-start);voice.onAgentResponse(text)}
 }}}
 const deadline=Date.now()+20000;while(voice.pendingTtsRequests&&Date.now()<deadline)await wait(20);
 assert.ok(metrics.pcmBytes>1000);assert.equal(voice.pendingTtsRequests,0);assert.ok(metrics.speechVoices.every(v=>v==='vits-aishell3'));
 metrics.firstAudioBeforeAgentEnd=metrics.firstPcmMs<metrics.agentEndMs;metrics.textToFirstPcmMs=metrics.firstPcmMs-metrics.firstTextMs;
 metrics.replyText=text;metrics.at=new Date().toISOString();
 console.log(JSON.stringify(metrics,null,2));fs.writeFileSync(path.join(root,'pet-agent-e2e-results.json'),JSON.stringify(metrics,null,2));
 }finally{clearTimeout(timer);abort.abort();ws.close()}
})().catch(e=>{console.error(e);process.exit(1)});
