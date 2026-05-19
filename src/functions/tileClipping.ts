import {
  Cesium3DTileset, Cesium3DTileFeature, Cesium3DTileContent, Cesium3DTileStyle,
  Cartesian3, Model, ClippingPolygon, ClippingPolygonCollection, Cartographic, Scene,
  GroundPrimitive, GeometryInstance, PolygonGeometry, PolygonHierarchy,
  ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Color, Matrix4
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
  /** 
   * Skip tile-level visibility masking (which hides entire tiles based on tile center).
   * Use this for composite/instanced tilesets like trees where tile centers don't represent
   * individual instance positions. ClippingPolygons will still clip individual geometry.
   * Default: false
   */
  skipTileVisibilityMasking?: boolean;
}

export interface ParsedMaskConfig {
  buffer: number;
  removeIntersecting: boolean;
  polygon?: string;
  skipTileVisibilityMasking: boolean;
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
  /** Enable animation playback for this model */
  animation?: boolean;
  /** Duration in seconds for one complete animation loop. If not specified, uses model's native speed. */
  animationDuration?: number;
}

export interface ThreedTileLayer {
  get: <T = unknown>(key: string) => T;
  CesiumTileset?: Cesium3DTileset;
  CesiumModels?: Model[];
  CesiumModelFootprints?: Array<Cartesian3[] | null>;
  CesiumClippingCollections?: Map<string, ClippingPolygonCollection>;
  /** Stores the actual ClippingPolygon instances this layer contributed to each tileset */
  OwnClippingPolygons?: Map<string, ClippingPolygon[]>;
  /** Stores the LngLat footprints this layer contributed for tile visibility masking */
  OwnMaskPolygons?: Map<string, LngLat[][]>;
  ExcludedFeatureIds?: Map<string, Set<string>>;
  TileListenerRemovers?: Map<string, () => void>;

  AccumulatedMaskPolygons?: Array<Array<LngLat>>;
  VisibilityMaskingSetup?: boolean;
  /** Tracks whether this layer's mask is currently enabled */
  MaskEnabled?: boolean;
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
  if (typeof value === 'number') return { buffer: value, removeIntersecting: false, skipTileVisibilityMasking: false };
  return { 
    buffer: value.buffer ?? 0, 
    removeIntersecting: value.removeIntersecting ?? false, 
    polygon: value.polygon,
    skipTileVisibilityMasking: value.skipTileVisibilityMasking ?? false
  };
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
    // Try coordinate properties first
    let lat: number | undefined, lng: number | undefined;
    for (const p of LAT_PROPS) { const v = feature.getProperty(p); if (typeof v === 'number') { lat = v; break; } }
    for (const p of LNG_PROPS) { const v = feature.getProperty(p); if (typeof v === 'number') { lng = v; break; } }
    if (lat !== undefined && lng !== undefined) return { lng, lat };

    // Try to get instance transform position (for I3DM instanced tilesets like trees)
    const f = feature as any;
    
    // Try getting position from the feature's computed transform
    if (typeof f.getPolylinePositions === 'function' || f._batchId !== undefined) {
      const content = f._content ?? f.content;
      
      // For I3DM: try to get the instance's model matrix
      if (content?._model?._instancingTranslationBuffer || content?._modelInstances) {
        // Some I3DM implementations store translations directly
        const instances = content._modelInstances;
        if (instances && f._batchId < instances.length) {
          const instance = instances[f._batchId];
          if (instance?.modelMatrix) {
            const pos = Cartesian3.fromElements(
              instance.modelMatrix[12],
              instance.modelMatrix[13], 
              instance.modelMatrix[14],
              new Cartesian3()
            );
            const c = Cartographic.fromCartesian(pos);
            if (c) return { lng: c.longitude * RAD_TO_DEG, lat: c.latitude * RAD_TO_DEG };
          }
        }
      }
      
      // Try getting from the tile's RTC (relative-to-center) combined with instance offset
      if (content?._rtcCenter && content?._batchTable) {
        const bt = content._batchTable;
        // Check for POSITION or POSITION_CARTOGRAPHIC semantic
        const pos3 = bt.getProperty?.(f._batchId, 'POSITION') ?? 
                     bt.getProperty?.(f._batchId, '_BATCHID_POSITION');
        if (pos3 && Array.isArray(pos3) && pos3.length >= 3) {
          const rtc = content._rtcCenter;
          const worldPos = Cartesian3.add(rtc, Cartesian3.fromArray(pos3), new Cartesian3());
          const c = Cartographic.fromCartesian(worldPos);
          if (c) return { lng: c.longitude * RAD_TO_DEG, lat: c.latitude * RAD_TO_DEG };
        }
      }
    }

    // Try bounding sphere
    if (f._content?._model?.boundingSphere?.center) {
      return cartographicToLngLat(Cartographic.fromCartesian(f._content._model.boundingSphere.center));
    }

