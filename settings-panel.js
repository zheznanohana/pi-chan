import {initCloudVoicePanel} from './cloud-voice-panel.js';
/**
 * settings-panel.js - Pi-chan Dashboard Voice Settings Panel
 * Independent voice settings interface: Input/Output devices, TTS voices,
 * VAD threshold, ASR/TTS toggles, engine health statuses, and persistence.
 * ZERO EMOJIS: All iconography uses SVG / CSS.
 */

export const DEFAULT_SETTINGS = {
  asrProvider: 'local',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  voiceKey: 'vits-aishell3',
  cloneVoiceKey: 'gpt-sovits-klee',
  speakerId: 51,
  vadThreshold: 0.015,
  asrEnabled: true,
  ttsEnabled: true
};

const STORAGE_KEY = 'pichan_voice_settings';

// 这台机器装了多个虚拟声卡（Steam Streaming / Oculus / Pico / Virtual Desktop /
// Mixed Reality Link / NVIDIA Virtual Audio）。它们会混进设备列表，选中后不会报错，
// 只是永远收不到声、也不出声，排查起来很费劲，所以在列表里显式标出来。
const VIRTUAL_DEVICE_HINTS = [
  'steam', 'oculus', 'pico', 'virtual desktop', 'mixed reality', 'mr link',
  'virtual audio', 'vb-audio', 'voicemeeter', 'nvidia virtual'
];
function isVirtualAudioDevice(label) {
  const l = (label || '').toLowerCase();
  return VIRTUAL_DEVICE_HINTS.some((h) => l.includes(h));
}

export class VoiceSettingsPanel {
  constructor(options = {}) {
    this.voiceUI = options.voiceUI || window.voiceUI || null;
    this.live2d = options.live2d || window.live2d || null;

    this.settings = this.loadSettings();
    this.isOpen = false;
    this.focusReturnTarget = null;
    this.modalBackgroundState = [];

    // Cache lists
    this.voiceList = [];
    this.inputDevices = [];
    this.outputDevices = [];

    // Engine statuses
    this.asrStatus = { state: 'loading', text: '检测中', detail: '等待 ASR WebSocket 握手...', error: '' };
    this.ttsStatus = { state: 'loading', text: '检测中', detail: '等待 TTS 服务响应...', error: '' };

    // Audition playback state
    this.isAuditioning = false;
    this.auditionAudio = null;
    this.auditionTimer = null;

    // Mic VU test state
    this.micVuStream = null;
    this.micVuAudioCtx = null;
    this.micVuAnalyser = null;
    this.micVuTimer = null;

    // DOM cache
    this.dom = {};
  }

