import {
  Scene,
  Cesium3DTileset,
  createOsmBuildingsAsync,
  Color,
  Cesium3DTileStyle,
  Cartesian3,
  ShadowMode,
  Model,
  Transforms,
  HeadingPitchRoll,
  Ellipsoid,
  HeightReference,
  Primitive,
  GeometryInstance,
  PolygonGeometry,
  PolygonHierarchy,
  ColorGeometryInstanceAttribute,
  PerInstanceColorAppearance,
  Cartographic,
  ModelAnimationLoop
} from 'cesium';
import {
  createSolidRoofColorShader,
  createOrtofotoRoofColorShader,
  loadRoofColorData,
  getWmsLayerInfo,
  setupLodRoofColor
} from '../functions/roofColorDraping';
import GeoJSON from 'ol/format/GeoJSON';
import OLMap from 'ol/Map';
import { load3DObject } from '../functions/load3DObject';
import {
  MaskConfig,
  ModelDefinition,
  ThreedTileLayer as BaseThreedTileLayer,
  applyMask,
  toggleMask
} from '../functions/tileClipping';

interface ExtrusionConfig {
  color?: string;
  opacity?: number;
  groundAttr: string;
  roofAttr: string;
}

interface LayerOptions {
  dataSource?: string;
  name?: string;
  extrusion?: ExtrusionConfig;
  model?: unknown;
  models?: ModelDefinition[];
  visible?: boolean;
  url?: string | number;
  showOutline?: boolean;
  outlineColor?: string;
  style?: Record<string, unknown> | 'default';
  filter?: boolean;
  /** Mask config: { tilesetName: buffer } or { tilesetName: { buffer, removeIntersecting } } */
  mask?: Record<string, number | MaskConfig>;
  CesiumModels?: Model[];
  CesiumExtrusions?: Primitive[];
  /** Roof color: hex RGB (e.g. "#ff0000") for solid color, or "sample" to sample from WMS ortofoto */
  roofColor?: string;
  /** Threshold for roof detection (0-1, default 0.7). Higher = more horizontal surfaces only */
  roofNormalThreshold?: number;
  /** Name of a WMS layer to sample roof colors from (e.g. "webservices:Ortofoto_0.16") */
  roofColorLayer?: string;
  /** Pre-generated roof color data file (JSON with imageUrl and bounds). If set, skips WMS fetch */
  roofColorData?: string;
  /** Camera altitude in meters to trigger high-res fetch (default 4000) */
  roofColorLodDistance?: number;
  /** Resolution of high-res ortofoto image (default 2048) */
  roofColorImageSize?: number;
  /** Radius in meters for high-res fetch area (default 600) - smaller = more detail */
  roofColorFetchRadius?: number;
  [key: string]: unknown;
}

type ThreedTileLayer = LayerOptions & BaseThreedTileLayer & {
  CesiumExtrusions?: Primitive[];
  objectScheduler?: { setVisible: (v: boolean) => void };
  on?: (type: string, listener: () => void) => void;
};

const DEFAULT_TILE_STYLE = "color('white', 1)";
const geoJsonFormat = new GeoJSON();
const MAX_CONCURRENT_LOADS = 3;
const PRIMITIVE_BATCH_SIZE = 100;

// Precomputed constants for performance
const RAD_TO_DEG = 180 / Math.PI;
const OCTAGON_ANGLES = Array.from({ length: 8 }, (_, i) => (i * Math.PI * 2) / 8);
const OCTAGON_COS = OCTAGON_ANGLES.map(Math.cos);
const OCTAGON_SIN = OCTAGON_ANGLES.map(Math.sin);

// Scratch objects to avoid GC pressure in hot paths
const scratchCartesian3A = new Cartesian3();
const scratchCartesian3B = new Cartesian3();
const scratchCartographic = new Cartographic();

