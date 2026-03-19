import {
  Cesium3DTileset, Cesium3DTileFeature, Cesium3DTileContent, Cesium3DTileStyle,
  Cartesian3, Model, ClippingPolygon, ClippingPolygonCollection, Cartographic, Scene,
  GroundPrimitive, GeometryInstance, PolygonGeometry, PolygonHierarchy,
  ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Color
} from 'cesium';

const DEFAULT_TILE_STYLE = "color('white', 1)";

/** Set to true to visualize clipping polygons as yellow overlays */
const DEBUG_SHOW_CLIPPING_POLYGONS = false;

// ============================================================================
// Types
// ============================================================================

export interface MaskConfig {
  buffer?: number;
  removeIntersecting?: boolean;
  polygon?: string;
}

export interface ParsedMaskConfig {
  buffer: number;
  removeIntersecting: boolean;
  polygon?: string;
}

export interface ModelDefinition {
  fileName: string;
  lat: number;
  lng: number;
  height?: number;
  heightReference?: string;
  rotHeading?: number;
  rotPitch?: number;
  rotRoll?: number;
  footprint?: [number, number][];
}

export interface ThreedTileLayer {
  get: <T = unknown>(key: string) => T;
  CesiumTileset?: Cesium3DTileset;
  CesiumModels?: Model[];
  CesiumModelFootprints?: Array<Cartesian3[] | null>;
  CesiumClippingCollections?: Map<string, ClippingPolygonCollection>;
  ExcludedFeatureIds?: Map<string, Set<string>>;
  TileListenerRemovers?: Map<string, () => void>;
  AccumulatedMaskPolygons?: Array<Array<LngLat>>;
  VisibilityMaskingSetup?: boolean;
  [key: string]: unknown;
}

type LngLat = { lng: number; lat: number };

// ============================================================================
// Utilities
// ============================================================================

const RAD_TO_DEG = 180 / Math.PI;
const ID_PROPS = ['Id', 'id', 'osm_id', 'gml_id', 'fid', 'OBJECTID', 'ogc_fid', 'building:id'];
const LAT_PROPS = ['latitude', 'lat', 'y', 'Latitude', 'LAT', 'Y'];
const LNG_PROPS = ['longitude', 'lng', 'lon', 'x', 'Longitude', 'LNG', 'LON', 'X'];

export function parseMaskConfig(value: number | MaskConfig): ParsedMaskConfig {
  if (typeof value === 'number') return { buffer: value, removeIntersecting: false };
  return { buffer: value.buffer ?? 0, removeIntersecting: value.removeIntersecting ?? false, polygon: value.polygon };
}

/** Convert Cartographic to LngLat */
function cartographicToLngLat(c: Cartographic | undefined): LngLat {
  return c ? { lng: c.longitude * RAD_TO_DEG, lat: c.latitude * RAD_TO_DEG } : { lng: 0, lat: 0 };
}

/** Project Cartesian3 to ellipsoid surface (height=0) */
function projectToSurface(p: Cartesian3): Cartesian3 {
  const c = Cartographic.fromCartesian(p);
  return c ? Cartesian3.fromDegrees(c.longitude * RAD_TO_DEG, c.latitude * RAD_TO_DEG, 0) : p;
}

export function cartesian3ToLngLat(positions: Cartesian3[]): LngLat[] {
  return positions.map(p => cartographicToLngLat(Cartographic.fromCartesian(p)));
}

