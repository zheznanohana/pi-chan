/**
 * ASR Engine using sherpa-onnx-node and Streaming Zipformer (Chinese 14M int8).
 * Lightweight (~24MB total download), CPU-optimized, true streaming real-time ASR.
 */

const path = require("path");
const fs = require("fs");

let sherpa = null;
let recognizer = null;
let finalRecognizer = null;
let initError = null;

const MODEL_DIR = path.resolve(__dirname, "models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23");

const MODEL_CONFIG = {
  encoder: path.join(MODEL_DIR, "encoder-epoch-99-avg-1.int8.onnx"),
  decoder: path.join(MODEL_DIR, "decoder-epoch-99-avg-1.int8.onnx"),
  joiner: path.join(MODEL_DIR, "joiner-epoch-99-avg-1.int8.onnx"),
  tokens: path.join(MODEL_DIR, "tokens.txt")
};

function initASR() {
  if (recognizer) return true;
  if (initError) return false;

  try {
    sherpa = require("sherpa-onnx-node");
  } catch (err) {
    initError = new Error(`Failed to load sherpa-onnx-node: ${err.message}`);
    console.error("[ASR]", initError.message);
    return false;
  }

  // Verify model files exist
  for (const [key, p] of Object.entries(MODEL_CONFIG)) {
    if (!fs.existsSync(p)) {
      initError = new Error(`ASR model file missing: ${p}`);
      console.error("[ASR]", initError.message);
      return false;
    }
  }

  try {
    const config = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80
      },
      modelConfig: {
        transducer: {
          encoder: MODEL_CONFIG.encoder,
          decoder: MODEL_CONFIG.decoder,
          joiner: MODEL_CONFIG.joiner
        },
        tokens: MODEL_CONFIG.tokens,
        numThreads: 2,
        provider: "cpu",
        debug: false
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: 1,
      rule1MinTrailingSilence: 1.5,
      rule2MinTrailingSilence: 0.9,
      rule3MinUtteranceLength: 20.0
    };

    console.log("[ASR] Initializing Streaming OnlineRecognizer...");
    const t0 = Date.now();
    recognizer = new sherpa.OnlineRecognizer(config);
    const finalDir = path.join(__dirname, 'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
    if (fs.existsSync(path.join(finalDir, 'model.int8.onnx'))) {
      finalRecognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: path.join(finalDir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 1 },
          tokens: path.join(finalDir, 'tokens.txt'), numThreads: 2, provider: 'cpu'
        }
      });
    }
    console.log(`[ASR] OnlineRecognizer initialized in ${Date.now() - t0}ms`);
    return true;
  } catch (err) {
    initError = new Error(`Failed to create OnlineRecognizer: ${err.message}`);
    console.error("[ASR]", initError.message);
    return false;
  }
}

class ASRSession {
  constructor(callbacks = {}, options = {}) {
    this.provider = options.provider || 'local';
    if (!['local', 'token-plan'].includes(this.provider)) throw new Error('ASR provider无效');
    this.abortController = new AbortController();
    this.bufferedSamples = 0;
    this.queuedFinals = 0;
    this.onPartial = callbacks.onPartial || (() => {});
    this.onFinal = callbacks.onFinal || (() => {});
    this.onError = callbacks.onError || (() => {});

    if (!recognizer && !initASR()) {
      throw initError || new Error("ASR engine not available");
    }

    this.stream = recognizer.createStream();
    this.lastPartial = "";
    this.totalSamplesFed = 0;
    this.isClosed = false;
    this.cancelled = false;
    this.audioChunks = [];
    this.pendingFinals = Promise.resolve();
  }

