import {
  Cartographic,
  Cartesian3,
  Ellipsoid,
  HeadingPitchRoll,
  Math as CesiumMath,
  Transforms,
  Model,
  ShadowMode,
  Scene,
  Matrix4,
  Resource,
  Request
} from "cesium";
import RBush from "rbush";

/* ---------------- Tunables ---------------- */

const RADIUS_M = 700;
const HIGH_DISTANCE = 120;
const MEDIUM_DISTANCE = 300;
const MOVE_THRESHOLD = 70;
const STABLE_DELAY = 500;
const MAX_CONCURRENT = 2;

/* ---------------- Types ---------------- */

type TreeMeta = {
  fid: string;
  lon: number;
  lat: number;
  height: number;
  scale: number;
  rot: number;
  urlHigh?: string;
  urlMedium?: string;
  urlLow?: string;
  url: string;
};

type LiveTree = {
  model: Model;
  url: string;
};

/* ====================================================== */

export class TreeLoadScheduler {
  private scene: Scene;
  private index = new RBush<any>();
  private all = new Map<string, TreeMeta>();
  private live = new Map<string, LiveTree>();

  private queue: TreeMeta[] = [];
  private loading = 0;

  private lastLon?: number;
  private lastLat?: number;
  private moving = false;
  private lock = false;

  private stableTimer?: number;

  /* ---------------- Debug HUD ---------------- */

  private hud = document.createElement("div");

  constructor(scene: Scene) {
    this.scene = scene;
    this.hookCamera();
    this.createHUD();
  }

  /* ---------------- Public API ---------------- */

  addTree(meta: TreeMeta) {
    this.all.set(meta.fid, meta);
    this.index.insert({
      minX: meta.lon,
      minY: meta.lat,
      maxX: meta.lon,
      maxY: meta.lat,
      t: meta
    });
  }

  start() {
    this.updateLOD();
  }

  destroy() {
    this.scene.camera.moveStart.removeEventListener(this.onMove);

    for (const { model } of this.live.values()) {
      try {
        this.scene.primitives.remove(model);
        if (!model.isDestroyed()) model.destroy();
      } catch {}
    }

    this.live.clear();
    this.hud.remove();
  }

  /* ---------------- Camera ---------------- */

  private hookCamera() {
    this.scene.camera.moveStart.addEventListener(this.onMove);
  }

  private onMove = () => {
    this.moving = true;

    if (this.stableTimer) clearTimeout(this.stableTimer);

    this.stableTimer = window.setTimeout(() => {
      this.moving = false;
      this.updateLOD();
    }, STABLE_DELAY);
  };

  /* ---------------- LOD ---------------- */

  private updateLOD() {
    if (this.lock || this.moving) return;
    this.lock = true;

    const cam = Cartographic.fromCartesian(this.scene.camera.positionWC);
    const lon = CesiumMath.toDegrees(cam.longitude);
    const lat = CesiumMath.toDegrees(cam.latitude);

    if (
      this.lastLon !== undefined &&
      this.lastLat !== undefined &&
      this.distance(lon, lat, this.lastLon, this.lastLat) < MOVE_THRESHOLD
    ) {
      this.lock = false;
      return;
    }

    this.lastLon = lon;
    this.lastLat = lat;

    const deg = RADIUS_M / 111320;
    const bbox = {
      minX: lon - deg,
      minY: lat - deg,
      maxX: lon + deg,
      maxY: lat + deg
    };

    const hits = this.index
      .search(bbox)
      .map((r: any) => ({
        t: r.t,
        d: this.distance(lon, lat, r.t.lon, r.t.lat)
      }))
      .filter(h => h.d <= RADIUS_M);

    const keep = new Set(hits.map(h => h.t.fid));

    /* --- Remove far trees (safe) --- */
    for (const [fid, item] of Array.from(this.live.entries())) {
      if (!keep.has(fid)) {
        try {
          this.scene.primitives.remove(item.model);
          if (!item.model.isDestroyed()) item.model.destroy();
        } catch {}
        this.live.delete(fid);
      }
    }

    /* --- Queue new / changed LODs --- */
    const queued = new Set<string>();
    const newQueue: TreeMeta[] = [];

    for (const h of hits) {
      const t = h.t;
      let url = t.urlLow;
      if (h.d < HIGH_DISTANCE) url = t.urlHigh || url;
      else if (h.d < MEDIUM_DISTANCE) url = t.urlMedium || url;

      const existing = this.live.get(t.fid);

      // Keep existing model
      if (existing && existing.url === url) {
        existing.model.modelMatrix = this.buildMatrix(t);
        continue;
      }

      // Replace model
      if (existing) {
        try {
          this.scene.primitives.remove(existing.model);
          if (!existing.model.isDestroyed()) existing.model.destroy();
        } catch {}
        this.live.delete(t.fid);
      }

      if (!queued.has(t.fid)) {
        newQueue.push({ ...t, url });
        queued.add(t.fid);
      }
    }

    this.queue = newQueue;
    this.processQueue();
    this.lock = false;
  }

  /* ---------------- Loading ---------------- */

  private async processQueue() {
    while (this.queue.length && this.loading < MAX_CONCURRENT) {
      const t = this.queue.shift()!;
      this.loading++;

      this.loadTree(t)
        .catch(() => {})
        .finally(() => {
          this.loading--;
          // 🔥 THIS IS THE MISSING LINE
          this.processQueue();
        });
    }
  }


  private async loadTree(t: TreeMeta) {
    const resource = new Resource({
      url: t.url!,
      request: new Request({
        throttle: true,
        priority: 100
      })
    });

    const model = await Model.fromGltfAsync({
      url: resource,
      modelMatrix: this.buildMatrix(t),
      allowPicking: false,
      asynchronous: true
    });

    model.shadows = ShadowMode.DISABLED;
    this.scene.primitives.add(model);
    this.live.set(t.fid, { model, url: t.url! });
  }

  /* ---------------- Helpers ---------------- */

  private buildMatrix(t: TreeMeta) {
    const pos = Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);
    const hpr = new HeadingPitchRoll(t.rot, 0, 0);
    const m = Transforms.headingPitchRollToFixedFrame(
      pos,
      hpr,
      Ellipsoid.WGS84
    );
    return Matrix4.multiplyByScale(
      m,
      new Cartesian3(t.scale, t.scale, t.scale),
      new Matrix4()
    );
  }

  private distance(lon1: number, lat1: number, lon2: number, lat2: number) {
    const R = 6371008.8;
    const φ1 = CesiumMath.toRadians(lat1);
    const φ2 = CesiumMath.toRadians(lat2);
    const dφ = φ2 - φ1;
    const dλ = CesiumMath.toRadians(lon2 - lon1);
    const a =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------------- Debug HUD ---------------- */

  private createHUD() {
    Object.assign(this.hud.style, {
      position: "absolute",
      top: "10px",
      left: "10px",
      background: "rgba(0,0,0,0.7)",
      color: "#0f0",
      fontFamily: "monospace",
      padding: "8px",
      zIndex: "9999",
      fontSize: "12px"
    });

    document.body.appendChild(this.hud);

    const update = () => {
      this.hud.innerHTML = `
  Trees live: ${this.live.size}<br>
  Queued: ${this.queue.length}<br>
  Loading: ${this.loading}<br>
  Camera moving: ${this.moving}<br>
        `;
      requestAnimationFrame(update);
    };

    update();
  }

}
