import { VoiceUIController } from '../voice-ui.js';
import { PetAnimator } from './pet-animator.js';
const api = window.petAPI || window.electronPet;
const preview = !api;
if(preview){document.body.classList.add('preview');if(new URLSearchParams(location.search).get('bg')==='dark')document.documentElement.style.background='#17202f';}
const sprite = document.getElementById('sprite');
const character = document.getElementById('character');
const bubble = document.getElementById('speechBubble');
document.body.dataset.state = 'idle';
let sharedState={}, peerSpeaking=false, peerMouth=0, micCleanup=null, micGeneration=0;
let state = 'idle', activityAt = Date.now(), transientUntil = 0, blinkUntil = 0, mouth = 0;
let nextBlink = Date.now() + 2500, bubbleTimer, isListening = true, ownReply = false;
const frames = {idle:1, listening:3, thinking:4, speaking:5, happy:7, sleepy:8};
for (let n = 1; n <= 24; n++) { const img = new Image(); img.src = framePath(n); }
function framePath(n) { return `assets/pet/chibi-v2/actions_frames/frame_${String(n).padStart(3,'0')}.png`; }
function setState(next, duration = 0) {
  if (state === next && !duration) return;
  state = next; activityAt = Date.now(); transientUntil = duration ? activityAt + duration : 0;
  document.body.dataset.state = state;
}
function showBubble(label, text, duration = 0) {
  clearTimeout(bubbleTimer); document.getElementById('bubbleLabel').textContent = label;
  document.getElementById('bubbleText').textContent = text; bubble.classList.remove('hidden');
  if (duration) bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), duration);
}
const avatar = { isSpeaking:false, stopSpeaking(){this.isSpeaking=false;mouth=0;}, viewer:{setParameter(id,value){if(id==='ParamMouthOpenY')mouth=value;},renderNow(){}} };
const voice = new VoiceUIController({live2d:avatar,serverUrl:'http://127.0.0.1:31415'});
if(window.piShared){
  const receive=async data=>{
    const before=sharedState.voiceSettings?.inputDeviceId;
    sharedState=data;peerSpeaking=data.speaking&&!ownReply;peerMouth=data.mouth||0;
    const prefs=data.voiceSettings;
    if(prefs){
      isListening=prefs.asrEnabled!==false;
      document.getElementById('listen').setAttribute('aria-pressed',String(isListening));
      voice.setAsrProvider(prefs.asrProvider||'local');
      voice.currentVoiceKey=prefs.voiceKey||'vits-aishell3';voice.currentSid=prefs.speakerId??51;
      voice.outputDeviceId=prefs.outputDeviceId||'default';
      localStorage.setItem('pichan_voice_settings',JSON.stringify(prefs));
      if(!prefs.ttsEnabled && voice.isTtsPlaying)voice.stopTtsPlayback();
      if(voice.ttsAudioCtx?.setSinkId)await voice.ttsAudioCtx.setSinkId(voice.outputDeviceId==='default'?'':voice.outputDeviceId).catch(err=>showBubble('输出设备',err.message,5000));
      if(before!==undefined&&before!==prefs.inputDeviceId&&!preview)startMicCapture();
    }
    if(data.captureOwner==='dashboard'&&data.transcript)showBubble(data.transcriptFinal?'收到啦':'正在听',data.transcript);
  };
  window.piShared.subscribe(receive);window.piShared.getState().then(receive);
}
const speakOriginal=voice.speakAgentReply.bind(voice);
voice.speakAgentReply=(text,options)=>{if(sharedState.voiceSettings?.ttsEnabled!==false)speakOriginal(text,options);};
voice.onBargeIn=()=>{ownReply=false;setState('listening');showBubble('我在听','上一段已打断，请继续说。');};
voice.showNotice=text=>showBubble('语音提示',text,6000);
if (!preview) voice.init();
let lastFrame = 0, tick, lastTime=performance.now(), smoothedMouth=0;
const animator = new PetAnimator(performance.now());
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mouthSvg = document.getElementById('mouthOverlay');
const mouthShape = document.getElementById('mouthShape');
function animate(now) {
  const wall = Date.now(), dt=Math.min(50,Math.max(0,now-lastTime));lastTime=now;
  if (transientUntil && wall > transientUntil) setState('idle');
  if (state === 'idle' && wall-activityAt>45000) setState('sleepy');
  const speaking=voice.isTtsPlaying || peerSpeaking || state==='speaking';
  animator.setTarget(speaking?'idle':state,now);
  const n=animator.update(now,reducedMotion.matches);
  if(n!==lastFrame){sprite.src=framePath(n);lastFrame=n;}
  // Exponential smoothing keeps mouth movement independent of display frame rate.
  const goal=speaking ? (voice.isTtsPlaying?mouth:peerSpeaking?peerMouth:(.35+.3*Math.sin(now/95))) : 0;
  smoothedMouth+=(goal-smoothedMouth)*(1-Math.exp(-dt/55));
  mouthSvg.style.opacity=speaking && n<=6 && smoothedMouth>.025?'1':'0';
  mouthShape.setAttribute('ry',String(.6+Math.min(1,smoothedMouth)*5));
  tick=requestAnimationFrame(animate);
}
tick=requestAnimationFrame(animate);
function pet() { setState('happy',1500); showBubble('小派','嘿，我在呢。',2500); }
character.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pet();}});
let drag;
character.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.screenX,y:e.screenY,moved:false};character.setPointerCapture(e.pointerId);});
character.addEventListener('pointermove',e=>{
  if (!drag) return;
  const dx=e.screenX-drag.x,dy=e.screenY-drag.y;
  if (!drag.moved && Math.hypot(dx,dy)<4) return;
  if(!Number.isFinite(dx)||!Number.isFinite(dy))return;
  const moveX=Math.round(dx),moveY=Math.round(dy);
  if(!moveX&&!moveY)return;
  drag.moved=true;api?.dragWindowDelta?.(moveX,moveY);
  // Keep sub-DIP residue instead of losing it on high-DPI displays.
  drag.x+=moveX;drag.y+=moveY;
});
character.addEventListener('pointerup',()=>{if(drag&&!drag.moved)pet();drag=null;});
character.addEventListener('pointercancel',()=>{drag=null;});
character.addEventListener('lostpointercapture',()=>{drag=null;});
function look(x) {
  document.body.style.setProperty('--look',`${Math.max(-1,Math.min(1,x))*3}deg`);
  document.body.style.setProperty('--lean',`${Math.max(-1,Math.min(1,x))*2}px`);
  if(state==='sleepy')setState('idle');
}
api?.onGlobalMousePos?.(d=>look((d.cursorX-d.winX-d.winW/2)/600));
window.addEventListener('pointermove',e=>look((e.clientX-innerWidth/2)/200));
document.getElementById('chat').onclick=()=>api?.openDashboard?.();
document.getElementById('menu').onclick=()=>api ? api.showContextMenu?.() : bubble.classList.toggle('hidden');
document.getElementById('listen').onclick=()=>{
  isListening=!isListening;api?.toggleListening?.(isListening);
  document.getElementById('listen').setAttribute('aria-pressed',String(isListening));
  setState(isListening?'idle':'sleepy');showBubble('小派',isListening?'喊「小派小派」叫我。':'唤醒监听已暂停。',2600);
};
window.addEventListener('contextmenu',e=>{e.preventDefault();api?.showContextMenu?.();});
api?.onWakeEvent?.(()=>{setState('listening');showBubble('我在听','请说出你的指令。');});
api?.onAsrEvent?.(d=>{
  if(d.type==='error'){setState('idle');showBubble('提示',d.text,6000);}
  if(d.type==='partial'){window.piShared?.update({captureOwner:'pet',transcript:d.text||'',transcriptFinal:false});setState('listening');showBubble('听到你说',d.text||'…');}
  if(d.type==='final'){window.piShared?.update({captureOwner:'pet',transcript:d.text||'',transcriptFinal:true});setState(d.text?'thinking':'idle');if(d.text)showBubble('收到啦',d.text);}
});
api?.onStateChange?.(d=>{isListening=!!d.enabled;document.getElementById('listen').setAttribute('aria-pressed',String(isListening));if(!isListening)setState('sleepy');});
let events, replyText='';
if (!preview) {
  events=new EventSource('http://127.0.0.1:31415/api/stream');
  events.onmessage=e=>{
    let event;try{event=JSON.parse(e.data);}catch{return;}
    const d=event.payload;
    if(event.type==='agent_reply'){showBubble('小派',d.replyText,10000);voice.isVoiceModeActive=true;voice.speakAgentReply(d.replyText,{realtime:true});setState('idle');}
    if(event.type==='pi_event'){
      if(d.type==='agent_start'){replyText='';ownReply=d.source==='pet-wake';voice.isVoiceModeActive=ownReply;if(ownReply)voice.beginAgentSpeech();setState('thinking');showBubble('小派','正在想办法…');}
      if(d.type==='message_update' && d.assistantMessageEvent?.type==='text_delta' ){if(ownReply)voice.onAgentTextDelta(d.assistantMessageEvent.delta);replyText+=d.assistantMessageEvent.delta;showBubble('小派',replyText.slice(-140));}
      if(d.type==='tool_execution_start'){setState('thinking');showBubble('正在处理',d.toolName||'稍等一下');}
      if(d.type==='agent_end' && !voice.speechInterrupted){if(ownReply)voice.onAgentResponse(replyText);ownReply=false;setState('happy',1600);showBubble('完成啦','点下方按钮查看结果。',5000);}
    }
  };
}
window.addEventListener('beforeunload',()=>{cancelAnimationFrame(tick);clearTimeout(bubbleTimer);events?.close();voice.stopTtsPlayback();voice.ws?.close();micCleanup?.();});
// Browser-only visual preview: does not request microphone access or send commands.
if(preview){const demo=new URLSearchParams(location.search).get('state');if(frames[demo])setState(demo);showBubble('小派 · 桌宠预览','摸摸我，或移动鼠标看看。');}
    async function startMicCapture() {
      const generation=++micGeneration;
      micCleanup?.();micCleanup=null;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          console.warn('[Pet Mic] 当前环境不支持 getUserMedia');
          return;
        }

        // 读取桌宠当前来源的设备偏好；未设置时使用系统默认输入
        let inputDeviceId = 'default';
        try {
          const raw = localStorage.getItem('pichan_voice_settings');
          if (raw) inputDeviceId = JSON.parse(raw).inputDeviceId || 'default';
        } catch (e) { /* 读不到就用默认设备 */ }

        const audio = {
          channelCount: 1, sampleRate: 16000,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true
        };
        if (inputDeviceId && inputDeviceId !== 'default') {
          audio.deviceId = { exact: inputDeviceId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if(generation!==micGeneration){stream.getTracks().forEach(t=>t.stop());return;}
        console.log('[Pet Mic] 采音已启动，设备:', stream.getAudioTracks()[0]?.label || inputDeviceId);

        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await ctx.resume();
        micCleanup=()=>{stream.getTracks().forEach(t=>t.stop());ctx.close().catch(()=>{});};
        const src = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(1024, 1, 1);

        proc.onaudioprocess = (e) => {
          if (!isListening || sharedState.captureOwner==='dashboard' || !api?.sendAudioChunk) return;
          const input = e.inputBuffer.getChannelData(0);
          if(voice.isTtsPlaying || voice.ttsPending || (ownReply && voice.agentReplyInProgress)){
            const buffered=voice.detectBargeIn(input,ctx.sampleRate);
            if(buffered){
              // Begin a command immediately; do not require another wake word.
              api.interruptListening?.();
              voice.resamplePhase=0;
              for(const chunk of buffered)api.sendAudioChunk(voice.resampleFloatTo16kPCM(chunk,ctx.sampleRate));
            }
            return;
          }
          voice.resetBargeIn();
          if(!voice.speechInterrupted&&performance.now()<voice.echoGuardUntil)return;
          // 唤醒引擎吃 Int16 PCM。直接送 Float32 的话主进程 Buffer.from()
          // 会把每个浮点截成一个字节，喂进 KWS 的是噪声，永远唤不醒。
          const pcm = voice.resampleFloatTo16kPCM(input, ctx.sampleRate);
          api.sendAudioChunk(pcm);
        };

        // ScriptProcessor 必须连到 destination 才会跑，但直连会把麦克风原声
        // 播出来造成啸叫，所以中间串一个 0 增益节点。
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);
      } catch (err) {
        console.warn('[Pet Mic] 采音失败:', err.name, err.message);
        showBubble('麦克风不可用', err.message, 5000);
      }
    }


if (!preview) startMicCapture();