export default async function load3DLayers(
  scene: Scene,
  map: OLMap,
  cesiumIontoken: string
): Promise<void> {
  const layers = map.getLayers().getArray() as unknown as ThreedTileLayer[];

  const threedLayers = layers.filter((layer) => layer.get('type') === 'THREEDTILE');
  // Force-init ALL layers (including those configured as invisible) so every
  // CesiumTileset / CesiumModels reference is populated before mask application.
  await runWithConcurrency(
    threedLayers.map(
      (layer) => () => ensureLayerInitialized(scene, map, layer, cesiumIontoken, true)
    ),
    MAX_CONCURRENT_LOADS
  );

  // Second pass: apply masks after the next render. Temporarily show all tilesets
  // so their GPU state is ready when clippingPolygons is assigned, then revert.
  scene.postRender.addEventListener(function applyMasksOnce() {
    scene.postRender.removeEventListener(applyMasksOnce);

    // Collect tilesets that are currently hidden and force them visible.
    const hiddenTilesets: Cesium3DTileset[] = [];
    threedLayers.forEach((layer) => {
      if (layer.CesiumTileset && !layer.CesiumTileset.show) {
        hiddenTilesets.push(layer.CesiumTileset);
        layer.CesiumTileset.show = true;
      }
    });

    // Apply masks asynchronously (handles GeoJSON loading)
    void Promise.all(
      threedLayers.map((layer) => applyMask(scene, layer, threedLayers, bufferPositions))
    ).then(() => {
      // Revert tilesets that were invisible before.
      hiddenTilesets.forEach((t) => { t.show = false; });
    });
  });

  threedLayers.forEach((layer) =>
    layer.on?.('change:visible', () => {
      const visible = layer.get('visible') as boolean;

      // If this layer has masks (i.e., it's a model layer with GLBs that clips tilesets),
      // toggle its mask on/off based on visibility
      if (layer.get('mask') && layer.OwnClippingPolygons?.size) {
        toggleMask(layer, threedLayers, visible);
      }

      void ensureLayerInitialized(scene, map, layer, cesiumIontoken).then(() => {
        // Re-apply masks in case this layer is a tileset that was invisible when
        // applyMask first ran — its CesiumTileset won't have been set yet then.
        const layerName = layer.get('name') as string;
        const modelLayers = threedLayers.filter((l) => {
          const m = l.get('mask');
          return m !== null && typeof m === 'object' && layerName in (m as object);
        });
        void Promise.all(
          modelLayers.map((modelLayer) => applyMask(scene, modelLayer, threedLayers, bufferPositions))
        );
      });
    })
  );
}

async function ensureLayerInitialized(
  scene: Scene,
  map: OLMap,
  layer: ThreedTileLayer,
  cesiumIontoken: string,
  forceInit = false
) {
  if (!forceInit && !layer.get('visible')) return;
  if (layer.CesiumExtrusions || layer.CesiumModels || layer.CesiumTileset || layer.objectScheduler) return;

  const dataType = layer.get('dataType');
  if (dataType === 'extrusion') {
    await loadExtrusionLayer(scene, layer);
    return;
  }

  if (dataType === 'model') {
    await loadModelLayer(scene, layer);
    return;
  }

  if (layer.get('model')) {
    await load3DObject(layer, scene, layer.get('model'));
    return;
  }

  await loadTilesetLayer(scene, map, layer, cesiumIontoken);
}

async function loadExtrusionLayer(scene: Scene, layer: ThreedTileLayer) {
  const extrusion = layer.get('extrusion') as ExtrusionConfig | undefined;
  const dataSource = layer.get('dataSource');
  const layerName = layer.get('name');
  if (!extrusion || !dataSource || !layerName) {
    return;
  }

  const requestUrl = `${dataSource}?service=WFS&version=1.0.0&request=GetFeature&typeName=${layerName}&outputFormat=application/json&srsName=EPSG:4326`;

  try {
    const response = await fetch(requestUrl);
    const geojson = await response.json();
    const features = geoJsonFormat.readFeatures(geojson);
    const visible = Boolean(layer.get('visible'));
    const baseColor = resolveColor(extrusion.color, extrusion.opacity);

    const primitives = features
      .map((feature) => {
        const coords = getPolygonCoordinates(feature.getGeometry());
        if (!coords) return undefined;

        const ground = toFiniteNumber(feature.get(extrusion.groundAttr)) ?? 0;
        const roof = toFiniteNumber(feature.get(extrusion.roofAttr)) ?? ground + 5;

        return createExtrusionPrimitive(
          coords,
          ground,
          roof,
          baseColor,
          feature.getId(),
          visible
        );
      })
      .filter((primitive): primitive is Primitive => Boolean(primitive));

    layer.CesiumExtrusions = primitives;
    await insertPrimitivesInBatches(scene, primitives);
  } catch (err) {
    console.error('Error loading WFS extruded buildings:', err);
  }
}

