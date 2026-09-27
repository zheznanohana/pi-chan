'use strict';
// One warm local clone runtime at a time: avoids double GPU residency.
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),path=require('node:path'),fs=require('node:fs'),readline=require('node:readline');
const PYTHON=fs.existsSync('E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe')?'E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe':'python';
// Explicit rollback is available without changing the selected voice.
const qwenBackend=process.env.QWEN_TTS_BACKEND||'native-stream';
const scripts={'qwen3-clone':qwenBackend==='native-stream'?'qwen3-native-stream-server.py':'qwen3-server.py','gpt-sovits-klee':'gpt-sovits-stream-server.py'};
let current=null,queue=Promise.resolve(),idleTimer;
// Models stay warm after successful playback. Optional positive override is for
// memory-constrained installations; normal idle is not a reason to reload weights.
const idleUnloadMs=Number(process.env.PICHAN_TTS_IDLE_UNLOAD_MS||0);
function close(){clearTimeout(idleTimer);if(current){const state=current;current=null;if(process.platform==='win32')spawn('taskkill',['/PID',String(state.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else state.child.kill();}}
function runtime(voice){
 if(!Object.hasOwn(scripts,voice))throw new Error('未知克隆音色: '+voice);
 if(current?.voice===voice)return current;
 close();const child=spawn(PYTHON,['-u',path.join(__dirname,scripts[voice])],{cwd:__dirname,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']});
 const state={voice,child,onMessage:null};current=state;
 child.stderr.on('data',d=>{state.lastError=String(d).slice(-1500);});
 readline.createInterface({input:child.stdout}).on('line',line=>{try{state.onMessage?.(JSON.parse(line));}catch(e){if(e instanceof SyntaxError)return;state.fail?.(e);}});
 child.on('error',e=>state.fail?.(e));child.on('exit',code=>{if(current===state)current=null;state.fail?.(new Error('克隆语音进程结束 '+code+' '+(state.lastError||'')));});return state;
}
function synthesize(voice,text,options={}){
 const run=()=>new Promise((resolve,reject)=>{
  if(options.signal?.aborted)return reject(new Error('语音已取消'));
  clearTimeout(idleTimer);const started=Date.now(),state=runtime(voice),id=randomUUID();let samples=0,firstPacketMs=null,index=0,rate=voice==='qwen3-clone'?24000:48000,settled=false;
  const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);state.onMessage=null;state.fail=null;if(Number.isFinite(idleUnloadMs)&&idleUnloadMs>0){idleTimer=setTimeout(close,idleUnloadMs);idleTimer.unref();}};
  const finish=(error)=>{if(settled)return;settled=true;cleanup();if(error){if(current===state)close();reject(error);return;}const stats={voice,sid:0,sampleRate:rate,totalMs:Date.now()-started,firstPacketMs,totalSamples:samples,durationSec:samples/rate};try{options.onDone?.(stats);resolve(stats);}catch(e){reject(e);}};
  const cancel=()=>finish(new Error('语音已取消'));
  const timer=setTimeout(()=>finish(new Error('克隆语音等待超时，请换快速音色或检查模型日志')),240000);
  state.fail=error=>finish(error);
  options.signal?.addEventListener('abort',cancel,{once:true});
  state.onMessage=m=>{if(['loading','ready','warming'].includes(m.event)){options.onStatus?.({phase:m.event,voice});return;}if(m.event==='error'&&!m.id){finish(new Error(m.error||'模型加载失败'));return;}if(m.id!==id)return;if(m.error||m.event==='error'){finish(new Error(m.error||m.message));return;}if(m.event==='chunk'){
   if(typeof m.pcm16Base64!=='string')throw Error('无效PCM编码');
   const pcm=Buffer.from(m.pcm16Base64,'base64');if(!pcm.length||pcm.length%2)throw Error('无效PCM片段');
   if(!Number.isInteger(m.sampleRate)||m.sampleRate<8000||m.sampleRate>96000||(samples&&m.sampleRate!==rate))throw Error('无效或变化的PCM采样率');
   rate=m.sampleRate;if(firstPacketMs===null)firstPacketMs=Date.now()-started;samples+=pcm.length/2;
   const floatSamples=new Float32Array(pcm.length/2);for(let i=0;i<floatSamples.length;i++)floatSamples[i]=pcm.readInt16LE(i*2)/32768;
   options.onChunk?.({pcmBuffer:pcm,floatSamples,sampleRate:rate,chunkIndex:++index,latencyMs:Date.now()-started,firstPacketMs,progress:0,voice,sid:0});
  }else if(m.event==='end'){if(m.eosReached===false||m.tokenLimitReached||m.contextLimitReached)finish(new Error('语音生成未完整结束，请缩短句子或切换快速音色'));else if(!samples)finish(new Error('模型未返回音频'));else finish();}};
  // stdin buffers while the resident model loads. Subsequent sentences reuse it.
  state.child.stdin.write(JSON.stringify({id,text,speed:options.speed||1,language:'Auto'})+'\n',e=>{if(e)finish(e)});
 });
 const result=queue.then(run,run);queue=result.catch(()=>{});return result;
}
module.exports={synthesize,close};