    // Try batch table properties
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

/** Get tile center from bounding volume or transform */
function getTileCenter(tile: any): LngLat | null {
  const bv = tile.boundingVolume;
  
  // Try bounding sphere center
  const sphereCenter = bv?.boundingSphere?.center ?? bv?.center;
  if (sphereCenter) {
    const c = Cartographic.fromCartesian(sphereCenter);
    if (c) return cartographicToLngLat(c);
  }
  
  // Fall back to tile transform
  const t = tile._transform;
  if (t) {
    const c = Cartographic.fromCartesian(Cartesian3.fromElements(t[12], t[13], t[14], new Cartesian3()));
    if (c) return cartographicToLngLat(c);
  }
  
  return null;
}

/** Check if a point should be hidden by any mask polygon */
function isInsideMask(center: LngLat, polygons: LngLat[][]): boolean {
  for (const polygon of polygons) {
    if (pointInPolygon2D(center, polygon)) return true;
  }
  return false;
}

/** Traverse all tiles in a tileset and apply a callback */
function forEachTile(tileset: Cesium3DTileset, callback: (tile: any) => void): void {
  const ts = tileset as any;
  const root = ts.root ?? ts._root;
  if (!root) return;
  
  const stack = [root];
  while (stack.length > 0) {
    const tile = stack.pop();
    if (!tile) continue;
    
    callback(tile);
    
    const children = tile.children ?? tile._children;
    if (children && Array.isArray(children)) {
      stack.push(...children);
    }
  }
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
    if (!polygons?.length) {
      tile.content.show = true;
      return;
    }

    const center = getTileCenter(tile);
    tile.content.show = !center || !isInsideMask(center, polygons);
  });
}

/**
 * Update visibility for all loaded tiles based on current mask polygons.
 * Called when mask polygons change to update already-loaded tiles.
 */
function updateAllTileVisibility(tileset: Cesium3DTileset, maskPolygons: LngLat[][] | undefined): void {
  const hasPolygons = maskPolygons && maskPolygons.length > 0;
  
  forEachTile(tileset, (tile) => {
    if (!tile.content) return;
    
    if (!hasPolygons) {
      tile.content.show = true;
    } else {
      const center = getTileCenter(tile);
      tile.content.show = !center || !isInsideMask(center, maskPolygons);
    }
  });
  
  // Trigger style refresh for any tiles that load later
  const ts = tileset as any;
  if (typeof ts.makeStyleDirty === 'function') {
    ts.makeStyleDirty();
  }
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
  layer.OwnClippingPolygons ??= new Map();
  layer.OwnMaskPolygons ??= new Map();
  layer.MaskEnabled = true;

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

    // Store this layer's own polygons for later enable/disable
    layer.OwnClippingPolygons!.set(tilesetName, newPolygons);
    layer.OwnMaskPolygons!.set(tilesetName, footprintsLngLat);

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

    // Apply tile visibility masking (optional - skip for composite/instanced tilesets like trees)
    if (!config.skipTileVisibilityMasking) {
      setupTileVisibilityMasking(tileset, tilesetLayer, footprintsLngLat);
    }

    // Handle removeIntersecting mode
    if (config.removeIntersecting && !layer.TileListenerRemovers.has(tilesetName)) {
      const excludedIds = new Set<string>();
      layer.ExcludedFeatureIds.set(tilesetName, excludedIds);
      const baseStyle = getBaseStyle(tilesetLayer);
      const remover = createTileLoadListener(tileset, excludedIds, footprintsLngLat, baseStyle);
      layer.TileListenerRemovers.set(tilesetName, remover);
    }
  }
}

/** Remove mask polygons from accumulated list */
function removeMaskPolygons(accumulated: LngLat[][] | undefined, toRemove: LngLat[][]): void {
  if (!accumulated) return;
  
  for (const maskPoly of toRemove) {
    const idx = accumulated.findIndex(p => 
      p.length === maskPoly.length && 
      p.every((pt, i) => 
        Math.abs(pt.lng - maskPoly[i].lng) < 1e-9 && 
        Math.abs(pt.lat - maskPoly[i].lat) < 1e-9
      )
    );
    if (idx !== -1) accumulated.splice(idx, 1);
  }
}

/** Get base style for a tileset layer */
function getBaseStyle(tilesetLayer: ThreedTileLayer | undefined): Record<string, unknown> | undefined {
  const rawStyle = tilesetLayer?.get('style') as Record<string, unknown> | 'default' | undefined;
  return rawStyle && rawStyle !== 'default' ? rawStyle : undefined;
}

/**
 * Disables clipping masks for a layer without destroying the stored polygon data.
 * Call this when a GLB model layer is hidden (visible: false).
 */