/** 2D point-in-polygon test (ray casting) */
export function pointInPolygon2D(point: LngLat, polygon: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    if (((yi > point.lat) !== (yj > point.lat)) &&
        (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

export function getFeaturePropertyNames(feature: Cesium3DTileFeature): string[] {
  try {
    if (typeof feature.getPropertyIds === 'function') return feature.getPropertyIds();
    const f = feature as any;
    if (f._content?.batchTable?._properties) return Object.keys(f._content.batchTable._properties);
  } catch { /* ignore */ }
  return [];
}

export function getFeatureId(feature: Cesium3DTileFeature): string | null {
  for (const prop of ID_PROPS) {
    try {
      const val = feature.getProperty(prop);
      if (val != null) return String(val);
    } catch { /* ignore */ }
  }
  return null;
}

export function getFeatureCenter(feature: Cesium3DTileFeature, _content: Cesium3DTileContent): LngLat | null {
  try {
    // Try coordinate properties
    let lat: number | undefined, lng: number | undefined;
    for (const p of LAT_PROPS) { const v = feature.getProperty(p); if (typeof v === 'number') { lat = v; break; } }
    for (const p of LNG_PROPS) { const v = feature.getProperty(p); if (typeof v === 'number') { lng = v; break; } }
    if (lat !== undefined && lng !== undefined) return { lng, lat };

    // Try bounding sphere
    const f = feature as any;
    if (f._content?._model?.boundingSphere?.center) {
      return cartographicToLngLat(Cartographic.fromCartesian(f._content._model.boundingSphere.center));
    }

    // Try batch table
    if (f.content?.batchTable && f._batchId !== undefined) {
      const bt = f.content.batchTable;
      for (const p of LAT_PROPS) { const v = bt.getProperty?.(f._batchId, p); if (typeof v === 'number') { lat = v; break; } }
      for (const p of LNG_PROPS) { const v = bt.getProperty?.(f._batchId, p); if (typeof v === 'number') { lng = v; break; } }
      if (lat !== undefined && lng !== undefined) return { lng, lat };
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================================
// GeoJSON Loading
// ============================================================================

export async function loadGeoJSONFootprint(
  path: string,
  bufferMeters: number,
  bufferPositions: (pos: Cartesian3[], buf: number) => Cartesian3[]
): Promise<Cartesian3[][]> {
  try {
    const res = await fetch(path);
    if (!res.ok) { console.warn(`[tileClipping] Failed to fetch ${path}: ${res.status}`); return []; }

    const geojson = await res.json();
    const footprints: Cartesian3[][] = [];

    const extractCoords = (geom: any): number[][][] => {
      if (!geom) return [];
      if (geom.type === 'Polygon') return [geom.coordinates[0]];
      if (geom.type === 'MultiPolygon') return geom.coordinates.map((p: number[][][]) => p[0]);
      return [];
    };

    let geometries: any[] = [];
    if (geojson.type === 'FeatureCollection') geometries = geojson.features.map((f: any) => f.geometry);
    else if (geojson.type === 'Feature') geometries = [geojson.geometry];
    else if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') geometries = [geojson];

    for (const geom of geometries) {
      for (const coords of extractCoords(geom)) {
        if (coords.length < 3) continue;
        const positions = coords.map((c: number[]) => Cartesian3.fromDegrees(c[0], c[1], 0));
        footprints.push(bufferPositions(positions, bufferMeters).map(projectToSurface));
      }
    }
    return footprints;
  } catch (e) {
    console.error(`[tileClipping] Error loading ${path}:`, e);
    return [];
  }
}

// ============================================================================
// Style Updates
// ============================================================================

export function updateTilesetStyleWithExclusions(
  tileset: Cesium3DTileset,
  excludedIds: Set<string>,
  baseStyle?: Record<string, unknown>
): void {
  if (excludedIds.size === 0) {
    tileset.style = new Cesium3DTileStyle(baseStyle ?? { color: DEFAULT_TILE_STYLE });
    return;
  }

  const idArray = Array.from(excludedIds);
  const conditions = idArray.flatMap(id => ID_PROPS.map(prop => {
    const num = Number(id);
    return !isNaN(num)
      ? `(\${${prop}} === ${num} || \${${prop}} === ${JSON.stringify(id)})`
      : `\${${prop}} === ${JSON.stringify(id)}`;
  }));

  const show = `!(${conditions.join(' || ')})`;
  tileset.style = new Cesium3DTileStyle({ ...(baseStyle ?? { color: DEFAULT_TILE_STYLE }), show });
}

// ============================================================================
// Footprint Generation
// ============================================================================

/**
 * Returns buffered, surface-projected footprint for a model.
 * Priority: manual footprint → auto-extracted hull → bounding-sphere fallback.
 */
export function modelFootprint(
  model: Model,
  def: ModelDefinition | undefined,
  autoFootprint: Cartesian3[] | null | undefined,
  bufferMeters: number,
  bufferPositions: (pos: Cartesian3[], buf: number) => Cartesian3[]
): Cartesian3[] | null {
  let raw: Cartesian3[];

  if (def?.footprint && def.footprint.length >= 3) {
    raw = def.footprint.map(([lng, lat]) => Cartesian3.fromDegrees(lng, lat, 0));
  } else if (autoFootprint && autoFootprint.length >= 3) {
    raw = autoFootprint;
  } else {
    // Bounding sphere fallback
    const bs = model.boundingSphere;
    const r = Math.max(bs.radius, 1);
    const c = Cartographic.fromCartesian(bs.center);
    const lat = c ? c.latitude * RAD_TO_DEG : (def?.lat ?? 0);
    const lng = c ? c.longitude * RAD_TO_DEG : (def?.lng ?? 0);
    const dLat = r / 111320;
    const dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
    raw = Cartesian3.fromDegreesArray([
      lng + dLng, lat + dLat, lng - dLng, lat + dLat,
      lng - dLng, lat - dLat, lng + dLng, lat - dLat,
    ]);
  }

  return bufferPositions(raw, bufferMeters).map(projectToSurface);
}

// ============================================================================
// Tile Visibility Masking
// ============================================================================

/** Get tile center from various sources */
function getTileCenter(tile: any): LngLat | null {
  const bv = tile.boundingVolume;
  if (bv?.boundingSphere) {
    const c = Cartographic.fromCartesian(bv.boundingSphere.center);
    if (c) return cartographicToLngLat(c);
  }
  if ((bv as any)?.center) {
    const c = Cartographic.fromCartesian((bv as any).center);
    if (c) return cartographicToLngLat(c);
  }
  const t = tile._transform;
  if (t) {
    const c = Cartographic.fromCartesian(Cartesian3.fromElements(t[12], t[13], t[14], new Cartesian3()));
    if (c) return cartographicToLngLat(c);
  }
  return null;
}

/**
 * Set up tile-level visibility masking for tilesets.
 * Hides tiles whose center falls within mask polygons.
 */
function setupTileVisibilityMasking(
  tileset: Cesium3DTileset,
  tilesetLayer: ThreedTileLayer,
  newPolygons: LngLat[][]
): void {
  tilesetLayer.AccumulatedMaskPolygons ??= [];
  tilesetLayer.AccumulatedMaskPolygons.push(...newPolygons);

  if (tilesetLayer.VisibilityMaskingSetup) return;
  tilesetLayer.VisibilityMaskingSetup = true;

  tileset.tileVisible.addEventListener((tile) => {
    if (!tile.content) return;
    const polygons = tilesetLayer.AccumulatedMaskPolygons;
    if (!polygons?.length) return;

    const center = getTileCenter(tile);
    if (!center) return;

    for (const polygon of polygons) {
      if (pointInPolygon2D(center, polygon)) {
        tile.content.show = false;
        return;
      }
    }
    tile.content.show = true;
  });
}

// ============================================================================
// Debug Visualization
// ============================================================================

/** Creates a yellow debug polygon to visualize clipping footprints */
function createDebugPolygon(scene: Scene, positions: Cartesian3[], id: string): GroundPrimitive {
  const primitive = new GroundPrimitive({
    geometryInstances: new GeometryInstance({
      geometry: new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(positions) }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW.withAlpha(0.5)) },
      id
    }),
    appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
    asynchronous: false
  });
  scene.primitives.add(primitive);
  return primitive;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Cuts holes in tilesets using model footprints so 3D models show through.
 * Supports clipping polygons, tile visibility masking, and feature exclusion.
 */
export async function applyMask(
  scene: Scene,
  layer: ThreedTileLayer,
  allLayers: ThreedTileLayer[],
  bufferPositions: (pos: Cartesian3[], buf: number) => Cartesian3[]
): Promise<void> {
  const mask = layer.get('mask') as Record<string, number | MaskConfig> | undefined;
  if (!mask) return;

  const models = layer.CesiumModels;
  const modelDefs = (layer.get('models') as ModelDefinition[]) ?? [];
  const layerName = layer.get('name') as string ?? 'unknown';

  layer.CesiumClippingCollections ??= new Map();
  layer.ExcludedFeatureIds ??= new Map();
  layer.TileListenerRemovers ??= new Map();

  for (const [tilesetName, maskValue] of Object.entries(mask)) {
    const config = parseMaskConfig(maskValue);
    if (config.buffer == null || config.buffer < 0) continue;

    const tilesetLayer = allLayers.find(l => l.get('name') === tilesetName);
    const tileset = tilesetLayer?.CesiumTileset;
    if (!tileset) {
      console.warn(`[tileClipping] Tileset "${tilesetName}" not found`);
      continue;
    }

    // Build footprint polygons
    let footprints: Cartesian3[][];
    if (config.polygon) {
      footprints = await loadGeoJSONFootprint(config.polygon, config.buffer, bufferPositions);
      if (!footprints.length) continue;
    } else if (models?.length) {
      footprints = models
        .map((m, i) => modelFootprint(m, modelDefs[i], layer.CesiumModelFootprints?.[i], config.buffer, bufferPositions))
        .filter((p): p is Cartesian3[] => p !== null && p.length >= 3);
      if (!footprints.length) continue;
    } else {
      continue;
    }

    // Debug visualization
    if (DEBUG_SHOW_CLIPPING_POLYGONS && !layer.CesiumClippingCollections.has(tilesetName)) {
      footprints.forEach((pos, i) => createDebugPolygon(scene, pos, `debug-${layerName}-${i}`));
    }

    const footprintsLngLat = footprints.map(cartesian3ToLngLat);
    const newPolygons = footprints.map(pos => new ClippingPolygon({ positions: pos }));
    if (!newPolygons.length) continue;

    // Apply clipping polygons
    const alreadyContributed = layer.CesiumClippingCollections.has(tilesetName);
    if (tileset.clippingPolygons) {
      if (!alreadyContributed) {
        newPolygons.forEach(p => tileset.clippingPolygons!.add(p));
        layer.CesiumClippingCollections.set(tilesetName, tileset.clippingPolygons);
      }
    } else {
      const collection = new ClippingPolygonCollection({ polygons: newPolygons });
      layer.CesiumClippingCollections.set(tilesetName, collection);
      tileset.clippingPolygons = collection;
    }

    // Also apply tile visibility masking (for composite/instanced tilesets)
    setupTileVisibilityMasking(tileset, tilesetLayer, footprintsLngLat);

    // Handle removeIntersecting mode
    if (config.removeIntersecting && !layer.TileListenerRemovers.has(tilesetName)) {
      const excludedIds = new Set<string>();
      layer.ExcludedFeatureIds.set(tilesetName, excludedIds);
      const rawStyle = tilesetLayer?.get('style') as Record<string, unknown> | 'default' | undefined;
      const baseStyle = rawStyle && rawStyle !== 'default' ? rawStyle : undefined;

      const remover = tileset.tileLoad.addEventListener((tile) => {
        if (!tile.content) return;
        const content = tile.content as Cesium3DTileContent;
        const len = content.featuresLength ?? 0;
        let newExclusions = false;

        for (let i = 0; i < len; i++) {
          const feature = content.getFeature(i);
          if (!feature) continue;
          const id = getFeatureId(feature);
          if (!id || excludedIds.has(id)) continue;
          const center = getFeatureCenter(feature, content);
          if (!center) continue;

          for (const poly of footprintsLngLat) {
            if (pointInPolygon2D(center, poly)) {
              excludedIds.add(id);
              newExclusions = true;
              break;
            }
          }
        }

        if (newExclusions) updateTilesetStyleWithExclusions(tileset, excludedIds, baseStyle);
      });

      layer.TileListenerRemovers.set(tilesetName, remover);
    }
  }
}
