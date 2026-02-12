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
  PerInstanceColorAppearance
} from 'cesium';
import GeoJSON from 'ol/format/GeoJSON';
import Map from 'ol/Map';
import { loadTrees } from '../functions/loadTrees';

interface ExtrusionConfig {
  color?: string;
  opacity?: number;
  groundAttr: string;
  roofAttr: string;
}

interface ModelDefinition {
  fileName: string;
  lat: number;
  lng: number;
  height?: number;
  heightReference?: string;
  rotHeading?: number;
  rotPitch?: number;
  rotRoll?: number;
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
  CesiumModels?: Model[];
  CesiumExtrusions?: Primitive[];
  [key: string]: unknown;
}

type ThreedTileLayer = LayerOptions & {
  get: <T = unknown>(key: string) => T;
  CesiumTileset?: Cesium3DTileset;
  CesiumModels?: Model[];
  CesiumExtrusions?: Primitive[];
  on?: (type: string, listener: () => void) => void;
};

const DEFAULT_TILE_STYLE = "color('white', 1)";
const geoJsonFormat = new GeoJSON();
const MAX_CONCURRENT_LOADS = 3;
const PRIMITIVE_BATCH_SIZE = 100;

export default async function load3DLayers(
  scene: Scene,
  map: Map,
  cesiumIontoken: string
): Promise<void> {
  const layers = map.getLayers().getArray() as unknown as ThreedTileLayer[];

  const threedLayers = layers.filter((layer) => layer.get('type') === 'THREEDTILE');
  await runWithConcurrency(
    threedLayers.map(
      (layer) => () => ensureLayerInitialized(scene, layer, cesiumIontoken)
    ),
    MAX_CONCURRENT_LOADS
  );
  threedLayers.forEach((layer) =>
    layer.on?.('change:visible', () => {
      void ensureLayerInitialized(scene, layer, cesiumIontoken);
    })
  );
}

async function ensureLayerInitialized(
  scene: Scene,
  layer: ThreedTileLayer,
  cesiumIontoken: string
) {
  if (!layer.get('visible')) {
    return;
  }

  if (layer.CesiumExtrusions || layer.CesiumModels || layer.CesiumTileset) {
    return;
  }

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
    await loadTrees(layer, scene, layer.get('model'));
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
  const primitives = await Promise.all(
    modelDefs.map((definition) =>
      Model.fromGltfAsync({
        url: `${baseUrl}${definition.fileName}`,
        modelMatrix: createModelMatrix(definition),
        minimumPixelSize: 0,
        asynchronous: true,
        heightReference: resolveHeightReference(definition.heightReference)
      })
    )
  );

  primitives.forEach((primitive) => {
    primitive.show = visible;
  });
  await insertPrimitivesInBatches(scene, primitives);

  layer.CesiumModels = [...(layer.CesiumModels ?? []), ...primitives];
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

function getPolygonCoordinates(
  geometry: unknown
): [number, number][] | undefined {
  if (!geometry || typeof (geometry as any).getType !== 'function') {
    return undefined;
  }

  const type = (geometry as any).getType();
  if (type === 'Polygon') {
    return (geometry as any).getCoordinates()?.[0];
  }
  if (type === 'MultiPolygon') {
    return (geometry as any).getCoordinates()?.[0]?.[0];
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

function createModelMatrix(model: any) {
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
