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
  Cartesian2,
  Matrix4,
  BillboardCollection,
  VerticalOrigin
} from "cesium";
import GeoJSON from "ol/format/GeoJSON";
import RBush from "rbush";

// --- Tunables ------------------------------------------------
const RADIUS_M = 1200;
const MOVE_THRESHOLD = 100;
const TICK_MS = 400;
const MAX_LIVE = 100000;
const TERRAIN_BATCH = 60;
const CHUNK_CREATE = 18;
const NEAR = 300;
const LOD_BB = 700;

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
  return Matrix4.multiplyByScale(m, new Cartesian3(t.scale, t.scale, t.scale), new Matrix4());
}

// --- Visibility helper ---------------------------------------
function setVisible(item: any, on: boolean) {
  if (!item) return;
  if (item.type === "model") item.model.show = on;
  if (item.type === "billboard") item.billboard.show = on;
}

// -----------------------------------------------------------------------
export async function loadTreesIncremental(layer: any, scene: Scene, modelCfg: any) {
  const all = new Map();
  const live = new Map();
  const index = new RBush();
  const meshPools = new Map();

  const billboards = scene.primitives.add(new BillboardCollection());

  // --- Fetch features from WFS -------------------------------
  const url = `${layer.get("dataSource")}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(
    layer.get("name")
  )}&outputFormat=application/json&srsName=EPSG:4326`;

  const gj = await (await fetch(url)).json();
  const feats = new GeoJSON().readFeatures(gj);

  for (const f of feats) {
    const [lon, lat] = (f as any).getGeometry().getCoordinates();
    const spec = f.get(modelCfg.gltf.speciesAttr) || "_d";
    const set = modelCfg.gltf.species?.[spec];

    const meta = {
      fid: f.getId(),
      lon,
      lat,
      species: spec,
      url: set?.model || modelCfg.gltf.baseModel,
      rot: CesiumMath.toRadians(Math.random() * 360),
      scale:
        (parseFloat(f.get(modelCfg.gltf.heightAttr || "")) || 1) /
        (set?.modelHeight || modelCfg.gltf.baseModelHeight || 1),
      height: 0
    };
    all.set(meta.fid, meta);
    index.insert({ minX: lon, minY: lat, maxX: lon, maxY: lat, t: meta });
  }

  // --- Create tree clone per species --------------------------
// --- Create tree clone per species --------------------------
async function createTree(t: any) {
  let pool = meshPools.get(t.species);

  // Load model once per species
  if (!pool) {
    pool = await Model.fromGltfAsync({
      url: t.url,
      allowPicking: false
    });
    pool.show = false; // master model hidden
    pool.shadows = ShadowMode.DISABLED;
    scene.primitives.add(pool);
    meshPools.set(t.species, pool);
  }

  // Clone by creating a new Model from the same GLTF URL
  const clone = await Model.fromGltfAsync({
    url: t.url,
    modelMatrix: buildMatrix(t),
    allowPicking: false
  });

  clone.shadows = ShadowMode.DISABLED;
  clone.show = false;
  scene.primitives.add(clone);

  live.set(t.fid, { type: "model", model: clone });
}


  // --- Chunked creation for performance -----------------------
  function chunkCreate(list: any) {
    return new Promise<void>((resolve) => {
      const q = list.slice();
      const step = () => {
        q.splice(0, CHUNK_CREATE).forEach((t: any) => createTree(t));
        q.length ? requestAnimationFrame(step) : resolve();
      };
      step();
    });
  }

  // --- Billboard fallback -------------------------------------
  function showBB(t: any) {
    const img = modelCfg.gltf.species?.[t.species]?.imposter || modelCfg.gltf.imposter;
    const b = billboards.add({
      position: Cartesian3.fromDegrees(t.lon, t.lat, t.height),
      image: img,
      verticalOrigin: VerticalOrigin.BOTTOM
    });
    live.set(t.fid, { type: "billboard", billboard: b });
  }

  // --- Camera center helper -----------------------------------
  function centerCarto() {
    const c = scene.canvas;
    const p = new Cartesian2(c.clientWidth / 2, c.clientHeight / 2);
    const ray = scene.camera.getPickRay(p);
    if (!ray) return undefined;
    const cartesian = scene.globe.pick(ray, scene);
    return cartesian ? Cartographic.fromCartesian(cartesian) : undefined;
  }

  // --- Main LOD update ----------------------------------------
  let lastLon: number | undefined,
    lastLat: number | undefined;
  let lock = false;

  async function updateLOD() {
    if (lock) return;
    lock = true;

    let c = centerCarto();
    let lon, lat;

    if (c) {
      lon = CesiumMath.toDegrees(c.longitude);
      lat = CesiumMath.toDegrees(c.latitude);
    } else {
      c = scene.camera.positionCartographic;
      lon = CesiumMath.toDegrees(c.longitude);
      lat = CesiumMath.toDegrees(c.latitude);
    }

    if (lastLon !== undefined && lastLat !== undefined) {
      if (dMeters(lon, lat, lastLon, lastLat) < MOVE_THRESHOLD) {
        lock = false;
        return;
      }
    }
    lastLon = lon;
    lastLat = lat;

    const camH = scene.camera.positionCartographic.height;
    const terr = scene.globe.getHeight(c) || 0;
    const camAGL = camH - terr;

    if (camAGL > RADIUS_M) {
      live.forEach((i) => setVisible(i, false));
      lock = false;
      return;
    }

    const deg = RADIUS_M / 111320;
    const hits = index
      .search({ minX: lon - deg, minY: lat - deg, maxX: lon + deg, maxY: lat + deg })
      .map((r: any) => r.t)
      .filter((t: any) => dMeters(lon, lat, t.lon, t.lat) <= RADIUS_M)
      .sort((a: any, b: any) => dMeters(lon, lat, a.lon, a.lat) - dMeters(lon, lat, b.lon, b.lat));

    // hide out-of-range
    const keep = new Set(hits.map((h: any) => h.fid));
    [...live.keys()].forEach((fid) => !keep.has(fid) && live.delete(fid));

    const need3: any[] = [];
    const needBB: any[] = [];
    const needSample: any[] = [];

    for (const t of hits) {
      const dist = dMeters(lon, lat, t.lon, t.lat);
      const item = live.get(t.fid);

      if (dist < NEAR) {
        if (!item || item.type === "billboard") {
          if (item) live.delete(t.fid);
          need3.push(t);
        }
        needSample.push(t);
      } else if (dist < LOD_BB) {
        if (!item || item.type !== "billboard") {
          if (item) live.delete(t.fid);
          needBB.push(t);
        }
      } else {
        if (item) live.delete(t.fid);
      }

      if (live.size + need3.length > MAX_LIVE) break;
    }

    // Sample terrain heights
    const samp = [...new Set(need3.concat(needSample))];
    for (let i = 0; i < samp.length; i += TERRAIN_BATCH) {
      const ch = samp.slice(i, i + TERRAIN_BATCH);
      const cart = ch.map((t) => Cartographic.fromDegrees(t.lon, t.lat));
      await sampleTerrainMostDetailed(scene.terrainProvider, cart);
      ch.forEach((t, ix) => (t.height = cart[ix].height));
    }

    if (need3.length) await chunkCreate(need3);

    need3.forEach((t) => setVisible(live.get(t.fid), layer.get("visible")));
    needBB.forEach(showBB);
    lock = false;
  }

  // --- Attach to camera events --------------------------------
  scene.camera.changed.addEventListener(updateLOD);
  scene.camera.percentageChanged = 0.001;

  // --- Initial LOD pass ---------------------------------------
  updateLOD();
}
