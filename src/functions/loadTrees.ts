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
const CHUNK_CREATE = 100;

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
    item.model.show = on;
  }
}

// -----------------------------------------------------------------------
export async function loadTreesIncremental(layer: any, scene: Scene, modelCfg: any) {
  const all = new Map<string, any>();
  const live = new Map<string, any>();
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
      fid: f.getId(),
      lon,
      lat,
      species: spec,
      url: set?.high || modelCfg.high,
      rot: CesiumMath.toRadians(Math.random() * 360),
      scale:
        (parseFloat(f.get(modelCfg.heightAttr || "")) || 1) /
        (set?.modelHeight || modelCfg.baseModelHeight || 1),
      height: 0
    };
    all.set(String(meta.fid), meta);
    index.insert({ minX: lon, minY: lat, maxX: lon, maxY: lat, t: meta });

    cartos.push(Cartographic.fromDegrees(lon, lat));
  }

  // --- Sample terrain once -----------------------------------
  // --- Sample terrain once -----------------------------------
  const heights = await sampleTerrainMostDetailed(scene.terrainProvider, cartos);
  feats.forEach((f, i) => {
    const fid = f.getId();
    const t = all.get(String(fid));
    t.height = heights[i].height;
  });

  // --- Preload all LOD URLs ----------------------------------
  const urls = new Set<string>();
  all.forEach(t => urls.add(t.url));
  for (const url of urls) {
    await preloadLOD(url);
  }

  // --- Chunked creation / LOD updates will follow ----------


  // --- Preload model once per URL ---------------------------
  async function preloadLOD(url: string) {
    if (!lodPools.has(url)) {
      const model = await Model.fromGltfAsync({ url, allowPicking: false });
      model.show = false;
      model.shadows = ShadowMode.DISABLED;
      scene.primitives.add(model);
      lodPools.set(url, model);
    }
  }

  // --- Clone preloaded model -------------------------------
  async function createTree(t: any) {
    const url = t.url;

    // Make sure the model is preloaded (optional)
    await preloadLOD(url);

    const model = await Model.fromGltfAsync({
      url,
      modelMatrix: buildMatrix(t),
      allowPicking: false
    });

    model.shadows = ShadowMode.DISABLED;
    model.show = true;
    scene.primitives.add(model);

    live.set(t.fid, { type: "model", model, url });
  }


  // --- Chunked creation ------------------------------------
async function chunkCreate(list: any[]) {
  const q = list.slice();

  while (q.length) {
    const batch = q.splice(0, CHUNK_CREATE);

    // Start all models in parallel without awaiting each one
    const promises = batch.map(async t => {
      const item = live.get(t.fid);
      if (item) return; // already exists
      await createTree(t);
    });

    // Wait for all in this batch
    await Promise.all(promises);

    // Yield to the render loop
    await new Promise(r => requestAnimationFrame(r));
  }
}

  // --- LOD update ------------------------------------------
  let lastLon: number | undefined;
  let lastLat: number | undefined;
  let lock = false;
// --- Queue for tree creation --------------------------------
let treeQueue: any[] = [];
let queueLock = false;

// --- Chunked creation with queue ---------------------------
async function processQueue() {
  if (queueLock || treeQueue.length === 0) return;
  queueLock = true;

  while (treeQueue.length) {
    const batch = treeQueue.splice(0, CHUNK_CREATE);

    // Only create trees still in view
    const batchToCreate = batch.filter(t => {
      const c = Cartographic.fromCartesian(scene.camera.positionWC);
      return dMeters(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude), t.lon, t.lat) <= RADIUS_M;
    });

    await Promise.all(batchToCreate.map(t => createTree(t)));

    // Yield to the render loop
    await new Promise(r => requestAnimationFrame(r));

    // If the queue has been replaced due to camera movement, stop this batch
    if (treeQueue.length === 0) break;
  }

  queueLock = false;
}

// --- LOD update --------------------------------------------
async function updateLOD() {
  if (lock) return;
  lock = true;

  const c = Cartographic.fromCartesian(scene.camera.positionWC);
  const lon = CesiumMath.toDegrees(c.longitude);
  const lat = CesiumMath.toDegrees(c.latitude);

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
    live.forEach(i => setVisible(i, false));
    treeQueue = []; // cancel old batches
    lock = false;
    return;
  }

  const deg = RADIUS_M / 111320;
  const hits = index
    .search({ minX: lon - deg, minY: lat - deg, maxX: lon + deg, maxY: lat + deg })
    .map((r: any) => r.t)
    .filter(t => dMeters(lon, lat, t.lon, t.lat) <= RADIUS_M)
    .sort((a, b) => dMeters(lon, lat, a.lon, a.lat) - dMeters(lon, lat, b.lon, b.lat));



  const keep = new Set(hits.map(h => h.fid));
  [...live.keys()].forEach(fid => {
    if (!keep.has(fid)) setVisible(live.get(fid), false);
  });

  // Determine which trees need to be created
  const newQueue: any[] = [];
  hits.forEach(t => {
    const dist = dMeters(lon, lat, t.lon, t.lat);

    if (dist < HIGH_DISTANCE) t.url = modelCfg.species?.[t.species]?.high || modelCfg.high;
    else if (dist < MEDIUM_DISTANCE) t.url = modelCfg.species?.[t.species]?.medium || modelCfg.medium;
    else t.url = modelCfg.species?.[t.species]?.low || modelCfg.low;

    const item = live.get(t.fid);
    if (!item || item.url !== t.url) {
      if (item) setVisible(item, false);
      newQueue.push(t);
    }
  });

  // Replace old queue (cancel old batches)
  treeQueue = newQueue;

  // Start processing queue asynchronously
  processQueue();

  // Update matrices for visible trees
hits.forEach(t => {
  const dist = dMeters(lon, lat, t.lon, t.lat);

  // Determine LOD
  let lodUrl;
  if (dist < HIGH_DISTANCE) lodUrl = modelCfg.species?.[t.species]?.high || modelCfg.high;
  else if (dist < MEDIUM_DISTANCE) lodUrl = modelCfg.species?.[t.species]?.medium || modelCfg.medium;
  else lodUrl = modelCfg.species?.[t.species]?.low || modelCfg.low;

  const item = live.get(t.fid);

  if (item) {
    // Update model if LOD changed
    if (item.url !== lodUrl) {
      // hide old model
      setVisible(item, false);
      // enqueue for creation
      treeQueue.push({ ...t, url: lodUrl });
      // remove from live temporarily
      live.delete(t.fid);
    } else {
      // just update position
      item.model.modelMatrix = buildMatrix(t);
      item.model.show = true;
    }
  } else {
    // not created yet -> enqueue
    treeQueue.push({ ...t, url: lodUrl });
  }
});

  lock = false;
}

// --- Throttle camera updates --------------------------------
let lastUpdate = 0;
scene.camera.changed.addEventListener(() => {
  const now = performance.now();
  if (now - lastUpdate > 700) {
    lastUpdate = now;
    updateLOD();
  }
});
  // --- Initial LOD pass ---------------------------------------
  updateLOD();
}
