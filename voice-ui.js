/**
 * voice-ui.js - Pi-chan Dashboard Voice Mode Controller
 * Handles Streaming ASR, Web Audio Capture, Live Transcription, Auto-Send, and TTS Lip-sync.
 * ZERO EMOJIS: All iconography uses SVG / CSS.
 */

export class VoiceUIController {
  constructor(options = {}) {
    this.live2d = options.live2d || null;
    this.serverUrl = options.serverUrl || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:31415');
    this.ws = null;
    this.wsReady = false;
    this.conversationModel = null;
    this.realtimeActive = false;
    this.realtimeGeneration = 0;
    this.realtimeSession = null;

    // State flags
    this.isVoiceModeActive = false;
    this.isRecording = false;
    this.isPlayingTestAudio = false;
    this.isTtsPlaying = false;
    this.ttsAvailable = false;
    this.asrAvailable = false;

    // Audio context for microphone & test audio
    this.micAudioCtx = null;
    this.micMediaStream = null;
    this.micScriptNode = null;
    this.resamplePhase = 0;
    this.micChunkBuffer = [];
    this.testAudioTimer = null;

    // Audio context for TTS playback & lip sync
    this.ttsAudioCtx = null;
    this.ttsAnalyser = null;
    this.ttsNextPlayTime = 0;
    this.ttsActiveSources = [];
    this.mouthMonitorTimer = null;
    this.currentTtsSampleRate = 8000;
    this.currentTtsVoice = null;
    this.currentVoiceKey = "vits-aishell3";
    this.currentAsrProvider = "local";
    this.asrProviderSent = null;
    this.asrProviderConfirmed = null;
    this.currentSid = 51;

    // Timing & Metrics
    this.utteranceRevision = 0;
    this.utteranceCandidate = null;
    this.speechEndTimestamp = 0;
    this.agentStartTimestamp = 0;
    this.lastAsrLatencyMs = 0;
    this.lastAgentReplyLatencyMs = null;
    this.lastRecognizedText = "";
    this.lastAgentResponseText = "";
    this.mouthMovedDuringTts = false;
    this.maxRecordedMouthOpen = 0;

    // UI Elements cache
    this.dom = {};
    this.captureGeneration = 0;
    this.ttsPending = false;
    this.ignoreTts = false;
    this.reconnectTimer = null;
    this.speechBuffer = '';
    this.speechInCode = false;
    this.speechFlushTimer = null;
    this.streamedAgentText = false;
    this.agentSpeechFinished = false;
    this.pendingTtsRequests = 0;
    this.firstAudioAt = 0;
    this.waitingSpeech = [];
    this.playbackEpoch = 0;
    this.ttsLoading = null;
    this.ttsLoadingAwaiting = false;
    this.speechInterrupted = false;
    this.agentReplyInProgress = false;
    this.bargeInVoicedMs = 0;
    this.bargeInBuffer = [];
    this.bargeInBufferMs = 0;
    this.bargeInNoiseFloor = .003;
    this.interruptionPromise = null;
    this.echoReference = [];
    this.echoGuardUntil = 0;
    this.playbackStartedAt = 0;
    this.playbackStats = { pcmBytes: 0, peak: 0, context: "not-created" };
  }

  init() {
    this.cacheDom();
    this.bindEvents();
    this.conversationModelListener = e => this.setConversationModel(e.detail);
    window.addEventListener('pi-conversation-model', this.conversationModelListener);
    if(window.piConversationModel)this.setConversationModel(window.piConversationModel);
    this.realtimeUnloadListener = () => { this.stopVoiceMode(); };
    window.addEventListener('pagehide', this.realtimeUnloadListener);
    this.connectWebSocket();
  }

  // Selecting a model never opens a microphone or a cloud connection.
  setConversationModel(model) {
    const next = model && typeof model.id === 'string' ? {id:model.id,realtime:model.realtime===true} : null;
    if (this.isVoiceModeActive && (next?.id !== this.conversationModel?.id || next?.realtime !== this.conversationModel?.realtime)) this.stopVoiceMode();
    this.conversationModel = next;
  }

  async startRealtimeVoice() {
    const generation = ++this.realtimeGeneration;
    this.stopTtsPlayback();
    this.stopMicRecording(false);
    this.stopTestSpeech();
    this.realtimeActive = true;
    this.realtimeTranscripts = new Map();
    this.isVoiceModeActive = true;
    this.initTtsAudioContext(); // Unlock during the microphone click.
    this.showVoiceStatusBar();this.updateMicButton('active');
    this.setStatus('实时语音 · 正在申请麦克风', 'connecting');
    window.piShared?.update({captureOwner:'dashboard'});
    try {
      const {RealtimeVoiceSession} = await import('./realtime-voice.js');
      if(generation!==this.realtimeGeneration)return;
      // No cloud connection/charges before microphone permission succeeds.
      await this.startMicRecording();
      if(generation!==this.realtimeGeneration)return;
      if(!this.isRecording)throw Error('麦克风尚未就绪，实时连接未启动');
      const active=()=>generation===this.realtimeGeneration&&this.realtimeActive;
      const end=message=>{if(!active())return;this.stopVoiceMode();this.showNotice(message);};
      this.realtimeSession = new RealtimeVoiceSession({serverUrl:this.serverUrl,model:this.conversationModel.id,
        onReady:()=>{if(active()){this.setStatus('实时语音已连接，直接说话即可','recording');this.updateTtsBadge('Realtime · 音频直接对话');}},
        onAudio:(pcm,rate)=>{if(!active())return;
          if(this.ttsAudioCtx&&this.ttsNextPlayTime-this.ttsAudioCtx.currentTime>12)throw Error('实时播放积压，已结束本次连接');
          this.ignoreTts=false;this.currentTtsVoice='realtime';this.playStreamingPcmChunk(pcm,rate);
        },
        onInterrupt:()=>{if(active())this.stopTtsPlayback();},
        onStatus:text=>{if(active())this.setStatus(text,'recording');},
        onTranscript:event=>{if(!active())return;
          const key=event.role+':'+(event.itemId||event.responseId||'current');
          const text=(event.delta&&!event.reset?(this.realtimeTranscripts.get(key)||'')+event.text:event.text).slice(-32000);
          this.realtimeTranscripts.set(key,text);
          while(this.realtimeTranscripts.size>32)this.realtimeTranscripts.delete(this.realtimeTranscripts.keys().next().value);
          if(this.dom.voiceTranscriptText){this.dom.voiceTranscriptText.className='voice-transcript-text';this.dom.voiceTranscriptText.textContent=(event.role==='user'?'你：':'小派：')+text;}
          // Dedicated display event, deliberately not handleRecognitionFinal/sendPrompt.
          window.dispatchEvent(new CustomEvent('pi-realtime-transcript',{detail:{...event,model:this.conversationModel.id}}));
        },onError:end,onEnd:end
      });
      this.setStatus('实时语音 · 正在连接','connecting');
      this.realtimeSession.start();
    } catch(err) {
      if(generation===this.realtimeGeneration){this.stopVoiceMode();this.showNotice('实时语音：'+err.message);}
    }
  }

  destroy() {
    this.destroyed=true;
    this.stopVoiceMode();
    clearTimeout(this.reconnectTimer);
    window.removeEventListener('pi-conversation-model',this.conversationModelListener);
    window.removeEventListener('pagehide',this.realtimeUnloadListener);
    this.dom.micBtn?.removeEventListener('click',this.micClickListener);
    if(this.ws){this.ws.onopen=this.ws.onmessage=this.ws.onerror=this.ws.onclose=null;this.ws.close();this.ws=null;}
    this.wsReady=false;
    this.ttsAudioCtx?.close().catch(()=>{});this.ttsAudioCtx=null;this.ttsAnalyser=null;
  }

