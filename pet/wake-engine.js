/**
 * WakeEngine — 本地常驻唤醒词「小派小派」+ 唤醒后转流式 ASR 听指令
 *
 * 链路：
 *   渲染进程 getUserMedia 采音(16kHz 单声道 Int16)
 *     -> IPC audio-chunk
 *     -> 能量门控（静音时不跑神经网络，空闲 CPU 基本为 0）
 *     -> sherpa-onnx KeywordSpotter 命中「小派小派」
 *     -> 切到流式 ASR 听完整指令
 *     -> 派发给 harness agent
 *
 * 关键词文件 models/sherpa-onnx-kws-.../keywords_xiaopai.txt：
 *   x iǎo p ài x iǎo p ài @小派小派
 *
 * 实测要点（别改坏）：
 *   - threshold 0.25 / score 1.5 + chunk-16-left-64 的 epoch-12 权重，能稳定命中
 *   - 采音必须 ≥16kHz。8kHz 音源识别不出来，实测过。
 *   - 渲染进程送过来的必须是 Int16 PCM。送 Float32 的话主进程 Buffer.from()
 *     会把每个浮点截成一个字节，喂进 KWS 的是噪声，永远唤不醒。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const sherpa = require('sherpa-onnx-node');

const KWS_DIR = path.join(__dirname, '..', 'models', 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
const HARNESS_URL = 'http://127.0.0.1:31415';

const COMMAND_WINDOW_MS = 8000;    // 唤醒后最多听这么久
const COMMAND_SILENCE_MS = 1200;   // 说完后的静音判定

class WakeEngine {
  constructor(options = {}) {
    this.onWake = options.onWake || (() => {});
    this.onAsr = options.onAsr || (() => {});
    this.onState = options.onState || (() => {});

    this.kws = null;
    this.kwsStream = null;
    this.asrEngine = null;
    this.asrSession = null;

    this.enabled = true;
    this.ready = false;
    this.state = 'idle';           // idle（听唤醒词） | command（听指令）
    this.energyThreshold = options.energyThreshold ?? 0.006;
    this.lastVoiceAt = 0;
    this.commandStartedAt = 0;
    this.commandText = '';
    this.commandSegments = '';
  }

  async init() {
    const enc = path.join(KWS_DIR, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx');
    const dec = path.join(KWS_DIR, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx');
    const joi = path.join(KWS_DIR, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx');
    const kwFile = path.join(KWS_DIR, 'keywords_xiaopai.txt');

    for (const f of [enc, dec, joi, kwFile]) {
      if (!fs.existsSync(f)) throw new Error('KWS 资源缺失: ' + f);
    }

    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: enc, decoder: dec, joiner: joi },
        tokens: path.join(KWS_DIR, 'tokens.txt'),
        numThreads: 1,          // 常驻监听，线程给少一点
        provider: 'cpu',
      },
      keywordsFile: kwFile,
      keywordsScore: 1.5,
      keywordsThreshold: 0.25,
    });
    this.kwsStream = this.kws.createStream();

    // 唤醒后的指令识别复用主仓的流式 ASR
    try {
      const asrEngine = require('../asr-engine');
      await asrEngine.initASR();
      this.asrEngine = asrEngine;
    } catch (e) {
      console.warn('[WakeEngine] ASR 不可用，唤醒后只上报事件:', e.message);
    }

    this.ready = true;
    this.onState({ state: 'idle', enabled: this.enabled, ready: true });
    console.log('[WakeEngine] 就绪：常驻监听「小派小派」');
    return true;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) this.resetToIdle();
    this.onState({ state: this.state, enabled: this.enabled, ready: this.ready });
    console.log('[WakeEngine] 监听', this.enabled ? '开启' : '关闭');
  }

  resetToIdle() {
    this.asrSession?.dispose?.();
    this.state = 'idle';
    this.commandText = '';
    this.commandSegments = '';
    this.commandStartedAt = 0;
    if (this.kws) this.kwsStream = this.kws.createStream();
    this.asrSession = null;
  }

  /** 接收一段 Int16 PCM（16kHz 单声道） */
  processAudioChunk(buf) {
    if (!this.ready || !this.enabled || this.state === 'finalizing') return;

    const i16 = buf instanceof Int16Array
      ? buf
      : new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const f32 = new Float32Array(i16.length);
    let sum = 0;
    for (let i = 0; i < i16.length; i++) {
      const v = i16[i] / 32768;
      f32[i] = v;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (f32.length || 1));
    const now = Date.now();

    if (this.state === 'idle') {
      if (rms >= this.energyThreshold) this.kwsLastVoiceAt = now;
      if (rms < this.energyThreshold && now - (this.kwsLastVoiceAt || 0) > 700) return;
      this.feedKws(f32);
      return;
    }

    if (rms >= this.energyThreshold) this.lastVoiceAt = now;
    if (this.asrSession) this.asrSession.feedPCM(i16);

    const silent = now - this.lastVoiceAt > COMMAND_SILENCE_MS;
    const timeout = now - this.commandStartedAt > COMMAND_WINDOW_MS;
    if (silent || timeout) this.finishCommand(timeout ? 'timeout' : 'silence');
  }

  feedKws(f32) {
    try {
      this.kwsStream.acceptWaveform({ sampleRate: 16000, samples: f32 });
      while (this.kws.isReady(this.kwsStream)) {
        this.kws.decode(this.kwsStream);
        const r = this.kws.getResult(this.kwsStream);
        if (r && r.keyword) {
          this.handleWakeDetected(r.keyword);
          break;
        }
      }
    } catch (e) {
      console.warn('[WakeEngine] KWS 解码异常:', e.message);
      this.kwsStream = this.kws.createStream();
    }
  }

  handleWakeDetected(keyword) {
    console.log('[WakeEngine] 唤醒命中:', keyword);
    this.state = 'command';
    this.commandText = '';
    this.commandSegments = '';
    this.commandStartedAt = Date.now();
    this.lastVoiceAt = Date.now();
    this.kwsStream = this.kws.createStream();   // 重置避免重复命中

    if (this.asrEngine) {
      this.asrSession = this.asrEngine.createSession({
        onPartial: ({ text }) => {
          this.commandText = this.commandSegments + text;
          this.onAsr({ type: 'partial', text: this.commandText });
        },
        onFinal: ({ text }) => {
          if (text) this.commandSegments += text;
          this.commandText = this.commandSegments;
          this.onAsr({ type: 'partial', text: this.commandText });
        },
      });
    }

    this.onWake({ keyword, at: this.commandStartedAt });
    this.onState({ state: 'command', enabled: this.enabled, ready: true });
  }

  async finishCommand(reason) {
    if (this.state === 'finalizing') return;
    this.state = 'finalizing';
    const session = this.asrSession;
    if (session) await session.finish();
    if (this.asrSession !== session || !this.enabled) return;
    const text = (this.commandText || '').trim();
    console.log(`[WakeEngine] 指令收口 (${reason}):`, text || '(空)');
    this.onAsr({ type: 'final', text });
    if (text) this.dispatchToAgent(text);
    this.resetToIdle();
    this.onState({ state: 'idle', enabled: this.enabled, ready: true });
  }

  dispatchToAgent(message) {
    const body = JSON.stringify({ message, source: 'pet-wake' });
    const req = http.request(
      HARNESS_URL + '/api/agent/message',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
          let body='';res.on('data',chunk=>body+=chunk);
          res.on('end',()=>{if(res.statusCode>=400){let message='语音指令发送失败';try{message=JSON.parse(body).error||message;}catch{}this.onAsr({type:'error',text:message});}});
        }
    );
    req.on('error', (e) => console.warn('[WakeEngine] 派发失败（harness 未运行？）:', e.message));
    req.write(body);
    req.end();
  }

  /** 测试用：喂一个 wav 走一遍完整唤醒流程 */
  simulateAudioPlayback(wavPath) {
    const saved = this.energyThreshold;
    this.energyThreshold = 0;
    const w = sherpa.readWave(wavPath);
    let samples = w.samples;
    if (w.sampleRate !== 16000) {
      const rs = new sherpa.LinearResampler(w.sampleRate, 16000, 8000, true);
      samples = rs.resample(w.samples, true);
    }
    // 补静音尾巴：KWS 要有后续帧才能把最后一个关键词收口，真实麦克风天然有
    const withTail = new Float32Array(samples.length + 16000);
    withTail.set(samples, 0);
    samples = withTail;

    const CH = 1600;
    for (let i = 0; i < samples.length; i += CH) {
      const slice = samples.subarray(i, Math.min(i + CH, samples.length));
      const i16 = new Int16Array(slice.length);
      for (let k = 0; k < slice.length; k++) {
        const v = Math.max(-1, Math.min(1, slice[k]));
        i16[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      this.processAudioChunk(i16);
    }
    this.energyThreshold = saved;
  }

  getStatus() {
    return { ready: this.ready, enabled: this.enabled, state: this.state, keyword: '小派小派' };
  }
}

module.exports = { WakeEngine };
