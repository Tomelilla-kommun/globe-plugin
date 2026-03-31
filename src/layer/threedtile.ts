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
  ClippingPolygonCollection,
  Cartographic
} from 'cesium';
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
      (layer) => () => ensureLayerInitialized(scene, layer, cesiumIontoken, true)
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

      void ensureLayerInitialized(scene, layer, cesiumIontoken).then(() => {
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

  await loadTilesetLayer(scene, layer, cesiumIontoken);
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

  // Revert to configured visibility now that footprints have been extracted.
  primitives.forEach((p) => { p.show = visible; });

  layer.CesiumModels = [...(layer.CesiumModels ?? []), ...primitives];

  // Extract convex-hull footprints from ready Model primitives for use in applyMask.
  const footprints = primitives.map((prim) => extractFootprintFromModel(prim));
  layer.CesiumModelFootprints = [...(layer.CesiumModelFootprints ?? []), ...footprints];
}

async function loadTilesetLayer(
  scene: Scene,
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
    // Already world-space after model.ready — do NOT apply modelMatrix again.
    const worldBS = model.boundingSphere;
    if (worldBS.radius <= 0) {
      console.warn('[extractFootprintFromModel] bounding sphere radius = 0');
      return null;
    }

    const center = Cartographic.fromCartesian(worldBS.center);
    if (!center) return null;

    const lat = (center.latitude * 180) / Math.PI;
    const lng = (center.longitude * 180) / Math.PI;
    const latDelta = worldBS.radius / 111320;
    const lngDelta = worldBS.radius / (111320 * Math.cos(center.latitude));

    // Single pass — no intermediate [number, number][] array needed.
    return Array.from({ length: 8 }, (_, a) => {
      const angle = (a * Math.PI * 2) / 8;
      return Cartesian3.fromDegrees(
        lng + lngDelta * Math.cos(angle),
        lat + latDelta * Math.sin(angle),
        0
      );
    });
  } catch (e) {
    console.warn('[extractFootprintFromModel] exception:', e);
    return null;
  }
}

/**
 * Expands a polygon (defined by Cartesian3 positions) radially outward from its
 * centroid by `bufferMeters` metres. Each vertex is moved away from the centroid
 * along the vector centroid→vertex.
 */
function bufferPositions(positions: Cartesian3[], bufferMeters: number): Cartesian3[] {
  // Mutate acc in-place to avoid allocating a new Cartesian3 on every iteration.
  const centroid = positions.reduce(
    (acc, p) => Cartesian3.add(acc, p, acc),
    new Cartesian3()
  );
  Cartesian3.divideByScalar(centroid, positions.length, centroid);

  return positions.map((p) => {
    const dir = Cartesian3.subtract(p, centroid, new Cartesian3());
    const dist = Cartesian3.magnitude(dir);
    if (dist === 0) return Cartesian3.clone(p);
    Cartesian3.normalize(dir, dir);
    Cartesian3.multiplyByScalar(dir, dist + bufferMeters, dir);
    return Cartesian3.add(centroid, dir, new Cartesian3());
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
