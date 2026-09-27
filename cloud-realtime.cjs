'use strict';

// Official session protocol / PCM formats / interruption sequence:
// https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
// Token Plan uses WorkspaceId=token-plan (not a normal metered workspace):
// https://help.aliyun.com/zh/model-studio/realtime-token-authentication
const { WebSocket, WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { getApiKey } = require('./token-plan-credentials.cjs');
const MODEL = 'qwen-audio-3.0-realtime-plus';
const ENDPOINT = 'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime';
const VOICES = ['longanqian', 'longanlingxin', 'longanlingxi', 'longanxiaoxin', 'longanlufeng'];
const DEFAULT_INSTRUCTIONS = '你是小派，一位自然、亲切、俏皮的聊天伙伴。用简短自然的口语回应，跟随用户使用的语言。不宣称执行了工具或开发任务；需要开发操作时请用户通过开发工作台确认。';

function getModelInfo() {
  let configured = false;
  try { configured = /^sk-sp-[A-Za-z0-9_.-]+$/.test(getApiKey()); } catch {}
  return { model: MODEL, provider: 'bailian-token-plan', configured, realtime: true,
    endpoint: ENDPOINT, inputSampleRate: 16000, sampleRate: 24000, voice: VOICES[0], voices: [...VOICES] };
}

function createRealtimeServer({ checkRequest, instructions = DEFAULT_INSTRUCTIONS } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  let owner = null;
  wss.on('connection', (client) => {
    let upstream = null, started = false, ready = false, ended = false;
    let sessionId = randomUUID(), activeResponse = null;
    const cancelled = new Set();
    let lastInput = Date.now(), rateTime = Date.now(), budget = 64000, pong = true;
    let initTimer, maxTimer, heartbeat, killTimer;

    function closeCloud() {
      if (!upstream || upstream.readyState === WebSocket.CLOSED) return;
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else {
        upstream.close(1000, 'Local session ended');
        const socket = upstream;
        killTimer = setTimeout(() => socket.terminate(), 1500);
        killTimer.unref?.();
      }
    }
    function finish(reason, error) {
      if (ended) return;
      ended = true; ready = false;
      clearTimeout(initTimer); clearTimeout(maxTimer); clearInterval(heartbeat);
      if (owner === client) owner = null;
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024 * 1024) {
        if (error) client.send(JSON.stringify({ type: 'error', ...error, sessionId }));
        client.send(JSON.stringify({ type: 'ended', reason, sessionId }));
      }
      closeCloud();
      if (client.readyState === WebSocket.OPEN) {
        client.close(error ? 1011 : 1000, error ? 'Realtime ended with error' : 'Realtime ended');
        const timer = setTimeout(() => client.terminate(), 1500); timer.unref?.();
      }
    }
    function fail(code, message) { finish('error', { code, message }); }
    function emit(event) {
      if (ended || client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 1024 * 1024) return fail('BACKPRESSURE', '实时语音播放端积压，连接已结束');
      client.send(JSON.stringify({ ...event, sessionId }), (error) => { if (error) finish('client_disconnected'); });
    }
    function sendCloud(event) {
      if (ended || upstream?.readyState !== WebSocket.OPEN) return false;
      if (upstream.bufferedAmount > 256 * 1024) { fail('BACKPRESSURE', '实时语音网络积压，连接已结束'); return false; }
      upstream.send(JSON.stringify({ ...event, event_id: randomUUID() }), (error) => {
        if (error) fail('UPSTREAM_NETWORK', '套餐实时语音发送失败');
      });
      return true;
    }
    function interrupt() {
      if (activeResponse) {
        cancelled.add(activeResponse);
        if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value);
        sendCloud({ type: 'response.cancel' });
        activeResponse = null;
      }
    }
    function onCloudMessage(bytes, isBinary) {
      if (ended) return;
      if (isBinary) return fail('UPSTREAM_PROTOCOL', '实时语音服务返回未知音频协议');
      let event;
      try { event = JSON.parse(bytes.toString()); } catch { return fail('UPSTREAM_PROTOCOL', '实时语音服务响应格式错误'); }
      if (!event || typeof event.type !== 'string') return fail('UPSTREAM_PROTOCOL', '实时语音服务响应缺少类型');
      const responseId = event.response_id || event.response?.id || null;
      const itemId = typeof event.item_id === 'string' ? event.item_id : null;
      if (event.type === 'error') {
        // A cancel may race with normal completion. Only this known benign code is ignored.
        if (event.error?.code === 'response_cancel_not_active') return;
        return fail('UPSTREAM_ERROR', '套餐实时语音服务拒绝请求，请检查模型权限或配置');
      }
      if (event.type === 'session.updated') {
        if (ready) return;
        clearTimeout(initTimer); ready = true;
        emit({ type: 'ready', model: MODEL, inputSampleRate: 16000, sampleRate: 24000 });
      } else if (event.type === 'input_audio_buffer.speech_started') {
        interrupt(); emit({ type: 'speech_started', itemId });
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        emit({ type: 'speech_stopped', itemId });
      } else if (event.type === 'response.created') {
        if (typeof responseId !== 'string') return fail('UPSTREAM_PROTOCOL', '实时语音回复缺少标识');
        activeResponse = responseId;
        emit({ type: 'response_started', responseId });
      } else if (event.type === 'response.done') {
        if (activeResponse === responseId) activeResponse = null;
        emit({ type: 'response_done', responseId, status: cancelled.has(responseId) ? 'cancelled' : (event.response?.status || 'completed') });
      } else if (event.type === 'response.audio.delta') {
        if (!responseId || cancelled.has(responseId)) return;
        const audio = event.delta;
        if (typeof audio !== 'string' || audio.length > 256 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio) || audio.length % 4) {
          return fail('UPSTREAM_PROTOCOL', '实时语音音频格式错误');
        }
        if (Buffer.from(audio, 'base64').length % 2) return fail('UPSTREAM_PROTOCOL', '实时语音 PCM 采样不完整');
        emit({ type: 'audio', responseId, itemId, pcm16Base64: audio, sampleRate: 24000 });
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        if (typeof event.transcript === 'string') emit({ type: 'transcript', role: 'user', text: event.transcript.slice(0, 32000), delta: false, itemId });
      } else if (/^response\.(audio_transcript|text)\.(delta|done)$/.test(event.type)) {
        if (!responseId || cancelled.has(responseId)) return;
        const delta = event.type.endsWith('.delta');
        const text = delta ? event.delta : (event.transcript ?? event.text);
        if (typeof text === 'string') emit({ type: 'transcript', role: 'assistant', text: text.slice(0, 32000), delta, responseId, itemId,
          channel: event.type.includes('audio_transcript') ? 'audio_transcript' : 'text' });
      }
    }

    function start(message) {
      if (started) return fail('INVALID_STATE', '实时语音会话已启动');
      if (message.model !== MODEL) return fail('UNSUPPORTED_MODEL', '该模型未接入套餐实时语音');
      if (owner && owner !== client) return fail('REALTIME_BUSY', '另一个窗口正在进行实时语音，请先结束该会话');
      const voice = message.voice || VOICES[0];
      if (!VOICES.includes(voice)) return fail('INVALID_VOICE', '请选择此实时模型支持的音色');
      let key;
      try { key = getApiKey(); } catch { return fail('NOT_CONFIGURED', '套餐实时语音凭据尚未配置'); }
      if (!/^sk-sp-[A-Za-z0-9_.-]+$/.test(key)) return fail('NOT_CONFIGURED', '套餐实时语音需要订阅凭据');
      started = true; owner = client;
      clearTimeout(initTimer);
      initTimer = setTimeout(() => fail('CONNECT_TIMEOUT', '套餐实时语音连接超时'), 20000);
      try {
        upstream = new WebSocket(`${ENDPOINT}?model=${encodeURIComponent(MODEL)}`, {
          headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15000,
          maxPayload: 512 * 1024, perMessageDeflate: false, followRedirects: false,
        });
      } catch { return fail('CONNECT_ERROR', '套餐实时语音连接失败'); }
      upstream.on('error', () => fail('UPSTREAM_NETWORK', '套餐实时语音连接失败'));
      upstream.on('close', () => { clearTimeout(killTimer); finish('upstream_closed'); });
      upstream.on('message', onCloudMessage);
      upstream.on('open', () => {
        if (ended) return closeCloud();
        sendCloud({ type: 'session.update', session: {
          modalities: ['text', 'audio'], voice, instructions: String(instructions).slice(0, 8000),
          input_audio_format: 'pcm', output_audio_format: 'pcm',
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
        } });
      });
      // No silent reconnect or unlimited unattended session; the user starts again explicitly.
      maxTimer = setTimeout(() => finish('duration_limit'), 30 * 60 * 1000);
    }

    client.on('error', () => finish('client_disconnected'));
    client.on('close', () => finish('client_disconnected'));
    client.on('pong', () => { pong = true; });
    client.on('message', (bytes, isBinary) => {
      if (ended) return;
      if (isBinary) {
        if (!ready) return fail('NOT_READY', '请等待实时语音就绪后发送音频');
        if (!bytes.length || bytes.length > 64000 || bytes.length % 2) return fail('INVALID_AUDIO', '实时语音需要 PCM16 单声道 16 kHz 音频');
        const now = Date.now();
        budget = Math.min(64000, budget + (now - rateTime) * 40); rateTime = now;
        if (bytes.length > budget) return fail('AUDIO_RATE_LIMIT', '实时语音输入超过采集速率限制');
        budget -= bytes.length; lastInput = now;
        sendCloud({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
        return;
      }
      if (bytes.length > 4096) return fail('INVALID_MESSAGE', '实时语音控制消息过大');
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return fail('INVALID_MESSAGE', '实时语音控制消息格式错误'); }
      if (message?.type === 'start') start(message);
      else if (message?.type === 'stop') finish('user_stop');
      else if (message?.type === 'interrupt' && ready) { interrupt(); emit({ type: 'speech_started', manual: true }); }
      else fail('INVALID_MESSAGE', '实时语音控制消息无效');
    });
    initTimer = setTimeout(() => finish('start_timeout'), 10000);
    heartbeat = setInterval(() => {
      if (!pong || (ready && Date.now() - lastInput > 60000)) return finish('client_idle');
      pong = false;
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, 15000);
    heartbeat.unref?.();
  });
  function upgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
    if (pathname !== '/ws/realtime') return false;
    try {
      if (typeof checkRequest !== 'function') throw new Error('Missing access guard');
      checkRequest(req);
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return true;
    }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
    return true;
  }
  function close() { for (const client of wss.clients) client.terminate(); wss.close(); }
  return { upgrade, close };
}

module.exports = { createRealtimeServer, getModelInfo };
