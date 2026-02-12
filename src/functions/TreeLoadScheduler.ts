import {
  Cartographic,
  Cartesian3,
  HeadingPitchRoll,
  Math as CesiumMath,
  Transforms,
  Model,
  Scene,
  Matrix4,
  Resource,
  BoundingSphere
} from "cesium";
import RBush from "rbush";

/* ---------------- Tunables ---------------- */
const RADIUS_M = 700;
const HIGH_DISTANCE = 70;
const MEDIUM_DISTANCE = 200;
const STABLE_DELAY = 400;
const MAX_CONCURRENT = 3;
const QUEUE_BATCH_SIZE = 5; // batch up to 5 trees per frame
const QUEUE_THROTTLE_MS = 8;

/* ---------------- Types ---------------- */
type LOD = "high" | "medium" | "low";

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
  matrixCache?: Partial<Record<LOD, Matrix4>>;
};

type QueueItem = {
  meta: TreeMeta;
  url: string;
  lod: LOD;
  version: number;
};

type LiveTree = {
  model: Model;
  url: string;
  lod: LOD;
};

/* ========================================================= */

export class TreeLoadScheduler {

    /**
     * Add an array of tree metadata to the scheduler's spatial index.
     */
    public addTrees(metas: TreeMeta[]) {
      for (const m of metas) {
        this.index.insert({
          minX: m.lon,
          minY: m.lat,
          maxX: m.lon,
          maxY: m.lat,
          t: m
        });
      }
    }
  private scene: Scene;

  private index = new RBush<any>();
  private live = new Map<string, LiveTree>();
  // Pool for reusing Model objects by url/lod
  private modelPool = new Map<string, Model[]>();

  private queue: QueueItem[] = [];
  private loading = 0;
  private visible = true;

  private moving = false;
  private stableTimer?: number;
  private lodVersion = 0;

  private hud = document.createElement("div");

  constructor(scene: Scene) {
    this.scene = scene;
    this.scene.camera.moveStart.addEventListener(this.onMove);
    this.createHUD();
  }


  /* ---------------- Public API ---------------- */

  start() {
    this.updateLOD();
  }

  destroy() {
    this.scene.camera.moveStart.removeEventListener(this.onMove);
    for (const { model } of this.live.values()) {
      this.scene.primitives.remove(model);
    }
    this.live.clear();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    for (const { model } of this.live.values()) {
      model.show = visible;
    }
    if (!visible) this.queue.length = 0;
  }

  /* ---------------- Camera ---------------- */

  private onMove = () => {
    this.moving = true;
    clearTimeout(this.stableTimer);
    this.stableTimer = window.setTimeout(() => {
      this.moving = false;
      this.updateLOD();
    }, STABLE_DELAY);
  };

  /* ---------------- LOD ---------------- */

  private updateLOD() {
    if (!this.visible) return;

    const camCart = Cartographic.fromCartesian(
      this.scene.camera.positionWC
    );
    const lon = CesiumMath.toDegrees(camCart.longitude);
    const lat = CesiumMath.toDegrees(camCart.latitude);
    const height = camCart.height || 0;

    const cam = this.scene.camera;
    const viewMatrix = cam.viewMatrix;
    let hits = this.queryTrees(lon, lat, height).filter(({ t }) => {
      const pos = Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);
      // Transform tree position to camera space
      const camSpace = Matrix4.multiplyByPoint(viewMatrix, pos, new Cartesian3());
      // Only consider trees in front of the camera (z < 0 in Cesium camera space)
      return camSpace.z < 0;
    });
    // Prioritize by distance (closest first)
    hits = hits.sort((a, b) => a.d - b.d);
    // Enforce max 2000 trees: keep only the closest 2000
    if (hits.length > 1000) {
      hits = hits.slice(0, 1000);
    }
    const keep = new Set(hits.map(h => h.t.fid));

    this.removeOutOfRange(keep);

    if (this.moving) return;