  init() {
    this.renderMarkup();
    this.cacheDom();
    this.initCloudTtsSettings();
    this.initAsrProviderSettings();
    this.initMcpSettings();
    this.cloudVoicePanel=initCloudVoicePanel(this);
    this.bindEvents();
    document.getElementById('settingCloneAuditionBtn')?.addEventListener('click',()=>this.playAudition(true));
    document.getElementById('settingCloneVoiceSelect')?.addEventListener('change',e=>{this.settings.cloneVoiceKey=e.target.value;this.saveSettings();});
    this.hookVoiceUI();
    this.applySettingsToRuntime();
    if(window.piShared){
      const receive=async state=>{
        if(state.voiceSettings&&JSON.stringify(state.voiceSettings)!==JSON.stringify(this.settings)){
          const oldInput=this.settings.inputDeviceId;
          this.settings={...DEFAULT_SETTINGS,...state.voiceSettings};
          localStorage.setItem(STORAGE_KEY,JSON.stringify(this.settings));
          this.syncDomWithSettings();await this.applySettingsToRuntime();
          if(oldInput!==this.settings.inputDeviceId&&this.voiceUI?.isRecording){this.voiceUI.stopMicRecording(false);await this.voiceUI.startMicRecording();}
        }
        if(state.captureOwner==='pet'&&state.transcript){
          if(state.transcriptFinal)this.voiceUI.showFinalTranscript(state.transcript);
          else this.voiceUI.showPartialTranscript(state.transcript);
        }
      };
      window.piShared.subscribe(receive);
      window.piShared.getState().then(state=>state.voiceSettings?receive(state):window.piShared.update({voiceSettings:this.settings}));
    }

    // Initial load of devices and server info
    this.refreshAll();

    // Handle hash route (e.g. index.html#settings)
    if (window.location.hash === '#settings') {
      this.open();
    }
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#settings') {
        if (!this.isOpen) this.open();
      } else {
        if (this.isOpen) this.close(false);
      }
    });

    console.log('[VoiceSettings] 独立语音设置面板初始化完成');
  }

  setVoiceUI(instance) {
    this.voiceUI = instance;
    this.hookVoiceUI();
    this.applySettingsToRuntime();
  }

  // ---------------------------------------------------------------------------
  // Settings Persistence (localStorage)
  // ---------------------------------------------------------------------------
  loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if(parsed.voiceKey&&!['vits-aishell3','matcha-baker','qwen3-clone','gpt-sovits-klee','qwen-cloud'].includes(parsed.voiceKey)){parsed.cloneVoiceKey=parsed.voiceKey;parsed.voiceKey='vits-aishell3';parsed.speakerId=51;}
        return Object.assign({}, DEFAULT_SETTINGS, parsed);
      }
    } catch (e) {
      console.warn('[VoiceSettings] 无法读取 localStorage 设置，恢复默认值:', e);
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      this.showSaveIndicator();
      window.piShared?.update({voiceSettings:this.settings});
    } catch (e) {
      console.warn('[VoiceSettings] 无法写入 localStorage:', e);
    }
  }

  showSaveIndicator() {
    if (this.dom.saveBadge) {
      this.dom.saveBadge.classList.add('active');
      clearTimeout(this._saveBadgeTimer);
      this._saveBadgeTimer = setTimeout(() => {
        if (this.dom.saveBadge) this.dom.saveBadge.classList.remove('active');
      }, 1500);
    }
  }

  restoreDefaults() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.saveSettings();
    this.syncDomWithSettings();
    this.applySettingsToRuntime();
    console.log('[VoiceSettings] 已恢复默认语音配置');
  }

  // ---------------------------------------------------------------------------
  // Runtime Hook & Immediate Effectiveness
  // ---------------------------------------------------------------------------
  hookVoiceUI() {
    if (!this.voiceUI) return;

    // Entering a two-way conversation explicitly enables both directions.
    this.voiceUI.onEnableConversation=()=>{
      this.settings.ttsEnabled=true;this.settings.asrEnabled=true;
      this.saveSettings();this.syncDomWithSettings();
    };
    // 1. Sync voice and speaker ID
    this.voiceUI.setAsrProvider?.(this.settings.asrProvider||'local');
    this.voiceUI.currentVoiceKey = this.settings.voiceKey;
    this.voiceUI.currentSid = this.settings.speakerId;
    this.voiceUI.outputDeviceId = this.settings.outputDeviceId;

    // 2. Wrap handleMicChunk for immediate VAD silence gating & ASR toggle
    if (!this.voiceUI._origHandleMicChunk) {
      this.voiceUI._origHandleMicChunk = this.voiceUI.handleMicChunk.bind(this.voiceUI);
      const self = this;
      this.voiceUI.handleMicChunk = function (floatData) {
        // ASR toggle: suppress microphone speech ingestion when turned off
        if (!self.settings.asrEnabled && !this.isPlayingTestAudio) {
          return;
        }

        // Keep original microphone samples. RMS gating was erasing quiet
        // consonants and turning low-volume syllables into artificial silence.
        // Pass through to native processor
        this._origHandleMicChunk(floatData);
      };
    }

    // 3. Wrap speakAgentReply for immediate TTS toggle
    if (!this.voiceUI._origSpeakAgentReply) {
      this.voiceUI._origSpeakAgentReply = this.voiceUI.speakAgentReply.bind(this.voiceUI);
      const self = this;
      this.voiceUI.speakAgentReply = function (rawText, options) {
        if (!self.settings.ttsEnabled) {
          console.log('[VoiceSettings] 语音播报 (TTS) 已在设置中关闭，跳过语音合成。');
          return;
        }
        this._origSpeakAgentReply(rawText, options);
      };
    }

    // 4. Wrap startMicRecording to enforce chosen input device and ASR toggle
    if (!this.voiceUI._origStartMicRecording) {
      this.voiceUI._origStartMicRecording = this.voiceUI.startMicRecording.bind(this.voiceUI);
      const self = this;
      this.voiceUI.startMicRecording = async function () {
        if (!self.settings.asrEnabled) {
          this.showNotice('实时语音识别 (ASR) 已在设置中关闭。请点击麦克风旁边的设置图标开启。');
          return;
        }
        this.inputDeviceId = self.settings.inputDeviceId;
        await this._origStartMicRecording();
      };
    }
  }

  async applySettingsToRuntime() {
    if (!this.voiceUI) return;
    this.voiceUI.setAsrProvider?.(this.settings.asrProvider||'local');

    // 1. Update Voice Key & Speaker ID on client & server
    this.voiceUI.currentVoiceKey = this.settings.voiceKey;
    this.voiceUI.currentSid = this.settings.speakerId;
    this.voiceUI.outputDeviceId = this.settings.outputDeviceId;

    try {
      await fetch('/api/tts/set-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: this.settings.voiceKey,
          sid: this.settings.speakerId
        })
      });
    } catch (e) {
      // Non-blocking degradation
      console.warn('[VoiceSettings] 后端 /api/tts/set-voice 同步提示:', e.message);
    }

    // 2. Apply Output Device (setSinkId) if supported
    if (this.settings.outputDeviceId && this.voiceUI.ttsAudioCtx) {
      if (typeof this.voiceUI.ttsAudioCtx.setSinkId === 'function') {
        try {
          const sinkId = this.settings.outputDeviceId === 'default' ? '' : this.settings.outputDeviceId;
          await this.voiceUI.ttsAudioCtx.setSinkId(sinkId);
        } catch (err) {
          console.warn('[VoiceSettings] setSinkId 应用异常:', err.message);
        }
      }
    }

    // 3. ASR Switch immediate check
    if (!this.settings.asrEnabled && this.voiceUI.isRecording) {
      this.voiceUI.stopMicRecording(false);
    }

    // 4. TTS Switch immediate check
    if (!this.settings.ttsEnabled && this.voiceUI.isTtsPlaying) {
      this.voiceUI.stopTtsPlayback();
    }
  }

  // ---------------------------------------------------------------------------
  // Audio Device Enumeration (Input / Output)
  // ---------------------------------------------------------------------------
  async enumerateDevices() {
    this.inputDevices = [];
    this.outputDevices = [];

    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      this.showMicNotice('当前浏览器环境不支持 enumerateDevices 设备查询接口。');
      this.showSpeakerNotice('当前浏览器环境不支持扬声器切换。');
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      let inputCount = 0;
      let outputCount = 0;

      devices.forEach((dev, idx) => {
        if (dev.kind === 'audioinput') {
          inputCount++;
          this.inputDevices.push({
            deviceId: dev.deviceId || `input-${idx}`,
            label: dev.label || `麦克风设备 ${inputCount}`,
            virtual: isVirtualAudioDevice(dev.label)
          });
        } else if (dev.kind === 'audiooutput') {
          outputCount++;
          this.outputDevices.push({
            deviceId: dev.deviceId || `output-${idx}`,
            label: dev.label || `扬声器设备 ${outputCount}`,
            virtual: isVirtualAudioDevice(dev.label)
          });
        }
      });

      this.populateDeviceDropdowns();

      if (this.inputDevices.length === 0) {
        this.showMicNotice('未检测到可用的麦克风硬件，或麦克风权限未授予。');
      } else {
        this.hideMicNotice();
      }

      const sinkSupported = 'setSinkId' in HTMLMediaElement.prototype || (window.AudioContext && 'setSinkId' in AudioContext.prototype);
      if (!sinkSupported) {
        this.showSpeakerNotice('浏览器不支持 setSinkId 扬声器切换，声音将通过默认设备输出。');
      } else {
        this.hideSpeakerNotice();
      }

    } catch (err) {
      console.warn('[VoiceSettings] 获取设备列表失败:', err.message);
      this.showMicNotice('无法读取音频输入设备列表: ' + err.message);
      this.showSpeakerNotice('无法读取音频输出设备列表: ' + err.message);
    }
  }

  populateDeviceDropdowns() {
    // 1. Microphone select
    if (this.dom.inputDeviceSelect) {
      this.dom.inputDeviceSelect.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = 'default';
      defaultOpt.textContent = '系统默认麦克风 (Default)';
      this.dom.inputDeviceSelect.appendChild(defaultOpt);

      this.inputDevices.forEach(d => {
        if (d.deviceId !== 'default' && d.deviceId !== '') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          // 虚拟声卡加前缀，避免误选后「不报错但没声音」
          opt.textContent = d.virtual ? '[虚拟] ' + d.label : d.label;
          this.dom.inputDeviceSelect.appendChild(opt);
        }
      });

      // Select active device
      this.dom.inputDeviceSelect.value = this.settings.inputDeviceId || 'default';
      if (!this.dom.inputDeviceSelect.value) {
        this.dom.inputDeviceSelect.value = 'default';
      }
    }

    // 2. Speaker select
    if (this.dom.outputDeviceSelect) {
      this.dom.outputDeviceSelect.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = 'default';
      defaultOpt.textContent = '系统默认扬声器 (Default)';
      this.dom.outputDeviceSelect.appendChild(defaultOpt);

      this.outputDevices.forEach(d => {
        if (d.deviceId !== 'default' && d.deviceId !== '') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          // 虚拟声卡加前缀，避免误选后「不报错但没声音」
          opt.textContent = d.virtual ? '[虚拟] ' + d.label : d.label;
          this.dom.outputDeviceSelect.appendChild(opt);
        }
      });

      this.dom.outputDeviceSelect.value = this.settings.outputDeviceId || 'default';
      if (!this.dom.outputDeviceSelect.value) {
        this.dom.outputDeviceSelect.value = 'default';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TTS & ASR Health Status and Voice List Query
  // ---------------------------------------------------------------------------
  async fetchTtsInfo() {
    try {
      const res = await fetch('/api/tts/info');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (data.code === 0 && Array.isArray(data.voices)) {
        this.voiceList = data.voices;
        this.populateVoiceDropdown();
        this.hideVoiceDegradeBanner();

        // Update TTS Status Card
        const currentModel = data.model || {};
        this.ttsStatus = {
          state: 'ready',
          text: '服务就绪',
          detail: `${currentModel.name || 'TTS 引擎'} · 采样率: ${currentModel.sampleRate || 8000}Hz · ${currentModel.streamingCapable ? '流式音频输出' : '逐句生成 · 首次加载较慢'}`,
          error: ''
        };
      } else {
        throw new Error(data.error || '返回数据格式不符合预期');
      }
    } catch (err) {
      console.warn('[VoiceSettings] 获取 TTS 信息失败，优雅降级:', err.message);
      this.showVoiceDegradeBanner('TTS 引擎接口暂时不可用或正在返工升级模型。已自动启用本地默认音色，保证基础功能可用。');
      this.ttsStatus = {
        state: 'error',
        text: '服务异常',
        detail: '无法连接到 /api/tts/info',
        error: err.message
      };
      // Fallback voices
      this.voiceList = [
        { key: 'vits-aishell3', name: 'VITS AISHELL-3 多发音人模型', sampleRate: 8000, defaultSid: 51, description: '51号发音人 SSB0427 (元气少女音)' },
        { key: 'matcha-baker', name: 'Matcha-TTS 标贝女声模型', sampleRate: 22050, defaultSid: 0, description: '标贝女声 (DataBaker Chinese Female)' }
      ];
      this.populateVoiceDropdown();
    }
    this.updateStatusDisplay();
  }

  checkAsrStatus() {
    if (this.voiceUI && this.voiceUI.wsReady) {
      this.asrStatus = {
        state: 'ready',
        text: '服务就绪',
        detail: 'Zipformer 实时预览 + SenseVoice 中文终稿 · 采样率: 16000Hz · 实测延迟: 19ms',
        error: ''
      };
    } else if (this.voiceUI && this.voiceUI.ws && this.voiceUI.ws.readyState === WebSocket.CONNECTING) {
      this.asrStatus = {
        state: 'loading',
        text: '连接中',
        detail: '正在建立 /ws/audio 流式通信链路...',
        error: ''
      };
    } else {
      this.asrStatus = {
        state: 'error',
        text: '未就绪',
        detail: 'ASR WebSocket 链路未建立',
        error: '请检查 harness-server 服务是否正常启动'
      };
    }
    this.updateStatusDisplay();
  }

  populateVoiceDropdown() {
    if(this.cloudTtsDom)this.cloudTtsDom.provider.value=this.settings.voiceKey==='qwen-cloud'?'cloud':'local';
    if (!this.dom.voiceSelect) return;
    this.dom.voiceSelect.innerHTML = '';

    if(!this.voiceList.some(v=>v.key==='qwen-cloud'))this.voiceList.push({key:'qwen-cloud',name:'云端 TTS',description:'先配置服务与凭据'});
    this.voiceList.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.key;
      opt.textContent = `${v.name} (${v.description || '默认音色'})`;
      this.dom.voiceSelect.appendChild(opt);
    });

    this.dom.voiceSelect.value = this.settings.voiceKey;
    if (!this.dom.voiceSelect.value && this.voiceList.length > 0) {
      this.dom.voiceSelect.value = this.voiceList[0].key;
      this.settings.voiceKey = this.voiceList[0].key;
    }

    const cloneSelect=document.getElementById('settingCloneVoiceSelect');
    if(cloneSelect){
      cloneSelect.innerHTML='';
      this.voiceList.filter(v=>!['vits-aishell3','matcha-baker','qwen-cloud'].includes(v.key)).forEach(v=>{const opt=document.createElement('option');opt.value=v.key;opt.textContent=v.name;cloneSelect.appendChild(opt);});
      cloneSelect.value=this.settings.cloneVoiceKey;
    }
    this.updateSpeakerOptions();
  }

  updateSpeakerOptions() {
    if (!this.dom.speakerIdSelect) return;
    this.dom.speakerIdSelect.innerHTML = '';

    const selectedVoiceKey = this.dom.voiceSelect ? this.dom.voiceSelect.value : this.settings.voiceKey;
    const voiceMeta = this.voiceList.find(v => v.key === selectedVoiceKey);

    if (selectedVoiceKey === 'vits-aishell3') {
      const candidates = [
        { sid: 51, label: '51号发音人 SSB0427 (元气少女音 - 推荐)' },
        { sid: 0, label: '0号发音人 (标准清晰女声)' },
        { sid: 10, label: '10号发音人 (清脆明朗女声)' },
        { sid: 20, label: '20号发音人 (知性沉稳女声)' },
        { sid: 30, label: '30号发音人 (温柔亲切女声)' }
      ];
      candidates.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.sid;
        opt.textContent = c.label;
        this.dom.speakerIdSelect.appendChild(opt);
      });
      this.dom.speakerIdGroup.style.display = 'block';
      this.dom.speakerIdSelect.value = this.settings.speakerId !== undefined ? this.settings.speakerId : 51;
    } else if (voiceMeta && voiceMeta.numSpeakers > 1) {
      for (let i = 0; i < Math.min(voiceMeta.numSpeakers, 20); i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${i}号发音人`;
        this.dom.speakerIdSelect.appendChild(opt);
      }
      this.dom.speakerIdGroup.style.display = 'block';
      this.dom.speakerIdSelect.value = this.settings.speakerId || 0;
    } else {
      // Single speaker
      const opt = document.createElement('option');
      opt.value = 0;
      opt.textContent = '单发音人 (默认)';
      this.dom.speakerIdSelect.appendChild(opt);
      this.dom.speakerIdGroup.style.display = 'none';
      this.settings.speakerId = 0;
    }
  }

  updateStatusDisplay() {
    // 1. ASR Display
    if (this.dom.asrBadge) {
      this.dom.asrBadge.className = `status-badge ${this.asrStatus.state}`;
      this.dom.asrBadge.textContent = this.asrStatus.text;
    }
    if (this.dom.asrDetail) {
      this.dom.asrDetail.textContent = this.asrStatus.detail;
    }
    if (this.dom.asrErrorBanner) {
      if (this.asrStatus.error) {
        this.dom.asrErrorBanner.textContent = '错误原因: ' + this.asrStatus.error;
        this.dom.asrErrorBanner.style.display = 'block';
      } else {
        this.dom.asrErrorBanner.style.display = 'none';
      }
    }

    // 2. TTS Display
    if (this.dom.ttsBadge) {
      this.dom.ttsBadge.className = `status-badge ${this.ttsStatus.state}`;
      this.dom.ttsBadge.textContent = this.ttsStatus.text;
    }
    if (this.dom.ttsDetail) {
      this.dom.ttsDetail.textContent = this.ttsStatus.detail;
    }
    if (this.dom.ttsErrorBanner) {
      if (this.ttsStatus.error) {
        this.dom.ttsErrorBanner.textContent = '错误原因: ' + this.ttsStatus.error;
        this.dom.ttsErrorBanner.style.display = 'block';
      } else {
        this.dom.ttsErrorBanner.style.display = 'none';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Audition Voice Audio Playback
  // ---------------------------------------------------------------------------
  async playAudition(clone = false) {
    if (this.isAuditioning) {
      this.stopAudition();
      return;
    }

    this.isAuditioning = true;

    const auditionText = '你好！我是皮酱，这是当前的语音试听效果。';
    const voiceKey = clone ? (document.getElementById('settingCloneVoiceSelect')?.value || this.settings.cloneVoiceKey) : this.settings.voiceKey;
    const sid = clone ? 0 : (parseInt(this.settings.speakerId, 10) || 0);
    this.auditionIsClone=clone;
    this.updateAuditionButtonState(true);

    console.log(`[VoiceSettings] 开始试听音色: voice=${voiceKey}, sid=${sid}`);

    try {
      // Direct Web Audio Streaming over WebSocket if available
      if (this.voiceUI && this.voiceUI.ws && this.voiceUI.ws.readyState === WebSocket.OPEN) {
        // Audition requests carry their own voice; conversation preferences stay unchanged.

        // Trigger speech synthesis
        this.voiceUI.stopTtsPlayback();
        this.voiceUI.ignoreTts = false;
        this.voiceUI.ttsPending = true;
        this.voiceUI.pendingTtsRequests = 1;
        this.voiceUI.initTtsAudioContext();
        if (typeof this.voiceUI.ttsAudioCtx.setSinkId === 'function' && this.settings.outputDeviceId !== 'default') {
          this.voiceUI.ttsAudioCtx.setSinkId(this.settings.outputDeviceId).catch(() => {});
        }

        this.voiceUI.ws.send(JSON.stringify({
          type: 'tts_speak',
          text: auditionText,
          speed: 1.0,
          voice: voiceKey,
          sid: sid
        }));

        // Watch for playback finish
        let settledCheckCount = 0;
        this.auditionTimer = setInterval(() => {
          if (!this.voiceUI.ttsPending && !this.voiceUI.isTtsPlaying && this.voiceUI.ttsActiveSources.length === 0) {
            settledCheckCount++;
            if (settledCheckCount > 2) {
              this.stopAudition();
            }
          } else {
            settledCheckCount = 0;
          }
        }, 200);

        // Safety timeout
        this.auditionTimeout = setTimeout(() => {
          if (this.isAuditioning) this.stopAudition();
        }, 300000);

      } else {
        throw new Error('WebSocket 未连接，无法流式出音');
      }
    } catch (err) {
      console.warn('[VoiceSettings] 试听失败:', err.message);
      this.stopAudition();
      this.showVoiceNotice('试听未能出声: ' + err.message + '。您也可以在首页点击麦克风进行端到端对话验证。');
    }
  }

  stopAudition() {
    const wasAuditioning = this.isAuditioning;
    clearTimeout(this.auditionTimeout);
    this.isAuditioning = false;
    if (this.auditionTimer) {
      clearInterval(this.auditionTimer);
      this.auditionTimer = null;
    }
    if (this.voiceUI && wasAuditioning) {
      this.voiceUI.stopTtsPlayback();
    }
    this.updateAuditionButtonState(false);
    const cloneBtn=document.getElementById('settingCloneAuditionBtn');if(cloneBtn)cloneBtn.textContent='试听克隆音色';
  }

  updateAuditionButtonState(playing) {
    if(this.auditionIsClone){const btn=document.getElementById('settingCloneAuditionBtn');if(btn)btn.textContent=playing?'正在生成 / 播放，点击停止':'试听克隆音色';return;}
    if (!this.dom.auditionBtn) return;
    if (playing) {
      this.dom.auditionBtn.classList.add('playing');
      this.dom.auditionBtn.innerHTML = `
        <svg class="settings-btn-icon wave-anim" viewBox="0 0 24 24" fill="currentColor">
          <rect x="3" y="9" width="3" height="6" rx="1"></rect>
          <rect x="8" y="5" width="3" height="14" rx="1"></rect>
          <rect x="13" y="3" width="3" height="18" rx="1"></rect>
          <rect x="18" y="7" width="3" height="10" rx="1"></rect>
        </svg>
        <span>正在试听播放中... (点击停止)</span>
      `;
    } else {
      this.dom.auditionBtn.classList.remove('playing');
      this.dom.auditionBtn.innerHTML = `
        <svg class="settings-btn-icon" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>试听当前音色</span>
      `;
    }
  }

  // ---------------------------------------------------------------------------
  // Microphone VU Level Test
  // ---------------------------------------------------------------------------
  async startMicVuTest() {
    if (this.micVuStream) return;
    try {
      const constraints = {
        audio: this.settings.inputDeviceId && this.settings.inputDeviceId !== 'default'
          ? { deviceId: { exact: this.settings.inputDeviceId } }
          : true
      };
      this.micVuStream = await navigator.mediaDevices.getUserMedia(constraints);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.micVuAudioCtx = new AudioContextClass();
      const src = this.micVuAudioCtx.createMediaStreamSource(this.micVuStream);
      this.micVuAnalyser = this.micVuAudioCtx.createAnalyser();
      this.micVuAnalyser.fftSize = 256;
      src.connect(this.micVuAnalyser);

      const buf = new Uint8Array(this.micVuAnalyser.frequencyBinCount);
      const tick = () => {
        if (!this.micVuAnalyser) return;
        this.micVuAnalyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        const pct = Math.min(100, Math.round((avg / 128) * 100));
        if (this.dom.micVuFill) {
          this.dom.micVuFill.style.width = `${pct}%`;
        }
        this.micVuTimer = requestAnimationFrame(tick);
      };
      this.micVuTimer = requestAnimationFrame(tick);
    } catch (e) {
      // Fallback silently if test cannot start
      console.log('[VoiceSettings] 麦克风拾音测试跳过:', e.message);
    }
  }

  stopMicVuTest() {
    if (this.micVuTimer) {
      cancelAnimationFrame(this.micVuTimer);
      this.micVuTimer = null;
    }
    if (this.micVuStream) {
      this.micVuStream.getTracks().forEach(t => t.stop());
      this.micVuStream = null;
    }
    if (this.micVuAudioCtx) {
      this.micVuAudioCtx.close().catch(() => {});
      this.micVuAudioCtx = null;
    }
    if (this.dom.micVuFill) {
      this.dom.micVuFill.style.width = '0%';
    }
  }

  // ---------------------------------------------------------------------------
  // Notice & Fallback Banners
  // ---------------------------------------------------------------------------
  showMicNotice(msg) {
    if (this.dom.micNotice) {
      this.dom.micNotice.textContent = msg;
      this.dom.micNotice.style.display = 'block';
    }
  }
  hideMicNotice() {
    if (this.dom.micNotice) this.dom.micNotice.style.display = 'none';
  }

  showSpeakerNotice(msg) {
    if (this.dom.speakerNotice) {
      this.dom.speakerNotice.textContent = msg;
      this.dom.speakerNotice.style.display = 'block';
    }
  }
  hideSpeakerNotice() {
    if (this.dom.speakerNotice) this.dom.speakerNotice.style.display = 'none';
  }

  showVoiceDegradeBanner(msg) {
    if (this.dom.voiceDegradeBanner) {
      this.dom.voiceDegradeBanner.textContent = msg;
      this.dom.voiceDegradeBanner.style.display = 'block';
    }
  }
  hideVoiceDegradeBanner() {
    if (this.dom.voiceDegradeBanner) this.dom.voiceDegradeBanner.style.display = 'none';
  }

  showVoiceNotice(msg) {
    if (this.dom.voiceGeneralNotice) {
      this.dom.voiceGeneralNotice.textContent = msg;
      this.dom.voiceGeneralNotice.style.display = 'block';
      setTimeout(() => {
        if (this.dom.voiceGeneralNotice) this.dom.voiceGeneralNotice.style.display = 'none';
      }, 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // UI Open / Close / Sync
  // ---------------------------------------------------------------------------
  open() {
    if (this.isOpen) return;
    this.focusReturnTarget = document.activeElement;
    this.isOpen = true;
    this.loadCloudTtsSettings();
    this.modalBackgroundState = [...document.body.children]
      .filter(node => node !== this.dom.overlay && !['SCRIPT','STYLE','LINK'].includes(node.tagName))
      .map(node => ({node, inert:node.inert}));
    for(const {node} of this.modalBackgroundState) node.inert=true;
    if (this.dom.overlay) {
      this.dom.overlay.classList.add('visible');
      requestAnimationFrame(() => { if(this.isOpen) this.dom.closeBtn?.focus({preventScroll:true}); });
    }
    if (window.location.hash !== '#settings') {
      window.location.hash = 'settings';
    }

    this.refreshAll();
    this.startMicVuTest();
  }

  close(updateHash = true) {
    this.cloudVoicePanel?.close();
    if(this.cloudTtsDom)this.cloudTtsDom.apiKey.value='';
    this.cloudLoadRevision=(this.cloudLoadRevision||0)+1;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.stopAudition();
    this.stopMicVuTest();

    if (this.dom.overlay) {
      this.dom.overlay.classList.remove('visible');
    }
    for(const {node,inert} of this.modalBackgroundState) if(node.isConnected) node.inert=inert;
    this.modalBackgroundState=[];
    if(this.focusReturnTarget?.isConnected) this.focusReturnTarget.focus?.({preventScroll:true});
    this.focusReturnTarget=null;
    if (updateHash && window.location.hash === '#settings') {
      history.pushState('', document.title, window.location.pathname + window.location.search);
    }
  }

  refreshAll() {
    this.syncDomWithSettings();
    this.enumerateDevices();
    this.fetchTtsInfo();
    this.checkAsrStatus();
  }

  syncDomWithSettings() {
    const asrProviderSelect=document.getElementById('settingAsrProvider');if(asrProviderSelect)asrProviderSelect.value=this.settings.asrProvider==='token-plan'?'token-plan':'local';
    if(this.cloudTtsDom)this.cloudTtsDom.provider.value=this.settings.voiceKey==='qwen-cloud'?'cloud':'local';
    if (this.dom.asrToggle) this.dom.asrToggle.checked = !!this.settings.asrEnabled;
    if (this.dom.ttsToggle) this.dom.ttsToggle.checked = !!this.settings.ttsEnabled;

    if (this.dom.vadSlider) {
      this.dom.vadSlider.value = this.settings.vadThreshold;
      this.updateVadLabel(this.settings.vadThreshold);
    }

    if (this.dom.inputDeviceSelect && this.settings.inputDeviceId) {
      this.dom.inputDeviceSelect.value = this.settings.inputDeviceId;
    }
    if (this.dom.outputDeviceSelect && this.settings.outputDeviceId) {
      this.dom.outputDeviceSelect.value = this.settings.outputDeviceId;
    }

    if (this.dom.voiceSelect && this.settings.voiceKey) {
      this.dom.voiceSelect.value = this.settings.voiceKey;
      this.updateSpeakerOptions();
    }
  }

  updateVadLabel(val) {
    const num = parseFloat(val);
    let desc = '推荐标准';
    if (num < 0.010) desc = '高灵敏度 (轻微耳语/极安静环境)';
    else if (num > 0.025) desc = '抗噪灵敏度 (滤除杂音/嘈杂环境)';
    if (this.dom.vadValue) {
      this.dom.vadValue.textContent = `${num.toFixed(3)} (${desc})`;
    }
  }

  // ---------------------------------------------------------------------------
  // Event Bindings
  // ---------------------------------------------------------------------------
  bindEvents() {
    // Close button & backdrop click
    if (this.dom.closeBtn) {
      this.dom.closeBtn.addEventListener('click', () => this.close());
    }
    if (this.dom.doneBtn) {
      this.dom.doneBtn.addEventListener('click', () => this.close());
    }
    if (this.dom.overlay) {
      this.dom.overlay.addEventListener('click', (e) => {
        if (e.target === this.dom.overlay) this.close();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
      if (e.key !== 'Tab') return;
      const controls=[...this.dom.modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
      if (!controls.length) { e.preventDefault(); return; }
      const first=controls[0], last=controls[controls.length-1], current=document.activeElement;
      if (!this.dom.modal.contains(current) || (e.shiftKey && current===first)) {
        e.preventDefault(); (e.shiftKey?last:first).focus();
      } else if (!e.shiftKey && current===last) {
        e.preventDefault(); first.focus();
      }
    });

    // Reset button
    if (this.dom.resetBtn) {
      this.dom.resetBtn.addEventListener('click', () => this.restoreDefaults());
    }

    // Refresh status button
    if (this.dom.refreshBtn) {
      this.dom.refreshBtn.addEventListener('click', () => this.refreshAll());
    }

    // ASR toggle
    if (this.dom.asrToggle) {
      this.dom.asrToggle.addEventListener('change', (e) => {
        this.settings.asrEnabled = e.target.checked;
        this.saveSettings();
        this.applySettingsToRuntime();
      });
    }

    // TTS toggle
    if (this.dom.ttsToggle) {
      this.dom.ttsToggle.addEventListener('change', (e) => {
        this.settings.ttsEnabled = e.target.checked;
        this.saveSettings();
        this.applySettingsToRuntime();
      });
    }

    // VAD Slider
    if (this.dom.vadSlider) {
      this.dom.vadSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.settings.vadThreshold = val;
        this.updateVadLabel(val);
        this.saveSettings();
      });
    }

    // Input device select
    if (this.dom.inputDeviceSelect) {
      this.dom.inputDeviceSelect.addEventListener('change', async (e) => {
        this.settings.inputDeviceId = e.target.value;
        this.saveSettings();
        this.applySettingsToRuntime();
        // Restart mic VU test on new device
        this.stopMicVuTest();
        this.startMicVuTest();
      });
    }

    // Output device select
    if (this.dom.outputDeviceSelect) {
      this.dom.outputDeviceSelect.addEventListener('change', (e) => {
        this.settings.outputDeviceId = e.target.value;
        this.saveSettings();
        this.applySettingsToRuntime();
      });
    }

    // Voice select
    if (this.dom.voiceSelect) {
      this.dom.voiceSelect.addEventListener('change', (e) => {
        this.settings.voiceKey = e.target.value;
        if(this.cloudTtsDom)this.cloudTtsDom.provider.value=e.target.value==='qwen-cloud'?'cloud':'local';
        if(e.target.value!=='qwen-cloud')this.lastLocalVoiceKey=e.target.value;
        this.updateSpeakerOptions();
        this.saveSettings();
        this.applySettingsToRuntime();
      });
    }

    // Speaker ID select
    if (this.dom.speakerIdSelect) {
      this.dom.speakerIdSelect.addEventListener('change', (e) => {
        this.settings.speakerId = parseInt(e.target.value, 10);
        this.saveSettings();
        this.applySettingsToRuntime();
      });
    }

    // Audition button
    if (this.dom.auditionBtn) {
      this.dom.auditionBtn.addEventListener('click', () => this.playAudition());
    }

    // Connect trigger button in page if already present
    const triggerBtn = document.getElementById('voiceSettingsBtn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', () => this.open());
    }
  }

  cacheDom() {
    this.dom = {
      overlay: document.getElementById('voiceSettingsOverlay'),
      modal: document.getElementById('voiceSettingsModal'),
      closeBtn: document.getElementById('voiceSettingsCloseBtn'),
      doneBtn: document.getElementById('voiceSettingsDoneBtn'),
      resetBtn: document.getElementById('voiceSettingsResetBtn'),
      refreshBtn: document.getElementById('voiceSettingsRefreshBtn'),
      saveBadge: document.getElementById('voiceSettingsSaveBadge'),

      asrBadge: document.getElementById('settingAsrBadge'),
      asrDetail: document.getElementById('settingAsrDetail'),
      asrErrorBanner: document.getElementById('settingAsrErrorBanner'),

      ttsBadge: document.getElementById('settingTtsBadge'),
      ttsDetail: document.getElementById('settingTtsDetail'),
      ttsErrorBanner: document.getElementById('settingTtsErrorBanner'),

      asrToggle: document.getElementById('settingAsrToggle'),
      ttsToggle: document.getElementById('settingTtsToggle'),

      inputDeviceSelect: document.getElementById('settingInputDeviceSelect'),
      micNotice: document.getElementById('settingMicNotice'),
      micVuFill: document.getElementById('settingMicVuFill'),

      outputDeviceSelect: document.getElementById('settingOutputDeviceSelect'),
      speakerNotice: document.getElementById('settingSpeakerNotice'),

      voiceSelect: document.getElementById('settingVoiceSelect'),
      speakerIdGroup: document.getElementById('settingSpeakerIdGroup'),
      speakerIdSelect: document.getElementById('settingSpeakerIdSelect'),
      voiceDegradeBanner: document.getElementById('settingVoiceDegradeBanner'),
      auditionBtn: document.getElementById('settingAuditionBtn'),
      voiceGeneralNotice: document.getElementById('settingVoiceGeneralNotice'),

      vadSlider: document.getElementById('settingVadSlider'),
      vadValue: document.getElementById('settingVadValue')
    };
  }

  // ---------------------------------------------------------------------------
  // Markup Generation (Zero Emoji, Apple HIG Dark Glass UI)
  // ---------------------------------------------------------------------------
  initMcpSettings() {
    const host = document.getElementById('settingVadSlider')?.closest('.settings-section');
    if (!host) return;
    const section = document.createElement('section');
    section.className = 'settings-section mcp-settings-section';
    section.innerHTML = `
      <div class="settings-section-header">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
          </svg>
          <span>MCP 连接器 (Model Context Protocol)</span>
        </div>
        <button type="button" class="settings-link-btn" id="settingMcpRefreshBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          <span>刷新</span>
        </button>
      </div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text">
            <label class="settings-item-label">协议连接状态</label>
            <div class="settings-item-desc" id="settingMcpDesc">正在检测 MCP 服务...</div>
          </div>
          <span class="status-badge loading" id="settingMcpBadge">检测中</span>
        </div>
        <div class="settings-divider"></div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button type="button" class="settings-btn-secondary" id="settingMcpOpenBtn" style="flex: 1;">管理 MCP 工具与资源</button>
          <button type="button" class="settings-link-btn" id="settingMcpReloadBtn">热重载配置</button>
        </div>
      </div>
    `;
    host.after(section);

    const updateMcpDisplay = async () => {
      try {
        const res = await fetch('/api/mcp/status');
        const data = await res.json();
        const badge = document.getElementById('settingMcpBadge');
        const desc = document.getElementById('settingMcpDesc');
        if (badge && desc) {
          if (data.status === 'ready') {
            badge.className = 'status-badge ready';
            badge.textContent = '正常运行';
            desc.textContent = `已挂载 ${data.serversCount} 个服务器，可用工具 ${data.toolsCount} 项，资源 ${data.resourcesCount} 项。`;
          } else {
            badge.className = 'status-badge loading';
            badge.textContent = data.status || '未就绪';
            desc.textContent = `已配置 ${data.serversCount} 个服务器 (${data.readyServersCount || 0} 个就绪)。`;
          }
        }
      } catch (e) {
        const badge = document.getElementById('settingMcpBadge');
        if (badge) {
          badge.className = 'status-badge error';
          badge.textContent = '未连接';
        }
      }
    };

    document.getElementById('settingMcpRefreshBtn')?.addEventListener('click', updateMcpDisplay);
    document.getElementById('settingMcpOpenBtn')?.addEventListener('click', () => {
      this.close();
      window.mcpPanel?.open();
    });
    document.getElementById('settingMcpReloadBtn')?.addEventListener('click', async () => {
      await window.mcpPanel?.triggerReload();
      updateMcpDisplay();
    });

    updateMcpDisplay();
  }

  initAsrProviderSettings() {
    const host=document.getElementById('settingAsrToggle')?.closest('.settings-section');if(!host)return;
    const section=document.createElement('section');section.className='settings-section';section.innerHTML='<div class="settings-section-header"><h3 class="settings-section-title">识别服务</h3></div><div class="settings-card"><label class="settings-item-label" for="settingAsrProvider">语音识别来源</label><div class="select-wrapper"><select id="settingAsrProvider" class="settings-select"><option value="local">本地实时识别</option><option value="token-plan">本地实时预览 + 套餐句尾识别</option></select></div><p class="settings-item-desc">套餐模式不是云端实时音频输入：本地生成实时预览，句尾录音会发送至云端完成识别并消耗 Credits。切换会清空当前未结束的识别片段，设置同步到桌宠。</p></div>';host.after(section);
    const select=section.querySelector('select');select.value=this.settings.asrProvider==='token-plan'?'token-plan':'local';select.onchange=()=>{this.settings.asrProvider=select.value;this.saveSettings();this.applySettingsToRuntime();};
  }

  initCloudTtsSettings() {
    const host=document.getElementById('settingVoiceSelect')?.closest('.settings-section') || this.dom.voiceSelect?.closest('.settings-section');
    if(!host)return;
    const section=document.createElement('section');section.className='settings-section cloud-tts-section';
    section.innerHTML='<div class="settings-section-header"><h3 class="settings-section-title">本地 / 云端语音</h3></div><div class="settings-card cloud-tts-fields"><label>运行位置<select class="settings-select" data-cloud="provider"><option value="local">本地 TTS</option><option value="cloud">云端 TTS</option></select></label><p class="settings-item-desc">Token Plan 的主模型、识别和套餐 TTS 共用一份订阅密钥，3.1 凭据独立。主模型密钥变更后需重启后台加载。本地克隆保持独立。云端会向所配置服务发送待朗读文本，可能产生费用；保存配置不会试听或发起合成。</p><label>服务地址<input data-cloud="endpoint" type="url" placeholder="平台 WSS 或 HTTPS 服务地址" autocomplete="off"></label><label>模型<select class="settings-select" data-cloud="model"><option value="qwen-audio-3.1-tts-flash">千问 3.1 · 独立凭据</option><option value="qwen-audio-3.0-tts-plus">千问 3.0 Plus · Token Plan</option></select></label><label>音色标识<input data-cloud="voice" type="text" value="longanhuan_v3.1" list="cloudTtsVoiceSuggestions" maxlength="200" placeholder="由平台提供的音色名称" autocomplete="off"><datalist id="cloudTtsVoiceSuggestions"><option value="qiaoxiaojiao_v3.1">俏皮可爱 · 仅中文</option><option value="longanhuan_v3.1">明亮自然 · 多语</option><option value="longanlingxin_v3.1">灵动清新 · 多语</option><option value="longanfengyue_v3.1">自然柔和 · 多语</option></datalist></label><label>自然语言风格<textarea data-cloud="instructions" rows="3" maxlength="2000" placeholder="原创明亮、偏高音、俏皮的动漫女声，咬字清楚，情绪自然。"></textarea></label><label>API 密钥<input data-cloud="apiKey" type="password" autocomplete="new-password" placeholder="留空保留已配置密钥" spellcheck="false"></label><small data-cloud="credential" class="settings-item-desc">凭据状态待读取</small><button type="button" class="settings-btn-secondary" data-cloud="save">保存并启用此模型</button><button type="button" class="settings-link-btn" data-cloud="reload">重新读取服务配置</button><p data-cloud="status" class="cloud-tts-status" role="status" aria-live="polite"></p></div>';
    host.after(section);const fields={};for(const name of ['provider','endpoint','model','voice','instructions','apiKey','credential','save','reload','status'])fields[name]=section.querySelector('[data-cloud="'+name+'"]');this.cloudTtsDom=fields;
    fields.provider.value=this.settings.voiceKey==='qwen-cloud'?'cloud':'local';
    fields.provider.onchange=()=>{if(fields.provider.value==='cloud'){if(this.settings.voiceKey!=='qwen-cloud')this.lastLocalVoiceKey=this.settings.voiceKey;this.settings.voiceKey='qwen-cloud';}else this.settings.voiceKey=this.lastLocalVoiceKey||'vits-aishell3';this.populateVoiceDropdown();this.saveSettings();this.applySettingsToRuntime();};
    fields.save.onclick=()=>this.saveCloudTtsSettings();
    fields.reload.onclick=()=>this.loadCloudTtsSettings(fields.model.value);
    fields.model.onchange=()=>this.loadCloudTtsSettings(fields.model.value);
    this.cloudConfigLoaded=false;
    for(const name of ['endpoint','model','voice','instructions','apiKey','save'])fields[name].disabled=true;
    fields.status.textContent='打开设置后读取服务配置；读取成功前不提交配置。';
  }

  async loadCloudTtsSettings(model) {
    const d=this.cloudTtsDom;if(!d)return;const revision=this.cloudLoadRevision=(this.cloudLoadRevision||0)+1;
    this.cloudConfigLoaded=false;d.apiKey.value='';
    for(const name of ['endpoint','model','voice','instructions']){d[name].value='';d[name].disabled=true;}
    d.apiKey.disabled=true;d.save.disabled=true;d.reload.disabled=true;d.credential.textContent='正在读取凭据状态…';d.status.textContent='正在读取服务配置…';
    try{const response=await fetch('/api/tts/cloud'+(model?'?model='+encodeURIComponent(model):''),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('云端配置服务暂未就绪（'+response.status+'）；可继续使用本地音色，服务更新后重新读取。');const payload=await response.json(),config=payload.config||payload;if(revision!==this.cloudLoadRevision||!this.isOpen)return;
      for(const name of ['endpoint','model','voice','instructions'])d[name].value=String(config[name]??'');
      this.cloudConfigLoaded=true;d.credential.textContent=config.hasApiKey?'已配置密钥 · 浏览器不会读取密钥内容':'尚未配置密钥';d.status.textContent=(config.isActive?'当前已启用此模型。':'仅查看此模型，尚未切换启用。')+(config.configured?' 配置已读取，未试听验证。':' 此模型配置尚未完整；密钥与其它模型独立。');
      const suggestions=document.getElementById('cloudTtsVoiceSuggestions');if(suggestions)suggestions.innerHTML=config.model==='qwen-audio-3.0-tts-plus'?'<option value="longanhuan_v3.6">Token Plan 官方示例音色（待试听确认）</option>':'<option value="longanhuan_v3.1">多语</option><option value="qiaoxiaojiao_v3.1">俏皮可爱 · 仅中文</option><option value="longanlingxin_v3.1">多语</option><option value="longanfengyue_v3.1">多语</option>'; 
    }catch(error){if(revision===this.cloudLoadRevision){d.credential.textContent='凭据状态未确认';d.status.textContent=error.name==='TimeoutError'?'读取超时；保持本地音色，稍后重新读取。':error.message;}}
    finally{if(revision===this.cloudLoadRevision){d.reload.disabled=false;for(const name of ['endpoint','model','voice','instructions','apiKey','save'])d[name].disabled=!this.cloudConfigLoaded;d.model.disabled=false;}}
  }

  async saveCloudTtsSettings() {
    const d=this.cloudTtsDom;if(!d||d.save.disabled||!this.cloudConfigLoaded)return;const data={activate:true};for(const name of ['endpoint','model','voice','instructions'])data[name]=d[name].value.trim();
    if(!data.endpoint){d.status.textContent='请先填写平台服务地址。';return;}
    try{const url=new URL(data.endpoint);if(!['wss:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{d.status.textContent='请使用平台提供的不含凭据的 WSS 或 HTTPS 服务地址。';return;}
    if(d.apiKey.value.trim())data.apiKey=d.apiKey.value.trim();d.apiKey.value='';
    const revision=this.cloudLoadRevision=(this.cloudLoadRevision||0)+1;for(const name of ['endpoint','model','voice','instructions','apiKey','save','reload'])d[name].disabled=true;d.status.textContent='正在保存云端配置…';
    try{const response=await fetch('/api/tts/cloud',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('保存失败（'+response.status+'），请检查平台配置；密钥如有改动需重新填写。');const payload=await response.json(),config=payload.config||payload;if(revision!==this.cloudLoadRevision||!this.isOpen)return;d.credential.textContent=config.hasApiKey?'已配置密钥 · 浏览器不会读取密钥内容':'尚未配置密钥';d.status.textContent='已保存；选择云端 TTS 后用于播报。未发起试听，可用性未验证。';
    }catch(error){if(revision===this.cloudLoadRevision){if(error.name==='TimeoutError')this.cloudConfigLoaded=false;d.status.textContent=error.name==='TimeoutError'?'保存响应超时，结果待确认；请先重新读取，避免重复提交。':error.message;}}
    finally{delete data.apiKey;if(revision===this.cloudLoadRevision){d.reload.disabled=false;for(const name of ['endpoint','model','voice','instructions','apiKey','save'])d[name].disabled=!this.cloudConfigLoaded;}}
  }

  renderMarkup() {
    if (document.getElementById('voiceSettingsOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'voiceSettingsOverlay';
    overlay.className = 'voice-settings-overlay';
    overlay.innerHTML = `
      <div class="voice-settings-modal" id="voiceSettingsModal" role="dialog" aria-modal="true" aria-labelledby="voiceSettingsTitle">
        
        <!-- Header -->
        <div class="settings-modal-header">
          <div class="settings-header-left">
            <div class="settings-header-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </div>
            <div>
              <h2 class="settings-modal-title" id="voiceSettingsTitle">语音独立设置</h2>
              <div class="settings-modal-subtitle">输入输出设备、ASR 实时流、TTS 音色与 VAD 门控深度配置</div>
            </div>
          </div>
          <button type="button" class="settings-close-btn" id="voiceSettingsCloseBtn" title="关闭设置 (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <!-- Content Grid (Apple HIG 2-Column Responsive Layout) -->
        <div class="settings-modal-body">
          <div class="settings-modal-grid">

            <!-- Left Column: Status, Toggles, VAD -->
            <div class="settings-grid-col">
              
              <!-- Section 1: Engine Statuses -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
                    <span>引擎运行状态</span>
                  </div>
                  <button type="button" class="settings-link-btn" id="voiceSettingsRefreshBtn" title="重新检测引擎状态与设备列表">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                    <span>刷新</span>
                  </button>
                </div>

                <div class="status-grid">
                  <!-- ASR Card -->
                  <div class="status-card">
                    <div class="status-card-header">
                      <span class="status-card-label">ASR 语音识别</span>
                      <span class="status-badge loading" id="settingAsrBadge">检测中</span>
                    </div>
                    <div class="status-card-detail" id="settingAsrDetail">Zipformer 16kHz 流式识别</div>
                    <div class="status-card-error" id="settingAsrErrorBanner" style="display: none;"></div>
                  </div>

                  <!-- TTS Card -->
                  <div class="status-card">
                    <div class="status-card-header">
                      <span class="status-card-label">TTS 语音合成</span>
                      <span class="status-badge loading" id="settingTtsBadge">检测中</span>
                    </div>
                    <div class="status-card-detail" id="settingTtsDetail">VITS AISHELL-3 / Matcha-TTS</div>
                    <div class="status-card-error" id="settingTtsErrorBanner" style="display: none;"></div>
                  </div>
                </div>
              </div>

              <!-- Section 2: Function Toggles (ASR & TTS) -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                    <span>功能开关控制</span>
                  </div>
                </div>

                <div class="settings-card">
                  <!-- ASR Toggle -->
                  <div class="settings-row">
                    <div class="settings-row-text">
                      <label class="settings-item-label" for="settingAsrToggle">实时语音识别 (ASR)</label>
                      <div class="settings-item-desc">开启麦克风实时转写并向 Agent 提问；关闭停止录音。</div>
                    </div>
                    <label class="settings-switch">
                      <input type="checkbox" id="settingAsrToggle" checked>
                      <span class="switch-slider"></span>
                    </label>
                  </div>

                  <div class="settings-divider"></div>

                  <!-- TTS Toggle -->
                  <div class="settings-row">
                    <div class="settings-row-text">
                      <label class="settings-item-label" for="settingTtsToggle">语音播报合成 (TTS)</label>
                      <div class="settings-item-desc">回复时流式朗读并驱动口型；关闭保持文字静音。</div>
                    </div>
                    <label class="settings-switch">
                      <input type="checkbox" id="settingTtsToggle" checked>
                      <span class="switch-slider"></span>
                    </label>
                  </div>
                </div>
              </div>

              <!-- Section 6: VAD Silence Gate Threshold -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>
                    <span>VAD 灵敏度门控</span>
                  </div>
                  <span class="settings-value-pill" id="settingVadValue">0.015 (推荐标准)</span>
                </div>

                <div class="settings-card">
                  <label class="settings-item-label" for="settingVadSlider">静音门控阈值</label>
                  <div class="settings-item-desc">拾音参考阈值；识别保留原始语音，避免吞掉轻声字词。</div>
                  
                  <div class="slider-wrapper">
                    <input type="range" class="settings-slider" id="settingVadSlider" min="0.002" max="0.050" step="0.001" value="0.015">
                  </div>

                  <div class="slider-markers">
                    <span>0.002 (高灵敏)</span>
                    <span class="marker-center">0.015 (推荐)</span>
                    <span>0.050 (抗噪)</span>
                  </div>
                </div>
              </div>

            </div>

            <!-- Right Column: Devices & Voice -->
            <div class="settings-grid-col">

              <!-- Section 3: Input Device (Microphone) -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                    <span>音频输入设备</span>
                  </div>
                </div>

                <div class="settings-card">
                  <label class="settings-item-label" for="settingInputDeviceSelect">输入麦克风 (Microphone)</label>
                  <div class="settings-item-desc">选择语音识别拾音设备，即改即生效。</div>
                  <div class="select-wrapper">
                    <select class="settings-select" id="settingInputDeviceSelect">
                      <option value="default">系统默认麦克风 (Default)</option>
                    </select>
                  </div>
                  <div class="settings-notice" id="settingMicNotice" style="display: none;"></div>

                  <!-- Real-time Mic Level Test -->
                  <div class="mic-level-test">
                    <div class="mic-level-label">拾音电平</div>
                    <div class="mic-level-track">
                      <div class="mic-level-fill" id="settingMicVuFill"></div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Section 4: Output Device (Speaker) -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                    <span>音频输出设备</span>
                  </div>
                </div>

                <div class="settings-card">
                  <label class="settings-item-label" for="settingOutputDeviceSelect">输出扬声器 / 耳机 (Speaker)</label>
                  <div class="settings-item-desc">选择流式语音播报输出设备 (setSinkId)。</div>
                  <div class="select-wrapper">
                    <select class="settings-select" id="settingOutputDeviceSelect">
                      <option value="default">系统默认扬声器 (Default)</option>
                    </select>
                  </div>
                  <div class="settings-notice info" id="settingSpeakerNotice" style="display: none;"></div>
                </div>
              </div>

              <!-- Section 5: Voice Selection & Audition -->
              <div class="settings-section">
                <div class="settings-section-header">
                  <div class="settings-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    <span>实时对话音色</span>
                  </div>
                </div>

                <div class="settings-card">
                  <div class="settings-notice warn" id="settingVoiceDegradeBanner" style="display: none;"></div>
                  
                  <div class="voice-form-row">
                    <div class="voice-field-col">
                      <label class="settings-item-label" for="settingVoiceSelect">对话音色（千问为本地流式实验，GPT-SoVITS 为逐句模式）</label>
                      <div class="select-wrapper">
                        <select class="settings-select" id="settingVoiceSelect">
                          <option value="vits-aishell3">VITS AISHELL-3 元气少女音</option>
                          <option value="matcha-baker">Matcha-TTS 标贝女声</option>
                        </select>
                      </div>
                    </div>

                    <div class="voice-field-col" id="settingSpeakerIdGroup">
                      <label class="settings-item-label" for="settingSpeakerIdSelect">发音人 (SID)</label>
                      <div class="select-wrapper">
                        <select class="settings-select" id="settingSpeakerIdSelect">
                          <option value="51">51号 (元气少女音)</option>
                          <option value="0">0号 (标准女声)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <!-- Audition Button -->
                  <div class="audition-action-row">
                    <button type="button" class="settings-audition-btn" id="settingAuditionBtn">
                      <svg class="settings-btn-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                      <span>试听当前音色</span>
                    </button>
                    <span class="audition-hint">实时流式合成与口型联动</span>
                  </div>

                  <div class="settings-notice" id="settingVoiceGeneralNotice" style="display: none;"></div>
                </div>
              </div>
              <section class="settings-section" aria-label="音色克隆">
                <div class="settings-section-header"><div class="settings-section-title"><span>音色克隆</span><span class="status-badge">独立试听</span></div></div>
                <div class="settings-card">
                  <p class="settings-item-desc">克隆试听独立于对话选择；上方可选千问本地流式实验或 GPT-SoVITS 逐句对话。首次加载较慢；成功播报后模型保持驻留待机，不再因闲置卸载，会持续占用内存或显存。取消正在生成的语音、模型错误或切换克隆引擎时仍会释放工作进程。</p>
                  <label class="settings-item-label" for="settingCloneVoiceSelect">克隆模型</label>
                  <div class="select-wrapper"><select class="settings-select" id="settingCloneVoiceSelect"><option value="gpt-sovits-klee">GPT-SoVITS 可莉</option><option value="qwen3-clone">Qwen3 克隆</option></select></div>
                  <div class="audition-action-row"><button type="button" class="settings-audition-btn" id="settingCloneAuditionBtn">试听克隆音色</button></div>
                </div>
              </section>

            </div>

          </div>
        </div>

        <!-- Footer -->
        <div class="settings-modal-footer">
          <div class="settings-footer-left">
            <span class="settings-save-badge" id="voiceSettingsSaveBadge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>配置已即时生效并持久化至本地 (localStorage)</span>
            </span>
          </div>
          <div class="settings-footer-right">
            <button type="button" class="settings-btn-secondary" id="voiceSettingsResetBtn">恢复默认</button>
            <button type="button" class="settings-btn-primary" id="voiceSettingsDoneBtn">完成</button>
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(overlay);
  }
}
