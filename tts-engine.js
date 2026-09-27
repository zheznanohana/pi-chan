/**
 * TTS Engine for Pi-chan Dashboard
 * Powered by sherpa-onnx (OfflineTts)
 * 
 * Supports:
 * 1. vits-icefall-zh-aishell3 (Multi-Speaker: 174 voices, default speaker 51: SSB0427)
 * 2. matcha-icefall-zh-baker + Vocos 22kHz (Single-Speaker: Biaobei)
 * 
 * Hardware characteristics:
 * - CPU inference via ONNX Runtime (0 MB VRAM, negligible CPU overhead)
 * - Real-time streaming chunks with sub-60ms first packet latency
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const sherpa_onnx = require('sherpa-onnx-node');

const AISHELL3_DIR = path.join(__dirname, 'models/vits-icefall-zh-aishell3');
const MATCHA_DIR = path.join(__dirname, 'models/matcha-icefall-zh-baker');
const VOCOS_PATH = path.join(__dirname, 'models/vocos-22khz-univ.onnx');
const PYTHON_PATH = fs.existsSync('E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe')
  ? 'E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe'
  : 'python';
const QWEN_NATIVE_STREAM = process.env.QWEN_TTS_BACKEND !== 'sentence';
const GPT_SOVITS_INFER = path.join(__dirname, 'gpt-sovits-infer.py');

// Instances cache
const engines = {
  'vits-aishell3': null,
  'matcha-baker': null
};

const initPromises = {};

// Default active configuration
let activeVoiceKey = 'vits-aishell3';
let activeSid = 51; // SSB0427 (元气少女音 / π-chan 推荐音色)

const VOICE_DEFINITIONS = {
  'qwen-cloud': {
    key:'qwen-cloud', name:'百炼 Qwen Audio 3.1 Flash / 3.0 Plus 云端语音',
    architecture:'Qwen-Audio-TTS / WebSocket 或 Token Plan HTTP SSE', sampleRate:24000,
    numSpeakers:1, defaultSid:0, defaultSpeakerName:'原创明亮俏皮女声（云端音色配置）',
    weightsSize:'云端托管', provider:'阿里云百炼 · 北京', streamingCapable:true,
    conversationCapable:true, cloneCapable:false, expectedFirstPacketMs:null,
    description:'官方流式PCM；需在云端语音设置配置API Key，按服务商计费；尚未实测延迟'
  },
  'vits-aishell3': {
    key: 'vits-aishell3',
    name: 'VITS AISHELL-3 多发音人流式模型',
    architecture: 'VITS (Variational Inference with adversarial learning)',
    sampleRate: 8000,
    numSpeakers: 174,
    defaultSid: 51,
    defaultSpeakerName: '51号发音人 SSB0427 (元气少女音 - π-chan 推荐)',
    weightsSize: '204 MB',
    provider: 'CPU (ONNX Runtime)',
    streamingCapable: true,
    cloneCapable: false,
    expectedFirstPacketMs: 45,
    rtfCpu: 0.05,
    description: '实时交互首选：超低首包延迟 (<60ms)，RTF=0.05，边合成边分块出音'
  },
  'matcha-baker': {
    key: 'matcha-baker',
    name: 'Matcha-TTS 标贝女声流式模型',
    architecture: 'Matcha-TTS (Flow-matching ODE) + Vocos Vocoder',
    sampleRate: 22050,
    numSpeakers: 1,
    defaultSid: 0,
    defaultSpeakerName: '标贝女声 (DataBaker Chinese Female)',
    weightsSize: '126 MB (acoustic 75MB + vocoder 51MB)',
    provider: 'CPU (ONNX Runtime)',
    streamingCapable: true,
    cloneCapable: false,
    expectedFirstPacketMs: 65,
    rtfCpu: 0.08,
    description: '高质量单发音人：22kHz 高保真 Vocos 声码器流式出音'
  },
  'qwen3-clone': {
    key: 'qwen3-clone',
    name: 'Qwen3-TTS-12Hz-0.6B-Base 零样本音色克隆',
    architecture: 'Qwen3-TTS (0.6B Dual-Track Transformer LM + 12Hz Codec Vocoder)',
    sampleRate: 24000,
    numSpeakers: 1,
    defaultSid: 0,
    defaultSpeakerName: 'π-chan 元气克隆音色 (基于参考音频 zero-shot)',
    weightsSize: '2.40 GB (主模型 1.74GB + Speech Tokenizer 0.65GB)',
    provider: 'PyTorch (CUDA / CPU)',
    streamingCapable: QWEN_NATIVE_STREAM,
    conversationCapable: true,
    experimental: true,
    cloneCapable: true,
    expectedFirstPacketMs: null,
    rtfCuda: null,
    rtfCpu: 13.54,
    description: QWEN_NATIVE_STREAM ? 'Windows 原生流式克隆（实验）；冷启动较慢，暖态延迟视负载变化' : '旧版逐句克隆（回退）；首次加载较慢'
  },
  'gpt-sovits-klee': {
    key: 'gpt-sovits-klee',
    name: 'GPT-SoVITS 可莉_ZH 萌系萝莉音',
    architecture: 'GPT-SoVITS v4 (AR Transformer T2S + Flow-Matching SoVITS + BigVGAN vocoder)',
    sampleRate: 48000,
    numSpeakers: 1,
    defaultSid: 0,
    defaultSpeakerName: '可莉_ZH（原神萝莉音，现成角色模型）',
    weightsSize: '2.69 GB (角色模型 221MB + GPT-SoVITS v4 预训练底模 2.47GB)',
    provider: 'PyTorch (CUDA / FP16)',
    streamingCapable: false,
    conversationCapable: true,
    experimental: true,
    cloneCapable: true,
    expectedFirstPacketMs: 13977,
    rtfCuda: 4.47,
    rtfCpu: null,
    description: '实验对话：常驻 v4 模型，生成片段立即播放；首句加载较慢，非 token 级实时流'
  }
};

async function getEngine(voiceKey = activeVoiceKey) {
  if(voiceKey==='qwen-cloud')return {cloud:true,sampleRate:24000};
  const key = engines[voiceKey] ? voiceKey : (VOICE_DEFINITIONS[voiceKey] ? voiceKey : activeVoiceKey);
  if (engines[key]) return engines[key];
  if (initPromises[key]) return initPromises[key];

  initPromises[key] = (async () => {
    console.log(`[TTS Engine] Initializing engine for voice: ${key}...`);

    if (key === 'vits-aishell3') {
      const modelPath = path.join(AISHELL3_DIR, 'model.onnx');
      const lexicon = path.join(AISHELL3_DIR, 'lexicon.txt');
      const tokens = path.join(AISHELL3_DIR, 'tokens.txt');

      if (!fs.existsSync(modelPath)) {
        throw new Error(`AISHELL-3 model files missing at ${AISHELL3_DIR}`);
      }

      const config = {
        model: {
          vits: {
            model: modelPath,
            lexicon,
            tokens
          },
          numThreads: 4,
          provider: 'cpu'
        },
        ruleFsts: [
          path.join(AISHELL3_DIR, 'phone.fst'),
          path.join(AISHELL3_DIR, 'date.fst'),
          path.join(AISHELL3_DIR, 'number.fst'),
          path.join(AISHELL3_DIR, 'new_heteronym.fst')
        ].filter(f => fs.existsSync(f)).join(','),
        ruleFars: path.join(AISHELL3_DIR, 'rule.far')
      };

      const instance = await sherpa_onnx.OfflineTts.createAsync(config);
      console.log(`[TTS Engine] Ready: ${key} (sampleRate: ${instance.sampleRate}Hz, speakers: ${instance.numSpeakers})`);
      engines[key] = instance;
      return instance;
    }

    if (key === 'matcha-baker') {
      const acousticModel = path.join(MATCHA_DIR, 'model-steps-3.onnx');
      const lexicon = path.join(MATCHA_DIR, 'lexicon.txt');
      const tokens = path.join(MATCHA_DIR, 'tokens.txt');
      const dictDir = path.join(MATCHA_DIR, 'dict');

      if (!fs.existsSync(acousticModel) || !fs.existsSync(VOCOS_PATH)) {
        throw new Error(`Matcha-TTS model files missing in ${MATCHA_DIR} or ${VOCOS_PATH}`);
      }

      const config = {
        model: {
          matcha: {
            acousticModel,
            vocoder: VOCOS_PATH,
            lexicon,
            tokens,
            dictDir
          },
          numThreads: 4,
          provider: 'cpu'
        },
        ruleFsts: [
          path.join(MATCHA_DIR, 'phone.fst'),
          path.join(MATCHA_DIR, 'date.fst'),
          path.join(MATCHA_DIR, 'number.fst')
        ].join(',')
      };

      const instance = await sherpa_onnx.OfflineTts.createAsync(config);
      console.log(`[TTS Engine] Ready: ${key} (sampleRate: ${instance.sampleRate}Hz, speakers: ${instance.numSpeakers})`);
      engines[key] = instance;
      return instance;
    }

    if (key === 'qwen3-clone') {
      const virtualInstance = {
        sampleRate: 24000,
        numSpeakers: 1,
        isCloneEngine: true
      };
      engines[key] = virtualInstance;
      return virtualInstance;
    }

    if (key === 'gpt-sovits-klee') {
      const virtualInstance = {
        sampleRate: 48000,
        numSpeakers: 1,
        isCloneEngine: true,
        isGptSovits: true
      };
      engines[key] = virtualInstance;
      return virtualInstance;
    }

    throw new Error(`Unknown voice engine key: ${key}`);
  })();

  return initPromises[key];
}

async function initTTS(defaultVoice = activeVoiceKey) {
  return getEngine(defaultVoice);
}

function setActiveVoice(voiceKey, sid = null) {
  if (VOICE_DEFINITIONS[voiceKey]) {
    activeVoiceKey = voiceKey;
  }
  if (sid !== null && typeof sid === 'number' && !isNaN(sid)) {
    activeSid = sid;
  }
  return getModelInfo();
}

function getActiveVoiceInfo(voiceKey = null, sid = null) {
  const key = voiceKey && VOICE_DEFINITIONS[voiceKey] ? voiceKey : activeVoiceKey;
  const def = VOICE_DEFINITIONS[key];
  const requestedSid = sid ?? (key === activeVoiceKey ? activeSid : def.defaultSid);
  const useSid = Number.isInteger(requestedSid) && requestedSid >= 0 && requestedSid < def.numSpeakers ? requestedSid : def.defaultSid;

  return {
    ...def,
    sid: useSid,
    activeSid: useSid
  };
}

function getModelInfo() {
  const active = getActiveVoiceInfo();
  return {
    name: active.name,
    architecture: active.architecture,
    sampleRate: active.sampleRate,
    numSpeakers: active.numSpeakers,
    speakerId: active.sid,
    speakerName: active.key === 'vits-aishell3' ? `${active.sid}号发音人 (SSB0427 元气少女音)` : active.defaultSpeakerName,
    weightsSize: active.weightsSize,
    provider: active.provider,
    streamingCapable: active.streamingCapable,
    cloneCapable: active.cloneCapable,
    expectedFirstPacketMs: active.expectedFirstPacketMs,
    activeVoice: active.key,
    evaluation: {
      qwen3TTS: {
        modelName: 'Qwen3-TTS-12Hz-0.6B-Base',
        supportsVoiceClone: true, supportsStreaming: QWEN_NATIVE_STREAM,
        backend: QWEN_NATIVE_STREAM ? 'faster-qwen3-tts v0.3.2 / native Windows CUDA graphs' : 'legacy sentence worker',
        experimental: true,
        measuredWarmFirstPacketMs: [396, 517],
        measuredColdLoadMs: [45000, 71000],
        verdict: '已验证生成期间输出PCM。短句暖态首包约0.4–0.52秒，但吞吐接近实时边界；存在偶发未自然结束，检测后报错，不保证所有文本稳定实时。'
      },
      gptSovits: {
        modelName: 'GPT-SoVITS v4', supportsVoiceClone: true, supportsStreaming: false,
        measuredWarmFirstPacketMs: 16030,
        verdict: '常驻逐句生成，保留独立试听及实验对话选项。'
      },
      finalChoice: {
        strategy: '保留所有现有音色；默认快速ONNX，千问原生流式实验，GPT-SoVITS逐句实验',
        realtimeStreamingEngine: 'VITS AISHELL-3 / Matcha-Baker',
        voiceCloneEngine: 'Qwen3-TTS / GPT-SoVITS'
      }
    }
  };
}

function getAvailableVoices() {
  return Object.values(VOICE_DEFINITIONS).map(v => ({
    key: v.key,
    name: v.name,
    sampleRate: v.sampleRate,
    numSpeakers: v.numSpeakers,
    defaultSid: v.defaultSid,
    description: v.description,
    streamingCapable: v.streamingCapable,
    experimental: !!v.experimental
  }));
}

/**
 * Convert Float32Array audio samples into 16-bit signed PCM Buffer (Little-Endian)
 */
