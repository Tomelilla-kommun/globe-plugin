import * as Cesium from "cesium";
import WMSThrottler from "./WMSThrottler";

export default function dynamicResolutionScaling(oGlobe: any, scene: Cesium.Scene) {

    /* ------------------------------------------------------------------
     * CONFIG
     * ------------------------------------------------------------------ */
    const cfg = {
        minScale: 0.5,
        maxScale: Math.min(1, window.devicePixelRatio),
        checkInterval: 500,
        fpsLogInterval: 5000,
        maxFrameSamples: 30,
        maxFrameTime: 50,
        tiltThreshold: Cesium.Math.toRadians(1.5),
        mseHigh: 0,
        mseLow: 8,
        lowDetailMinTime: 800,
        pointerMaxMs: 120,
        idleRenderDelay: 300,
        frameSkipThreshold: 42,
        lodThrottleMs: 50, // step 2: throttle LOD updates
    };
    /* ------------------------------------------------------------------
     * STATE
     * ------------------------------------------------------------------ */
    let state = {
        scale: 0.9,
        lastFrame: performance.now(),
        lastCheck: performance.now(),
        lastFPSLog: performance.now(),
        lastPitch: scene.camera.pitch,
        lowDetailUntil: 0,
        pointerBusy: false,
        frameTimes: [] as number[],
        frameTimeSum: 0,
        renderIdleTimer: null as any,
        skipNextFrame: false,
        wmsQueue: [] as Function[],
        wmsActive: 0,
        lastWmsTime: 0,
        lastLodUpdate: 0,          // step 2: throttle LOD
        cameraMoving: false,        // step 1 & 4
        wmsThrottler: undefined as undefined | WMSThrottler, // Added property
    };

    oGlobe.setResolutionScale(state.scale);

    /* ------------------------------------------------------------------
     * LOW-END GPU DETECTION
     * ------------------------------------------------------------------ */
    function detectLowEndGPU(): boolean {
        const gl = scene.canvas.getContext("webgl2") || scene.canvas.getContext("webgl");
        if (!gl) return true;

        const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = dbgInfo
            ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL).toLowerCase()
            : "";

        // Known low-end indicators
        const lowEndKeywords = [
            "intel",        // old iGPUs
            "swiftshader",  // CPU fallback
            "llvmpipe",
            "mali",
            "adreno"
        ];

        // Modern ANGLE / D3D translations are fine; don't count as low-end
        // Exclude 'angle' and 'hd' from the low-end list
        return lowEndKeywords.some(k => renderer.includes(k));
    }

    const LOW_END = detectLowEndGPU();
    if (LOW_END) {
        cfg.minScale = 0.5;
        // cfg.maxScale = Math.min(0.9, window.devicePixelRatio);
        cfg.maxFrameTime = 35;
        cfg.maxFrameSamples = 20;
        cfg.tiltThreshold = Cesium.Math.toRadians(2.0);
        cfg.mseLow = 10;
        cfg.mseHigh = 2;
        cfg.pointerMaxMs = 80;
        cfg.idleRenderDelay = 300;
        console.warn("⚠ Low-end GPU detected → enabling low-end mode.");
    }

    /* ------------------------------------------------------------------
     * ACTIVE / IDLE RENDER MODE + camera movement tracking
     * ------------------------------------------------------------------ */
    function enableContinuousRender() {
        scene.requestRenderMode = false;
        clearTimeout(state.renderIdleTimer);
        state.cameraMoving = true;

        // Step 1: temporarily reduce resolution & pause WMS
        oGlobe.setResolutionScale(cfg.minScale);
        state.wmsThrottler?.pause?.();
    }

    function scheduleIdle() {
        clearTimeout(state.renderIdleTimer);
        state.renderIdleTimer = setTimeout(() => {
            scene.requestRenderMode = true;
            scene.requestRender();
            state.cameraMoving = false;

            // Step 1: restore resolution & resume WMS
            oGlobe.setResolutionScale(state.scale);
            state.wmsThrottler?.resume?.();
        }, cfg.idleRenderDelay);
    }

    scene.camera.moveStart.addEventListener(enableContinuousRender);
    scene.camera.moveEnd.addEventListener(scheduleIdle);
    scene.requestRenderMode = true;

    /* ------------------------------------------------------------------
     * RESOLUTION SCALING (running sum)
     * ------------------------------------------------------------------ */
    function updateResolution(now: number) {
        if (now - state.lastCheck < cfg.checkInterval || state.frameTimes.length === 0) return;

        const avg = state.frameTimeSum / state.frameTimes.length;
        const fps = 1000 / avg;

        if (fps < 25 && state.scale > cfg.minScale) {
            state.scale = Math.max(cfg.minScale, state.scale - 0.05);
            if (!state.cameraMoving) oGlobe.setResolutionScale(state.scale);
        } else if (fps > 55 && state.scale < cfg.maxScale) {
            state.scale = Math.min(cfg.maxScale, state.scale + 0.05);
            if (!state.cameraMoving) oGlobe.setResolutionScale(state.scale);
        }

        if (now - state.lastFPSLog >= cfg.fpsLogInterval) {
            console.log(`FPS=${fps.toFixed(1)} scale=${state.scale}`);
            state.lastFPSLog = now;
        }

        state.lastCheck = now;
    }

    /* ------------------------------------------------------------------
     * TERRAIN LOD (tilt-based with throttle)
     * ------------------------------------------------------------------ */
    function updateTerrainLOD(now: number) {
        if (now - state.lastLodUpdate < cfg.lodThrottleMs) return; // step 2
        state.lastLodUpdate = now;

        const pitch = scene.camera.pitch;
        const delta = Math.abs(pitch - state.lastPitch);
        state.lastPitch = pitch;

        if (delta > cfg.tiltThreshold) {
            scene.globe.maximumScreenSpaceError = cfg.mseLow;
            state.lowDetailUntil = now + cfg.lowDetailMinTime;
            state.skipNextFrame = true;
            return;
        }

        if (now < state.lowDetailUntil) return;
        scene.globe.maximumScreenSpaceError = cfg.mseHigh;
    }

    /* ------------------------------------------------------------------
     * MAIN FRAME LOOP (postRender, skip if camera stationary)
     * ------------------------------------------------------------------ */
    scene.postRender.addEventListener(() => {
        const now = performance.now();
        const delta = now - state.lastFrame;
        state.lastFrame = now;

        if (state.skipNextFrame) {
            state.skipNextFrame = false;
            return;
        }

        // step 4: skip frame logic if camera not moving
        if (!state.cameraMoving && delta > cfg.frameSkipThreshold) return;

        if (delta < cfg.maxFrameTime) {
            state.frameTimes.push(delta);
            state.frameTimeSum += delta;
            if (state.frameTimes.length > cfg.maxFrameSamples) {
                state.frameTimeSum -= state.frameTimes.shift()!;
            }
        }

        updateResolution(now);
        updateTerrainLOD(now);
    });

    /* ------------------------------------------------------------------
     * POINTER THROTTLING (requestAnimationFrame)
     * ------------------------------------------------------------------ */
    let pointerPending = false;
    scene.canvas.addEventListener("pointermove", () => {
        if (pointerPending) return;
        pointerPending = true;

        requestAnimationFrame(() => {
            // Place your pointer logic here
            pointerPending = false;
        });
    });
}