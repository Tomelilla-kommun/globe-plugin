import {
  Cartographic,
  Cartesian3,
  Ellipsoid,
  HeadingPitchRoll,
  Math as CesiumMath,
  Transforms,
  Model,
  sampleTerrainMostDetailed,
  ShadowMode,
  Scene,
  Matrix4
} from "cesium";
import GeoJSON from "ol/format/GeoJSON";
import RBush from "rbush";

// --- Tunables ------------------------------------------------
const RADIUS_M = 700;
const MEDIUM_DISTANCE = 300;
const HIGH_DISTANCE = 120;
const MOVE_THRESHOLD = 70;
const CHUNK_CREATE = 40; // smaller batches are smoother
const CAMERA_THROTTLE_MS = 250; // throttle updates while panning

// --- Fast distance (Haversine) --------------------------------
function dMeters(lon1: number, lat1: number, lon2: number, lat2: number) {
  const R = 6371008.8;
  const φ1 = CesiumMath.toRadians(lat1),
    φ2 = CesiumMath.toRadians(lat2);
  const dφ = φ2 - φ1;
  const dλ = CesiumMath.toRadians(lon2 - lon1);
  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Matrix Builder ------------------------------------------
function buildMatrix(t: any) {
  const pos = Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);
  const hpr = new HeadingPitchRoll(t.rot, 0, 0);
  const m = Transforms.headingPitchRollToFixedFrame(pos, hpr, Ellipsoid.WGS84);
  return Matrix4.multiplyByScale(
    m,
    new Cartesian3(t.scale, t.scale, t.scale),
    new Matrix4()
  );
}

// --- Visibility helper ---------------------------------------
function setVisible(item: any, on: boolean) {
  if (!item) return;
  if (item.type === "model" && item.model) {
    try {
      item.model.show = on;
    } catch (e) {}
  }
}

