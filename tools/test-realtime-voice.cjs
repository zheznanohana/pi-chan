const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),WebSocket=require('ws');
const path=require('path');const root=path.resolve(__dirname,'..');
const scope=vm.createContext({console,WebSocket,Float32Array,Int16Array,Uint8Array,ArrayBuffer,performance,setTimeout,clearTimeout,setInterval,clearInterval,window:{},document:{},cancelAnimationFrame(){},requestAnimationFrame(){return 1}});
vm.runInContext(fs.readFileSync(path.join(root,'voice-ui.js'),'utf8').replace('export class','class')+'\nglobalThis.Voice=VoiceUIController;',scope);
const results=[];
const pass=(name,details)=>{results.push({name,details,passed:true});console.log('PASS',name,details||'')};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const v=new scope.Voice();v.isVoiceModeActive=true;const phrases=[];
v.speakAgentReply=(text,options)=>phrases.push({text,options});
v.beginAgentSpeech();v.onAgentTextDelta('你好，我是小派。');
assert.ok(phrases.length);assert.equal(v.agentSpeechFinished,false);pass('First phrase emitted before agent_end');
v.onAgentTextDelta('现在边生成边说话');await sleep(300);assert.ok(phrases.some(p=>p.text==='现在边生成边说话'));pass('Unpunctuated phrase flushed within bounded wait');
v.onAgentTextDelta('。这是结尾');v.onAgentResponse('你好，我是小派。现在边生成边说话。这是结尾');
const text=phrases.map(p=>p.text).join('');assert.equal(text,'你好，我是小派。现在边生成边说话。这是结尾');const n=phrases.length;
v.onAgentResponse(text);assert.equal(phrases.length,n);pass('No duplicate final readback or lost tail');
v.beginAgentSpeech();phrases.length=0;
for(const delta of ['说明。``','`js\nsecret();\n`','``继续说话。'])v.onAgentTextDelta(delta);
v.onAgentResponse('');assert.equal(phrases.map(p=>p.text).join(''),'说明。继续说话。');pass('Fenced code split across token deltas is not spoken');
v.beginAgentSpeech();phrases.length=0;v.onAgentTextDelta('字'.repeat(350)+'。');v.onAgentResponse('');assert.equal(phrases.map(p=>p.text).join(''),'字'.repeat(350)+'。');pass('Long replies split without old 200-character truncation');
v.beginAgentSpeech();phrases.length=0;v.onAgentTextDelta('还没完成的句子');v.stopTtsPlayback();await sleep(300);assert.equal(phrases.length,0);pass('Cancellation clears pending sentence timers');
const direct=new scope.Voice();direct.currentVoiceKey='gpt-sovits-klee';direct.initTtsAudioContext=()=>{};const commands=[];direct.ws={readyState:1,send:s=>commands.push(JSON.parse(s))};
direct.speakAgentReply('实时测试。',{realtime:true,append:true});assert.equal(commands[0].voice,'gpt-sovits-klee');assert.equal(commands[0].append,true);
direct.speakAgentReply('试听测试。');assert.equal(commands[1].voice,'gpt-sovits-klee');pass('Explicit experimental voice honored for conversation and audition');
const ws=new WebSocket(`ws://127.0.0.1:${process.env.TEST_PORT||31416}/ws/audio`);const events=[];let audioBytes=0,firstPacketMs=null,requestAt;
ws.on('message',(data,binary)=>{if(binary){audioBytes+=data.length;if(firstPacketMs===null)firstPacketMs=performance.now()-requestAt;}else events.push(JSON.parse(data));});
const until=async(fn)=>{const deadline=Date.now()+20000;while(!fn()){if(Date.now()>deadline)throw Error('Timeout '+JSON.stringify(events));await sleep(10)}};
await until(()=>events.some(e=>e.type==='tts_ready'));requestAt=performance.now();
const sentences=['你好，我是小派。','我现在可以分句播报。','不必等整段回复生成完。'];
for(const text of sentences)ws.send(JSON.stringify({type:'tts_speak',append:true,text,voice:'vits-aishell3',sid:51}));
await until(()=>events.filter(e=>e.type==='tts_end').length===3);
assert.deepEqual(events.filter(e=>e.type==='tts_start').map(e=>e.text),sentences);assert.ok(audioBytes>10000);assert.ok(firstPacketMs<1500);
pass('Three queued phrases all return PCM in order',{firstPacketMs:Math.round(firstPacketMs),audioBytes,totalGenerationMs:Math.round(performance.now()-requestAt)});ws.close();
const sherpa=require('sherpa-onnx-node'),asr=require('../asr-engine');const wav=sherpa.readWave(path.join(root,'audio-debug/test-zh.wav'));
let endpoint=null;let samplesFed=0;const finals=[];const session=asr.createSession({onFinal:event=>{if(event.isEndpoint){endpoint={...event,samplesFed};finals.push(endpoint)}}});
const pcm=Buffer.alloc((wav.samples.length+16000)*2);let lastVoiced=0;for(let i=0;i<wav.samples.length;i++){pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(wav.samples[i]*32767))),i*2);if(Math.abs(wav.samples[i])>0.015)lastVoiced=i;}
for(let i=0;i<pcm.length;i+=2048){const chunk=pcm.subarray(i,i+2048);samplesFed+=chunk.length/2;session.feedPCM(chunk)}
await session.pendingFinals;assert.ok(endpoint?.text);assert.ok(finals.map(e=>e.text).join('').includes('研究感兴趣'));assert.ok(endpoint.refined);pass('Real ASR auto-finalizes without asr_finish',{text:finals.map(e=>e.text).join(''),endpointAfterLastVoicedMs:Math.round((endpoint.samplesFed-lastVoiced)/16)});await session.finish();
fs.writeFileSync(path.join(root,'realtime-voice-test-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
})().catch(e=>{console.error(e);process.exit(1)});