function floatTo16BitPCM(float32Array) {
  const buffer = Buffer.alloc(float32Array.length * 2);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, i * 2);
  }
  return buffer;
}

function sanitizeSpeechText(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove surrogate pairs and control chars
  let clean = text.replace(/[\uD800-\uDFFF].|[\uD800-\uDFFF]/g, '');
  // Remove markdown formatting
  clean = clean.replace(/[*#\`_~\[\]()]/g, ' ');
  // Ensure readable characters
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(clean)) return '';
  return clean.trim();
}

/**
 * Zero-shot Voice Clone via Qwen3-TTS-12Hz-0.6B-Base
 */
function synthesizeClone(text, options = {}) {
  const cleanText = sanitizeSpeechText(text) || '你好，我是派酱，很高兴见到你！';
  const refAudio = options.refAudio || path.join(__dirname, 'speaker-eval/pick-sid-51.wav');
  const refText = options.refText || '';
  const outputWav = options.output || path.join(__dirname, 'tts-clone-run.wav');
  const scriptPath = path.join(__dirname, 'qwen3-clone.py');

  const args = [
    scriptPath,
    '--text', cleanText,
    '--ref_audio', refAudio,
    '--output', outputWav,
    '--max_tokens', String(options.maxTokens || 128)
  ];
  if (refText) {
    args.push('--ref_text', refText);
  }

  console.log(`[TTS Clone] Running Qwen3-TTS voice clone for text: "${cleanText.slice(0, 30)}"...`);
  const t0 = Date.now();
  const res = spawnSync(PYTHON_PATH, args, { encoding: 'utf-8', timeout: 180000 });
  const totalMs = Date.now() - t0;

  if (res.error || res.status !== 0) {
    const errMsg = res.stderr || res.stdout || res.error?.message || 'Unknown error';
    console.error(`[TTS Clone] Execution failed:`, errMsg);
    throw new Error(`Qwen3-TTS Clone failed: ${errMsg}`);
  }

  let durationSec = 0;
  let sampleRate = 24000;
  const matchDur = res.stdout.match(/duration=([0-9.]+)s/);
  if (matchDur) durationSec = parseFloat(matchDur[1]);
  const matchSr = res.stdout.match(/sr=([0-9]+)/);
  if (matchSr) sampleRate = parseInt(matchSr[1], 10);

  let pcmBuffer = Buffer.alloc(0);
  if (fs.existsSync(outputWav)) {
    const raw = fs.readFileSync(outputWav);
    if (raw.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid WAV output');
    for (let offset = 12; offset + 8 <= raw.length;) {
      const size = raw.readUInt32LE(offset + 4);
      if (raw.toString('ascii', offset, offset + 4) === 'data') {
        pcmBuffer = raw.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!pcmBuffer.length) throw new Error('Empty WAV audio');
  }

  return {
    success: true,
    totalMs,
    firstPacketMs: totalMs,
    durationSec,
    sampleRate,
    outputWav,
    pcmBuffer,
    voice: 'qwen3-clone',
    refAudio,
    model: 'Qwen3-TTS-12Hz-0.6B-Base'
  };
}

/**
 * GPT-SoVITS v4 character-model synthesis (可莉_ZH moe loli voice)
 * Runs the gpt-sovits-infer.py bridge in a subprocess; the bridge reports
 * RTF and first-packet latency as a METRICS_JSON line.
 */
function synthesizeGptSovits(text, options = {}) {
  const cleanText = sanitizeSpeechText(text) || '你好，我是派酱，很高兴见到你！';
  // Resolve to an absolute path: the bridge chdir()s into the GPT-SoVITS runtime,
  // so a relative path would land in the wrong directory.
  const outputWav = path.resolve(__dirname, options.output || 'tts-moe-run.wav');

  const args = [
    GPT_SOVITS_INFER,
    '--skip-analysis',
    '--text', cleanText,
    '--output', outputWav
  ];
  if (options.speed && options.speed !== 1.0) {
    args.push('--speed', String(options.speed));
  }
  if (options.cpu) {
    args.push('--cpu');
  }

  console.log(`[TTS GSV] Running GPT-SoVITS synthesis for text: "${cleanText.slice(0, 30)}"...`);
  const t0 = Date.now();
  const res = spawnSync(PYTHON_PATH, ['-X', 'utf8', ...args], { encoding: 'utf-8', timeout: 300000 });
  const wallMs = Date.now() - t0;

  if (res.error || res.status !== 0) {
    const errMsg = res.stderr || res.stdout || res.error?.message || 'Unknown error';
    console.error(`[TTS GSV] Execution failed:`, errMsg);
    throw new Error(`GPT-SoVITS synthesis failed: ${errMsg}`);
  }

  let metrics = null;
  const m = res.stdout.match(/METRICS_JSON=(\{.*\})/);
  if (m) {
    try { metrics = JSON.parse(m[1]); } catch (e) { metrics = null; }
  }

  let durationSec = 0;
  let sampleRate = 48000;
  let firstPacketMs = wallMs;
  let genMs = wallMs;
  let loadMs = 0;
  if (metrics) {
    durationSec = metrics.duration_sec || 0;
    sampleRate = metrics.sample_rate || 48000;
    firstPacketMs = Math.round((metrics.first_packet_sec || 0) * 1000);
    genMs = Math.round((metrics.gen_sec || 0) * 1000);
    loadMs = Math.round((metrics.load_sec || 0) * 1000);
  }

  let pcmBuffer = Buffer.alloc(0);
  if (fs.existsSync(outputWav)) {
    const raw = fs.readFileSync(outputWav);
    if (raw.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid WAV output');
    for (let offset = 12; offset + 8 <= raw.length;) {
      const size = raw.readUInt32LE(offset + 4);
      if (raw.toString('ascii', offset, offset + 4) === 'data') {
        pcmBuffer = raw.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!pcmBuffer.length) throw new Error('Empty WAV audio');
  }

  return {
    success: true,
    totalMs: genMs,
    wallMs,
    firstPacketMs,
    loadMs,
    durationSec,
    sampleRate,
    outputWav,
    pcmBuffer,
    voice: 'gpt-sovits-klee',
    model: 'GPT-SoVITS-v4-可莉_ZH',
    rtf: metrics ? metrics.rtf : 0
  };
}

function synthesizeCloneAsync(voice, text, options = {}) {
  const { Worker } = require('worker_threads');
  const { randomUUID } = require('crypto');
  const output = options.output || path.join(__dirname, 'audio-debug', `tts-${randomUUID()}.wav`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'tts-worker.js'), {
      workerData: { voice, text, options: { speed: options.speed, output } }
    });
    worker.once('message', message => {
      if (message.error) reject(new Error(message.error));
      else resolve({ ...message.result, pcmBuffer: Buffer.from(message.result.pcmBuffer) });
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`TTS worker exit ${code}`)); });
  });
}
async function synthesizeGptSovitsAsync(text, options = {}) {
  return synthesizeCloneAsync('gpt-sovits-klee', text, options);
}


