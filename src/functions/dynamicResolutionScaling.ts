import * as Cesium from "cesium";

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
  lastAppliedScale: number;
  lastAppliedMSE: number;
  lastFrameTs: number;
  inLowDetailTilt: boolean;
  adaptiveAlpha: number;
  lastVolatility: number;
  lastFPS: number;
  lodFrameCounter: number;
  mseTransition?: { from: number; to: number; start: number; duration: number };
  frustumFarBase?: number;
}

/**
 * @param oGlobe
 * @param scene
 * @param opts Optional overrides: { forceLowEnd?: boolean, forceHighEnd?: boolean, debugLogs?: boolean }
 */
export default function dynamicResolutionScaling(
  oGlobe: GlobeLike,
  scene: Cesium.Scene,
  opts: { forceLowEnd?: boolean; forceHighEnd?: boolean; debugLogs?: boolean } = {}
) {
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
    mseHigh: 0,
    mseLow: 4,
    lowDetailMinTime: 800,
    idleRenderDelay: 500,
    lodThrottleMs: 300,
    debugLogs: opts.debugLogs ?? false,
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
    lastAppliedScale: -1,
    lastAppliedMSE: -1,
    lastFrameTs: nowTs,
    inLowDetailTilt: false,
    adaptiveAlpha: cfg.ewmaAlpha,
    lastVolatility: 0,
    lastFPS: cfg.targetFPS,
    lodFrameCounter: 0
  };

  function applyResolutionScale(scale: number) {
    if (state.lastAppliedScale !== scale) {
      oGlobe.setResolutionScale(scale);
      state.lastAppliedScale = scale;
      if (scene.requestRenderMode) scene.requestRender();
    }
  }

  function applyMSE(mse: number) {
    if (!LOW_END || state.lastAppliedMSE === -1) {
      if (state.lastAppliedMSE !== mse) {
        scene.globe.maximumScreenSpaceError = mse;
        state.lastAppliedMSE = mse;
        state.mseTransition = undefined;
        if (scene.requestRenderMode) scene.requestRender();
      }
      return;
    }

    const current = state.mseTransition ? scene.globe.maximumScreenSpaceError : state.lastAppliedMSE;
    if (Math.abs(current - mse) < 0.01) {
      state.mseTransition = undefined;
      state.lastAppliedMSE = mse;
      return;
    }

    state.mseTransition = {
      from: current,
      to: mse,
      start: performance.now(),
      duration: 250
    };
    if (scene.requestRenderMode) scene.requestRender();
  }

  function stepMseTransition(now: number) {
    if (!state.mseTransition) return;
    const { from, to, start, duration } = state.mseTransition;
    const t = Cesium.Math.clamp((now - start) / duration, 0, 1);
    const value = Cesium.Math.lerp(from, to, t);
    scene.globe.maximumScreenSpaceError = value;
    if (t >= 1) {
      state.mseTransition = undefined;
      state.lastAppliedMSE = to;
    }
  }

  function applyDynamicFrustumCap() {
    if (!LOW_END) return;
    const frustum = scene.camera.frustum as Cesium.PerspectiveFrustum | Cesium.OrthographicFrustum;
    if (!frustum || typeof frustum.far !== "number") return;
    const height = scene.camera.positionCartographic?.height ?? 0;
    const dynamicCap = Cesium.Math.clamp(height * 6, 250_000, cfg.frustumFarCap);
    if (frustum.far !== dynamicCap) {
      frustum.far = dynamicCap;
    }
  }

  function adjustAdaptiveAlpha(volatility: number) {
    let nextAlpha = state.adaptiveAlpha;
    if (volatility > 10) nextAlpha = Math.min(0.3, nextAlpha + 0.05);
    else if (volatility < 2) nextAlpha = Math.max(0.12, nextAlpha - 0.03);
    state.adaptiveAlpha = nextAlpha;
    state.lastVolatility = volatility;
    return nextAlpha;
  }

  applyResolutionScale(state.scale);

  // ---------------------------------------
  // LOW-END GPU DETECTION
  // ---------------------------------------
  function detectLowEndGPU(): boolean {
    if (opts.forceLowEnd) return true;
    if (opts.forceHighEnd) return false;
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
    const lowEndKeywords = ["intel", "swiftshader", "llvmpipe", "mali", "adreno", "basic", "sgx", "nouveau", "mesa"];
    const okKeywords = ["angle", "hd", "nvidia", "radeon", "apple"]; // improved heuristics
    return lowEndKeywords.some(k => renderer.includes(k)) && !okKeywords.some(k => renderer.includes(k));
  }

  const LOW_END = detectLowEndGPU();
  if (LOW_END) {
    cfg.minScale = 0.8;
    cfg.maxScale = Math.min(1.1, dpr);
    cfg.maxFrameTime = 35;
    cfg.tiltEnter = Cesium.Math.toRadians(2.2);
    cfg.tiltExit = Cesium.Math.toRadians(1.4);
    cfg.mseLow = 6;
    cfg.mseHigh = 0;
    cfg.idleRenderDelay = 300;
    cfg.requestMaxActive = 32;
    cfg.requestPerServerActive = 4;
    cfg.requestMaxContinuous = 8;
    cfg.requestPerServerContinuous = 2;
    cfg.frustumFarCap = 1_000_000;
    if (cfg.debugLogs) console.warn("Low-end GPU detected → enabling low-end mode.");
    scene.highDynamicRange = false;
  }

  if (state.scale > cfg.maxScale || state.scale < cfg.minScale) {
    state.scale = Cesium.Math.clamp(state.scale, cfg.minScale, cfg.maxScale);
    applyResolutionScale(state.scale);
  }

  state.frustumFarBase = (scene.camera.frustum as any)?.far;

  // ---------------------------------------
  // ACTIVE / IDLE RENDER MODE
  // ---------------------------------------
  function enableContinuousRender() {
    scene.requestRenderMode = false;
    state.cameraMoving = true;
    state.lodFrameCounter = 0;
    Cesium.RequestScheduler.maximumRequests = cfg.requestMaxContinuous;
    Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerContinuous;
    if (LOW_END) {
      applyResolutionScale(cfg.minScale);
    }

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
      state.lodFrameCounter = 0;

      Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
      Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;

      applyResolutionScale(state.scale);
      scene.requestRender();

      state.renderIdleTimer = null;
    }, cfg.idleRenderDelay);
  }

  scene.camera.moveStart.addEventListener(enableContinuousRender);
  scene.camera.moveEnd.addEventListener(scheduleIdle);
  scene.requestRenderMode = true;
  Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
  Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;

  // ---------------------------------------
  // RESOLUTION SCALING (EWMA)
  // ---------------------------------------
  // Adaptive EWMA alpha and dynamic debug logging
  function updateResolution(now: number) {
    if (now - state.lastCheck < cfg.checkInterval || state.ewmaFrameTime <= 0) return;

    const fps = 1000 / state.ewmaFrameTime;
    const error = cfg.targetFPS - fps;
    const volatility = Math.abs(fps - state.lastFPS);
    state.lastFPS = fps;
    const ewmaAlpha = adjustAdaptiveAlpha(volatility);

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

    if (cfg.debugLogs && now - state.lastFPSLog >= cfg.fpsLogInterval) {
      console.log(`FPS=${fps.toFixed(1)} scale=${state.scale.toFixed(3)} step=${step.toFixed(4)} alpha=${ewmaAlpha.toFixed(2)} volatility=${volatility.toFixed(2)}`);
      state.lastFPSLog = now;
    }

    state.lastCheck = now;
  }

  // ---------------------------------------
  // TERRAIN LOD (tilt-based with throttle + hysteresis)
  // ---------------------------------------
  let enterFrames = 0;
  function updateTerrainLOD(now: number) {
    if (LOW_END && state.cameraMoving) {
      state.lodFrameCounter += 1;
      if (state.lodFrameCounter % 3 !== 0) {
        return;
      }
    }
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
  // Dynamic idleRenderDelay based on recent camera activity
  let lastMoveEnd = performance.now();
  const onPostRender = () => {
    const now = performance.now();
    stepMseTransition(now);
    applyDynamicFrustumCap();

    if (!state.cameraMoving && scene.requestRenderMode) {
      updateTerrainLOD(now);
      state.lastFrameTs = now;
      // Gradually increase idleRenderDelay if camera is idle
      if (cfg.idleRenderDelay < 1200 && now - lastMoveEnd > 2000 && state.lastVolatility < 5) {
        cfg.idleRenderDelay += 50;
      }
      return;
    }

    const delta = now - state.lastFrameTs;
    state.lastFrameTs = now;
    if (delta > 0 && delta < cfg.maxFrameTime) {
      const ewmaAlpha = state.adaptiveAlpha;
      state.ewmaFrameTime = state.ewmaFrameTime > 0 ? (ewmaAlpha * delta + (1 - ewmaAlpha) * state.ewmaFrameTime) : delta;
    }

    updateResolution(now);
    updateTerrainLOD(now);
  };

  // Listen for camera moveEnd to reset idleRenderDelay
  const resetIdleDelay = () => {
    lastMoveEnd = performance.now();
    cfg.idleRenderDelay = LOW_END ? 300 : 500;
  };
  scene.camera.moveEnd.addEventListener(resetIdleDelay);

  scene.postRender.addEventListener(onPostRender);

  // ---------------------------------------
  // OPTIONAL: expose a dispose function
  // ---------------------------------------
  // Expose runtime debug logging toggle and robust cleanup
  return {
    setDebugLogs(enabled: boolean) {
      cfg.debugLogs = enabled;
    },
    dispose() {
      try {
        scene.camera.moveStart.removeEventListener(enableContinuousRender);
        scene.camera.moveEnd.removeEventListener(scheduleIdle);
        scene.camera.moveEnd.removeEventListener(resetIdleDelay);
        scene.postRender.removeEventListener(onPostRender);
        if (state.renderIdleTimer !== null) {
          clearTimeout(state.renderIdleTimer);
        }
        Cesium.RequestScheduler.maximumRequests = cfg.requestMaxActive;
        Cesium.RequestScheduler.maximumRequestsPerServer = cfg.requestPerServerActive;
        applyResolutionScale(dpr);
        applyMSE(cfg.mseHigh);
        if (typeof state.frustumFarBase === "number" && LOW_END) {
          const frustum = scene.camera.frustum as any;
          if (frustum && typeof frustum.far === "number") {
            frustum.far = state.frustumFarBase;
          }
        }
      } catch {
      }
    }
  };
}