async function loadModelLayer(scene: Scene, layer: ThreedTileLayer) {
  const modelDefs = (layer.get('models') as ModelDefinition[]) ?? [];
  if (!modelDefs.length) {
    return;
  }

  const baseUrl = layer.get('url');
  if (!baseUrl || typeof baseUrl !== 'string') {
    return;
  }

  const visible = Boolean(layer.get('visible'));

  // Load models with bounded concurrency to avoid spiking memory and stalling
  // the render loop when many models are defined on a single layer.
  const primitives = await runWithConcurrency(
    modelDefs.map((definition) => () =>
      Model.fromGltfAsync({
        url: `${baseUrl}${definition.fileName}`,
        modelMatrix: createModelMatrix(definition),
        minimumPixelSize: 0,
        asynchronous: true,
        heightReference: resolveHeightReference(definition.heightReference)
      })
    ),
    MAX_CONCURRENT_LOADS
  );

  // Force show=true so Cesium's render loop processes the model and fires readyEvent
  // regardless of the layer's configured visibility.
  primitives.forEach((p) => { p.show = true; });
  await insertPrimitivesInBatches(scene, primitives);

  // Wait for every model to be GPU-ready before accessing boundingSphere / _loader.
  await Promise.all(primitives.map(waitForModelReady));

  // Setup animations for models that have animation enabled
  primitives.forEach((model, index) => {
    const definition = modelDefs[index];
    if (definition.animation && model.activeAnimations) {
      try {
        // Calculate multiplier based on desired duration
        // multiplier = 1.0 is native speed, higher = faster, lower = slower
        const multiplier = definition.animationDuration 
          ? 1.0 / definition.animationDuration 
          : 1.0;
        
        model.activeAnimations.addAll({
          loop: ModelAnimationLoop.REPEAT,
          multiplier
        });
      } catch (e) {
        console.warn(`Failed to add animation for model ${definition.fileName}:`, e);
      }
    }
  });

  // Revert to configured visibility now that footprints have been extracted.
  primitives.forEach((p) => { p.show = visible; });

  layer.CesiumModels = [...(layer.CesiumModels ?? []), ...primitives];

  // Extract convex-hull footprints from ready Model primitives for use in applyMask.
  const footprints = primitives.map((prim) => extractFootprintFromModel(prim));
  layer.CesiumModelFootprints = [...(layer.CesiumModelFootprints ?? []), ...footprints];
}

