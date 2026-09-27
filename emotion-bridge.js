import {
  SoullinkRuntime,
  loadModelProfile,
  getVADPreset,
  emotionVADPresets
} from './soullink-engine.browser.js';

// Jev chooses the semantic mood. Soullink owns continuous VAD state and performance.
export const JEV_VAD_MAP = Object.freeze({
  neutral: { valence: 0.05, arousal: 0.18, dominance: 0.05 },
  happy: { valence: 0.82, arousal: 0.58, dominance: 0.25 },
  smug: { valence: 0.62, arousal: 0.52, dominance: 0.78 },
  tsundere: { valence: -0.28, arousal: 0.72, dominance: 0.64 },
  thinking: { valence: 0.02, arousal: 0.24, dominance: 0.38 },
  alert: { valence: -0.36, arousal: 0.9, dominance: 0.7 }
});

const TRACE_LIMIT = 240;
const MOUTH_PARAM = 'ParamMouthOpenY';
// The controller owns tracking and head/body damping. The emotion loop must
// not overwrite these on every frame after the pointer handler has run.
const TRACKING_PARAMS = new Set(['ParamEyeBallX', 'ParamEyeBallY',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY']);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function mapJevMoodToVAD(mood, intensity = 1, urgency = 'normal') {
  const base = JEV_VAD_MAP[mood] || JEV_VAD_MAP.neutral;
  const urgencyBoost = urgency === 'urgent' ? 0.12 : 0;
  const amount = clamp01(intensity) * 0.78 + 0.22;
  return {
    valence: Math.max(-1, Math.min(1, base.valence * amount)),
    arousal: clamp01(base.arousal * amount + urgencyBoost),
    dominance: Math.max(-1, Math.min(1, base.dominance * amount))
  };
}

export class SoullinkEmotionBridge {
  constructor({ controller, profileUrl = './soullink.profile.json', traceLimit = TRACE_LIMIT } = {}) {
    this.controller = controller;
    this.profileUrl = profileUrl;
    this.traceLimit = traceLimit;
    this.runtime = null;
    this.profile = null;
    this.started = false;
    this.lastFrameTime = null;
    this.frameId = null;
    this.trace = [];
    this.currentMood = 'neutral';
    this.lastSnapshot = null;
  }

  async init() {
    this.profile = (await loadModelProfile(this.profileUrl)).profile;
    this.runtime = new SoullinkRuntime({
      profile: this.profile,
      personality: {
        expressiveness: 0.82,
        softness: 0.42,
        shyness: 0.34,
        gazeStability: 0.72
      },
      emotionPersonality: {
        baseline: JEV_VAD_MAP.neutral,
        reactivity: 0.9,
        targetApproachRate: 4.5,
        decayRate: 0.32,
        emotionHoldSeconds: 1.2,
        ambientDriftStrength: 0.025
      }
    });
    // TTS and VoiceUI retain exclusive ownership of ParamMouthOpenY.
    this.runtime.setLipSyncEnabled(false);
    this.runtime.setIdleEnabled(true);
    window.soullinkEmotion = this;
    return this;
  }

  applyJevDecision({ mood = 'neutral', intensity = 1, urgency = 'normal', text = '' } = {}) {
    if (!this.runtime) return null;
    this.currentMood = mood;
    const vad = mapJevMoodToVAD(mood, intensity, urgency);
    const intent = {
      emotion: mood,
      intensity: clamp01(intensity),
      contextTags: ['jev_decision'],
      sourceMessage: text || mood,
      naturalVAD: vad
    };
    this.runtime.triggerIntent(intent, this.lastFrameTime == null ? 0 : this.lastFrameTime / 1000, {
      vadTarget: vad,
      provider: 'jev'
    });
    this.trace.push({
      frame: this.trace.length,
      t: this.lastFrameTime == null ? 0 : this.lastFrameTime / 1000,
      kind: 'decision',
      mood,
      intensity,
      urgency,
      vadTarget: vad,
      intent
    });
    return { vad, intent };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.lastFrameTime = performance.now();
    const tick = (now) => {
      if (!this.started || !this.runtime) return;
      const dt = Math.min(0.1, Math.max(0.001, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      const snapshot = this.runtime.update(now / 1000, dt);
      this.lastSnapshot = snapshot;
      this.applySnapshot(snapshot, now / 1000);
      this.frameId = requestAnimationFrame(tick);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  applySnapshot(snapshot, timeSeconds) {
    if (!this.controller?.viewer) return;
    const params = snapshot.live2dParams || {};
    const applied = {};
    for (const [id, value] of Object.entries(params)) {
      // Soullink's speech layer is disabled and never writes the TTS mouth gate.
      if (id === MOUTH_PARAM || TRACKING_PARAMS.has(id)) continue;
      this.controller.viewer.setParameter(id, value);
      applied[id] = value;
    }
    this.controller.viewer.renderNow();
    const sample = {
      frame: this.trace.length,
      t: Number(timeSeconds.toFixed(4)),
      mood: this.currentMood,
      vad: {
        valence: Number(snapshot.vad.current.valence.toFixed(5)),
        arousal: Number(snapshot.vad.current.arousal.toFixed(5)),
        dominance: Number(snapshot.vad.current.dominance.toFixed(5))
      },
      params: applied,
      mouthOwnedBySoullink: Object.prototype.hasOwnProperty.call(applied, MOUTH_PARAM)
    };
    this.trace.push(sample);
    if (this.trace.length > this.traceLimit) this.trace.shift();
    window.soullinkEmotionTrace = this.trace;
  }

  stop() {
    this.started = false;
    if (this.frameId != null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  getStatus() {
    return {
      ready: Boolean(this.runtime),
      mood: this.currentMood,
      mappedParameters: Object.keys(this.profile?.parameterMap || {}).length,
      capabilities: this.profile?.capabilities || null,
      mouthOwnedBySoullink: false,
      traceFrames: this.trace.filter((entry) => entry.params).length
    };
  }
}

export { emotionVADPresets, getVADPreset };
