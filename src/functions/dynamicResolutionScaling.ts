import * as Cesium from "cesium";
import WMSThrottler from "./WMSThrottler";

type GlobeLike = {
  setResolutionScale: (scale: number) => void;
};

interface State {
  scale: number;
  lastCheck: number;
  lastFPSLog: number;
  lastPitch: number;
  lowDetailUntil: number;
  renderIdleTimer: number | null;
  ewmaFrameTime: number;
  lastLodUpdate: number;
  cameraMoving: boolean;
  wmsThrottler?: WMSThrottler;
  lastAppliedScale: number;
  lastAppliedMSE: number;
  lastFrameTs: number;
  inLowDetailTilt: boolean;
}

export default function dynamicResolutionScaling(oGlobe: GlobeLike, scene: Cesium.Scene) {
  // ---------------------------------------
  // CONFIG
  // ---------------------------------------
  const dpr = Math.min(1, window.devicePixelRatio || 1);
  const cfg = {
    minScale: 0.7,
    maxScale: dpr,
    checkInterval: 500,
    fpsLogInterval: 5000,
    targetFPS: 30,
    deadbandFPS: 5,
    ewmaAlpha: 0.18,
    maxFrameTime: 50,
    tiltEnter: Cesium.Math.toRadians(1.8), 
    tiltExit: Cesium.Math.toRadians(1.2), 
    mseHigh: 3,
    mseLow: 6,
    lowDetailMinTime: 800,
    idleRenderDelay: 500,
    lodThrottleMs: 300,
    debugLogs: false,
    frustumFarCap: 2_000_000,
    requestMaxActive: 50,
    requestPerServerActive: 6,
    requestMaxContinuous: 12,
    requestPerServerContinuous: 4
  };

  // ---------------------------------------
  // STATE
  // ---------------------------------------
  const nowTs = performance.now();
  const state: State = {
    scale: dpr,
    lastCheck: nowTs,
    lastFPSLog: nowTs,
    lastPitch: scene.camera.pitch,
    lowDetailUntil: 0,
    renderIdleTimer: null,
    ewmaFrameTime: 0,
    lastLodUpdate: 0,
    cameraMoving: false,
    wmsThrottler: undefined,
    lastAppliedScale: -1,
    lastAppliedMSE: -1,
    lastFrameTs: nowTs,
    inLowDetailTilt: false
  };

  function applyResolutionScale(scale: number) {
    if (state.lastAppliedScale !== scale) {
      oGlobe.setResolutionScale(scale);
      state.lastAppliedScale = scale;
      if (scene.requestRenderMode) scene.requestRender();
    }
  }

  function applyMSE(mse: number) {
    if (state.lastAppliedMSE !== mse) {
      scene.globe.maximumScreenSpaceError = mse;
      state.lastAppliedMSE = mse;
      if (scene.requestRenderMode) scene.requestRender();
    }
  }

  applyResolutionScale(state.scale);

  // ---------------------------------------
  // LOW-END GPU DETECTION
  // ---------------------------------------
  function detectLowEndGPU(): boolean {
    const canvas = scene.canvas;
    const gl =
      (canvas.getContext("webgl2", { preserveDrawingBuffer: false }) as WebGL2RenderingContext | null) ||
      (canvas.getContext("webgl", { preserveDrawingBuffer: false }) as WebGLRenderingContext | null);

    if (!gl) return true;

    const onContextLost = (e: Event) => {
      e.preventDefault?.();
      console.warn("WebGL context lost");
    };
    canvas.removeEventListener("webglcontextlost", onContextLost as EventListener);
    canvas.addEventListener("webglcontextlost", onContextLost as EventListener, { passive: false });

    const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbgInfo
      ? String(gl.getParameter((dbgInfo as any).UNMASKED_RENDERER_WEBGL)).toLowerCase()
      : "";

    const lowEndKeywords = ["intel", "swiftshader", "llvmpipe", "mali", "adreno"];
    const okKeywords = ["angle", "hd"]; // heuristics

    return lowEndKeywords.some(k => renderer.includes(k)) && !okKeywords.some(k => renderer.includes(k));
  }

  const LOW_END = detectLowEndGPU();
  if (LOW_END) {
    cfg.minScale = 0.5;
    cfg.maxFrameTime = 35;
    cfg.tiltEnter = Cesium.Math.toRadians(2.2);
    cfg.tiltExit = Cesium.Math.toRadians(1.4);
    cfg.mseLow = 7;
    cfg.mseHigh = 2;
    cfg.idleRenderDelay = 300;
    if (cfg.debugLogs) console.warn("Low-end GPU detected → enabling low-end mode.");
  }

  if (LOW_END) {
    scene.highDynamicRange = false;
  }

  // ---------------------------------------
  // ACTIVE / IDLE RENDER MODE
  // ---------------------------------------
  function enableContinuousRender() {
    scene.requestRenderMode = false;
    state.cameraMoving = true;

    // Cesium.RequestScheduler.maximumRequests = cfg.requestMaxContinuous;
    // Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerContinuous;

    // applyResolutionScale(cfg.minScale);
    
    state.wmsThrottler?.pause?.();

    if (state.renderIdleTimer !== null) {
      clearTimeout(state.renderIdleTimer);
      state.renderIdleTimer = null;
    }
  }

  function scheduleIdle() {
    if (state.renderIdleTimer !== null) {
      clearTimeout(state.renderIdleTimer);
      state.renderIdleTimer = null;
    }
    state.renderIdleTimer = window.setTimeout(() => {
      scene.requestRenderMode = true;
      state.cameraMoving = false;

      Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
      Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;

      applyResolutionScale(state.scale);
      scene.requestRender();
      state.wmsThrottler?.resume?.();

      state.renderIdleTimer = null;
    }, cfg.idleRenderDelay);
  }

  scene.camera.moveStart.addEventListener(enableContinuousRender);
  scene.camera.moveEnd.addEventListener(scheduleIdle);
  scene.requestRenderMode = true;

  // ---------------------------------------
  // RESOLUTION SCALING (EWMA)
  // ---------------------------------------
  function updateResolution(now: number) {
    if (now - state.lastCheck < cfg.checkInterval || state.ewmaFrameTime <= 0) return;

    const fps = 1000 / state.ewmaFrameTime;
    const error = cfg.targetFPS - fps;
    const k = 0.0015;

    let step = -error * k;
    step = Cesium.Math.clamp(step, -0.05, 0.05);

    const lowerBand = cfg.targetFPS - cfg.deadbandFPS;
    const upperBand = cfg.targetFPS + cfg.deadbandFPS;

    let newScale = state.scale;
    if (fps < lowerBand && state.scale > cfg.minScale) {
      newScale = Math.max(cfg.minScale, state.scale + step);
    } else if (fps > upperBand && state.scale < cfg.maxScale) {
      newScale = Math.min(cfg.maxScale, state.scale + Math.abs(step));
    }

    if (newScale !== state.scale) {
      state.scale = newScale;
      if (!state.cameraMoving) {
        applyResolutionScale(state.scale);
      }
    }

    console.log(`FPS=${fps.toFixed(1)} scale=${state.scale.toFixed(3)} step=${step.toFixed(4)}`);
    if (cfg.debugLogs && now - state.lastFPSLog >= cfg.fpsLogInterval) {
    //   console.log(`FPS=${fps.toFixed(1)} scale=${state.scale.toFixed(3)} step=${step.toFixed(4)}`);
      state.lastFPSLog = now;
    }

    state.lastCheck = now;
  }

  // ---------------------------------------
  // TERRAIN LOD (tilt-based with throttle + hysteresis)
  // ---------------------------------------
  let enterFrames = 0;
  function updateTerrainLOD(now: number) {
    if (now - state.lastLodUpdate < cfg.lodThrottleMs) return;
    state.lastLodUpdate = now;

    const pitch = scene.camera.pitch;
    const tilt = -pitch + Cesium.Math.PI_OVER_TWO;
    const delta = Math.abs(pitch - state.lastPitch);
    state.lastPitch = pitch;

    const movedSignificantly = delta > Cesium.Math.toRadians(3);
    const enterTilt = cfg.tiltEnter;
    const exitTilt = cfg.tiltExit;

    // Enter low detail when tilted above enter threshold and camera is moving
    if (!state.inLowDetailTilt && tilt > enterTilt && movedSignificantly) {
      if (++enterFrames >= 2) {
        applyMSE(cfg.mseLow);
        state.inLowDetailTilt = true;
        state.lowDetailUntil = now + cfg.lowDetailMinTime;
        enterFrames = 0;
        return;
      }
    } else {
      enterFrames = 0;
    }

    // Leave low detail when tilt drops below exit threshold and min time elapsed
    if (state.inLowDetailTilt && tilt < exitTilt && now >= state.lowDetailUntil) {
      applyMSE(cfg.mseHigh);
      state.inLowDetailTilt = false;
    }
  }

  // ---------------------------------------
  // MAIN FRAME LOOP (postRender)
  // ---------------------------------------
  const onPostRender = () => {
    const now = performance.now();

    if (!state.cameraMoving && scene.requestRenderMode) {
      updateTerrainLOD(now);
      state.lastFrameTs = now;
      return;
    }

    const delta = now - state.lastFrameTs;
    state.lastFrameTs = now;
    if (delta > 0 && delta < cfg.maxFrameTime) {
      const a = cfg.ewmaAlpha;
      state.ewmaFrameTime = state.ewmaFrameTime > 0 ? (a * delta + (1 - a) * state.ewmaFrameTime) : delta;
    }

    updateResolution(now);
    updateTerrainLOD(now);
  };

  scene.postRender.addEventListener(onPostRender);

  // ---------------------------------------
  // OPTIONAL: expose a dispose function
  // ---------------------------------------
  return {
    dispose() {
      try {
        scene.camera.moveStart.removeEventListener(enableContinuousRender);
        scene.camera.moveEnd.removeEventListener(scheduleIdle);
        scene.postRender.removeEventListener(onPostRender);
        if (state.renderIdleTimer !== null) {
          clearTimeout(state.renderIdleTimer);
        }

        Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
        Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;
        applyResolutionScale(dpr);
        applyMSE(cfg.mseHigh);
      } catch {
      }
    }
  };
}