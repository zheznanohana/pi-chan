'use strict';

// Sentence-end HTTP recognition, NOT the separate Flash-Streaming model.
// Schema: https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
// Subscription endpoint: https://help.aliyun.com/zh/model-studio/token-plan-multimodal-gen
const { getApiKey } = require('./token-plan-credentials.cjs');
const MODEL = 'qwen-audio-3.0-asr-flash';
const ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const SAMPLE_RATE = 16000;
const MAX_DURATION_SEC = 30;
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_DURATION_SEC;
const TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function failure(code, message, status) {
  const error = new Error(message);
  error.name = code === 'ABORT_ERR' ? 'AbortError' : 'CloudAsrError';
  error.code = code;
  if (status) error.status = status;
  return error;
}

function subscriptionKey() {
  let key;
  try { key = getApiKey(); } catch { /* Do not propagate private-store errors. */ }
  if (typeof key !== 'string' || !/^sk-sp-[A-Za-z0-9_.-]+$/.test(key)) {
    throw failure('ASR_NOT_CONFIGURED', 'Token Plan 语音识别订阅密钥尚未配置');
  }
  return key;
}

function getModelInfo() {
  let configured = false;
  try { subscriptionKey(); configured = true; } catch { /* keyless status */ }
  return {
    model: MODEL, provider: 'token-plan', endpoint: ENDPOINT,
    sampleRate: SAMPLE_RATE, channels: 1, format: 'pcm16le',
    streaming: false, mode: 'sentence-http', maxDurationSec: MAX_DURATION_SEC,
    timeoutMs: TIMEOUT_MS, configured,
  };
}

function wavFromPcm(input) {
  if (!(input instanceof Uint8Array) && !(input instanceof Int16Array)) {
    throw failure('ASR_INVALID_AUDIO', '语音识别需要 16 kHz 单声道 PCM16 数据');
  }
  const length = input.byteLength;
  if (!length || length % 2 || length > MAX_BYTES) {
    throw failure('ASR_INVALID_AUDIO', '语音识别片段须为完整 PCM16 采样且长度介于 0 至 30 秒');
  }
  const wav = Buffer.allocUnsafe(44 + length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + length, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(length, 40);
  if (input instanceof Int16Array) {
    for (let i = 0; i < input.length; i++) wav.writeInt16LE(input[i], 44 + i * 2);
  } else {
    Buffer.from(input.buffer, input.byteOffset, length).copy(wav, 44);
  }
  return wav;
}

async function readJson(response) {
  if (!response.body) throw failure('ASR_INVALID_RESPONSE', '语音识别服务返回空响应');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw failure('ASR_INVALID_RESPONSE', '语音识别响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* cleanup only */ } }
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw failure('ASR_INVALID_RESPONSE', '语音识别服务返回了非 JSON 响应'); }
}

/** PCM16 LE mono 16 kHz -> final text; silence may return ''. No retries/fallback. */
async function transcribe(pcm16k, { signal } = {}) {
  if (signal?.aborted) throw failure('ABORT_ERR', '语音识别已取消');
  const wav = wavFromPcm(pcm16k);
  const key = subscriptionKey();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
      body: JSON.stringify({
        model: MODEL,
        input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] }] },
        parameters: { format: 'wav', sample_rate: '16000' },
      }),
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* no upstream error text or credential logging */ }
      throw failure('ASR_HTTP_ERROR', `Token Plan 语音识别请求失败（HTTP ${response.status}）`, response.status);
    }
    const data = await readJson(response);
    if (controller.signal.aborted) throw failure('ABORT_ERR', '语音识别已取消');
    if (!data || typeof data !== 'object' || data.code || data.error ||
        !data.output || typeof data.output.text !== 'string' ||
        (data.output.sentence != null && data.output.sentence.sentence_end !== true)) {
      throw failure('ASR_INVALID_RESPONSE', '语音识别服务未返回有效的最终转写结果');
    }
    return data.output.text.trim();
  } catch (error) {
    if (signal?.aborted) throw failure('ABORT_ERR', '语音识别已取消');
    if (timedOut) throw failure('ASR_TIMEOUT', 'Token Plan 语音识别请求超时');
    if (error?.name === 'CloudAsrError' || error?.code === 'ABORT_ERR') throw error;
    // Never relay fetch causes, headers, raw provider bodies, or supplied audio.
    throw failure('ASR_NETWORK_ERROR', 'Token Plan 语音识别网络请求失败');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { transcribe, getModelInfo };
