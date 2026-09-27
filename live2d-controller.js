/**
 * Live2D Controller for Pi-chan Dashboard (Master Grade)
 * Rigged with Cubism 4/5 Core, PixiJS & Jev Cognitive Emotion Director
 * 
 * Kinematics Architecture (Referenced from mature Live2D / VTube standards):
 *   1. Proportional body follow (torso follows head yaw with 0.35 damping, NO artificial shaking).
 *   2. Organic resting breath wave (smooth 0.25Hz sinus solely on ParamBreath).
 *   3. Expressive thinking cognitive states (upward pensive gaze, head tilt, thinking blink).
 *   4. Natural speech phoneme modulation with closing smile.
 */

import { createViewer } from './live2d/runtime.js';
const TRACKING_IDS = ['ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY'];

export class PiChanLive2D {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.viewer = null;
    this.ready = false;
    
    // Animation & Speech State
    this.speakingAnimId = null;
    this.speechPhase = 0;
    this.speakingUntil = 0;
    
    // Core Kinematics Loop
    this.kinematicsTickId = null;
    this.animTime = 0;
    this.nextBlinkTime = 0;
    this.blinkPhase = 0;
    
    // Target parameters for smooth interpolation
    this.targetParams = {
      ParamAngleX: 0,
      ParamAngleY: 0,
      ParamAngleZ: 0,
      ParamBodyAngleX: 0,
      ParamBodyAngleY: 0,
      ParamEyeBallX: 0,
      ParamEyeBallY: 0,
      ParamEyeLOpen: 1.0,
      ParamEyeROpen: 1.0,
      ParamMouthForm: 0.2,
      ParamMouthOpenY: 0,
      ParamBreath: 0.5
    };
    