  /**
   * Feed raw Int16 PCM chunk (16kHz, mono, 16-bit signed).
   * @param {Buffer} pcmBuffer
   */
  feedPCM(pcmBuffer) {
    if (this.isClosed || !this.stream) return;
    if (!pcmBuffer || pcmBuffer.length < 2) return;

    // Bound each utterance before allocating its Float32 mirror. Long incoming
    // frames are split; no final request exceeds 30 seconds of original PCM.
    const MAX_SAMPLES = 16000 * 30;
    const capacityBytes = (MAX_SAMPLES - this.bufferedSamples) * 2;
    if (pcmBuffer.byteLength > capacityBytes) {
      const source = Buffer.from(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
      this.feedPCM(source.subarray(0, capacityBytes));
      this.feedPCM(source.subarray(capacityBytes));
      return;
    }
    const tStart = Date.now();
    // Buffers count bytes; Int16Array.length counts samples. Accept either,
    // including unaligned Buffer slices supplied by WebSocket/IPC.
    const bytes = Buffer.from(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
    const sampleCount = Math.floor(bytes.length / 2);

    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = bytes.readInt16LE(i * 2) / 32768.0;
    }

    this.audioChunks.push(Buffer.from(bytes.subarray(0, sampleCount * 2)));
    this.bufferedSamples += sampleCount;
    this.totalSamplesFed += sampleCount;
    this.stream.acceptWaveform({ samples: float32, sampleRate: 16000 });

    while (recognizer.isReady(this.stream)) {
      recognizer.decode(this.stream);
    }

    const latencyMs = Date.now() - tStart;
    const isEndpoint = recognizer.isEndpoint(this.stream);
    const result = recognizer.getResult(this.stream);
    const text = result && result.text ? result.text.trim() : "";

    if (isEndpoint || this.bufferedSamples >= MAX_SAMPLES) {
      this.emitFinal(text, { latencyMs, isEndpoint: true });
      recognizer.reset(this.stream);
      this.lastPartial = "";
    } else if (text && text !== this.lastPartial) {
      this.lastPartial = text;
      this.onPartial({ text, latencyMs });
    }
  }

  /**
   * Finish the stream and flush remaining recognition.
   */
  finish() {
    if (this.isClosed || !this.stream) return this.pendingFinals;
    this.isClosed = true;

    try {
      const tStart = Date.now();
      // Right-context padding preserves the final syllables on explicit stop.
      this.stream.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 });
      this.stream.inputFinished();

      while (recognizer.isReady(this.stream)) {
        recognizer.decode(this.stream);
      }

      const latencyMs = Date.now() - tStart;
      const result = recognizer.getResult(this.stream);
      const text = result && result.text ? result.text.trim() : "";

      this.emitFinal(text, { latencyMs, isEndpoint: false, flushed: true });
      this.lastPartial = "";
    } catch (err) {
      this.onError(err);
    }
    return this.pendingFinals;
  }

  emitFinal(draft, metadata) {
    const chunks = this.audioChunks;
    this.audioChunks = [];
    this.bufferedSamples = 0;
    if (!chunks.length || (this.provider === 'local' && !draft.trim())) return;
    const pcm = Buffer.concat(chunks);
    // Acoustic gate is independent of Zipformer's Chinese transcript: English
    // speech may have an empty draft. This gate reduces silence hallucinations.
    let energy = 0, voicedSamples = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i) / 32768;
      energy += sample * sample;
      if (Math.abs(sample) > 0.01) voicedSamples++;
    }
    if (this.provider === 'token-plan' && (voicedSamples < 800 || Math.sqrt(energy / (pcm.length / 2)) < 0.003)) return;
    // One in-flight + one waiting final. Report overload; never silently grow
    // an unlimited paid queue or fall back to a different recognition provider.
    if (this.queuedFinals >= 2) { this.onError(new Error('识别队列已满，该段未提交；请等待识别完成后重说')); return; }
    this.queuedFinals++;
    this.pendingFinals = this.pendingFinals.then(async () => {
      if (this.cancelled) return;
      const started = Date.now();
      let text = draft, refined = false;
      if (this.provider === 'token-plan') {
        const result = await require('./cloud-asr.cjs').transcribe(pcm, { signal: this.abortController.signal });
        text = typeof result === 'string' ? result.trim() : (result?.text || '').trim();
        refined = true;
      } else if (finalRecognizer) {
        const samples = new Float32Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
        try {
          const stream = finalRecognizer.createStream();
          stream.acceptWaveform({ samples, sampleRate: 16000 });
          const result = await finalRecognizer.decodeAsync(stream);
          text = (result.text || '').replace(/<\|[^|]*\|>/g, '').trim();
          refined = true;
        } catch (err) { if (!this.cancelled) this.onError(err); }
      }
      if (!this.cancelled && text) await this.onFinal({ ...metadata, text, draftText: draft,
        provider: this.provider, refined, refinementMs: Date.now() - started,
        latencyMs: metadata.latencyMs + Date.now() - started });
    }).catch(err => { if (!this.cancelled) this.onError(err); })
      .finally(() => { this.queuedFinals--; });
  }

  dispose() {
    this.cancelled = true;
    this.abortController.abort();
    this.bufferedSamples = 0;
    this.isClosed = true;
    this.audioChunks = [];
    this.stream = null;
  }
}

module.exports = {
  initASR,
  isReady: () => !!recognizer || initASR(),
  getModelInfo: (provider = 'local') => provider === 'token-plan' ? { ...require('./cloud-asr.cjs').getModelInfo(), provider, preview: '本地 Zipformer 实时预览；云端句尾识别' } : ({
    provider: 'local',
    name: finalRecognizer ? "Zipformer 实时预览 + SenseVoice 中文最终识别" : "Zipformer 中文实时识别",
    finalPass: !!finalRecognizer,
    size: "24.35 MB",
    type: "Zipformer Transducer (Streaming, Int8)",
    sampleRate: 16000
  }),
  createSession: (callbacks, options) => new ASRSession(callbacks, options)
};
