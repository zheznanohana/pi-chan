const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const results=[];const ctx=vm.createContext({console,Float32Array,Int16Array,Uint8Array,ArrayBuffer,URL,AbortController,performance:{now:()=>1000},setTimeout,clearTimeout,cancelAnimationFrame(){},window:{},WebSocket:{OPEN:1},fetch:async()=>({ok:true})});
vm.runInContext(fs.readFileSync('voice-ui.js','utf8').replace('export class','class')+'\nglobalThis.Voice=VoiceUIController;',ctx);
const v=new ctx.Voice();v.isRecording=true;v.isVoiceModeActive=true;v.micAudioCtx={sampleRate:16000};v.isTtsPlaying=true;v.playbackStartedAt=0;
let messages=[],stops=0;v.ws={readyState:1,send:x=>messages.push(x)};v.ttsActiveSources=[{stop(){stops++},disconnect(){}}];
const quiet=new Float32Array(1024).fill(.002);for(let i=0;i<10;i++)v.handleMicChunk(quiet);assert.equal(stops,0);results.push('silence does not interrupt');
const short=new Float32Array(1024).fill(.08);v.handleMicChunk(short);v.handleMicChunk(quiet);assert.equal(stops,0);results.push('brief transient does not interrupt');
for(let i=0;i<3;i++)v.handleMicChunk(short);assert.equal(stops,1);assert.equal(v.speechInterrupted,true);assert.ok(messages.some(x=>typeof x==='string'&&JSON.parse(x).type==='asr_reset'));assert.ok(messages.filter(x=>x instanceof ArrayBuffer).reduce((n,b)=>n+b.byteLength,0)>=6144);results.push('192ms sustained voice cancels output and replays initial words');
const before=messages.length;v.onAgentTextDelta('这是旧回复');v.onAgentResponse('这是旧回复');assert.equal(messages.length,before);results.push('late old reply does not restart speech');
v.beginAgentSpeech();assert.equal(v.speechInterrupted,false);results.push('next reply is enabled');
const ref=new Float32Array(16000);let seed=1;for(let i=0;i<ref.length;i++){seed=(seed*16807)%2147483647;ref[i]=(seed/2147483647-.5)*.4;}
v.ttsAudioCtx={currentTime:.5};v.echoReference=[{start:0,sampleRate:16000,samples:ref}];v.isTtsPlaying=true;v.playbackStartedAt=0;v.resetBargeIn();
const echo=ref.slice(Math.round((.5-.064-.12)*16000),Math.round((.5-.12)*16000));for(let i=0;i<8;i++)assert.equal(v.detectBargeIn(echo,16000),null);results.push('correlated 120ms speaker echo suppressed');
const {SharedState}=require('../pet/shared-state.cjs');const shared=new SharedState();let events=0;shared.on('change',()=>events++);shared.patch({voiceSettings:{asrEnabled:false,cloneVoiceKey:'qwen3-clone'},captureOwner:'dashboard'});shared.patch({voiceSettings:{asrEnabled:false}});assert.equal(events,1);shared.patch({mouth:NaN,captureOwner:'evil'});assert.equal(events,1);assert.equal(shared.value.voiceSettings.cloneVoiceKey,'qwen3-clone');results.push('shared settings merge, no feedback loop, invalid patch rejected');
fs.writeFileSync('barge-sync-test-results.json',JSON.stringify({at:new Date().toISOString(),results},null,2));console.log('PASS',results);