  setLive2D(instance) {
    this.live2d = instance;
  }

  cacheDom() {
    this.dom = {
      micBtn: document.getElementById("micBtn"),
      voiceStatusBar: document.getElementById("voiceStatusBar"),
      voiceStatusDot: document.getElementById("voiceStatusDot"),
      voiceStatusTitle: document.getElementById("voiceStatusTitle"),
      voiceMeterFill: document.getElementById("voiceMeterFill"),
      voiceLatencyPill: document.getElementById("voiceLatencyPill"),
      voiceTranscriptText: document.getElementById("voiceTranscriptText"),
      voiceNotice: document.getElementById("voiceNotice"),
      voiceNoticeText: document.getElementById("voiceNoticeText"),
      voiceTtsBadge: document.getElementById("voiceTtsBadge"),
      promptInput: document.getElementById("promptInput"),
      sendBtn: document.getElementById("sendBtn")
    };
  }

  bindEvents() {
    if (this.dom.micBtn) {
      this.micClickListener = () => this.toggleVoiceMode();
      this.dom.micBtn.addEventListener("click", this.micClickListener);
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Connection (/ws/audio)
  // ---------------------------------------------------------------------------
  connectWebSocket() {
    if(this.destroyed)return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const base = new URL(this.serverUrl);
    const protocol = base.protocol === "https:" ? "wss://" : "ws://";
    const wsUrl = `${protocol}${base.host}/ws/audio`;

    try {
      this.asrProviderSent=null;this.asrProviderConfirmed=null;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.wsReady = true;
        this.log("WebSocket 连接就绪 (/ws/audio)");
        this.updateTtsBadge("TTS: 待机");
        const waiting=this.waitingSpeech.splice(0);
        for(const item of waiting) this.speakAgentReply(item.text,item.options);
      };

      this.ws.onmessage = (e) => {
        // Binary Frame: Incoming TTS PCM Audio Chunk
        if (e.data instanceof ArrayBuffer) {
          if (this.realtimeActive) return;
          try { this.playStreamingPcmChunk(e.data, this.currentTtsSampleRate); }
          catch (err) { this.showNotice('音频播放失败：' + err.message); this.setStatus('播放失败，请点声音自检', 'error'); }
          return;
        }

        // Text Frame: JSON Control Messages
        if (typeof e.data === "string") {
          try {
            const msg = JSON.parse(e.data);
            this.handleIncomingMessage(msg);
          } catch (err) {
            console.warn("[VoiceUI] JSON 解析异常:", err);
          }
        }
      };

      this.ws.onerror = (err) => {
        console.warn("[VoiceUI] WebSocket 错误:", err);
        this.wsReady = false;
      };

      this.ws.onclose = () => {
        this.clearUtteranceCandidate();
        this.acceptUtteranceFinals=false;
        this.wsReady = false;
        this.asrAvailable = false;
        this.ttsAvailable = false;
        if (!this.realtimeActive) this.stopTtsPlayback();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2000);
      };
    } catch (e) {
      console.warn("[VoiceUI] 无法建立 WebSocket 连接:", e);
    }
  }

  setAsrProvider(provider) {
    const next=provider==='token-plan'?'token-plan':'local';
    const changed=next!==this.currentAsrProvider;
    if(changed)this.clearUtteranceCandidate();
    this.currentAsrProvider=next;
    if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return;
    if(this.asrProviderSent===next)return;
    if(changed&&this.isRecording){this.ws.send(JSON.stringify({type:'asr_reset'}));this.resamplePhase=0;}
    this.asrProviderSent=next;this.asrProviderConfirmed=null;this.asrAvailable=false;
    this.ws.send(JSON.stringify({type:'asr_set_provider',provider:next}));
  }

