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
} from "cesium";
import RBush from "rbush";

/* ---------------- Tunables ---------------- */
const RADIUS_M = 700;
const HIGH_DISTANCE = 70;
const MEDIUM_DISTANCE = 200;
const MOVE_THRESHOLD = 50;
const STABLE_DELAY = 400;
const MAX_CONCURRENT = 3;
const QUEUE_THROTTLE_MS = 8;

/* ---------------- Helpers ---------------- */
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
  matrix?: Matrix4; // cached for reuse if not facing camera
};

export class TreeLoadScheduler {
  private scene: Scene;
  private index = new RBush<any>();
  private all = new Map<string, TreeMeta>();
  private live = new Map<string, LiveTree>();
  private queue: TreeMeta[] = [];
  private loading = 0;
  private pauseQueue = false;
  private lock = false;

  private visible = true;

  private lastLon?: number;
  private lastLat?: number;
  private moving = false;
  private stableTimer?: number;

  private hud = document.createElement("div");

  constructor(scene: Scene) {
    this.scene = scene;
    this.scene.camera.moveStart.addEventListener(this.onMove);
    this.createHUD();
  }

  addTrees(metas: TreeMeta[]) {
    metas.forEach(meta => this.all.set(meta.fid, meta));

    const items = metas.map(meta => ({
      minX: meta.lon,
      minY: meta.lat,
      maxX: meta.lon,
      maxY: meta.lat,
      t: meta
    }));

    this.index.load(items);
  }


  start() {
    this.updateLOD();
  }

  destroy() {
    this.scene.camera.moveStart.removeEventListener(this.onMove);

    // Batch removal
    const modelsToRemove = Array.from(this.live.values()).map(l => l.model);
    for (const m of modelsToRemove) {
      this.scene.primitives.remove(m);
      if (!m.isDestroyed()) m.destroy();
    }
    this.live.clear();
    this.hud.remove();
  }

  public setVisible(visible: boolean) {
  this.visible = visible;

  for (const { model } of this.live.values()) {
    model.show = visible;
  }
}


  /* ---------------- Camera ---------------- */
private onMove = () => {
  this.moving = true;
  clearTimeout(this.stableTimer);
  this.stableTimer = window.setTimeout(() => {
    this.moving = false;
    this.updateLOD(); // trigger LOD update when camera stops moving
  }, STABLE_DELAY);
};


  /* ---------------- LOD ---------------- */
  private updateLOD() {
    console.log(this.visible)
    if (!this.visible) return;
    if (this.lock || this.moving) return;
    this.lock = true;

    const camCart = Cartographic.fromCartesian(this.scene.camera.positionWC);
    const camLon = CesiumMath.toDegrees(camCart.longitude);
    const camLat = CesiumMath.toDegrees(camCart.latitude);
    const camHeight = camCart.height || 0;

    if (
      this.lastLon !== undefined &&
      this.lastLat !== undefined &&
      this.distance(camLon, camLat, this.lastLon, this.lastLat) < MOVE_THRESHOLD
    ) {
      this.lock = false;
      return;
    }

    this.lastLon = camLon;
    this.lastLat = camLat;

    const deg = RADIUS_M / 111320;
    const bbox = { minX: camLon - deg, minY: camLat - deg, maxX: camLon + deg, maxY: camLat + deg };

    const hits = this.index
      .search(bbox)
      .map((r: any) => {
        const horizontal = this.distance(camLon, camLat, r.t.lon, r.t.lat);
        const vertical = r.t.height ?? 0;
        return { t: r.t, horizontal, vertical };
      })
      // Keep only trees inside the cylinder
      .filter(h => h.horizontal <= RADIUS_M && h.vertical >= camHeight - RADIUS_M);

    const keep = new Set(hits.map(h => h.t.fid));

    // Batch remove far/out-of-cylinder trees
    const removeModels: Model[] = [];
    for (const [fid, item] of this.live.entries()) {
      if (!keep.has(fid)) {
        this.scene.primitives.remove(item.model);
        if (!item.model.isDestroyed()) item.model.destroy();
        this.live.delete(fid);
      }
    }
    for (const m of removeModels) {
      this.scene.primitives.remove(m);
      if (!m.isDestroyed()) m.destroy();
    }

    // Queue new/updated LODs
    const newQueue: TreeMeta[] = [];
    const queued = new Set<string>();

    for (const { t, horizontal: d } of hits) {
      let url = t.urlLow;
      let faceCamera = false;

      if (d < HIGH_DISTANCE) url = t.urlHigh || url;
      else if (d < MEDIUM_DISTANCE) url = t.urlMedium || url;
      else faceCamera = true; // low-poly single-faced

      const existing = this.live.get(t.fid);
      if (existing?.url === url) {
        // Reuse matrix if not facing camera
        if (existing && !faceCamera && existing.matrix) {
          existing.model.modelMatrix = existing.matrix;
        } else if (existing && faceCamera) {
          const m = this.buildMatrix(t, faceCamera, camCart);
          existing.model.modelMatrix = m;
          if (!faceCamera) existing.matrix = m;
        }
        continue;
      }

      if (!queued.has(t.fid)) {
        newQueue.push({ ...t, url, faceCamera });
        queued.add(t.fid);
      }
    }

    this.queue = newQueue;
    this.scheduleQueueRunner();
    this.processQueue();
    this.lock = false;
  }

