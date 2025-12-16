import {
  Cartographic,
  Cartesian3,
  HeadingPitchRoll,
  Math as CesiumMath,
  Transforms,
  Model,
  Scene,
  Matrix4,
  Resource
} from "cesium";
import RBush from "rbush";

/* ---------------- Tunables ---------------- */
const RADIUS_M = 700;
const HIGH_DISTANCE = 70;
const MEDIUM_DISTANCE = 200;
const STABLE_DELAY = 400;
const MAX_CONCURRENT = 3;
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
  private scene: Scene;

  private index = new RBush<any>();
  private live = new Map<string, LiveTree>();

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

  addTrees(metas: TreeMeta[]) {
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

    const hits = this.queryTrees(lon, lat, height);
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

  private removeOutOfRange(keep: Set<string>) {
    for (const [fid, item] of this.live) {
      if (!keep.has(fid)) {
        this.scene.primitives.remove(item.model);
        this.live.delete(fid);
      }
    }
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
    while (this.queue.length && this.loading < MAX_CONCURRENT) {
      const item = this.queue.shift()!;
      this.loading++;

      this.loadTree(item)
        .catch(() => {})
        .finally(() => {
          this.loading--;
          setTimeout(() => this.processQueue(), QUEUE_THROTTLE_MS);
        });
    }
  }

private async loadTree(item: QueueItem) {
  const matrix = this.getCachedMatrix(item.meta, item.lod);

  const model = await Model.fromGltfAsync({
    url: new Resource({ url: item.url }),
    modelMatrix: matrix,
    allowPicking: false,
    asynchronous: true
  });

  // ❗ Abort outdated loads
  if (!this.visible || item.version !== this.lodVersion) {
    return;
  }

  // ❗ Remove previous model for this tree
  const existing = this.live.get(item.meta.fid);
  if (existing) {
    this.scene.primitives.remove(existing.model);
  }
  if (existing && existing.lod === item.lod && existing.url === item.url) {
    return;
  }

  this.scene.primitives.add(model);

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
