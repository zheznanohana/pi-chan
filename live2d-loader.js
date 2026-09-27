/**
 * Live2D WebGL Controller for Pi-chan Dashboard
 * Powered by Cubism Core 4 & PixiJS
 */

class PiChanLive2D {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.app = null;
    this.model = null;
    this.ready = false;
  }

  async init() {
    try {
      await this.loadDependencies();
      await this.initPixi();
      await this.loadModel();
      this.bindInteractions();
      this.ready = true;
      console.log("✨ [Live2D] π-chan Live2D model loaded and rendering smoothly!");
      return true;
    } catch (err) {
      console.error("❌ [Live2D] Failed to load Live2D:", err);
      return false;
    }
  }

  async loadDependencies() {
    const loadScript = (src, check) => {
      if (check()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = (e) => reject(new Error(`Failed to load ${src}: ${e}`));
        document.head.appendChild(s);
      });
    };

    // 1. Cubism Core
    await loadScript("./live2d/vendor/live2dcubismcore.min.js", () => !!window.Live2DCubismCore);
    
    // Wait for WASM to be ready
    const deadline = performance.now() + 10000;
    while (true) {
      try {
        if (window.Live2DCubismCore?.Version?.csmGetVersion()) break;
      } catch (e) {}
      if (performance.now() > deadline) throw new Error("Cubism Core WASM timeout");
      await new Promise(r => setTimeout(r, 20));
    }

    // 2. PixiJS
    await loadScript("./live2d/vendor/pixi-6.5.10.min.js", () => !!window.PIXI);

    // 3. pixi-live2d-display
    await loadScript("./live2d/vendor/pixi-live2d-display-0.4.0.min.js", () => !!window.PIXI?.live2d?.Live2DModel);
  }

  async initPixi() {
    const PIXI = window.PIXI;
    if (!PIXI.utils.isWebGLSupported()) {
      throw new Error("WebGL is not supported in this browser environment");
    }

    // Measure parent container
    const width = this.canvas.parentElement.clientWidth || 420;
    const height = 480;

    this.app = new PIXI.Application({
      view: this.canvas,
      width: width,
      height: height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: "high-performance"
    });

    this.app.ticker.maxFPS = 60;
  }

  async loadModel() {
    const PIXI = window.PIXI;
    const modelUrl = "./live2d/model/model.model3.json";

    this.model = await PIXI.live2d.Live2DModel.from(modelUrl, {
      autoUpdate: true,
      autoInteract: false // We handle custom interaction tracking
    });

    this.app.stage.addChild(this.model);

    this.fitModel();

    // Start idle motion
    this.playMotion("Idle");
  }

  fitModel() {
    if (!this.model || !this.app) return;
    
    const stageWidth = this.app.renderer.width / this.app.renderer.resolution;
    const stageHeight = this.app.renderer.height / this.app.renderer.resolution;

    this.model.anchor.set(0.5, 0.5);
    this.model.x = stageWidth / 2;
    this.model.y = stageHeight / 2 + 10;

    // Scale to show waist up / bust
    const scale = (stageHeight * 0.95) / (this.model.internalModel.height || 1536);
    this.model.scale.set(scale * 1.55);
  }

  bindInteractions() {
    if (!this.model) return;

    // WebGL Context Lost Protection (Recommended by Jev)
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      console.warn("⚠️ [Live2D] WebGL context lost, pausing render ticker.");
      if (this.app?.ticker) this.app.ticker.stop();
    }, false);

    this.canvas.addEventListener("webglcontextrestored", () => {
      console.log("🔄 [Live2D] WebGL context restored, restarting viewer.");
      if (this.app?.ticker) this.app.ticker.start();
      this.fitModel();
    }, false);

    // Smooth cursor follow
    window.addEventListener("pointermove", (e) => {
      if (!this.model) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const y = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);

      // Clamp values between -1 and 1
      const targetX = Math.max(-1, Math.min(1, x));
      const targetY = Math.max(-1, Math.min(1, y));

      if (this.model.focus) {
        this.model.focus(e.clientX, e.clientY);
      }
    });

    // Tap/Click reactions
    this.canvas.addEventListener("click", () => {
      this.onTap();
    });

    // Resize handler
    window.addEventListener("resize", () => {
      if (!this.app || !this.canvas.parentElement) return;
      const width = this.canvas.parentElement.clientWidth || 420;
      this.app.renderer.resize(width, 480);
      this.fitModel();
    });
  }

  onTap() {
    if (!this.model) return;
    const motions = ["Nod", "Shake", "Blink", "Idle"];
    const chosen = motions[Math.floor(Math.random() * motions.length)];
    this.playMotion(chosen);
    
    // Voice line trigger
    if (window.tapPiChan) {
      window.tapPiChan(chosen);
    }
  }

  playMotion(name) {
    if (!this.model || !this.model.motion) return;
    try {
      this.model.motion(name);
    } catch (e) {
      console.warn("Motion trigger notice:", e);
    }
  }

  setExpression(name) {
    if (!this.model || !this.model.expression) return;
    try {
      this.model.expression(name);
    } catch (e) {}
  }
}

window.PiChanLive2D = PiChanLive2D;