// -----------------------------------------------------------------------
export async function loadTreesIncremental(layer: any, scene: Scene, modelCfg: any) {
  const all = new Map<string, any>();
  const live = new Map<string, any>(); // fid -> { type:'model', model, url }
  const index = new RBush();
  const lodPools = new Map<string, Model>();

  // --- Fetch features from WFS -------------------------------
  const url = `${layer.get("dataSource")}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(
    layer.get("name")
  )}&outputFormat=application/json&srsName=EPSG:4326`;

  const gj = await (await fetch(url)).json();
  const feats = new GeoJSON().readFeatures(gj);

  const cartos: Cartographic[] = [];

  for (const f of feats) {
    const [lon, lat] = (f as any).getGeometry().getCoordinates();
    const spec = f.get(modelCfg.speciesAttr) || "_d";
    const set = modelCfg.species?.[spec];

    const meta = {
      fid: String(f.getId()),
      lon,
      lat,
      species: spec,
      // we store base LOD url; LOD selection happens later
      urlHigh: set?.high || modelCfg.high,
      urlMedium: set?.medium || modelCfg.medium,
      urlLow: set?.low || modelCfg.low,
      rot: CesiumMath.toRadians(Math.random() * 360),
      scale:
        (parseFloat(f.get(modelCfg.heightAttr || "")) || 1) /
        (set?.modelHeight || modelCfg.baseModelHeight || 1),
      height: 0
    };

    all.set(meta.fid, meta);
    index.insert({ minX: lon, minY: lat, maxX: lon, maxY: lat, t: meta });
    cartos.push(Cartographic.fromDegrees(lon, lat));
  }

  // --- Sample terrain once -----------------------------------
  if (cartos.length) {
    // sample in batches to avoid provider limits if huge
    const TERRAIN_BATCH = 200;
    for (let i = 0; i < cartos.length; i += TERRAIN_BATCH) {
      const slice = cartos.slice(i, i + TERRAIN_BATCH);
      await sampleTerrainMostDetailed(scene.terrainProvider, slice);
      // assign heights back to all
      for (let j = 0; j < slice.length; j++) {
        const c = slice[j];
        // find corresponding fid by coords (we preserved order earlier)
        // simpler: feats index matches cartos order
        const f = feats[i + j];
        const fid = String(f.getId());
        const t = all.get(fid);
        if (t) t.height = c.height;
      }
    }
  }

  // --- Preload LOD URLs (all species) ------------------------
  async function preloadLOD(url: string) {
    if (!url) return;
    if (!lodPools.has(url)) {
      const model = await Model.fromGltfAsync({ url, allowPicking: false });
      model.show = false;
      model.shadows = ShadowMode.DISABLED;
      scene.primitives.add(model);
      lodPools.set(url, model);
    }
  }

  // Gather all LOD URLs and preload (non-blocking serial)
  const lodUrls = new Set<string>();
  all.forEach((t) => {
    if (t.urlHigh) lodUrls.add(t.urlHigh);
    if (t.urlMedium) lodUrls.add(t.urlMedium);
    if (t.urlLow) lodUrls.add(t.urlLow);
  });
  for (const u of lodUrls) await preloadLOD(u);

  // --- createTree (simple, no post-check) -------------------
  async function createTree(t: any) {
    const model = await Model.fromGltfAsync({
      url: t.url,
      modelMatrix: buildMatrix(t),
      allowPicking: false
    });
    model.shadows = ShadowMode.DISABLED;
    model.show = true;
    scene.primitives.add(model);

    // register
    live.set(t.fid, { type: "model", model, url: t.url });
  }

  // --- queue + processing (sequential-ish, chunked per frame) --
  let treeQueue: any[] = [];
  let queueLock = false;

  async function processQueueSequential() {
    if (queueLock || treeQueue.length === 0) return;
    queueLock = true;

    while (treeQueue.length) {
      const batch = treeQueue.splice(0, CHUNK_CREATE);

      // sequential create per item inside batch to reduce parallel GPU uploads
      for (const t of batch) {
        // quick check: skip if already live with right url
        const existing = live.get(t.fid);
        if (existing && existing.url === t.url) {
          // update transform and ensure visible
          try {
            existing.model.modelMatrix = buildMatrix(t);
            existing.model.show = true;
          } catch (e) {}
          continue;
        }

        // pre-check distance (hybrid approach)
        const c = Cartographic.fromCartesian(scene.camera.positionWC);
        const camLon = CesiumMath.toDegrees(c.longitude);
        const camLat = CesiumMath.toDegrees(c.latitude);
        if (dMeters(camLon, camLat, t.lon, t.lat) > RADIUS_M) {
          // skip creating this one
          continue;
        }

        // create (no post-check)
        try {
          await createTree(t);
        } catch (e) {
          // continue and avoid breaking the queue on single model failure
        }
      }

      // yield to render loop
      await new Promise((r) => requestAnimationFrame(r));
    }

    queueLock = false;
  }

  // --- robust updateLOD -------------------------------------
  let lastLon: number | undefined = undefined;
  let lastLat: number | undefined = undefined;
  let lock = false;

  async function updateLOD() {
    if (lock) return;
    lock = true;

    const c = Cartographic.fromCartesian(scene.camera.positionWC);
    const lon = CesiumMath.toDegrees(c.longitude);
    const lat = CesiumMath.toDegrees(c.latitude);

    // movement threshold
    if (lastLon !== undefined && lastLat !== undefined) {
      if (dMeters(lon, lat, lastLon, lastLat) < MOVE_THRESHOLD) {
        lock = false;
        return;
      }
    }
    lastLon = lon;
    lastLat = lat;

    const terr = scene.globe.getHeight(c) || 0;
    const camAGL = c.height - terr;
    if (camAGL > RADIUS_M) {
      // camera far above, clear everything
      for (const [fid, item] of Array.from(live.entries())) {
        try {
          scene.primitives.remove(item.model);
          item.model.destroy?.();
        } catch (e) {}
        live.delete(fid);
      }
      treeQueue = [];
      lock = false;
      return;
    }

    // query RBush for candidates inside bounding box then precise filter
    const deg = RADIUS_M / 111320;
    const hits = index
      .search({ minX: lon - deg, minY: lat - deg, maxX: lon + deg, maxY: lat + deg })
      .map((r: any) => r.t)
      .filter((t: any) => {
        // precise meters
        return dMeters(lon, lat, t.lon, t.lat) <= RADIUS_M;
      });

    // build keep set
    const keep = new Set(hits.map((h: any) => h.fid));

    // remove live items not in keep (immediate removal + optional destroy)
    for (const [fid, item] of Array.from(live.entries())) {
      if (!keep.has(fid)) {
        try {
          scene.primitives.remove(item.model);
          item.model.destroy?.();
        } catch (e) {}
        live.delete(fid);
      }
    }

    // build new queue (deduped) for items that need creation or LOD change
    const queued = new Set<string>();
    const newQueue: any[] = [];

    for (const t of hits) {
      const dist = dMeters(lon, lat, t.lon, t.lat);

      // choose LOD URL
      let lodUrl = t.urlLow || modelCfg.low;
      if (dist < HIGH_DISTANCE) lodUrl = t.urlHigh || modelCfg.high;
      else if (dist < MEDIUM_DISTANCE) lodUrl = t.urlMedium || modelCfg.medium;

      // annotate target url on the temporary tree object
      const qItem = { ...t, url: lodUrl };

      const item = live.get(t.fid);
      if (!item) {
        if (!queued.has(t.fid)) {
          newQueue.push(qItem);
          queued.add(t.fid);
        }
      } else {
        // LOD changed?
        if (item.url !== lodUrl) {
          // remove old model immediately
          try {
            scene.primitives.remove(item.model);
            item.model.destroy?.();
          } catch (e) {}
          live.delete(t.fid);

          if (!queued.has(t.fid)) {
            newQueue.push(qItem);
            queued.add(t.fid);
          }
        } else {
          // same LOD, just update transform & ensure visible
          try {
            item.model.modelMatrix = buildMatrix(t);
            item.model.show = true;
          } catch (e) {}
        }
      }
    }

    // replace queue and start processing
    treeQueue = newQueue;
    processQueueSequential();

    lock = false;
  }

  // throttle + attach camera
  let lastUpdate = 0;
  scene.camera.changed.addEventListener(() => {
    const now = performance.now();
    if (now - lastUpdate > CAMERA_THROTTLE_MS) {
      lastUpdate = now;
      updateLOD();
    }
  });

  // initial pass
  updateLOD();
}
