const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const results = [];
function passed(name, details) { results.push({ name, passed: true, details }); console.log('PASS', name, details || ''); }
function loadClass(file, className, extra = {}) {
  const context = vm.createContext({ console, WebSocket, Float32Array, Int16Array, Uint8Array, ArrayBuffer, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 800 },
    document: { getElementById: () => null }, localStorage: { getItem: () => null }, ...extra });
  let src = fs.readFileSync(path.join(root, file), 'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace(/export\s+(class|const|function)/g, '$1').replace(/^export \{.*\};?$/gm, '');
  vm.runInContext(src + `\nglobalThis.TestClass = ${className};`, context);
  return { Class: context.TestClass, context };
}
async function main() {
  const {Class: Voice} = loadClass('voice-ui.js', 'VoiceUIController');
  const voice = new Voice();
  let total = 0;
  for (let i=0;i<100;i++) total += voice.resampleFloatTo16kPCM(new Float32Array(2048), 44100).byteLength / 2;
  assert.ok(Math.abs(total - 204800 * 16000/44100)<1);
  passed('Resampling returns exact PCM length', total);
  const {Class: Settings} = loadClass('settings-panel.js','VoiceSettingsPanel');
  let silence;
  const stub = { handleMicChunk: data => {silence=data}, speakAgentReply(){}, startMicRecording(){}, updateMeter(){} };
  const settings = new Settings({voiceUI:stub}); settings.hookVoiceUI(); stub.handleMicChunk(new Float32Array(2048).fill(0.001));
  assert.equal(silence.length,2048); assert.ok(silence.every(v=>Math.abs(v-0.001)<1e-7));
  passed('Quiet phonemes retained without destructive gating');
  let stopped=0,disconnected=0;
  voice.ttsActiveSources=[{stop(){stopped++},disconnect(){disconnected++}}];
  voice.stopTtsPlayback();assert.equal(stopped,1);assert.equal(disconnected,1);assert.equal(voice.ttsActiveSources.length,0);
  passed('Stopping playback stops real audio sources');
  let handler;
  const {Class: Model} = loadClass('live2d-controller.js','PiChanLive2D',{window:{innerWidth:1200,innerHeight:800,addEventListener(type,cb){if(type==='pointermove')handler=cb}}});
  const model=new Model('canvas');model.viewer={};model.canvas={getBoundingClientRect:()=>({left:0,top:0,width:1200,height:800})};model.bindGlobalPointerTracking();
  handler({clientX:1100,clientY:100}); assert.ok(model.targetParams.ParamEyeBallX>0);assert.ok(model.targetParams.ParamAngleY>0);
  const applied={};
  const {Class: Emotion}=loadClass('emotion-bridge.js','SoullinkEmotionBridge');
  const emotion=new Emotion({controller:{viewer:{setParameter(id,v){applied[id]=v},renderNow(){}}}});
  emotion.applySnapshot({live2dParams:{ParamAngleX:0,ParamEyeBallX:0,ParamMouthOpenY:1,ParamBrowLY:0.5},vad:{current:{valence:0,arousal:0,dominance:0}}},1);
  assert.equal(applied.ParamAngleX,undefined);assert.equal(applied.ParamEyeBallX,undefined);assert.equal(applied.ParamMouthOpenY,undefined);assert.equal(applied.ParamBrowLY,0.5);
  passed('Pointer updates pose; emotion does not overwrite tracking or lip sync');
  assert.ok(!fs.readFileSync(path.join(root,'index.html'),'utf8').includes('id="resultPanel"'));
  passed('Duplicate result panel removed');
  const asr = require('../asr-engine'); const sherpa=require('sherpa-onnx-node');
  const wave=sherpa.readWave(path.join(root,'audio-debug/test-zh.wav'));
  const pcm=Buffer.alloc(wave.samples.length*2);
  for(let i=0;i<wave.samples.length;i++)pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(wave.samples[i]*32767))),i*2);
  const recognized=[];const session=asr.createSession({onFinal:({text})=>recognized.push(text)});
  // Int16Array path used by desktop wake engine.
  session.feedPCM(new Int16Array(pcm.buffer,pcm.byteOffset,pcm.length/2));await session.finish();
  assert.ok(recognized.join('').length>3);passed('Real ASR accepts Int16 IPC audio and flushes tail',recognized);
  const {WakeEngine}=require('../pet/wake-engine');const wake=new WakeEngine();let dispatched='';
  wake.asrEngine={createSession(cb){cb.onPartial({text:'测试'});return{finish(){cb.onFinal({text:'测试完成'})}}}};
  wake.kws={createStream:()=>({})};wake.dispatchToAgent=text=>{dispatched=text};wake.handleWakeDetected('小派小派');await wake.finishCommand('test');
  assert.equal(dispatched,'测试完成');passed('Wake engine unwraps callbacks and flushes before dispatch');
  const port=process.env.TEST_PORT||31416;
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/audio`);const events=[];let bytes=0;
  ws.on('message',(data,binary)=>{if(binary)bytes+=data.length;else events.push(JSON.parse(data));});
  const until=async pred=>{const end=Date.now()+20000;while(!pred()){if(Date.now()>end)throw new Error('Timed out: '+JSON.stringify(events));await new Promise(r=>setTimeout(r,20));}};
  await until(()=>events.some(e=>e.type==='asr_ready'));
  for(let round=1;round<=2;round++){
    for(let i=0;i<pcm.length;i+=4096)ws.send(pcm.subarray(i,i+4096));
    ws.send(JSON.stringify({type:'asr_finish'}));
    await until(()=>events.filter(e=>e.type==='asr_finished').length>=round);
  }
  assert.equal(events.filter(e=>e.type==='asr_final').map(e=>e.text).join(''), recognized.join('').repeat(2));
  passed('Same WebSocket recognizes two consecutive utterances',events.filter(e=>e.type==='asr_final').map(e=>e.text));
  ws.send(JSON.stringify({type:'tts_speak',text:'你好，这是播放测试。',voice:'vits-aishell3',sid:51}));
  await until(()=>events.some(e=>e.type==='tts_end'));assert.ok(bytes>1000);assert.ok(!events.some(e=>e.type==='tts_error'));
  passed('Real WebSocket TTS returns playable PCM',bytes);ws.close();
  const res=await fetch(`http://127.0.0.1:${port}/api/tts/synthesize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'你好',voice:'vits-aishell3'})});
  assert.equal(res.status,200);const info=await res.json();const wavRes=await fetch(`http://127.0.0.1:${port}${info.url}`);const wav=Buffer.from(await wavRes.arrayBuffer());
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.ok(wav.length>44);passed('HTTP synthesis serves a valid nonempty WAV',wav.length);
  fs.writeFileSync(path.join(root,'voice-fix-test-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});