    this.enqueueMissing(hits);
    this.processQueue();
  }

  private queryTrees(lon: number, lat: number, height: number) {
    const deg = RADIUS_M / 111320;
    return this.index
      .search({
        minX: lon - deg,
        minY: lat - deg,
        maxX: lon + deg,
        maxY: lat + deg
      })
      .map((r: any) => {
        const d = this.distance(lon, lat, r.t.lon, r.t.lat);
        return { t: r.t as TreeMeta, d };
      })
      .filter(h => h.d <= RADIUS_M && (h.t.height ?? 0) >= height - RADIUS_M);
  }

  private resolveLOD(t: TreeMeta, d: number): { url: string; lod: LOD } {
    if (d < HIGH_DISTANCE)
      return { url: t.urlHigh ?? t.urlLow!, lod: "high" };
    if (d < MEDIUM_DISTANCE)
      return { url: t.urlMedium ?? t.urlLow!, lod: "medium" };
    return { url: t.urlLow!, lod: "low" };
  }

  // Deferred/unloading: remove trees in small batches for smoothness
  private removeOutOfRange(keep: Set<string>) {
    const toRemove: [string, LiveTree][] = [];
    for (const [fid, item] of this.live) {
      if (!keep.has(fid)) {
        toRemove.push([fid, item]);
      }
    }
    if (toRemove.length === 0) return;
    const BATCH_SIZE = 8; // You can make this configurable if needed
    const BATCH_DELAY = 16; // ms, for smoother cleanup (about one frame)
    let idx = 0;
    const removeBatch = () => {
      for (let i = 0; i < BATCH_SIZE && idx < toRemove.length; i++, idx++) {
        const [fid, item] = toRemove[idx];
        if (!item.model.isDestroyed?.()) {
          this.scene.primitives.remove(item.model);
          // Return to pool if not destroyed
          const poolKey = `${item.url}|${item.lod}`;
          if (!this.modelPool.has(poolKey)) this.modelPool.set(poolKey, []);
          this.modelPool.get(poolKey)!.push(item.model);
        }
        this.live.delete(fid);
      }
      if (idx < toRemove.length) {
        setTimeout(removeBatch, BATCH_DELAY);
      }
    };
    removeBatch();
  }

  private enqueueMissing(hits: any[]) {
    this.queue.length = 0;
    this.lodVersion++;
    const version = this.lodVersion;

    for (const { t, d } of hits) {
      const { url, lod } = this.resolveLOD(t, d);
      const existing = this.live.get(t.fid);

      if (existing && existing.url === url && existing.lod === lod) continue;

      this.queue.push({ meta: t, url, lod, version });
    }
  }

  /* ---------------- Loading ---------------- */

  private async processQueue() {
    // Batch up to QUEUE_BATCH_SIZE trees per frame
    let batch = 0;
    while (this.queue.length && this.loading < MAX_CONCURRENT && batch < QUEUE_BATCH_SIZE) {
      const item = this.queue.shift()!;
      this.loading++;
      batch++;
      this.loadTree(item)
        .catch(() => {})
        .finally(() => {
          this.loading--;
          setTimeout(() => this.processQueue(), QUEUE_THROTTLE_MS);
        });
    }
    // If more remain, schedule next batch
    if (this.queue.length && this.loading < MAX_CONCURRENT) {
      setTimeout(() => this.processQueue(), QUEUE_THROTTLE_MS);
    }
  }

  private async loadTree(item: QueueItem) {
    const matrix = this.getCachedMatrix(item.meta, item.lod);

    // Pool key by url+lod
    const poolKey = `${item.url}|${item.lod}`;
    let model: Model | undefined;
    if (this.modelPool.has(poolKey) && this.modelPool.get(poolKey)!.length > 0) {
      // Only use non-destroyed models from the pool
      while (this.modelPool.get(poolKey)!.length > 0) {
        const candidate = this.modelPool.get(poolKey)!.pop()!;
        if (!candidate.isDestroyed?.()) {
          model = candidate;
          model.modelMatrix = matrix;
          break;
        }
      }
    }
    if (!model) {
      model = await Model.fromGltfAsync({
        url: new Resource({ url: item.url }),
        modelMatrix: matrix,
        allowPicking: false,
        asynchronous: true
      });
    }

    // ❗ Abort outdated loads
    if (!this.visible || item.version !== this.lodVersion) {
      // Return model to pool if not used and not destroyed
      if (model && !model.isDestroyed?.()) {
        if (!this.modelPool.has(poolKey)) this.modelPool.set(poolKey, []);
        this.modelPool.get(poolKey)!.push(model);
      }
      return;
    }

    // ❗ Remove previous model for this tree
    const existing = this.live.get(item.meta.fid);
    if (existing) {
      if (!existing.model.isDestroyed?.()) {
        this.scene.primitives.remove(existing.model);
        // Return old model to pool if not destroyed
        const oldKey = `${existing.url}|${existing.lod}`;
        if (!this.modelPool.has(oldKey)) this.modelPool.set(oldKey, []);
        this.modelPool.get(oldKey)!.push(existing.model);
      }
    }
    if (existing && existing.lod === item.lod && existing.url === item.url) {
      return;
    }

    // Only add to scene if not destroyed
    if (!model.isDestroyed?.()) {
      this.scene.primitives.add(model);
    }

    this.live.set(item.meta.fid, {
      model,
      url: item.url,
      lod: item.lod
    });
  }


  /* ---------------- Matrix Cache ---------------- */

  private getCachedMatrix(t: TreeMeta, lod: LOD): Matrix4 {
    t.matrixCache ??= {};
    if (!t.matrixCache[lod]) {
      t.matrixCache[lod] = this.buildMatrix(t);
    }
    return t.matrixCache[lod]!;
  }

  private buildMatrix(t: TreeMeta): Matrix4 {
    const pos = Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);
    return Matrix4.multiplyByScale(
      Transforms.headingPitchRollToFixedFrame(
        pos,
        new HeadingPitchRoll(t.rot, 0, 0)
      ),
      new Cartesian3(t.scale, t.scale, t.scale),
      new Matrix4()
    );
  }

  /* ---------------- Helpers ---------------- */

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
