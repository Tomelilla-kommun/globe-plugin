
import * as Cesium from "cesium";

type GlobeLike = { setResolutionScale: (scale: number) => void };

interface State {
  scale: number;
  lastCheck: number;
  lastFPSLog: number;
  renderIdleTimer: number | null;
  ewmaFrameTime: number;
  cameraMoving: boolean;
  lastAppliedScale: number;
  lastFrameTs: number;
  lastFPS: number;
  initialized: boolean;
}

/**
 * Dynamic resolution scaling for Cesium globe performance optimization.
 * Adjusts resolution based on FPS while maintaining quality when idle.
 */
export default function dynamicResolutionScaling(
  oGlobe: GlobeLike,
  scene: Cesium.Scene,
  opts: { forceLowEnd?: boolean; forceHighEnd?: boolean; debugLogs?: boolean } = {}
) {
  const dpr = Math.min(1, window.devicePixelRatio || 1);

  const cfg = {
    minScale: 0.75,
    maxScale: dpr,
    checkInterval: 500,
    fpsLogInterval: 5000,
    targetFPS: 30,
    deadbandFPS: 5,
    ewmaAlpha: 0.18,
    maxFrameTime: 50,
    idleRenderDelay: 400,
    debugLogs: opts.debugLogs ?? false,
    requestMaxActive: 50,
    requestPerServerActive: 18,
    requestMaxContinuous: 18,
    requestPerServerContinuous: 6,
  };

  const state: State = {
    scale: dpr,
    lastCheck: performance.now(),
    lastFPSLog: performance.now(),
    renderIdleTimer: null,
    ewmaFrameTime: 0,
    cameraMoving: false,
    lastAppliedScale: -1,
    lastFrameTs: performance.now(),
    lastFPS: cfg.targetFPS,
    initialized: false,
  };

  // GPU Detection
  function detectLowEndGPU(): boolean {
    if (opts.forceLowEnd) return true;
    if (opts.forceHighEnd) return false;
    try {
      const gl = (scene as any).context?._gl || (scene as any)._context?._gl ||
        scene.canvas.getContext("webgl2") || scene.canvas.getContext("webgl");
      if (!gl) return true;
      const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = dbgInfo ? String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)).toLowerCase() : "";
      const lowEnd = ["swiftshader", "llvmpipe", "mali", "adreno", "basic", "sgx", "nouveau", "mesa"];
      const ok = ["angle", "hd", "uhd", "iris", "arc", "nvidia", "radeon", "apple", "geforce", "rtx", "gtx", "rx "];
      return lowEnd.some(k => renderer.includes(k)) && !ok.some(k => renderer.includes(k));
    } catch { return false; }
  }

  const LOW_END = detectLowEndGPU();

  if (LOW_END) {
    cfg.minScale = 0.8;
    cfg.maxScale = Math.min(1.1, dpr);
    cfg.idleRenderDelay = 300;
    cfg.requestMaxActive = 32;
    cfg.requestPerServerActive = 4;
    cfg.requestMaxContinuous = 8;
    cfg.requestPerServerContinuous = 2;
    scene.highDynamicRange = false;
  }

  function applyScale(scale: number) {
    if (state.lastAppliedScale !== scale) {
      oGlobe.setResolutionScale(scale);
      state.lastAppliedScale = scale;
      if (scene.requestRenderMode) scene.requestRender();
    }
  }

  // Apply initial scale
  state.scale = Cesium.Math.clamp(state.scale, cfg.minScale, cfg.maxScale);
  applyScale(state.scale);

  // Camera movement handlers
  function onMoveStart() {
    if (!state.initialized) return;
    scene.requestRenderMode = false;
    state.cameraMoving = true;
    Cesium.RequestScheduler.maximumRequests = cfg.requestMaxContinuous;
    Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerContinuous;
    if (LOW_END) applyScale(cfg.minScale);
    if (state.renderIdleTimer !== null) {
      clearTimeout(state.renderIdleTimer);
      state.renderIdleTimer = null;
    }
  }

  function onMoveEnd() {
    if (!state.initialized) return;
    if (state.renderIdleTimer !== null) clearTimeout(state.renderIdleTimer);
    state.renderIdleTimer = window.setTimeout(() => {
      scene.requestRenderMode = true;
      state.cameraMoving = false;
      Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
      Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;
      applyScale(state.scale);
      scene.requestRender();
      state.renderIdleTimer = null;
    }, cfg.idleRenderDelay);
  }

  scene.camera.moveStart.addEventListener(onMoveStart);
  scene.camera.moveEnd.addEventListener(onMoveEnd);
  scene.requestRenderMode = true;
  Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
  Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;

  // Resolution adjustment based on FPS
  function updateResolution(now: number) {
    if (now - state.lastCheck < cfg.checkInterval || state.ewmaFrameTime <= 0) return;
    state.lastCheck = now;

    const fps = 1000 / state.ewmaFrameTime;
    state.lastFPS = fps;

    const step = Cesium.Math.clamp((cfg.targetFPS - fps) * -0.002, -0.05, 0.05);
    const lowerBand = cfg.targetFPS - cfg.deadbandFPS;
    const upperBand = cfg.targetFPS + cfg.deadbandFPS;

    let newScale = state.scale;
    if (fps < lowerBand) {
      newScale = Math.max(cfg.minScale, state.scale + step);
    } else if (fps > upperBand) {
      newScale = Math.min(cfg.maxScale, state.scale + Math.abs(step));
    }

    if (newScale !== state.scale) {
      state.scale = newScale;
      if (!state.cameraMoving) applyScale(state.scale);
    }

    if (cfg.debugLogs && now - state.lastFPSLog >= cfg.fpsLogInterval) {
      console.log(`FPS=${fps.toFixed(1)} scale=${state.scale.toFixed(3)}`);
      state.lastFPSLog = now;
    }
  }

  // Main render loop
  let initFrames = 0;
  const onPostRender = () => {
    const now = performance.now();

    // Initialization delay to avoid NaN errors from olcs sync
    if (!state.initialized) {
      if (++initFrames < 30) return;
      try {
        const pos = scene.camera.position;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
        state.initialized = true;
      } catch { return; }
    }

    // Skip if idle
    if (!state.cameraMoving && scene.requestRenderMode) {
      state.lastFrameTs = now;
      return;
    }

    // Update EWMA frame time
    const delta = now - state.lastFrameTs;
    state.lastFrameTs = now;
    if (delta > 0 && delta < cfg.maxFrameTime) {
      state.ewmaFrameTime = state.ewmaFrameTime > 0
        ? cfg.ewmaAlpha * delta + (1 - cfg.ewmaAlpha) * state.ewmaFrameTime
        : delta;
    }

    updateResolution(now);
  };

  scene.postRender.addEventListener(onPostRender);

  return {
    setDebugLogs(enabled: boolean) { cfg.debugLogs = enabled; },
    getStats() {
      return { fps: state.lastFPS, scale: state.scale, isLowEnd: LOW_END };
    },
    dispose() {
      scene.camera.moveStart.removeEventListener(onMoveStart);
      scene.camera.moveEnd.removeEventListener(onMoveEnd);
      scene.postRender.removeEventListener(onPostRender);
      if (state.renderIdleTimer !== null) clearTimeout(state.renderIdleTimer);
      Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
      Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;
      applyScale(dpr);
    },
  };
}