/**
 * Stream synthesis for real-time delivery
 * @param {string} text - text to speak
 * @param {Object} options
 * @param {string} [options.voice] - voice key
 * @param {number} [options.sid] - speaker ID
 * @param {number} [options.speed=1.0] - playback speed
 * @param {function} [options.onChunk] - chunk callback
 * @param {function} [options.onDone] - finish callback
 * @param {function} [options.onError] - error callback
 */
async function synthesizeStream(text, options = {}) {
  const voiceKey = options.voice || activeVoiceKey;
  if(voiceKey==='qwen-cloud'){
    const clean=sanitizeSpeechText(text);
    // Empty formatting deltas complete silently, without a cloud request.
    if(!clean){
      const result={sampleRate:24000,totalMs:0,firstPacketMs:0,totalSamples:0,durationSec:0,voice:voiceKey,sid:0};
      options.onDone?.(result);return result;
    }
    try{return await require('./cloud-tts.cjs').synthesize(clean,options);}
    catch(error){options.onError?.(error);throw error;}
  }
  if(!options._languageRouted && ['vits-aishell3','matcha-baker'].includes(voiceKey) && /[A-Za-z]/.test(text)){
    const started=Date.now(),sampleRate=getActiveVoiceInfo(voiceKey,options.sid).sampleRate;
    const segments=String(text).match(/[A-Za-z][A-Za-z0-9\s.,!?':/+#_%()\-]*|[^A-Za-z]+/g)||[];
    let totalSamples=0,firstPacketMs=null,chunkIndex=0;
    const emit=chunk=>{
      if(firstPacketMs===null)firstPacketMs=Date.now()-started;
      totalSamples+=chunk.pcmBuffer.length/2;
      options.onChunk?.({...chunk,chunkIndex:++chunkIndex,firstPacketMs});
    };
    try{
      for(const segment of segments){
        if(!segment.trim())continue;
        if(/[A-Za-z]/.test(segment)){
          const result=await require('./english-tts').englishPCM(segment,sampleRate);
          emit({...result,floatSamples:new Float32Array(result.pcmBuffer.length/2),progress:1,latencyMs:Date.now()-started,sid:0});
        }else await synthesizeStream(segment,{...options,_languageRouted:true,onChunk:emit,onDone:undefined,onError:undefined});
      }
      const stats={sampleRate,totalMs:Date.now()-started,firstPacketMs:firstPacketMs||0,totalSamples,durationSec:totalSamples/sampleRate,voice:voiceKey,sid:options.sid};
      options.onDone?.(stats);return stats;
    }catch(error){options.onError?.(error);throw error;}
  }

  if (voiceKey === 'qwen3-clone' || voiceKey === 'gpt-sovits-klee') {
    try { return await require('./clone-stream').synthesize(voiceKey, sanitizeSpeechText(text), options); }
    catch(error){ options.onError?.(error); throw error; }
  }

  const tts = await getEngine(voiceKey);
  const sid = getActiveVoiceInfo(voiceKey, options.sid).sid;

  const cleanText = sanitizeSpeechText(text);
  if (!cleanText) {
    if (options.onDone) {
      options.onDone({
        totalMs: 0,
        firstPacketMs: 0,
        totalSamples: 0,
        durationSec: 0,
        sampleRate: tts.sampleRate,
        voice: voiceKey,
        sid
      });
    }
    return { audio: { samples: new Float32Array(0) }, totalMs: 0, firstPacketMs: 0, durationSec: 0, sampleRate: tts.sampleRate };
  }

  const t0 = Date.now();
  let firstPacketMs = null;
  let chunkIndex = 0;
  let totalSamplesCount = 0;

  try {
    const audio = await tts.generateAsync({
      text: cleanText,
      sid: sid,
      speed: options.speed || 1.0,
      onProgress: (info) => {
        chunkIndex++;
        const now = Date.now();
        if (firstPacketMs === null) {
          firstPacketMs = now - t0;
        }

        const samples = info.samples || new Float32Array(0);
        totalSamplesCount += samples.length;
        const pcmBuffer = floatTo16BitPCM(samples);

        if (options.onChunk) {
          options.onChunk({
            chunkIndex,
            pcmBuffer,
            floatSamples: samples,
            sampleRate: tts.sampleRate,
            progress: info.progress,
            latencyMs: now - t0,
            firstPacketMs,
            voice: voiceKey,
            sid
          });
        }
        return 1;
      }
    });

    const totalMs = Date.now() - t0;
    const durationSec = audio.samples.length / tts.sampleRate;

    if (options.onDone) {
      options.onDone({
        totalMs,
        firstPacketMs: firstPacketMs || totalMs,
        totalSamples: audio.samples.length,
        durationSec,
        sampleRate: tts.sampleRate,
        voice: voiceKey,
        sid
      });
    }

    return {
      audio,
      totalMs,
      firstPacketMs: firstPacketMs || totalMs,
      durationSec,
      sampleRate: tts.sampleRate,
      voice: voiceKey,
      sid
    };
  } catch (err) {
    console.error(`[TTS Engine] Synthesis error:`, err.message);
    if (options.onError) options.onError(err);
    throw err;
  }
}

/**
 * Generate full audio synchronously
 */
function synthesizeSync(text, options = {}) {
  const voiceKey = options.voice || activeVoiceKey;
  if (voiceKey === 'gpt-sovits-klee') {
    return synthesizeGptSovits(text, options);
  }
  if (voiceKey === 'qwen3-clone') {
    return synthesizeClone(text, options);
  }
  const tts = engines[voiceKey];
  if (!tts) {
    throw new Error(`TTS engine ${voiceKey} not initialized. Call initTTS() or getEngine() first.`);
  }

  const sid = getActiveVoiceInfo(voiceKey, options.sid).sid;
  const cleanText = sanitizeSpeechText(text);

  if (!cleanText) {
    return {
      audio: { samples: new Float32Array(0), sampleRate: tts.sampleRate },
      pcmBuffer: Buffer.alloc(0),
      sampleRate: tts.sampleRate,
      totalMs: 0,
      durationSec: 0,
      voice: voiceKey,
      sid
    };
  }

  const t0 = Date.now();
  const audio = tts.generate({
    text: cleanText,
    sid: sid,
    speed: options.speed || 1.0
  });
  const totalMs = Date.now() - t0;
  const pcmBuffer = floatTo16BitPCM(audio.samples);

  return {
    audio,
    pcmBuffer,
    sampleRate: tts.sampleRate,
    totalMs,
    durationSec: audio.samples.length / tts.sampleRate,
    voice: voiceKey,
    sid
  };
}

function saveWav(filename, audio, sampleRate) {
  // sherpa 的 writeWave 要求对象里带 sampleRate。某些分支（空文本、
  // 引擎初始化未完成）返回的 audio 只有 samples，这里补齐再写，
  // 否则会抛 "The argument object should have a field sampleRate"。
  const payload = (audio && audio.sampleRate)
    ? audio
    : { samples: (audio && audio.samples) || new Float32Array(0),
        sampleRate: sampleRate || (audio && audio.sampleRate) || 16000 };
  sherpa_onnx.writeWave(filename, payload);
}

module.exports = {
  initTTS,
  getEngine,
  synthesizeStream,
  synthesizeSync,
  synthesizeClone,
  synthesizeGptSovits,
  synthesizeGptSovitsAsync,
  saveWav,
  floatTo16BitPCM,
  getModelInfo,
  getActiveVoiceInfo,
  getAvailableVoices,
  setActiveVoice,
  get sampleRate() {
    return getActiveVoiceInfo().sampleRate;
  }
};