  /* ---------------- Loading ---------------- */
  private queueRunnerScheduled = false;

  private scheduleQueueRunner() {
    if (this.queueRunnerScheduled) return;
    this.queueRunnerScheduled = true;
    requestAnimationFrame(() => {
      this.queueRunnerScheduled = false;
      this.processQueue();
      // Reschedule if queue still has items
      if (this.queue.length > 0 && !this.pauseQueue) this.scheduleQueueRunner();
    });
  }

  private async processQueue() {
    if (this.pauseQueue) return;

    while (this.queue.length && this.loading < MAX_CONCURRENT) {
      const t = this.queue.shift()!;
      this.loading++;
      this.loadTree(t)
        .catch(() => {})
        .finally(() => {
          this.loading--;
          // Throttle next load to prevent spikes
          setTimeout(() => this.processQueue(), QUEUE_THROTTLE_MS);
        });
    }
  }

  private async loadTree(t: TreeMeta & { faceCamera?: boolean }) {
    const resource = new Resource({ url: t.url! });
    const model = await Model.fromGltfAsync({
      url: resource,
      modelMatrix: this.buildMatrix(t, t.faceCamera),
      allowPicking: false,
      asynchronous: true
    });

    model.show = this.visible;
    this.scene.primitives.add(model);

    this.live.set(t.fid, { model, url: t.url!, matrix: t.faceCamera ? undefined : model.modelMatrix });
  }

  /* ---------------- Helpers ---------------- */
  private buildMatrix(t: TreeMeta, faceCamera = false, camCart?: Cartographic) {
    const pos = Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);

    if (faceCamera && camCart) {
      const camPos = Ellipsoid.WGS84.cartographicToCartesian(camCart);
      const direction = Cartesian3.subtract(camPos, pos, new Cartesian3());
      let heading = Math.atan2(direction.y, direction.x);
      // heading += Math.PI / 6; // rotate 90 deg
      const hpr = new HeadingPitchRoll(heading, 0, 0);
      const m = Transforms.headingPitchRollToFixedFrame(pos, hpr, Ellipsoid.WGS84);
      return Matrix4.multiplyByScale(m, new Cartesian3(t.scale, t.scale, t.scale), new Matrix4());
    }

    const hpr = new HeadingPitchRoll(t.rot, 0, 0);
    const m = Transforms.headingPitchRollToFixedFrame(pos, hpr, Ellipsoid.WGS84);
    return Matrix4.multiplyByScale(m, new Cartesian3(t.scale, t.scale, t.scale), new Matrix4());
  }

  private distance(lon1: number, lat1: number, lon2: number, lat2: number) {
    const R = 6371008.8;
    const φ1 = CesiumMath.toRadians(lat1);
    const φ2 = CesiumMath.toRadians(lat2);
    const dφ = φ2 - φ1;
    const dλ = CesiumMath.toRadians(lon2 - lon1);
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
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
