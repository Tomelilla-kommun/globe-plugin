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
  EllipsoidGeodesic,
  Cartesian2
} from "cesium";
import GeoJSON from "ol/format/GeoJSON";

export async function loadTreesIncremental(layer: any, scene: Scene, model: any): Promise<void> {
// Key tunables
const RADIUS_M = 700;
const MOVE_THRESHOLD_M = 100;
const TICK_MS = 500;
const MAX_LIVE_MODELS = 100000; // pool budget
const TERRAIN_CHUNK = 64;

type TreeMeta = {
  fid: string;
  lon: number;
  lat: number;
  modelUrl: string;
  scale: number;
  height: number; // 0 until sampled
};

// State
const allTrees = new Map<string, TreeMeta>();          // all features (metadata only)
const live = new Map<string, Model>();                 // currently instantiated
const byFid = new Map<string, TreeMeta>();             // convenience
let lastCamLon = NaN, lastCamLat = NaN;
let inProgress = false;

// Throttle helper
function throttle<T extends (...args:any[])=>void>(fn:T, ms:number) {
  let last = 0, trailing:any;
  return (...a:any[]) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(trailing); trailing = setTimeout(() => { last = performance.now(); fn(...a); }, ms - (now - last)); }
  };
}

function geodesicDistanceMeters(lon1:number, lat1:number, lon2:number, lat2:number) {
  const geod = new EllipsoidGeodesic(Cartographic.fromDegrees(lon1, lat1), Cartographic.fromDegrees(lon2, lat2));
  return geod.surfaceDistance;
}

// 1) Fetch all features once
async function fetchAllOnce() {
  const url =
    `${layer.get('dataSource')}?service=WFS&version=1.0.0&request=GetFeature` +
    `&typeName=${encodeURIComponent(layer.get('name'))}` +
    `&outputFormat=application/json&srsName=EPSG:4326`;
  const resp = await fetch(url);
  const geojson = await resp.json();
  const features = new GeoJSON().readFeatures(geojson);

  for (const f of features) {
    const g = f.getGeometry?.(); if (!g) continue;
    let coords:any = null;
    if (g.getType?.() === 'Point') coords = (g as any).getCoordinates();
    else {
      try { coords = (g as any).getInteriorPoint?.()?.getCoordinates?.(); } catch {}
      if (!coords) {
        const e = g.getExtent?.(); if (e) coords = [(e[0]+e[2])/2, (e[1]+e[3])/2];
      }
    }
    if (!coords) continue;
    const [lon, lat] = coords;

    const fid = f.getId?.() || f.get('id') || `${lon},${lat}`;
    const speciesAttr = model.gltf.speciesAttr;
    const speciesName = f.get(speciesAttr) || "";
    const speciesSettings = model.gltf.species?.[speciesName];
    const modelUrl = speciesSettings ? speciesSettings.model : model.gltf.baseModel;
    const rawHeight = parseFloat(f.get(model.gltf.heightAttr || "")) || 1;
    const modelHeight = speciesSettings?.modelHeight ?? model.gltf.baseModelHeight ?? 1;
    const scale = rawHeight / modelHeight;

    const meta: TreeMeta = { fid, lon, lat, modelUrl, scale, height: 0 };
    allTrees.set(fid, meta);
    byFid.set(fid, meta);
  }
}

// 2) Ensure near set is materialized with a pool

function getViewCenterCartographic(scene: Scene): Cartographic | null {
  const w = scene.canvas.clientWidth;
  const h = scene.canvas.clientHeight;
  const screenCenter = new Cartesian2(w * 0.5, h * 0.5);

  const ray = scene.camera.getPickRay(screenCenter);
  const cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
  if (cartesian) return Cartographic.fromCartesian(cartesian);

  const ellipsoidCartesian = scene.camera.pickEllipsoid(screenCenter, Ellipsoid.WGS84);
  return ellipsoidCartesian ? Cartographic.fromCartesian(ellipsoidCartesian) : null;
}