  handleIncomingMessage(msg) {
    if(this.realtimeActive)return;
    if (msg.type === "asr_ready") {
      this.asrProviderConfirmed = msg.provider || "local";
      if(this.asrProviderSent!==this.currentAsrProvider)this.setAsrProvider(this.currentAsrProvider);
      this.asrAvailable = this.asrProviderConfirmed===this.currentAsrProvider;
      if(this.asrAvailable)this.log(`ASR 已就绪: ${this.asrProviderConfirmed==='token-plan'?'本地预览 + 套餐句尾识别':'本地实时识别'}`);
    } else if (msg.type === "tts_ready") {
      this.ttsAvailable = true;
      if (msg.model?.sampleRate) {
        this.currentTtsSampleRate = msg.model.sampleRate;
      }
      this.updateTtsBadge(`TTS: ${msg.model?.speakerName || "元气少女音"}`);
      this.log(`TTS 引擎已就绪: ${msg.model?.name || "VITS"}`);
    } else if (msg.type === "asr_partial") {
      this.lastAsrLatencyMs = msg.latencyMs || 0;
      this.showPartialTranscript(msg.text, msg.latencyMs);
      this.noteUtteranceContinuation(msg.text);
    } else if (msg.type === "asr_final") {
      this.lastAsrLatencyMs = msg.latencyMs || 0;
      this.lastRecognizedText = msg.text || "";
      this.showFinalTranscript(msg.text, msg.latencyMs);
      this.handleRecognitionFinal(msg.text);
    } else if (msg.type === "dialogue_reply") {
      this.log(`服务端对话回复: ${msg.replyText}`);
    } else if (msg.type === "asr_error") {
      this.showNotice("识别错误: " + msg.error);
    } else if (msg.type === "tts_start") {
      if (this.ignoreTts || (!this.ttsPending && !this.pendingTtsRequests)) return;
      this.ttsLoadingAwaiting = true;
      this.showTtsLoading("generating");
      this.currentTtsVoice = msg.voice;
      this.ttsPending = true;
      this.updateTtsBadge("TTS: 合成播报中");
      this.setStatus("正在语音播报回复...", "speaking");
      if (msg.sampleRate) {
        this.currentTtsSampleRate = msg.sampleRate;
      }
    } else if (msg.type === 'tts_status') {
      if(this.ignoreTts || !this.ttsLoadingAwaiting)return;
      if(!['loading','warming','ready','connected'].includes(msg.phase))return;
      this.showTtsLoading(msg.phase);
      const label=msg.phase==='connected'?'云端已连接 · 等待音频':msg.phase==='ready'?'模型已就绪 · 正在生成':msg.phase==='warming'?'本地模型预热中 · 首次需要等待':'正在加载本地模型 · 首次需要等待';
      this.updateTtsBadge(label);
      this.setStatus(label,'connecting');
    } else if (msg.type === "tts_chunk") {
      if(this.ignoreTts)return;
      if(this.noticeKind==='tts')this.hideNotice();
      this.clearTtsLoading();
      this.updateTtsBadge('TTS: 流式播报中');
    } else if (msg.type === "tts_end") {
      this.clearTtsLoading();
      this.pendingTtsRequests = Math.max(0, this.pendingTtsRequests - 1);
      this.ttsPending = this.pendingTtsRequests > 0;
      this.updateTtsBadge(this.ttsPending ? "TTS: 连续播报中" : "TTS: 待机");
      this.log(`TTS 播报完成 (总耗时: ${msg.totalMs}ms, 音频时长: ${msg.durationSec?.toFixed(2)}s)`);
    } else if (msg.type === "tts_error") {
      this.speechInterrupted = true;
      // An upstream error must not destroy audio already downloaded and queued.
      // User barge-in/cancel still uses stopTtsPlayback for immediate silence.
      this.clearTtsLoading();
      this.ignoreTts=true;
      this.pendingTtsRequests=0;
      this.ttsPending=false;
      clearTimeout(this.speechFlushTimer);this.speechFlushTimer=null;this.speechBuffer='';
      if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'tts_cancel'}));
      this.showNotice("TTS 语音引擎提示: " + (msg.error || "服务响应异常，本轮保留文字回复"),'tts');
      this.updateTtsBadge(this.ttsActiveSources.length?'TTS: 上游中断 · 播完已接收音频':"TTS: 本轮播放失败");
    }
  }

  // ---------------------------------------------------------------------------
  // Voice Mode Toggle & UI Flow
  // ---------------------------------------------------------------------------
  async toggleVoiceMode() {
    if (this.isVoiceModeActive) {
      this.stopVoiceMode();
    } else {
      await this.startVoiceMode();
    }
  }

  async startVoiceMode() {
    if(this.conversationModel?.realtime)return this.startRealtimeVoice();
    this.isVoiceModeActive = true;
    window.piShared?.update({captureOwner:'dashboard'});
    // Unlock playback during the user's click, not a later network event.
    this.initTtsAudioContext();
    if (this.onEnableConversation) this.onEnableConversation();
    this.connectWebSocket();
    this.showVoiceStatusBar();
    this.updateMicButton("active");
    this.setStatus("语音模式已启动，请点击麦克风说话或播放测试音频", "ready");

    // Automatically attempt to start microphone recording
    await this.startMicRecording();
    if (this.isRecording) this.speakAgentReply('我在听，请说。', {realtime:true});
  }

  stopVoiceMode() {
    this.clearUtteranceCandidate();
    ++this.realtimeGeneration;
    this.realtimeSession?.close();this.realtimeSession=null;
    this.realtimeActive=false;
    window.piShared?.update({captureOwner:null});
    this.isVoiceModeActive = false;
    this.agentReplyInProgress = false;
    this.resetBargeIn();
    this.stopTtsPlayback();
    this.stopMicRecording(false);
    this.stopTestSpeech();
    this.hideVoiceStatusBar();
    this.updateMicButton("idle");
    this.hideNotice();
    this.resetMeter();
  }

  showVoiceStatusBar() {
    if (this.dom.voiceStatusBar) {
      this.dom.voiceStatusBar.style.display = "flex";
    }
  }

  hideVoiceStatusBar() {
    if (this.dom.voiceStatusBar) {
      this.dom.voiceStatusBar.style.display = "none";
    }
  }

  updateMicButton(state) {
    if (!this.dom.micBtn) return;
    this.dom.micBtn.removeAttribute('title');
    this.dom.micBtn.classList.remove("active", "recording");
    if (state === "active") {
      this.dom.micBtn.classList.add("active");
      this.dom.micBtn.setAttribute("aria-label", "语音模式已开启，点击退出");
    } else if (state === "recording") {
      this.dom.micBtn.classList.add("active", "recording");
      this.dom.micBtn.setAttribute("aria-label", "正在录音与识别，点击停止");
    } else {
      this.dom.micBtn.setAttribute("aria-label", "开启语音模式");
    }
  }

  setStatus(text, mode = "") {
    if (this.dom.voiceStatusTitle) {
      this.dom.voiceStatusTitle.textContent = text;
    }
    if (this.dom.voiceStatusDot) {
      this.dom.voiceStatusDot.className = "voice-status-dot " + mode;
    }
  }

  updateTtsBadge(text) {
    if (this.dom.voiceTtsBadge) {
      this.dom.voiceTtsBadge.textContent = text;
    }
  }

  showNotice(msg,kind='general') {
    this.noticeKind=kind;
    if (this.dom.voiceNotice && this.dom.voiceNoticeText) {
      this.dom.voiceNoticeText.textContent = msg;
      this.dom.voiceNotice.style.display = "block";
    }
  }

  hideNotice() {
    this.noticeKind=null;
    if (this.dom.voiceNotice) {
      this.dom.voiceNotice.style.display = "none";
    }
  }

  updateMeter(percent) {
    if (this.dom.voiceMeterFill) {
      const p = Math.min(100, Math.max(0, Math.round(percent)));
      this.dom.voiceMeterFill.style.width = `${p}%`;
    }
  }

  resetMeter() {
    if (this.dom.voiceMeterFill) {
      this.dom.voiceMeterFill.style.width = "0%";
    }
  }

  // ---------------------------------------------------------------------------
  // Transcription Display: Partial (Sky-blue italic) vs Final (White normal)
  // ---------------------------------------------------------------------------
  showPartialTranscript(text, latencyMs) {
    if(this.isRecording)window.piShared?.update({transcript:text||'',transcriptFinal:false});
    if (!this.dom.voiceTranscriptText) return;
    this.dom.voiceTranscriptText.className = "voice-transcript-text partial";
    this.dom.voiceTranscriptText.innerHTML = `${this.escapeHtml(text)}<span class="voice-cursor"></span>`;
    
    if (this.dom.voiceLatencyPill) {
      this.dom.voiceLatencyPill.textContent = latencyMs !== undefined ? `实时识别: ${latencyMs}ms` : "实时识别中...";
    }
    this.setStatus("正在倾听并实时出字...", "recording");
  }

  showFinalTranscript(text, latencyMs) {
    if(this.isRecording)window.piShared?.update({transcript:text||'',transcriptFinal:true});
    if (!this.dom.voiceTranscriptText) return;
    this.dom.voiceTranscriptText.className = "voice-transcript-text final";
    this.dom.voiceTranscriptText.textContent = text || "(未识别到有效语音)";
    
    if (this.dom.voiceLatencyPill) {
      this.dom.voiceLatencyPill.textContent = latencyMs !== undefined ? `最终确认: ${latencyMs}ms` : "最终确认";
    }
    this.setStatus("语音识别完成，已就绪", "ready");
  }

  escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ---------------------------------------------------------------------------
  // Auto-Send Pipeline (ASR Final -> Prompt Input -> Agent)
  // ---------------------------------------------------------------------------
  clearUtteranceCandidate() {
    this.deferredUtteranceText='';
    ++this.utteranceRevision;
    clearTimeout(this.utteranceTimer);clearTimeout(this.utteranceDeadline);
    this.utteranceAbort?.abort();this.utteranceAbort=null;
    this.utteranceCandidate=null;
  }

  noteUtteranceContinuation(text) {
    if(this.realtimeActive||!text?.trim()||!this.utteranceCandidate)return;
    const candidate=this.utteranceCandidate;
    ++this.utteranceRevision;this.utteranceAbort?.abort();clearTimeout(this.utteranceTimer);
    candidate.awaitingFinal=true;candidate.lastActivity=Date.now();
    this.setStatus('还在听，等待这句话说完…','recording');
  }

  handleRecognitionFinal(text) {
    if(this.realtimeActive||(!this.isVoiceModeActive&&!this.isPlayingTestAudio))return;
    // Explicit stop/disconnect must not resurrect a pending candidate.
    if(!this.acceptUtteranceFinals&&!this.isPlayingTestAudio)return;
    if(!this.speechInterrupted&&(this.isTtsPlaying||performance.now()<this.echoGuardUntil))return;
    const part=String(text||'').trim();if(!part)return;
    ++this.utteranceRevision;this.utteranceAbort?.abort();clearTimeout(this.utteranceTimer);
    let c=this.utteranceCandidate;
    if(!c){
      c=this.utteranceCandidate={text:(Date.now()<(this.deferredUtteranceUntil||0)&&this.dom.promptInput?.value===this.deferredUtteranceText?this.deferredUtteranceText:''),started:Date.now(),lastActivity:Date.now(),awaitingFinal:false};
      this.deferredUtteranceText='';
      // Absolute cap also covers a lost ASR final after renewed partial activity.
      this.utteranceDeadline=setTimeout(()=>{
        if(this.utteranceCandidate!==c)return;
        if(c.awaitingFinal){const draft=c.text;this.clearUtteranceCandidate();if(this.dom.promptInput)this.dom.promptInput.value=draft;this.showNotice('续说识别等待超时，已保留确认文字；请检查后手动发送。');}
        else if(c.semanticDecision&&!['uncertain','fallback'].includes(c.semanticDecision))this.preserveUtteranceDraft('等待达到上限，未完成内容已保留为草稿');
        else this.commitUtteranceCandidate('等待达到上限，按已确认文字提交（声学回退）');
      },12000);
    }
    c.text+=(c.text?' ':'')+part;c.awaitingFinal=false;c.lastActivity=Date.now();
    if(c.text.length>2000){const draft=c.text;this.clearUtteranceCandidate();if(this.dom.promptInput)this.dom.promptInput.value=draft;this.showNotice('语音文字超过语义判断长度，已保留草稿，请检查后发送。');return;}
    this.setStatus('停顿候选 · 正在等待语义确认','recording');
    this.utteranceTimer=setTimeout(()=>this.checkUtteranceCandidate(),250);
  }

  async checkUtteranceCandidate() {
    const c=this.utteranceCandidate;if(!c||c.awaitingFinal||this.realtimeActive)return;
    const revision=this.utteranceRevision,requestId=crypto.randomUUID();
    const controller=this.utteranceAbort=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),1100);
    let result;
    this.reportUtteranceStatus('Jev 正在判断是否说完…','checking');
    try{
      const response=await fetch(new URL('/api/jev/utterance',this.serverUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:c.text,requestId}),signal:controller.signal});
      if(!response.ok)throw Object.assign(Error('语义服务暂未就绪'),{reason:response.status===404?'backend_not_loaded':'http_'+response.status});
      result=await response.json();
      if(result.requestId!==requestId)throw Error('语义响应关联不一致');
    }catch(error){result={status:'unavailable',decision:'uncertain',source:'fallback',reason:error.reason||(error.name==='AbortError'?'timeout':'connection_error')};}
    finally{clearTimeout(timeout);if(this.utteranceAbort===controller)this.utteranceAbort=null;}
    if(revision!==this.utteranceRevision||this.utteranceCandidate!==c||c.awaitingFinal)return;
    if(result.status==='ready'&&result.source==='jev'&&result.decision==='complete'){
      this.reportUtteranceStatus('Jev：已说完 · '+Math.round(result.latencyMs||0)+'ms','complete');
      this.commitUtteranceCandidate('语义完整，提交本轮');return;
    }
    const policies={
      expressing:{wait:2500,label:'正在表达，继续听…'},
      thinking:{wait:6000,label:'正在思考，不着急，我在听…'},
      awaiting_completion:{wait:4000,label:'等待补充，保留前文…'},
      self_correcting:{wait:4500,label:'正在修正，等待新的表述…'},
      continue:{wait:4000,label:'等待续说…'},
      uncertain:{wait:1800,label:'语义不确定，稍等确认…'}
    };
    const semantic=result.status==='ready'&&result.source==='jev';
    const decision=semantic&&policies[result.decision]?result.decision:'uncertain';
    const policy=policies[decision];c.semanticDecision=semantic?decision:'fallback';
    const reasons={backend_not_loaded:'后台未加载语义接口（404）',jev_unavailable:'Jev 凭据未配置',timeout:'Jev 判断超时',busy:'Jev 正忙',invalid_response:'Jev 返回格式异常',jev_error:'Jev 请求失败',connection_error:'语义接口连接失败'};
    this.reportUtteranceStatus(semantic?'Jev：'+policy.label:'Jev 未生效：'+(reasons[result.reason]||'接口异常')+' · 本轮声学回退',semantic?decision:'fallback');
    this.setStatus(policy.label,'recording');
    this.utteranceTimer=setTimeout(()=>{
      if(this.utteranceCandidate!==c||revision!==this.utteranceRevision||c.awaitingFinal)return;
      if(semantic&&decision!=='uncertain'){
        this.preserveUtteranceDraft('等待续说结束，未抢答；已保留草稿，可继续说或手动发送');
      }else this.commitUtteranceCandidate('语义未确认，等待后按声学停顿提交（回退）');
    },semantic?policy.wait:1200);
  }

  preserveUtteranceDraft(message) {
    const c=this.utteranceCandidate;if(!c)return;
    if(this.dom.promptInput)this.dom.promptInput.value=c.text;
    clearTimeout(this.utteranceTimer);clearTimeout(this.utteranceDeadline);
    this.utteranceAbort?.abort();++this.utteranceRevision;
    this.clearUtteranceCandidate();
    this.reportUtteranceStatus(message,'draft');
    this.setStatus('内容已保留，等待你继续','recording');
    this.deferredUtteranceText=c.text;this.deferredUtteranceUntil=Date.now()+60000;
  }

  reportUtteranceStatus(text,state) {
    let badge=document.getElementById('voiceSemanticStatus');
    if(!badge){
      const host=this.dom.voiceNotice?.parentElement||document.querySelector('.dialog-box');
      if(host){badge=document.createElement('div');badge.id='voiceSemanticStatus';badge.className='voice-semantic-status';badge.setAttribute('role','status');badge.setAttribute('aria-live','polite');host.append(badge);}
    }
    if(badge){badge.textContent=text;badge.dataset.state=state;}
    window.dispatchEvent(new CustomEvent('pi-utterance-status',{detail:{state,text}}));
  }

  async commitUtteranceCandidate(reason) {
    const c=this.utteranceCandidate;if(!c||c.awaitingFinal||this.realtimeActive||c.committing)return;
    c.committing=true;
    const expected=this.utteranceRevision;
    if(this.interruptionPromise)await this.interruptionPromise;
    c.committing=false;
    if(this.utteranceCandidate!==c||expected!==this.utteranceRevision||c.awaitingFinal)return;
    const text=c.text;
    this.clearUtteranceCandidate();
    const revision=this.utteranceRevision;
    this.setStatus(reason,'sending');
    if(reason.includes('回退')||reason.includes('未确认'))this.showNotice(reason);
    window.dispatchEvent(new CustomEvent('pi-utterance-status',{detail:{state:'submitted',reason}}));
    void this.submitRecognizedUtterance(text,revision);
  }

  async submitRecognizedUtterance(text, revision) {
    if(this.realtimeActive)return;
    // Suppress delayed ASR endpoints from speaker leakage, never user barge-in audio.
    if(!this.speechInterrupted && (this.isTtsPlaying || performance.now()<this.echoGuardUntil))return;
    const trimmed = (text || "").trim();
    if (!trimmed) {
      this.setStatus("倾听完毕 (未检测到有效语音)", "ready");
      return;
    }

    if (!this.isVoiceModeActive && !this.isPlayingTestAudio) return;
    this.lastAgentReplyLatencyMs = null;
    this.speechEndTimestamp = performance.now();
    this.setStatus(`识别: "${trimmed}" · 已发送`, "sending");

    // 填进输入框，让用户看得见识别到了什么
    if (this.dom.promptInput) {
      this.dom.promptInput.value = trimmed;
    }

    // Only a settled semantic candidate reaches this existing Pi send path.
    if (this.interruptionPromise) await this.interruptionPromise;
    if (revision !== this.utteranceRevision) return;
    if (!this.isVoiceModeActive && !this.isPlayingTestAudio) return;
    if (typeof window.sendPrompt === "function") {
      window.sendPrompt(trimmed);
    }
  }

  /**
   * Called when Agent starts generating response or text delta arrives
   */
  onAgentReplyStart() {
    if(this.realtimeActive)return;
    if (this.speechEndTimestamp > 0 && !this.lastAgentReplyLatencyMs) {
      this.lastAgentReplyLatencyMs = Math.round(performance.now() - this.speechEndTimestamp);
      this.log(`[闭环延迟] 从说话结束到 Agent 开始回复: ${this.lastAgentReplyLatencyMs}ms`);
      if (this.dom.voiceLatencyPill) {
        this.dom.voiceLatencyPill.textContent = `响应延迟: ${this.lastAgentReplyLatencyMs}ms`;
      }
    }
    this.setStatus("Agent 正在生成回复...", "active");
  }

  /**
   * Called when Agent turn ends / final response settled
   */
  beginAgentSpeech() {
    if(this.realtimeActive)return;
    this.stopTtsPlayback();
    this.speechInterrupted = false;
    this.agentReplyInProgress = this.isVoiceModeActive;
    this.resetBargeIn();
    this.streamedAgentText = false;
    this.agentSpeechFinished = false;
    this.speechInCode = false;
    this.firstAudioAt = 0;
    this.lastAgentReplyLatencyMs = null;
  }

  onAgentTextDelta(delta) {
    if(this.realtimeActive)return;
    if (!this.isVoiceModeActive || this.speechInterrupted || this.agentSpeechFinished || !delta) return;
    this.streamedAgentText = true;
    this.speechBuffer += delta;
    if(this.currentVoiceKey==='qwen-cloud')return;
    this.flushSpeechBuffer();
    // Bound the wait even when the model hasn't emitted a full sentence yet.
    if (this.speechBuffer && !this.speechFlushTimer) {
      this.speechFlushTimer = setTimeout(() => {
        this.speechFlushTimer = null;
        this.flushSpeechBuffer(true);
      }, 250);
    }
  }

  flushSpeechBuffer(force = false, final = false) {
    if(this.currentVoiceKey==='qwen-cloud'){
      if(final){const text=this.speechBuffer;this.speechBuffer='';if(this.isVoiceModeActive)this.speakAgentReply(text,{realtime:true,append:true});}
      return;
    }
    while (this.speechBuffer) {
      if (this.speechInCode) {
        const end = this.speechBuffer.indexOf('```');
        if (end < 0) {
          this.speechBuffer = final ? '' : this.speechBuffer.slice(-2);
          break;
        }
        this.speechBuffer = this.speechBuffer.slice(end + 3);
        this.speechInCode = false;
        continue;
      }
      const fence = this.speechBuffer.indexOf('```');
      if (fence === 0) {
        this.speechInCode = true;
        this.speechBuffer = this.speechBuffer.slice(3);
        continue;
      }
      const visible = fence < 0 ? this.speechBuffer : this.speechBuffer.slice(0, fence);
      const boundary = /[。！？!?；;\n]|[，,](?=.)/.exec(visible);
      let count = boundary ? boundary.index + 1 : 0;
      if (!count && fence > 0) count = fence;
      if (!count && visible.length >= 48) count = 48;
      if (!count && (final || (force && visible.length >= 8))) {
        // Preserve a partial fence marker across delta boundaries.
        count = visible.replace(/`{1,2}$/, '').length;
      }
      if (!count) break;
      count = Math.min(count, 48);
      const sentence = this.speechBuffer.slice(0, count);
      this.speechBuffer = this.speechBuffer.slice(count);
      if (this.isVoiceModeActive) this.speakAgentReply(sentence, { realtime: true, append: true });
    }
    if (final) this.speechBuffer = '';
  }

  onAgentResponse(fullText) {
    if(this.realtimeActive)return;
    this.agentReplyInProgress = false;
    if (this.speechInterrupted) return;
    if (this.agentSpeechFinished) return; // agent_end + agent_settled must not repeat audio.
    this.lastAgentResponseText = fullText || '';
    clearTimeout(this.speechFlushTimer);
    this.speechFlushTimer = null;
    if (this.isVoiceModeActive) {
      if (!this.streamedAgentText) this.speechBuffer += fullText || '';
      this.flushSpeechBuffer(true, true);
    }
    this.agentSpeechFinished = true;
  }

  // ---------------------------------------------------------------------------
  // TTS Streaming Synthesizer & Live2D Lip-Sync Driver
  // ---------------------------------------------------------------------------
  cleanTextForSpeech(text) {
    if (!text) return "";
    let s = text.replace(/```[\s\S]*?```/g, ""); // Strip code blocks
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    s = s.replace(/[#*~_>]/g, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  initTtsAudioContext() {
    if (!this.ttsAudioCtx || this.ttsAudioCtx.state === "closed") {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ttsAudioCtx = new AudioContextClass();
      this.ttsAnalyser = this.ttsAudioCtx.createAnalyser();
      this.ttsAnalyser.fftSize = 256;
      this.ttsAnalyser.connect(this.ttsAudioCtx.destination);
      if (this.outputDeviceId && this.ttsAudioCtx.setSinkId) {
        this.ttsAudioCtx.setSinkId(this.outputDeviceId === 'default' ? '' : this.outputDeviceId)
          .catch(async err => { this.outputDeviceId='default'; await this.ttsAudioCtx.setSinkId('').catch(()=>{}); this.showNotice('原输出设备不可用，已切回系统默认：'+err.message); });
      }
    }
    this.playbackStats.context=this.ttsAudioCtx.state;
    this.ttsAudioCtx.onstatechange=()=>{
      this.playbackStats.context=this.ttsAudioCtx.state;
      this.log('音频设备状态: '+this.ttsAudioCtx.state);
    };
    if (this.ttsAudioCtx.state === "suspended" || this.ttsAudioCtx.state === "interrupted") {
      this.ttsAudioCtx.resume().catch(err => this.showNotice('请点击麦克风或试听按钮启用声音: ' + err.message));
    }
  }

  async testSpeaker() {
    if(this.realtimeActive){this.showNotice('请先退出实时语音，再使用声音自检');return;}
    this.showVoiceStatusBar();
    this.stopTtsPlayback();
    this.initTtsAudioContext(); // inside click gesture
    try {
      if(this.ttsAudioCtx.setSinkId) await this.ttsAudioCtx.setSinkId(this.outputDeviceId === 'default' ? '' : this.outputDeviceId);
      await Promise.race([this.ttsAudioCtx.resume(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('播放设备仍被暂停')),2500))]);
      if(this.ttsAudioCtx.state!=='running')throw new Error('播放状态：'+this.ttsAudioCtx.state);
      this.ignoreTts=false;
      const oscillator=this.ttsAudioCtx.createOscillator(), gain=this.ttsAudioCtx.createGain();
      oscillator.frequency.value=660;gain.gain.value=.06;
      oscillator.connect(gain);gain.connect(this.ttsAudioCtx.destination);
      oscillator.start();oscillator.stop(this.ttsAudioCtx.currentTime+.18);
      oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      this.showNotice('声音自检：先播放短提示音，再说一句话。使用设置中选择的输出设备。');
      this.speakAgentReply('你好，我是小派。现在应该可以听到我的声音。',{realtime:true});
    } catch(err){this.showNotice('声音自检失败：'+err.message);}
  }

  speakAgentReply(rawText, options = {}) {
    if(this.realtimeActive)return;
    const speechText = this.cleanTextForSpeech(rawText);
    if (!speechText) return;

    this.initTtsAudioContext();

    // Check if WebSocket is open to request streaming TTS
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.setStatus("正在合成流式语音并驱动口型...", "speaking");
      this.updateTtsBadge("TTS: 合成中");
      this.ignoreTts = false;
      this.ttsPending = true;
      this.pendingTtsRequests++;
      // Honor the user's explicit experimental conversation voice selection.
      const voice = this.currentVoiceKey;
      if (voice === 'qwen-cloud') this.updateTtsBadge('云端语音 · 正在合成');
      else if (voice === 'qwen3-clone') this.updateTtsBadge('千问本地语音 · 首次加载较慢');
      else if (voice === 'gpt-sovits-klee') this.updateTtsBadge('实验音色 · 逐句生成，首次加载较慢');
      this.ws.send(JSON.stringify({
        type: "tts_speak",
        append: !!options.append,
        text: speechText,
        speed: 1.0,
        voice,
        sid: voice === this.currentVoiceKey ? this.currentSid : 51
      }));
    } else {
      // Keep speech while the socket connects. Never pretend silent lip motion is speech.
      if(this.waitingSpeech.length<32)this.waitingSpeech.push({text:rawText,options});
      this.connectWebSocket();
      this.setStatus('正在连接声音服务，回复已排队', 'connecting');
      clearTimeout(this.speechConnectTimer);
      this.speechConnectTimer=setTimeout(()=>{
        if(this.waitingSpeech.length)this.showNotice('声音服务连接超时，请点声音自检。');
      },5000);
    }
  }

  playStreamingPcmChunk(arrayBuffer, sampleRate = 8000) {
    if (this.ignoreTts || arrayBuffer.byteLength % 2) return;
    if(arrayBuffer.byteLength)this.clearTtsLoading();
    this.initTtsAudioContext();

    const int16 = new Int16Array(arrayBuffer);
    if (int16.length === 0) return;

    this.playbackStats.pcmBytes += arrayBuffer.byteLength;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
      this.playbackStats.peak=Math.max(this.playbackStats.peak,Math.abs(float32[i]));
    }

    const audioBuf = this.ttsAudioCtx.createBuffer(1, float32.length, sampleRate);
    audioBuf.getChannelData(0).set(float32);

    const source = this.ttsAudioCtx.createBufferSource();
    source.buffer = audioBuf;
    source.connect(this.ttsAnalyser);

    const now = this.ttsAudioCtx.currentTime;
    if (this.ttsNextPlayTime < now) {
      // Local autoregressive decoding has chunk jitter; absorb a small amount
      // without waiting for the whole sentence. Fast ONNX voices stay at 15ms.
      this.ttsNextPlayTime = now + (this.currentTtsVoice === 'qwen3-clone' ? 0.12 : 0.015);
    }
    if (!this.firstAudioAt) {
      this.firstAudioAt = performance.now();
      if (this.speechEndTimestamp > 0 && this.dom.voiceLatencyPill) {
        this.dom.voiceLatencyPill.textContent = `识别确认→首音: ${Math.round(this.firstAudioAt - this.speechEndTimestamp)}ms`;
      }
    }
    source.start(this.ttsNextPlayTime);
    this.echoReference.push({start:this.ttsNextPlayTime,sampleRate,samples:float32});
    const cutoff=this.ttsAudioCtx.currentTime-1;
    this.echoReference=this.echoReference.filter(c=>c.start+c.samples.length/c.sampleRate>cutoff);
    if(!this.isTtsPlaying)this.playbackStartedAt=performance.now();
    if(this.ttsAudioCtx.state!=='running'){
      this.showNotice('音频已收到，但播放设备未启动。请点击「声音自检」启用声音。');
    }
    this.log(`PCM已调度: ${int16.length} samples, ${sampleRate}Hz, context=${this.ttsAudioCtx.state}, peak=${this.playbackStats.peak.toFixed(3)}`);
    this.ttsNextPlayTime += audioBuf.duration;
    this.ttsActiveSources.push(source);

    if (!this.isTtsPlaying) {
      this.isTtsPlaying = true;
      this.setStatus("正在播报回复，口型同步中...", "speaking");
      this.startLipSyncDriving();
    }

    source.onended = () => {
      source.disconnect();
      const idx = this.ttsActiveSources.indexOf(source);
      if (idx !== -1) this.ttsActiveSources.splice(idx, 1);
      if (this.ttsActiveSources.length === 0 && this.ttsAudioCtx.currentTime >= this.ttsNextPlayTime - 0.05) {
        this.stopLipSyncDriving();
      }
    };
  }

  startLipSyncDriving() {
    if (this.live2d) {
      this.live2d.stopSpeaking();
      this.live2d.isSpeaking = true; // Audio owns the mouth; no competing synthetic flap.
    }
    if (this.mouthMonitorTimer) cancelAnimationFrame(this.mouthMonitorTimer);

    const dataArray = new Uint8Array(this.ttsAnalyser.frequencyBinCount);

    const updateMouth = () => {
      if (!this.isTtsPlaying) return;
      this.ttsAnalyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      // Map average frequency amplitude to natural mouth opening (0.05 ~ 0.95)
      const mouthOpen = Math.min(0.95, Math.max(0.05, (avg / 90.0) * 1.25));
      window.currentMouthOpen = mouthOpen;
      const stamp=performance.now();
      if(!this.lastSharedMouthAt||stamp-this.lastSharedMouthAt>80){
        this.lastSharedMouthAt=stamp;
        window.piShared?.update({speaking:true,mouth:mouthOpen});
      }

      if (mouthOpen > this.maxRecordedMouthOpen) {
        this.maxRecordedMouthOpen = mouthOpen;
      }
      if (mouthOpen > 0.15) {
        this.mouthMovedDuringTts = true;
      }

      // Update volume meter fill during TTS playback
      this.updateMeter(mouthOpen * 100);

      if (this.live2d && this.live2d.viewer) {
        this.live2d.viewer.setParameter("ParamMouthOpenY", mouthOpen);
        this.live2d.viewer.renderNow();
      }

      this.mouthMonitorTimer = requestAnimationFrame(updateMouth);
    };

    this.mouthMonitorTimer = requestAnimationFrame(updateMouth);
  }

  showTtsLoading(phase) {
    if(typeof document === "undefined" || !document.createElement || !document.body) return;
    if(!this.ttsLoading)this.ttsLoading=new TtsLoadingIndicator(this.serverUrl,()=>{
      this.speechInterrupted=true;
      this.stopTtsPlayback();
      this.updateTtsBadge("TTS: 已取消本轮语音");
      this.setStatus("语音已取消，文字回复继续", "ready");
    });
    this.ttsLoading.show(phase);
  }
  clearTtsLoading(){this.ttsLoadingAwaiting=false;this.ttsLoading?.hide();}
  stopTtsPlayback() {
    this.clearTtsLoading();
    ++this.playbackEpoch;
    this.waitingSpeech=[];
    clearTimeout(this.speechConnectTimer);
    clearTimeout(this.speechFlushTimer);
    this.speechFlushTimer = null;
    this.speechBuffer = '';
    this.pendingTtsRequests = 0;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'tts_cancel' }));
    this.ignoreTts = true;
    this.ttsPending = false;
    for (const source of this.ttsActiveSources.splice(0)) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.ttsNextPlayTime = 0;
    this.stopLipSyncDriving();
  }

  stopLipSyncDriving() {
    if(this.isTtsPlaying&&!this.speechInterrupted)this.echoGuardUntil=performance.now()+450;
    if(this.isTtsPlaying)window.piShared?.update({speaking:false,mouth:0});
    this.isTtsPlaying = false;
    window.currentMouthOpen = 0.0;
    if (this.mouthMonitorTimer) {
      cancelAnimationFrame(this.mouthMonitorTimer);
      this.mouthMonitorTimer = null;
    }
    this.resetMeter();
    this.setStatus("语音播报完毕，待机就绪", "ready");

    if (this.live2d) {
      this.live2d.stopSpeaking();
    }
    this.log("TTS 播放完成，角色口型已自然复位。");
  }

  // ---------------------------------------------------------------------------
  // Microphone Stream Handling & Resampling
  // ---------------------------------------------------------------------------
  resampleFloatTo16kPCM(inputBuffer, inSampleRate) {
    if (inSampleRate === 16000) {
      const out = new Int16Array(inputBuffer.length);
      for (let i = 0; i < inputBuffer.length; i++) {
        const s = Math.max(-1, Math.min(1, inputBuffer[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return out.buffer;
    }

    const ratio = inSampleRate / 16000;
    const maxOut = Math.ceil(inputBuffer.length / ratio) + 1;
    const outSamples = new Int16Array(maxOut);
    let outIdx = 0;

    while (this.resamplePhase < inputBuffer.length) {
      const i0 = Math.floor(this.resamplePhase);
      const i1 = Math.min(i0 + 1, inputBuffer.length - 1);
      const frac = this.resamplePhase - i0;
      const sample = inputBuffer[i0] * (1 - frac) + inputBuffer[i1] * frac;
      const s = Math.max(-1, Math.min(1, sample));
      outSamples[outIdx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      this.resamplePhase += ratio;
    }
    this.resamplePhase -= inputBuffer.length;
    return outSamples.buffer.slice(0, outIdx * 2);
  }

  resetBargeIn() {
    this.bargeInVoicedMs=0;this.bargeInBuffer=[];this.bargeInBufferMs=0;
  }

  isPlaybackEcho(samples, sampleRate) {
    if(!this.ttsAudioCtx||!this.echoReference.length)return false;
    const end=this.ttsAudioCtx.currentTime;
    const duration=samples.length/sampleRate;
    const stride=Math.max(1,Math.round(sampleRate/2000));
    // Compare with the *scheduled* PCM, including 0–400ms acoustic/device delay.
    for(let lag=0;lag<=.4;lag+=.008){
      let dot=0,micEnergy=0,refEnergy=0,count=0;
      for(let i=0;i<samples.length;i+=stride){
        const time=end-duration+i/sampleRate-lag;
        const chunk=this.echoReference.find(c=>time>=c.start&&time<c.start+c.samples.length/c.sampleRate);
        if(!chunk)continue;
        const reference=chunk.samples[Math.round((time-chunk.start)*chunk.sampleRate)]||0;
        const value=samples[i];dot+=value*reference;micEnergy+=value*value;refEnergy+=reference*reference;count++;
      }
      if(count>=32&&micEnergy>1e-7&&refEnergy>1e-7&&Math.abs(dot)/Math.sqrt(micEnergy*refEnergy)>.42)return true;
    }
    return false;
  }

  detectBargeIn(samples, sampleRate) {
    if (!samples.length || !sampleRate) return null;
    const ms=samples.length/sampleRate*1000;
    let energy=0;for(const value of samples)energy+=value*value;
    const rms=Math.sqrt(energy/samples.length);
    const echo=this.isPlaybackEcho(samples,sampleRate);
    if(echo){
      this.bargeInNoiseFloor=.8*this.bargeInNoiseFloor+.2*Math.min(rms,.04);
      this.resetBargeIn();return null;
    }
    if(this.isTtsPlaying&&performance.now()-this.playbackStartedAt<240){this.resetBargeIn();return null;}
    const threshold=Math.max(this.isTtsPlaying ? .03 : .018,Math.min(.09,this.bargeInNoiseFloor*3.5));
    if(rms<threshold){
      this.bargeInNoiseFloor=.96*this.bargeInNoiseFloor+.04*Math.min(rms,.02);
      this.bargeInVoicedMs=0;
    } else this.bargeInVoicedMs+=ms;
    this.bargeInBuffer.push(new Float32Array(samples));this.bargeInBufferMs+=ms;
    while(this.bargeInBufferMs>450 && this.bargeInBuffer.length>1){
      this.bargeInBufferMs-=this.bargeInBuffer.shift().length/sampleRate*1000;
    }
    if(this.bargeInVoicedMs<180)return null;
    const buffered=this.bargeInBuffer.slice();
    this.interruptForSpeech();
    this.resetBargeIn();
    return buffered;
  }

  interruptForSpeech() {
    this.clearUtteranceCandidate();
    const abortAgent=this.agentReplyInProgress;
    this.speechInterrupted=true;
    this.agentSpeechFinished=true;
    this.agentReplyInProgress=false;
    this.stopTtsPlayback(); // stops queued AudioBufferSources AND server synthesis
    this.setStatus('已打断，我在听你说…','recording');
    this.onBargeIn?.();
    if(abortAgent){
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),2500);
      this.interruptionPromise=fetch(new URL('/api/abort',this.serverUrl),{method:'POST',signal:controller.signal})
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);})
        .catch(err=>this.showNotice('声音已停止，取消旧任务时出现提示：'+err.message))
        .finally(()=>{clearTimeout(timeout);this.interruptionPromise=null;});
    }
  }

  handleMicChunk(floatData) {
    if(this.realtimeActive){
      if(this.isRecording&&this.micAudioCtx){
        let energy=0;for(const sample of floatData)energy+=sample*sample;
        if(!this.isTtsPlaying)this.updateMeter(Math.min(100,Math.sqrt(energy/floatData.length)*400));
        this.realtimeSession?.sendPCM(this.resampleFloatTo16kPCM(floatData,this.micAudioCtx.sampleRate));
      }
      return;
    }
    if(this.asrProviderSent&&this.asrProviderConfirmed!==this.currentAsrProvider)return;
    if (!this.isRecording && !this.isPlayingTestAudio) return;
    if (!this.micAudioCtx) return;
    if (!this.isPlayingTestAudio && (this.isTtsPlaying || this.ttsPending || this.agentReplyInProgress)) {
      const buffered=this.detectBargeIn(floatData,this.micAudioCtx.sampleRate);
      if(buffered && this.ws?.readyState===WebSocket.OPEN){
        this.resamplePhase=0;
        this.ws.send(JSON.stringify({type:'asr_reset'}));
        for(const chunk of buffered)this.ws.send(this.resampleFloatTo16kPCM(chunk,this.micAudioCtx.sampleRate));
      }
      return;
    }
    this.resetBargeIn();
    if(!this.speechInterrupted && performance.now()<this.echoGuardUntil){
      if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(this.resampleFloatTo16kPCM(new Float32Array(floatData.length),this.micAudioCtx.sampleRate));
      return;
    }

    // Calculate RMS amplitude for volume meter
    let sumSquares = 0;
    for (let i = 0; i < floatData.length; i++) {
      sumSquares += floatData[i] * floatData[i];
    }
    const rms = Math.sqrt(sumSquares / floatData.length);
    const volumePercent = Math.min(100, Math.round(rms * 400));
    this.updateMeter(volumePercent);

    // Resample to 16kHz PCM
    const pcmBuffer = this.resampleFloatTo16kPCM(floatData, this.micAudioCtx.sampleRate);
    if (pcmBuffer.byteLength > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBuffer);
    }
  }

  async startMicRecording() {
    if (this.isRecording || this.micStarting) return;
    this.micStarting = true;
    const generation = ++this.captureGeneration;
    try {
      this.hideNotice();
      if(!this.realtimeActive)this.connectWebSocket();

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("浏览器不支持或禁用了音频输入接口");
      }

      const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (this.inputDeviceId && this.inputDeviceId !== 'default') audio.deviceId = { exact: this.inputDeviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (generation !== this.captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.micMediaStream = stream;
      this.resamplePhase = 0;
      if (!this.realtimeActive && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'asr_reset' }));

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.micAudioCtx = new AudioContextClass({ sampleRate: 16000 });
      await this.micAudioCtx.resume();
      if (generation !== this.captureGeneration) return;
      const source = this.micAudioCtx.createMediaStreamSource(this.micMediaStream);

      this.micScriptNode = this.micAudioCtx.createScriptProcessor(1024, 1, 1);
      this.micScriptNode.onaudioprocess = (e) => this.handleMicChunk(e.inputBuffer.getChannelData(0));
      source.connect(this.micScriptNode);
      this.micScriptNode.connect(this.micAudioCtx.destination);

      this.isRecording = true;
      this.acceptUtteranceFinals=true;
      this.updateMicButton("recording");
      this.setStatus("正在录音并实时识别中...", "recording");
      this.log("麦克风启动成功，开始流式上行音频 PCM");
    } catch (err) {
      console.warn("[VoiceUI] 麦克风无法启动:", err.message);
      this.isRecording = false;
      this.updateMicButton("active");
      this.showNotice("麦克风权限未授予或无可用设备。您可以使用「测试音频」按钮进行真实中文语音全链路验证。");
      this.setStatus("麦克风不可用 (可通过测试音频验证)", "ready");
      this.stopMicRecording(false);
    } finally {
      this.micStarting = false;
    }
  }

  stopMicRecording(flush = true) {
    this.clearUtteranceCandidate();
    this.acceptUtteranceFinals=false;
    ++this.captureGeneration;
    this.isRecording = false;
    if (this.micMediaStream) {
      this.micMediaStream.getTracks().forEach(t => t.stop());
      this.micMediaStream = null;
    }
    if (this.micScriptNode) {
      this.micScriptNode.disconnect();
      this.micScriptNode = null;
    }
    if (this.micAudioCtx) {
      this.micAudioCtx.close().catch(() => {});
      this.micAudioCtx = null;
    }
    if (!this.realtimeActive && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: flush ? "asr_finish" : "asr_reset" }));
    }
    this.resamplePhase = 0;
    this.updateMicButton(this.isVoiceModeActive ? "active" : "idle");
    this.resetMeter();
  }

  // ---------------------------------------------------------------------------
  // Test Audio Mode (Real Chinese Speech Audio Injection)
  // ---------------------------------------------------------------------------
  async playTestSpeech() {
    if(this.realtimeActive){this.showNotice('请先退出实时语音，再使用测试音频');return;}
    try {
      if (this.isPlayingTestAudio) return;
      this.stopMicRecording(false);
      this.isVoiceModeActive = true;
      this.initTtsAudioContext();
      this.resamplePhase = 0;
      this.isPlayingTestAudio = true;
      this.acceptUtteranceFinals=true;
      this.hideNotice();
      this.showVoiceStatusBar();
      this.updateMicButton("recording");
      this.connectWebSocket();

      this.setStatus("正在加载真实中文测试音频 (test-zh.wav)...", "recording");
      this.showPartialTranscript("加载测试音频中...", 0);

      const res = await fetch("/audio-debug/test-zh.wav");
      if (!res.ok) throw new Error("无法读取 /audio-debug/test-zh.wav");
      const arrayBuf = await res.arrayBuffer();
      if (!this.isPlayingTestAudio) return;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.micAudioCtx = new AudioContextClass();
      const audioBuf = await this.micAudioCtx.decodeAudioData(arrayBuf);
      if (!this.isPlayingTestAudio) return;

      this.setStatus("流式推送测试音频并实时 ASR 出字...", "recording");
      const channelData = audioBuf.getChannelData(0);
      const chunkSize = 2048;
      let offset = 0;
      const stepMs = Math.round((chunkSize / audioBuf.sampleRate) * 1000);

      this.testAudioTimer = setInterval(() => {
        if (offset >= channelData.length) {
          this.stopTestSpeech();
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "asr_finish" }));
          }
          this.setStatus("测试音频推送完成，等待 ASR 确认与 Agent 回复...", "ready");
          return;
        }

        const chunk = channelData.subarray(offset, Math.min(offset + chunkSize, channelData.length));
        offset += chunkSize;
        this.handleMicChunk(chunk);
      }, stepMs);

    } catch (err) {
      this.isPlayingTestAudio = false;
      this.showNotice("测试音频加载失败: " + err.message);
      this.setStatus("测试音频加载失败", "ready");
      this.updateMicButton(this.isVoiceModeActive ? "active" : "idle");
    }
  }

  stopTestSpeech() {
    if (this.testAudioTimer) {
      clearInterval(this.testAudioTimer);
      this.testAudioTimer = null;
    }
    this.isPlayingTestAudio = false;
    if (!this.isRecording && this.micAudioCtx) {
      this.micAudioCtx.close().catch(() => {});
      this.micAudioCtx = null;
    }
    this.updateMicButton(this.isVoiceModeActive ? "active" : "idle");
    this.resetMeter();
  }

  log(msg, level = "info") {
    console.log(`[VoiceUI] ${msg}`);
  }
}

// UI-only, indeterminate: no estimated percentage is represented as model progress.
class TtsLoadingIndicator {
  constructor(serverUrl,onCancel){
    this.timer=null;this.startedAt=0;
    if(!document.getElementById('ttsLoadingStyle')){const css=document.createElement('link');css.id='ttsLoadingStyle';css.rel='stylesheet';css.href=new URL('/tts-loading.css',serverUrl).href;document.head.append(css);}
    this.root=document.createElement('section');this.root.className='tts-loading';this.root.hidden=true;this.root.setAttribute('aria-label','语音准备进度');
    this.label=document.createElement('span');this.label.setAttribute('role','status');this.label.setAttribute('aria-live','polite');
    this.elapsed=document.createElement('span');this.elapsed.className='tts-loading-elapsed';
    const row=document.createElement('div');row.className='tts-loading-row';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消语音';cancel.title='只取消本轮语音，文字回复继续';cancel.onclick=onCancel;
    row.append(this.label,this.elapsed,cancel);
    const track=document.createElement('div');track.className='tts-loading-track';track.setAttribute('role','progressbar');track.setAttribute('aria-label','等待语音首段');const fill=document.createElement('i');track.append(fill);
    this.root.append(row,track);document.body.append(this.root);
    window.addEventListener('pagehide',()=>this.hide());
  }
  place(){
    const overlay=document.getElementById('voiceSettingsOverlay');
    const modal=overlay?.classList.contains('visible')?document.getElementById('voiceSettingsModal'):null;
    const host=modal?.querySelector('.settings-modal-body')||modal||document.body;
    if(this.root.parentElement!==host){if(host!==document.body)host.prepend(this.root);else host.append(this.root);this.root.inert=false;}
    this.root.classList.toggle('tts-loading-inline',host!==document.body);
  }
  show(phase){
    this.place();this.label.textContent=({loading:'加载语音模型',warming:'预热语音模型',ready:'生成第一段语音',generating:'生成第一段语音'})[phase]||'准备语音';
    if(this.root.hidden){this.startedAt=Date.now();this.root.hidden=false;this.tick();this.timer=setInterval(()=>{this.place();this.tick();},1000);}
  }
  tick(){this.elapsed.textContent=`已等待 ${Math.max(0,Math.floor((Date.now()-this.startedAt)/1000))} 秒`;}
  hide(){clearInterval(this.timer);this.timer=null;this.root.hidden=true;}
}