async function loadTilesetLayer(
  scene: Scene,
  map: OLMap,
  layer: ThreedTileLayer,
  cesiumIontoken: string
) {
  const url = layer.get('url');
  if (!url) return;

  const visible = Boolean(layer.get('visible'));
  const show = layer.get('filter') as boolean | undefined;
  const style = layer.get('style') as (Record<string, unknown> | 'default' | undefined);
  let tileset: Cesium3DTileset | undefined;

  try {
    if (typeof url === 'number' && cesiumIontoken) {
      tileset = await Cesium3DTileset.fromIonAssetId(url, {
        instanceFeatureIdLabel: layer.get('name'),
        dynamicScreenSpaceError: true,
        skipLevelOfDetail: true,           // Skip intermediate LODs for faster load
        preferLeaves: true,                 // Load leaf tiles first (highest detail)
        cullRequestsWhileMoving: true,      // Don't request tiles while camera moves
        cullRequestsWhileMovingMultiplier: 60, // More aggressive culling
        show: visible
      });
    } else if (url === 'OSM-Buildings' && cesiumIontoken) {
      tileset = await createOsmBuildingsAsync({
        showOutline: layer.get('showOutline') as boolean | undefined
      });
    } else if (typeof url === 'string') {
      tileset = await Cesium3DTileset.fromUrl(url, {
        instanceFeatureIdLabel: layer.get('name'),
        dynamicScreenSpaceError: true,
        skipLevelOfDetail: true,           // Skip intermediate LODs for faster load
        preferLeaves: true,                 // Load leaf tiles first (highest detail)
        cullRequestsWhileMoving: true,      // Don't request tiles while camera moves
        cullRequestsWhileMovingMultiplier: 60, // More aggressive culling
        shadows:
          layer.get('showShadows') === false
            ? ShadowMode.RECEIVE_ONLY
            : ShadowMode.ENABLED,
        show: visible
      });
    }

    if (!tileset) {
      return;
    }

    const added = scene.primitives.add(tileset);
    layer.CesiumTileset = added;
    (layer.CesiumTileset as any).OrigoLayerName = layer.get('name');

    added.style = new Cesium3DTileStyle(
      style && style !== 'default' ? { ...style, show } : { color: DEFAULT_TILE_STYLE, show }
    );

    // Apply roof color shader if enabled
    const roofColor = layer.get('roofColor') as string | undefined;
    if (roofColor) {
      const normalThreshold = (layer.get('roofNormalThreshold') as number | undefined) ?? 0.7;
      
      if (roofColor.toLowerCase() === 'sample') {
        // Check for pre-generated data first
        const roofColorData = layer.get('roofColorData') as string | undefined;
        
        if (roofColorData) {
          // Load pre-generated data (no WMS fetch needed)
          loadRoofColorData(roofColorData).then(data => {
            if (data) {
              added.customShader = createOrtofotoRoofColorShader(data, normalThreshold);
            } else {
              console.warn(`roofColor: Failed to load pre-generated data from "${roofColorData}"`);
              added.customShader = createSolidRoofColorShader('#808080', normalThreshold);
            }
          });
        } else {
          // Sample colors from ortofoto WMS with LOD support
          const roofColorLayer = layer.get('roofColorLayer') as string | undefined;
          const lodDistance = (layer.get('roofColorLodDistance') as number | undefined) ?? 4000;
          const highResSize = (layer.get('roofColorImageSize') as number | undefined) ?? 2048;
          const fetchRadius = (layer.get('roofColorFetchRadius') as number | undefined) ?? 600;
          
          if (roofColorLayer) {
            const wmsInfo = getWmsLayerInfo(map, roofColorLayer);
            if (wmsInfo) {
              setupLodRoofColor(scene, added, normalThreshold, wmsInfo.url, wmsInfo.layers, lodDistance, highResSize, fetchRadius);
            } else {
              console.warn(`roofColor: Could not find WMS layer "${roofColorLayer}"`);
              added.customShader = createSolidRoofColorShader('#808080', normalThreshold);
            }
          } else {
            console.warn('roofColor: "sample" mode requires roofColorLayer or roofColorData');
            added.customShader = createSolidRoofColorShader('#808080', normalThreshold);
          }
        }
      } else {
        // Solid color - parse hex RGB
        added.customShader = createSolidRoofColorShader(roofColor, normalThreshold);
      }
    }
  } catch (err) {
    console.error('Error loading 3D Tileset:', err);
  }
}

function resolveColor(colorName?: string, opacity = 1): Color {
  if (!colorName) {
    return Color.LIGHTGRAY.withAlpha(opacity);
  }

  const upperCase = colorName.toUpperCase();
  const namedColors = Color as unknown as Record<string, Color>;
  return (namedColors[upperCase] || Color.LIGHTGRAY).withAlpha(opacity);
}

interface OlGeometryLike {
  getType(): string;
  getCoordinates(): unknown;
}

function getPolygonCoordinates(
  geometry: unknown
): [number, number][] | undefined {
  if (!geometry || typeof (geometry as OlGeometryLike).getType !== 'function') {
    return undefined;
  }

  const g = geometry as OlGeometryLike;
  const type = g.getType();
  if (type === 'Polygon') {
    return (g.getCoordinates() as [number, number][][])?.[0];
  }
  if (type === 'MultiPolygon') {
    return (g.getCoordinates() as [number, number][][][])?.[0]?.[0];
  }
  return undefined;
}

function createExtrusionPrimitive(
  coords: [number, number][],
  ground: number,
  roof: number,
  color: Color,
  id: string | number | undefined,
  visible: boolean
): Primitive {
  const positions = coords.map(([lon, lat]) =>
    Cartesian3.fromDegrees(lon, lat, ground)
  );

  const polygon = new PolygonGeometry({
    polygonHierarchy: new PolygonHierarchy(positions),
    height: ground,
    extrudedHeight: roof
  });

  const geomInstance = new GeometryInstance({
    geometry: polygon,
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color)
    },
    id
  });

  return new Primitive({
    geometryInstances: geomInstance,
    appearance: new PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      closed: true
    }),
    asynchronous: false,
    releaseGeometryInstances: false,
    show: visible
  });
}