    this.currentParams = { ...this.targetParams };
    this.currentMood = 'neutral';
    this.isSpeaking = false;
    this.pointer = { x: 0, y: 0, active: false };
    this.moodTracking = Object.fromEntries(TRACKING_IDS.map(id => [id, 0]));
    this.disposePointerTracking = null;
  }

  async init() {
    try {
      const modelUrl = './live2d/model/model.model3.json';

      this.viewer = await createViewer({
        canvas: this.canvas,
        modelUrl: modelUrl,
        onReady: (info) => {
          console.log(`✨ [Live2D] Master Model ready: ${info.parameters.length} parameters, Core ${info.coreVersion}`);
        },
        onError: (err) => {
          console.error('❌ [Live2D] Viewer error:', err);
        }
      });

      // 1. Enable viewer basic state
      this.viewer.setAutoPlay(true);
      this.viewer.setPointerFollow(false); // We handle standard proportional tracking
      this.viewer.setView('portrait');
      this.viewer.playMotion('Idle');

      // 2. Start global window pointer tracking & mature kinematics
      this.bindGlobalPointerTracking();
      this.startKinematicsLoop();

      this.ready = true;
      console.log('🎉 [Live2D] Pi-chan Live2D Master Controller active with mature kinematics!');
      return true;
    } catch (err) {
      console.error('❌ [Live2D] Init exception:', err);
      return false;
    }
  }

  setView(viewName) {
    if (!this.viewer) return;
    this.viewer.setView(viewName);
  }

  playMotion(name) {
    if (!this.viewer) return;
    try {
      this.viewer.playMotion(name);
    } catch (e) {
      console.warn('Motion play notice:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Standard Mature Pointer Tracking (Eyes, Head, and proportional Torso follow)
  // ---------------------------------------------------------------------------
  composeTrackingPose() {
    const active = this.pointer.active;
    const nx = active ? this.pointer.x : 0, ny = active ? this.pointer.y : 0;
    // Keep Jev's characteristic tilt, but never lock gaze while thinking/speaking.
    const thinking = ['thinking', 'analytical'].includes(this.currentMood);
    const gain = thinking ? 0.85 : 1;
    const moodWeight = active ? 0.3 : 1;
    const offsets = {ParamEyeBallX:nx*0.65*gain, ParamEyeBallY:ny*0.55*gain,
      ParamAngleX:nx*18*gain, ParamAngleY:ny*14*gain, ParamAngleZ:-nx*ny*5,
      ParamBodyAngleX:nx*6.5*gain, ParamBodyAngleY:ny*4*gain};
    for (const id of TRACKING_IDS) {
      const limit = id.startsWith('ParamEyeBall') ? 0.9 : id.startsWith('ParamBody') ? 10 : 24;
      this.targetParams[id] = Math.max(-limit, Math.min(limit, this.moodTracking[id]*moodWeight+offsets[id]));
    }
  }

  bindGlobalPointerTracking() {
    this.disposePointerTracking?.();
    const followPointer = (e) => {
      if (!this.viewer || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const centerX = rect.left + rect.width/2, centerY = rect.top + rect.height*0.35;
      this.pointer = {
        x:Math.max(-1, Math.min(1, (e.clientX-centerX)/Math.max(1,window.innerWidth*0.55))),
        y:Math.max(-1, Math.min(1, (centerY-e.clientY)/Math.max(1,window.innerHeight*0.55))), active:true
      };
      this.composeTrackingPose();
    };
    const reset = () => { this.pointer.active = false; this.composeTrackingPose(); };
    const leave = e => {
      // pointerleave also fires on child elements in capture phase; only the window exit counts.
      if (window.dashboardPointer || (e.target!==window && e.target!==document.documentElement && e.target!==document)) return;
      reset();
    };
    window.addEventListener('pointermove', followPointer, {capture:true,passive:true});
    window.addEventListener('pointerleave', leave, true);
    window.addEventListener('blur', reset);
    const unsubscribe = window.dashboardPointer?.subscribe(position => {
      const zoom = Number.isFinite(position.zoom)&&position.zoom>0 ? position.zoom : 1;
      followPointer({clientX:(position.cursorX-position.winX)/zoom, clientY:(position.cursorY-position.winY)/zoom});
    });
    const unload = () => this.destroy();
    window.addEventListener('pagehide', unload);
    this.disposePointerTracking = () => {
      window.removeEventListener('pointermove', followPointer, true);
      window.removeEventListener('pointerleave', leave, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('pagehide', unload);
      if (typeof unsubscribe==='function') unsubscribe();
      this.disposePointerTracking = null;
    };
  }

  destroy() {
    this.disposePointerTracking?.();
    if(this.kinematicsTickId!=null) cancelAnimationFrame(this.kinematicsTickId);
    this.kinematicsTickId=null;
    this.stopSpeaking();
    this.viewer?.destroy?.();
    this.viewer=null;
    this.ready=false;
  }

  // ---------------------------------------------------------------------------
  // Mature Organic Kinematics Loop (Breathing + Smooth Damping + Natural Blinking)
  // ---------------------------------------------------------------------------
  startKinematicsLoop() {
    if (this.kinematicsTickId) cancelAnimationFrame(this.kinematicsTickId);
    this.nextBlinkTime = performance.now() + 2500;

    const tick = () => {
      if (!this.viewer) return;
      const now = performance.now();
      this.animTime += 0.022;

      // 1. Standard resting breath wave: 0.28Hz sinus on ParamBreath (0.0 to 0.55)
      const breathWave = (Math.sin(this.animTime * 1.5) + 1) * 0.275;

      // 2. Natural periodic blinking (quick 180ms blink every 3~5s)
      let blinkValue = 1.0;
      if (now > this.nextBlinkTime) {
        this.blinkPhase += 0.18;
        if (this.blinkPhase < Math.PI) {
          // Closed eyelid trough
          blinkValue = Math.max(0, 1.0 - Math.sin(this.blinkPhase) * 1.05);
        } else {
          this.blinkPhase = 0;
          this.nextBlinkTime = now + (this.currentMood === 'thinking' ? 2200 : 3500) + Math.random() * 2000;
        }
      }

      // 3. Smooth damping (lerp) towards target pose
      const lerp = (cur, tar, factor) => cur + (tar - cur) * factor;
      const k = 0.08;

      this.currentParams.ParamAngleX = lerp(this.currentParams.ParamAngleX, this.targetParams.ParamAngleX, k);
      this.currentParams.ParamAngleY = lerp(this.currentParams.ParamAngleY, this.targetParams.ParamAngleY, k);
      this.currentParams.ParamAngleZ = lerp(this.currentParams.ParamAngleZ, this.targetParams.ParamAngleZ, k);
      this.currentParams.ParamBodyAngleX = lerp(this.currentParams.ParamBodyAngleX, this.targetParams.ParamBodyAngleX, k);
      this.currentParams.ParamBodyAngleY = lerp(this.currentParams.ParamBodyAngleY, this.targetParams.ParamBodyAngleY, k);
      this.currentParams.ParamEyeBallX = lerp(this.currentParams.ParamEyeBallX, this.targetParams.ParamEyeBallX, k);
      this.currentParams.ParamEyeBallY = lerp(this.currentParams.ParamEyeBallY, this.targetParams.ParamEyeBallY, k);
      this.currentParams.ParamMouthForm = lerp(this.currentParams.ParamMouthForm, this.targetParams.ParamMouthForm, 0.12);

      // Apply to Cubism Core
      this.viewer.setParameter('ParamBreath', breathWave);
      this.viewer.setParameter('ParamAngleX', this.currentParams.ParamAngleX);
      this.viewer.setParameter('ParamAngleY', this.currentParams.ParamAngleY);
      this.viewer.setParameter('ParamAngleZ', this.currentParams.ParamAngleZ);
      this.viewer.setParameter('ParamBodyAngleX', this.currentParams.ParamBodyAngleX);
      this.viewer.setParameter('ParamBodyAngleY', this.currentParams.ParamBodyAngleY);
      this.viewer.setParameter('ParamEyeBallX', this.currentParams.ParamEyeBallX);
      this.viewer.setParameter('ParamEyeBallY', this.currentParams.ParamEyeBallY);

      // Natural blink application (respecting mood limits)
      const eyeL = Math.min(this.targetParams.ParamEyeLOpen, blinkValue);
      const eyeR = Math.min(this.targetParams.ParamEyeROpen, blinkValue);
      this.viewer.setParameter('ParamEyeLOpen', eyeL);
      this.viewer.setParameter('ParamEyeROpen', eyeR);

      if (!this.isSpeaking) {
        this.viewer.setParameter('ParamMouthForm', this.currentParams.ParamMouthForm);
        this.viewer.setParameter('ParamMouthOpenY', 0);
      }

      this.viewer.renderNow();
      this.kinematicsTickId = requestAnimationFrame(tick);
    };

    this.kinematicsTickId = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Intelligent Dialogue Speech Flapping (Multi-frequency phonemes)
  // ---------------------------------------------------------------------------
  speakDialogue(text, explicitDurationMs = 0) {
    if (!this.viewer) return;

    // Calculate natural spoken duration: ~13 characters per second, min 2.2s, max 8.5s
    const textLen = (text || '').length;
    const duration = explicitDurationMs > 0 ? explicitDurationMs : Math.min(8500, Math.max(2200, textLen * 75));
    
    this.speakingUntil = performance.now() + duration;
    this.isSpeaking = true;

    if (this.speakingAnimId) return; // Loop active

    const animateSpeech = () => {
      const now = performance.now();
      if (now > this.speakingUntil) {
        this.stopSpeaking();
        return;
      }

      this.speechPhase += 0.28;

      // Realistic syllable modulation (multiple harmonic waves + natural syllable breaks)
      const primary = Math.sin(this.speechPhase * 1.4);
      const secondary = Math.sin(this.speechPhase * 0.7);
      const pulse = Math.abs(primary * 0.65 + secondary * 0.35);

      // Map to natural mouth apertures (0.15 ~ 0.85)
      const openY = pulse < 0.12 ? 0.05 : Math.min(0.85, 0.15 + pulse * 0.7);
      const mouthForm = 0.4 + 0.3 * Math.sin(this.speechPhase * 0.9);

      this.viewer.setParameter('ParamMouthOpenY', openY);
      this.viewer.setParameter('ParamMouthForm', mouthForm);
      this.viewer.renderNow();

      this.speakingAnimId = requestAnimationFrame(animateSpeech);
    };

    this.speakingAnimId = requestAnimationFrame(animateSpeech);
  }

  startSpeaking() {
    this.speakDialogue('', 3000);
  }

  stopSpeaking() {
    this.isSpeaking = false;
    if (this.speakingAnimId) {
      cancelAnimationFrame(this.speakingAnimId);
      this.speakingAnimId = null;
    }
    if (this.viewer) {
      this.viewer.setParameter('ParamMouthOpenY', 0);
      this.viewer.setParameter('ParamMouthForm', 0.2); // Gentle smiling resting mouth
      this.viewer.renderNow();
    }
  }

  // ---------------------------------------------------------------------------
  // Jev Cognitive Emotion & Mood Integration (With Thinking States)
  // ---------------------------------------------------------------------------
  setMood(mood) {
    if (!this.viewer) return;
    this.currentMood = mood;
    // Reset all pose axes before selecting a mood (no stale angles from prior moods).
    for(const id of TRACKING_IDS) this.targetParams[id]=0;

    if (mood === 'thinking' || mood === 'analytical') {
      // Pensive / Thinking expression:
      // Eyes glance upward and to the side, head inquisitively tilted, lips composed
      this.targetParams.ParamEyeBallX = 0.32;
      this.targetParams.ParamEyeBallY = 0.58;
      this.targetParams.ParamAngleX = 4.0;
      this.targetParams.ParamAngleY = 5.0;
      this.targetParams.ParamAngleZ = 5.0;
      this.targetParams.ParamBodyAngleX = 2.0;
      this.targetParams.ParamEyeLOpen = 0.95;
      this.targetParams.ParamEyeROpen = 0.95;
      this.targetParams.ParamMouthForm = -0.10; // Thoughtful pursed mouth
      this.targetParams.ParamMouthOpenY = 0;
    } else if (mood === 'smug' || mood === 'proud') {
      this.targetParams.ParamEyeBallX = 0;
      this.targetParams.ParamEyeBallY = 0;
      this.targetParams.ParamMouthForm = 1.0;
      this.targetParams.ParamAngleZ = 6;
      this.targetParams.ParamAngleY = 4;
      this.targetParams.ParamBodyAngleX = 3;
      this.targetParams.ParamEyeLOpen = 0.95;
      this.targetParams.ParamEyeROpen = 0.95;
      this.playMotion('Nod');
    } else if (mood === 'tsundere' || mood === 'pout') {
      this.targetParams.ParamEyeBallX = -0.4;
      this.targetParams.ParamEyeBallY = 0.1;
      this.targetParams.ParamMouthForm = -1.0;
      this.targetParams.ParamAngleX = -15;
      this.targetParams.ParamAngleY = 4;
      this.targetParams.ParamAngleZ = -4;
      this.targetParams.ParamBodyAngleX = -5;
      this.targetParams.ParamEyeLOpen = 0.90;
      this.targetParams.ParamEyeROpen = 0.90;
      this.playMotion('Shake');
    } else if (mood === 'alert' || mood === 'danger' || mood === 'shocked') {
      this.targetParams.ParamEyeBallX = 0;
      this.targetParams.ParamEyeBallY = 0;
      this.targetParams.ParamEyeLOpen = 1.15;
      this.targetParams.ParamEyeROpen = 1.15;
      this.targetParams.ParamMouthForm = -0.5;
      this.targetParams.ParamAngleY = -5;
      this.targetParams.ParamBodyAngleX = -3;
      this.playMotion('Shake');
    } else if (mood === 'happy') {
      this.targetParams.ParamEyeBallX = 0;
      this.targetParams.ParamEyeBallY = 0;
      this.targetParams.ParamMouthForm = 0.85;
      this.targetParams.ParamAngleZ = 4;
      this.targetParams.ParamAngleY = 2;
      this.targetParams.ParamBodyAngleX = 2;
      this.targetParams.ParamEyeLOpen = 1.0;
      this.targetParams.ParamEyeROpen = 1.0;
      this.playMotion('Nod');
    } else {
      // Neutral
      this.targetParams.ParamEyeBallX = 0;
      this.targetParams.ParamEyeBallY = 0;
      this.targetParams.ParamMouthForm = 0.2;
      this.targetParams.ParamAngleX = 0;
      this.targetParams.ParamAngleY = 0;
      this.targetParams.ParamAngleZ = 0;
      this.targetParams.ParamBodyAngleX = 0;
      this.targetParams.ParamEyeLOpen = 1.0;
      this.targetParams.ParamEyeROpen = 1.0;
    }
    this.moodTracking=Object.fromEntries(TRACKING_IDS.map(id=>[id,this.targetParams[id]]));
    this.composeTrackingPose();
  }

  /**
   * Jev System One Director Hook:
   * Called when Jev classifies emotional intent from text or action.
   */
  applyJevEmotion(emotion, confidence = 0.85, speechText = '') {
    console.log(`🧠 [Jev Emotion Director] Decision: ${emotion} (conf: ${confidence})`);
    this.setMood(emotion);
    if (speechText) {
      this.speakDialogue(speechText);
    }
  }

  captureScreenshot() {
    if (!this.viewer) return null;
    return this.viewer.capture();
  }
}

// Global hook
if (typeof window !== 'undefined') {
  window.PiChanLive2D = PiChanLive2D;
}