async function ensureNear(scene: Scene) {
  if (inProgress) return;
  inProgress = true;
  try {
    // 1) Stable center (view center preferred; fallback to camera cartographic)
    const center = getViewCenterCartographic(scene) ?? scene.camera.positionCartographic;
    const centerLon = CesiumMath.toDegrees(center.longitude);
    const centerLat = CesiumMath.toDegrees(center.latitude);

    // 2) Throttle by movement of the same center
    const moved = Number.isFinite(lastCamLon)
      ? geodesicDistanceMeters(lastCamLon, lastCamLat, centerLon, centerLat)
      : Infinity;
    if (moved < MOVE_THRESHOLD_M) return;
    lastCamLon = centerLon; lastCamLat = centerLat;

    // 3) Compute AGL at center and horizontal budget of the 3D sphere
    const terrainH = scene.globe.getHeight(center) ?? 0; // undefined -> 0 for a frame
    const cam = scene.camera.positionCartographic;
    const camAGL = Math.max(0, cam.height - terrainH);

    if (camAGL >= RADIUS_M) {
      // Too high: hide everything and bail
      for (const mdl of live.values()) mdl.show = false;
      return;
    }
    const horizMax = Math.sqrt(RADIUS_M * RADIUS_M - camAGL * camAGL);

    // 4) Determine target set using horizMax (not RADIUS_M)
    const target: TreeMeta[] = [];
    for (const t of allTrees.values()) {
      if (geodesicDistanceMeters(centerLon, centerLat, t.lon, t.lat) <= horizMax) {
        target.push(t);
      }
    }

    // 5) Sort by distance (closest first)
    target.sort((a, b) =>
      geodesicDistanceMeters(centerLon, centerLat, a.lon, a.lat) -
      geodesicDistanceMeters(centerLon, centerLat, b.lon, b.lat)
    );

    // 6) Hide those no longer near
    for (const [fid, mdl] of live.entries()) {
      if (!target.find(t => t.fid === fid)) mdl.show = false;
    }

    // 7) Create/show up to budget
    const need: TreeMeta[] = [];
    for (const t of target) {
      const existing = live.get(t.fid);
      if (existing) { existing.show = layer.get('visible'); continue; }
      need.push(t);
      if (live.size + need.length >= MAX_LIVE_MODELS) break;
    }

    // 8) Create models (unchanged from your code)
    const toSample: TreeMeta[] = [];
    await Promise.all(need.slice(0, Math.max(0, MAX_LIVE_MODELS - live.size)).map(async (it) => {
      const position0 = Cartesian3.fromDegrees(it.lon, it.lat, 0);
      const randomHeading = CesiumMath.toRadians(Math.random() * 360);
      const randomPitch = CesiumMath.toRadians((Math.random() - 0.5) * 20);
      const hpr = new HeadingPitchRoll(randomHeading, randomPitch, 0);
      const modelMatrix0 = Transforms.headingPitchRollToFixedFrame(position0, hpr, Ellipsoid.WGS84);

      const m = await Model.fromGltfAsync({
        url: it.modelUrl,
        modelMatrix: modelMatrix0,
        scale: it.scale,
        minimumPixelSize: 0,
        asynchronous: true,
        allowPicking: false,
      });
      m.backFaceCulling = true;
      m.shadows = ShadowMode.DISABLED;
      m.show = layer.get('visible');
      live.set(it.fid, m);
      layer.CesiumModels = layer.CesiumModels || [];
      layer.CesiumModels.push(m);
      scene.primitives.add(m);
      toSample.push(it);
    }));

    // 9) Sample terrain and update heights (your code)
    for (let i = 0; i < toSample.length; i += TERRAIN_CHUNK) {
      const chunk = toSample.slice(i, i + TERRAIN_CHUNK);
      const cartos = chunk.map(t => Cartographic.fromDegrees(t.lon, t.lat));
      await sampleTerrainMostDetailed(scene.terrainProvider, cartos);
      for (let k = 0; k < chunk.length; k++) {
        const t = chunk[k];
        t.height = cartos[k].height ?? 0;
        const mdl = live.get(t.fid);
        if (!mdl) continue;
        const posH = Cartesian3.fromDegrees(t.lon, t.lat, t.height);
        const modelMatrix = Transforms.headingPitchRollToFixedFrame(posH, new HeadingPitchRoll(0,0,0), Ellipsoid.WGS84);
        mdl.modelMatrix = modelMatrix;
      }
    }
  } finally {
    inProgress = false;
  }
}

// Wire up frequent updates during motion
scene.camera.percentageChanged = 0.001;
const onChanged = throttle(() => { ensureNear(scene); }, TICK_MS);
scene.camera.changed.addEventListener(onChanged);

// Init
await fetchAllOnce();
await ensureNear(scene);
}