function createModelMatrix(model: ModelDefinition) {
  const position = Cartesian3.fromDegrees(
    model.lng,
    model.lat,
    model.height || 0
  );
  const hpr = new HeadingPitchRoll(
    model.rotHeading || 0,
    model.rotPitch || 0,
    model.rotRoll || 0
  );
  return Transforms.headingPitchRollToFixedFrame(position, hpr, Ellipsoid.WGS84);
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Derives a ground-level footprint from an already-loaded (ready) Cesium Model.
 *
 * `model.boundingSphere` is in world (ECEF) space after the model is ready —
 * no additional transform is needed. We build an 8-point octagon around the
 * sphere's ground-projected centre with radius equal to the sphere radius.
 * The caller's `bufferPositions` step will expand it by the configured metres.
 */
function extractFootprintFromModel(model: Model): Cartesian3[] | null {
  try {
    const worldBS = model.boundingSphere;
    if (worldBS.radius <= 0) return null;

    // Use scratch cartographic to avoid allocation
    const center = Cartographic.fromCartesian(worldBS.center, Ellipsoid.WGS84, scratchCartographic);
    if (!center) return null;

    const lat = center.latitude * RAD_TO_DEG;
    const lng = center.longitude * RAD_TO_DEG;
    const latDelta = worldBS.radius / 111320;
    const lngDelta = worldBS.radius / (111320 * Math.cos(center.latitude));

    // Use precomputed sin/cos for octagon angles
    return OCTAGON_COS.map((cos, i) => 
      Cartesian3.fromDegrees(
        lng + lngDelta * cos,
        lat + latDelta * OCTAGON_SIN[i],
        0
      )
    );
  } catch {
    return null;
  }
}

/**
 * Expands a polygon (defined by Cartesian3 positions) radially outward from its
 * centroid by `bufferMeters` metres. Each vertex is moved away from the centroid
 * along the vector centroid→vertex.
 */
function bufferPositions(positions: Cartesian3[], bufferMeters: number): Cartesian3[] {
  // Early return if no buffering needed
  if (bufferMeters === 0) return positions;
  
  // Compute centroid using scratch object
  Cartesian3.clone(Cartesian3.ZERO, scratchCartesian3A);
  for (let i = 0; i < positions.length; i++) {
    Cartesian3.add(scratchCartesian3A, positions[i], scratchCartesian3A);
  }
  Cartesian3.divideByScalar(scratchCartesian3A, positions.length, scratchCartesian3A);
  const centroid = Cartesian3.clone(scratchCartesian3A);

  return positions.map((p) => {
    Cartesian3.subtract(p, centroid, scratchCartesian3B);
    const dist = Cartesian3.magnitude(scratchCartesian3B);
    if (dist === 0) return Cartesian3.clone(p);
    Cartesian3.normalize(scratchCartesian3B, scratchCartesian3B);
    Cartesian3.multiplyByScalar(scratchCartesian3B, dist + bufferMeters, scratchCartesian3B);
    return Cartesian3.add(centroid, scratchCartesian3B, new Cartesian3());
  });
}

function resolveHeightReference(value?: string): HeightReference | undefined {
  if (!value || value === 'NONE') {
    return undefined;
  }

  const lookup = HeightReference as unknown as Record<string, HeightReference>;
  return lookup[value] ?? undefined;
}

type CesiumPrimitiveLike = Primitive | Model;

async function insertPrimitivesInBatches(
  scene: Scene,
  items: CesiumPrimitiveLike[]
) {
  for (let i = 0; i < items.length; i += PRIMITIVE_BATCH_SIZE) {
    const batch = items.slice(i, i + PRIMITIVE_BATCH_SIZE);
    batch.forEach((item) => scene.primitives.add(item));
    if (i + PRIMITIVE_BATCH_SIZE < items.length) {
      await waitNextFrame();
    }
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const current = idx++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

function waitNextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(() => resolve(), 16);
  });
}

/**
 * Resolves when `model.ready` is true (i.e. after Cesium's render loop has
 * uploaded all GPU buffers and populated `_loader._components`).
 */
function waitForModelReady(model: Model): Promise<void> {
  return new Promise((resolve) => {
    if ((model as any).ready) {
      resolve();
      return;
    }
    const remove = model.readyEvent.addEventListener(() => {
      remove();
      resolve();
    });
  });
}