export function disableMask(
  layer: ThreedTileLayer,
  allLayers: ThreedTileLayer[]
): void {
  if (!layer.MaskEnabled) return;
  layer.MaskEnabled = false;

  const ownPolygons = layer.OwnClippingPolygons;
  const ownMaskPolygons = layer.OwnMaskPolygons;
  if (!ownPolygons?.size) return;

  for (const [tilesetName, polygons] of ownPolygons) {
    const tilesetLayer = allLayers.find(l => l.get('name') === tilesetName);
    const tileset = tilesetLayer?.CesiumTileset;
    if (!tileset?.clippingPolygons) continue;

    // Remove clipping polygons
    polygons.forEach(p => tileset.clippingPolygons!.remove(p));

    // Remove mask polygons and update tile visibility
    const layerMaskPolygons = ownMaskPolygons?.get(tilesetName);
    if (tilesetLayer?.AccumulatedMaskPolygons && layerMaskPolygons) {
      removeMaskPolygons(tilesetLayer.AccumulatedMaskPolygons, layerMaskPolygons);
      updateAllTileVisibility(tileset, tilesetLayer.AccumulatedMaskPolygons);
    }

    // Clear style exclusions (preserved in ExcludedFeatureIds for re-enable)
    const excludedIds = layer.ExcludedFeatureIds?.get(tilesetName);
    if (excludedIds?.size) {
      updateTilesetStyleWithExclusions(tileset, new Set(), getBaseStyle(tilesetLayer));
    }

    // Remove tile load listener
    const remover = layer.TileListenerRemovers?.get(tilesetName);
    if (remover) {
      remover();
      layer.TileListenerRemovers!.delete(tilesetName);
    }
  }
}

/** Create tile load listener for removeIntersecting mode */
function createTileLoadListener(
  tileset: Cesium3DTileset,
  excludedIds: Set<string>,
  footprints: LngLat[][],
  baseStyle: Record<string, unknown> | undefined
): () => void {
  return tileset.tileLoad.addEventListener((tile) => {
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
      if (center && isInsideMask(center, footprints)) {
        excludedIds.add(id);
        newExclusions = true;
      }
    }

    if (newExclusions) updateTilesetStyleWithExclusions(tileset, excludedIds, baseStyle);
  });
}

/**
 * Re-enables clipping masks for a layer using stored polygon data.
 * Call this when a GLB model layer is shown again (visible: true).
 */
export function enableMask(
  layer: ThreedTileLayer,
  allLayers: ThreedTileLayer[]
): void {
  if (layer.MaskEnabled) return;
  layer.MaskEnabled = true;

  const ownPolygons = layer.OwnClippingPolygons;
  const ownMaskPolygons = layer.OwnMaskPolygons;
  if (!ownPolygons?.size) return;

  const mask = layer.get('mask') as Record<string, number | MaskConfig> | undefined;
  if (!mask) return;

  for (const [tilesetName, polygons] of ownPolygons) {
    const tilesetLayer = allLayers.find(l => l.get('name') === tilesetName);
    const tileset = tilesetLayer?.CesiumTileset;
    if (!tileset) continue;

    const config = parseMaskConfig(mask[tilesetName]);
    const layerMaskPolygons = ownMaskPolygons?.get(tilesetName);

    // Re-add clipping polygons
    if (tileset.clippingPolygons) {
      polygons.forEach(p => {
        if (!tileset.clippingPolygons!.contains(p)) tileset.clippingPolygons!.add(p);
      });
    } else {
      tileset.clippingPolygons = new ClippingPolygonCollection({ polygons });
    }

    // Re-add mask polygons and update tile visibility
    if (tilesetLayer && layerMaskPolygons && !config.skipTileVisibilityMasking) {
      tilesetLayer.AccumulatedMaskPolygons ??= [];
      tilesetLayer.AccumulatedMaskPolygons.push(...layerMaskPolygons);
      updateAllTileVisibility(tileset, tilesetLayer.AccumulatedMaskPolygons);
    }

    // Re-apply style exclusions and tile load listener
    if (config.removeIntersecting) {
      const excludedIds = layer.ExcludedFeatureIds?.get(tilesetName) ?? new Set<string>();
      const baseStyle = getBaseStyle(tilesetLayer);
      
      if (excludedIds.size) {
        updateTilesetStyleWithExclusions(tileset, excludedIds, baseStyle);
      }

      if (!layer.TileListenerRemovers?.has(tilesetName)) {
        const remover = createTileLoadListener(tileset, excludedIds, layerMaskPolygons ?? [], baseStyle);
        layer.TileListenerRemovers ??= new Map();
        layer.TileListenerRemovers.set(tilesetName, remover);
      }
    }
  }
}

/**
 * Toggles the mask on/off based on visibility state.
 * @param visible - true to enable mask, false to disable
 */
export function toggleMask(
  layer: ThreedTileLayer,
  allLayers: ThreedTileLayer[],
  visible: boolean
): void {
  if (visible) {
    enableMask(layer, allLayers);
  } else {
    disableMask(layer, allLayers);
  }
}
