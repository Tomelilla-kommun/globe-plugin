import {
  Cesium3DTileset, Cesium3DTileFeature, Cesium3DTileContent, Cesium3DTileStyle,
  Cartesian3, Model, ClippingPolygon, ClippingPolygonCollection, Cartographic, Scene,
  GroundPrimitive, GeometryInstance, PolygonGeometry, PolygonHierarchy,
  ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Color, Matrix4
} from 'cesium';

const DEFAULT_TILE_STYLE = "color('white', 1)";

/** Set to true to visualize clipping polygons as yellow overlays */
const DEBUG_SHOW_CLIPPING_POLYGONS = false;

/** Set to true to log instance hiding details */
const DEBUG_INSTANCE_HIDING = true;

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
  /**
   * For instanced tilesets (I3DM) like trees: skip ClippingPolygons entirely and use
   * per-instance hiding based on show property. This is more reliable for instanced content
   * but requires iterating through all features.
   * Default: false
   */
  useInstanceHiding?: boolean;
}

export interface ParsedMaskConfig {
  buffer: number;
  removeIntersecting: boolean;
  polygon?: string;
  skipTileVisibilityMasking: boolean;
  useInstanceHiding: boolean;
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
  /** Stores the actual ClippingPolygon instances this layer contributed to each tileset */
  OwnClippingPolygons?: Map<string, ClippingPolygon[]>;
  /** Stores the LngLat footprints this layer contributed for tile visibility masking */
  OwnMaskPolygons?: Map<string, LngLat[][]>;
  ExcludedFeatureIds?: Map<string, Set<string>>;
  TileListenerRemovers?: Map<string, () => void>;
  /** Stores tileVisible listener removers for instance hiding */
  InstanceHidingRemovers?: Map<string, () => void>;
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
  if (typeof value === 'number') return { buffer: value, removeIntersecting: false, skipTileVisibilityMasking: false, useInstanceHiding: false };
  return { 
    buffer: value.buffer ?? 0, 
    removeIntersecting: value.removeIntersecting ?? false, 
    polygon: value.polygon,
    skipTileVisibilityMasking: value.skipTileVisibilityMasking ?? false,
    useInstanceHiding: value.useInstanceHiding ?? false
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
// Instance Hiding (for I3DM/composite tilesets)
// ============================================================================

/**
 * Get the world position of a feature/instance, handling I3DM instanced content.
 * Returns position as Cartesian3 or null if not determinable.
 */
function getFeatureWorldPosition(feature: Cesium3DTileFeature, content: Cesium3DTileContent): Cartesian3 | null {
  try {
    const f = feature as any;
    const c = f._content ?? f.content ?? content;
    
    // For I3DM: try various ways to get the instance position
    
    // Method 1: Check for computed bounding volume per feature
    if (f._boundingVolume?.boundingSphere?.center) {
      return f._boundingVolume.boundingSphere.center;
    }
    
    // Method 2: Try to compute from the tile's model and instance data
    const model = c?._model;
    if (model && f._batchId !== undefined) {
      // Check for instancing data
      const structuralMetadata = c._structuralMetadata ?? model._structuralMetadata;
      if (structuralMetadata) {
        // Try to get position from EXT_mesh_gpu_instancing or similar
        const table = structuralMetadata._propertyTables?.[0];
        if (table) {
          const translation = table.getProperty?.(f._batchId, 'TRANSLATION');
          if (translation && translation.length >= 3) {
            // Translation is relative to tile origin
            const tileTransform = c._tile?.computedTransform;
            if (tileTransform) {
              const localPos = Cartesian3.fromArray(translation);
              return Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
            }
          }
        }
      }
      
      // Method 3: Check for instance transforms array
      if (c._instances) {
        const instanceTransform = c._instances[f._batchId]?.transform;
        if (instanceTransform) {
          return Cartesian3.fromElements(
            instanceTransform[12],
            instanceTransform[13],
            instanceTransform[14],
            new Cartesian3()
          );
        }
      }
    }
    
    // Method 4: For composite tiles, try to get from the individual primitive
    if (c._contents) {
      for (const subContent of c._contents) {
        const pos = getFeatureWorldPosition(feature, subContent);
        if (pos) return pos;
      }
    }
    
    // Method 5: Fall back to tile center with some offset based on batch ID
    // This is a last resort - not ideal but better than nothing
    const tile = c._tile ?? c.tile;
    if (tile?.boundingSphere?.center && f._batchId !== undefined) {
      // Use tile center as approximation
      return tile.boundingSphere.center;
    }
    
  } catch (e) {
    // Ignore errors in position extraction
  }
  return null;
}

/**
 * Set up per-instance hiding for instanced tilesets.
 * Uses tileVisible event to check and hide individual features within each tile.
 * Handles composite tiles by recursively processing inner contents.
 */
function setupInstanceHiding(
  tileset: Cesium3DTileset,
  maskPolygons: LngLat[][],
  layer: ThreedTileLayer,
  tilesetName: string
): () => void {
  let debugLogCount = 0;
  const MAX_DEBUG_LOGS = 10;
  
  const processContent = (content: any, depth = 0, parentUrl = ''): void => {
    if (!content) return;
    
    const contentUrl = content._url ?? content.url ?? content._resource?.url ?? '';
    const shouldDebug = DEBUG_INSTANCE_HIDING && debugLogCount < MAX_DEBUG_LOGS;
    
    // For composite tiles, process inner contents recursively FIRST
    const innerContents = content._contents ?? content.innerContents ?? content._innerContents;
    if (innerContents && Array.isArray(innerContents) && innerContents.length > 0) {
      if (shouldDebug) {
        console.log(`[tileClipping] Composite tile at depth ${depth} with ${innerContents.length} inner contents`);
        debugLogCount++;
      }
      for (let idx = 0; idx < innerContents.length; idx++) {
        const inner = innerContents[idx];
        processContent(inner, depth + 1, `composite[${idx}]`);
      }
      // DO NOT process features at the composite level - only process inner contents
      // The composite's featuresLength sums all inner content features, but getFeature
      // returns features that may belong to different inner models
      return;
    }
    
    // Process features at this content level (only for non-composite/leaf content)
    const featuresLength = content.featuresLength ?? 0;
    
    if (shouldDebug && featuresLength > 0) {
      console.log(`[tileClipping] Leaf content at depth ${depth} (${parentUrl || contentUrl || 'unknown'}): ${featuresLength} features`);
      debugLogCount++;
      
      // Log model info
      const model = content._model ?? content.model;
      if (model) {
        const loaderComponents = model._loader?.components;
        console.log(`[tileClipping] Model info:`, {
          url: model._resource?.url ?? 'unknown',
          hasInstancingTransforms: !!model._instancingTransforms,
          hasTranslationBuffer: !!(model._instancingTranslationBuffer || model._translationBuffer),
          hasSceneGraph: !!model._sceneGraph,
          instanceCount: model._instanceCount ?? 'unknown',
          loaderInstances: !!loaderComponents?.instances,
          translationsLength: loaderComponents?.instances?.translations?.length ?? 0
        });
      }
    }
    
    for (let i = 0; i < featuresLength; i++) {
      const feature = content.getFeature?.(i);
      if (!feature) continue;
      
      // Try multiple methods to get the feature position
      let center: LngLat | null = null;
      let method = '';
      
      // Method 1: getFeatureCenter (enhanced for I3DM)
      center = getFeatureCenter(feature, content);
      if (center) method = 'getFeatureCenter';
      
      // Method 2: Get world position and convert
      if (!center) {
        const worldPos = getFeatureWorldPosition(feature, content);
        if (worldPos) {
          const carto = Cartographic.fromCartesian(worldPos);
          if (carto) {
            center = { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
            method = 'getFeatureWorldPosition';
          }
        }
      }
      
      // Method 3: Try to get position from the model's instancing data directly
      if (!center) {
        center = getInstancePositionFromModel(feature, content, i);
        if (center) method = 'getInstancePositionFromModel';
      }
      
      // Method 4: Try to get from the tile's computed transform directly
      if (!center) {
        const tile = (content as any)._tile ?? (content as any).tile;
        if (tile?.computedTransform) {
          // Get feature's local position if available, otherwise use tile origin
          const batchId = (feature as any)._batchId ?? i;
          center = getPositionFromTileTransform(content, tile, batchId);
          if (center) method = 'tileTransform';
        }
      }
      
      if (shouldDebug && i < 3) {
        console.log(`[tileClipping] Feature ${i} (batchId: ${(feature as any)._batchId}): center=${center ? `{lng:${center.lng.toFixed(6)}, lat:${center.lat.toFixed(6)}}` : 'null'} via ${method || 'none'}`);
      }
      
      if (!center) {
        if (shouldDebug && i === 0) {
          console.log(`[tileClipping] WARNING: Could not get position for feature ${i}`);
        }
        continue;
      }
      
      // Check if this feature falls within any mask polygon
      let shouldHide = false;
      for (const polygon of maskPolygons) {
        if (pointInPolygon2D(center, polygon)) {
          shouldHide = true;
          break;
        }
      }
      
      // Hide or show the feature
      feature.show = !shouldHide;
    }
  };
  
  const remover = tileset.tileVisible.addEventListener((tile) => {
    if (!tile.content) return;
    processContent(tile.content, 0, tile._contentResource?.url ?? '');
  });
  
  return remover;
}

/**
 * Try to get position from the tile's transform combined with local instance data.
 */
function getPositionFromTileTransform(
  content: any,
  tile: any,
  instanceIndex: number
): LngLat | null {
  try {
    const model = content._model ?? content.model;
    if (!model) return null;
    
    const tileTransform = tile.computedTransform ?? tile._computedTransform;
    if (!tileTransform) return null;
    
    // Try to find instance translation data in various places
    const sources = [
      // EXT_mesh_gpu_instancing translations
      model._loader?.components?.instances?.translations,
      // glTF structural metadata
      content._structuralMetadata?.propertyTables?.[0],
      // Model instances
      model._sceneGraph?.components?.instances?.translations,
    ];
    
    for (const source of sources) {
      if (!source) continue;
      
      // If it's a typed array or regular array
      if (source.length && instanceIndex * 3 + 2 < source.length) {
        const localPos = Cartesian3.fromElements(
          source[instanceIndex * 3],
          source[instanceIndex * 3 + 1],
          source[instanceIndex * 3 + 2],
          new Cartesian3()
        );
        
        const worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
        const carto = Cartographic.fromCartesian(worldPos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
      
      // If it's a property table with getProperty
      if (typeof source.getProperty === 'function') {
        const translation = source.getProperty(instanceIndex, 'TRANSLATION') ?? 
                           source.getProperty(instanceIndex, 'translation');
        if (translation && translation.length >= 3) {
          const localPos = Cartesian3.fromArray(translation);
          const worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
          const carto = Cartographic.fromCartesian(worldPos);
          if (carto) {
            return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
          }
        }
      }
    }
    
    // Last resort: try to get from model's raw glTF data
    if (model._loader?._gltfJson?.extensions?.EXT_mesh_gpu_instancing) {
      // This would require more complex parsing...
    }
    
  } catch (e) {
    // Ignore
  }
  return null;
}

/**
 * Try to extract instance position from the model's GPU instancing data.
 * This handles EXT_mesh_gpu_instancing and similar extensions.
 */
function getInstancePositionFromModel(
  feature: Cesium3DTileFeature,
  content: Cesium3DTileContent,
  instanceIndex: number
): LngLat | null {
  try {
    const f = feature as any;
    const c = content as any;
    const model = c._model ?? c.model;
    
    if (!model) return null;
    
    // Try to get the tile's computed transform
    const tile = c._tile ?? c.tile;
    const tileTransform = tile?.computedTransform ?? tile?._computedTransform;
    
    const batchId = f._batchId ?? instanceIndex;
    
    // Method 1: Check model._loader?.components?.instances
    // This is where Cesium stores EXT_mesh_gpu_instancing data for glTF 2.0
    const loaderComponents = model._loader?.components;
    if (loaderComponents?.instances) {
      const instances = loaderComponents.instances;
      const translations = instances.translations;
      if (translations && translations.length > batchId * 3 + 2) {
        const localPos = Cartesian3.fromElements(
          translations[batchId * 3],
          translations[batchId * 3 + 1],
          translations[batchId * 3 + 2],
          new Cartesian3()
        );
        
        let worldPos = localPos;
        if (tileTransform) {
          worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
        }
        
        const carto = Cartographic.fromCartesian(worldPos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
    }
    
    // Method 2: Check model._sceneGraph for runtime node instances
    if (model._sceneGraph?._runtimeNodes) {
      for (const node of model._sceneGraph._runtimeNodes) {
        // Check instancing on the node
        const nodeInstances = node._runtimeInstances ?? node._instances;
        if (nodeInstances && nodeInstances.length > batchId) {
          const instance = nodeInstances[batchId];
          if (instance?.translation) {
            let pos = instance.translation;
            if (tileTransform) {
              pos = Matrix4.multiplyByPoint(tileTransform, pos, new Cartesian3());
            }
            const carto = Cartographic.fromCartesian(pos);
            if (carto) {
              return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
            }
          }
          if (instance?.transform) {
            const t = instance.transform;
            let pos: Cartesian3;
            if (t instanceof Matrix4) {
              pos = Matrix4.getTranslation(t, new Cartesian3());
            } else if (Array.isArray(t) && t.length >= 16) {
              pos = Cartesian3.fromElements(t[12], t[13], t[14], new Cartesian3());
            } else {
              continue;
            }
            if (tileTransform) {
              pos = Matrix4.multiplyByPoint(tileTransform, pos, new Cartesian3());
            }
            const carto = Cartographic.fromCartesian(pos);
            if (carto) {
              return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
            }
          }
        }
        
        // Also check for typed array translations
        if (node._instancingTranslations) {
          const translations = node._instancingTranslations;
          if (translations.length > batchId * 3 + 2) {
            const localPos = Cartesian3.fromElements(
              translations[batchId * 3],
              translations[batchId * 3 + 1],
              translations[batchId * 3 + 2],
              new Cartesian3()
            );
            
            let worldPos = localPos;
            if (tileTransform) {
              worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
            }
            
            const carto = Cartographic.fromCartesian(worldPos);
            if (carto) {
              return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
            }
          }
        }
      }
    }
    
    // Method 3: Check model._instancingTransforms (array of matrices)
    if (model._instancingTransforms) {
      const transforms = model._instancingTransforms;
      if (transforms[batchId]) {
        const t = transforms[batchId];
        // Extract translation from 4x4 matrix (column-major: indices 12, 13, 14)
        let pos: Cartesian3;
        if (Array.isArray(t)) {
          pos = Cartesian3.fromElements(t[12], t[13], t[14], new Cartesian3());
        } else if (t.translation) {
          pos = t.translation;
        } else if (t instanceof Matrix4) {
          pos = Matrix4.getTranslation(t, new Cartesian3());
        } else {
          return null;
        }
        
        // Transform to world coordinates if needed
        if (tileTransform) {
          pos = Matrix4.multiplyByPoint(tileTransform, pos, new Cartesian3());
        }
        
        const carto = Cartographic.fromCartesian(pos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
    }
    
    // Method 4: Check for instancingTranslationBuffer
    if (model._instancingTranslationBuffer || model._translationBuffer) {
      const buffer = model._instancingTranslationBuffer ?? model._translationBuffer;
      // Each translation is 3 floats (x, y, z)
      const offset = batchId * 3;
      if (buffer.length > offset + 2) {
        const localPos = Cartesian3.fromElements(buffer[offset], buffer[offset + 1], buffer[offset + 2], new Cartesian3());
        
        // Transform to world coordinates
        let worldPos = localPos;
        if (tileTransform) {
          worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
        }
        
        const carto = Cartographic.fromCartesian(worldPos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
    }
    
    // Method 5: Check for feature tables (glTF-based / I3DM)
    if (c._featureTable) {
      const ft = c._featureTable;
      
      // Check for POSITION semantic
      const positions = ft.getPropertyArray?.('POSITION') ?? ft._properties?.POSITION;
      if (positions && positions.length > batchId * 3 + 2) {
        const localPos = Cartesian3.fromElements(
          positions[batchId * 3],
          positions[batchId * 3 + 1],
          positions[batchId * 3 + 2],
          new Cartesian3()
        );
        
        // Add RTC center if present
        let worldPos = localPos;
        const rtcCenter = c._rtcCenter ?? ft._rtcCenter;
        if (rtcCenter) {
          worldPos = Cartesian3.add(rtcCenter, localPos, new Cartesian3());
        } else if (tileTransform) {
          worldPos = Matrix4.multiplyByPoint(tileTransform, localPos, new Cartesian3());
        }
        
        const carto = Cartographic.fromCartesian(worldPos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
    }
    
    // Method 6: Try model.instances (older API)
    if (model.instances && model.instances.length > batchId) {
      const instance = model.instances[batchId];
      if (instance?.modelMatrix) {
        let pos = Cartesian3.fromElements(
          instance.modelMatrix[12],
          instance.modelMatrix[13],
          instance.modelMatrix[14],
          new Cartesian3()
        );
        if (tileTransform) {
          pos = Matrix4.multiplyByPoint(tileTransform, pos, new Cartesian3());
        }
        const carto = Cartographic.fromCartesian(pos);
        if (carto) {
          return { lng: carto.longitude * RAD_TO_DEG, lat: carto.latitude * RAD_TO_DEG };
        }
      }
    }
    
  } catch (e) {
    // Ignore extraction errors
  }
  return null;
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
  layer.InstanceHidingRemovers ??= new Map();
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

    // For instanced tilesets: use per-instance hiding instead of clipping polygons
    if (config.useInstanceHiding) {
      if (!layer.InstanceHidingRemovers!.has(tilesetName)) {
        const remover = setupInstanceHiding(tileset, footprintsLngLat, layer, tilesetName);
        layer.InstanceHidingRemovers!.set(tilesetName, remover);
      }
      // Skip ClippingPolygon setup for instance hiding mode
      continue;
    }

    // Apply clipping polygons (standard mode)
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

    // Remove instance hiding listener if it exists
    const instanceHidingRemover = layer.InstanceHidingRemovers?.get(tilesetName);
    if (instanceHidingRemover) {
      instanceHidingRemover();
      layer.InstanceHidingRemovers!.delete(tilesetName);
      // Reset feature visibility for this tileset - traverse all visible tiles
      if (tileset) {
        try {
          // Use tilesetTraversal to reset all features to visible
          const resetVisibility = (tile: any) => {
            if (tile.content && tile.content.featuresLength) {
              for (let i = 0; i < tile.content.featuresLength; i++) {
                const feature = tile.content.getFeature(i);
                if (feature) feature.show = true;
              }
            }
            tile.children?.forEach(resetVisibility);
          };
          if (tileset.root) resetVisibility(tileset.root);
        } catch { /* ignore traversal errors */ }
      }
    }

    if (!tileset?.clippingPolygons) continue;

    // Remove this layer's clipping polygons from the tileset
    for (const polygon of polygons) {
      tileset.clippingPolygons.remove(polygon);
    }

    // Remove this layer's mask polygons from tile visibility masking
    const layerMaskPolygons = ownMaskPolygons?.get(tilesetName);
    if (tilesetLayer?.AccumulatedMaskPolygons && layerMaskPolygons) {
      for (const maskPoly of layerMaskPolygons) {
        const idx = tilesetLayer.AccumulatedMaskPolygons.findIndex(
          p => p.length === maskPoly.length && p.every((pt, i) => 
            Math.abs(pt.lng - maskPoly[i].lng) < 1e-9 && Math.abs(pt.lat - maskPoly[i].lat) < 1e-9
          )
        );
        if (idx !== -1) {
          tilesetLayer.AccumulatedMaskPolygons.splice(idx, 1);
        }
      }
    }

    // Disable removeIntersecting style exclusions
    const excludedIds = layer.ExcludedFeatureIds?.get(tilesetName);
    if (excludedIds?.size) {
      const rawStyle = tilesetLayer?.get('style') as Record<string, unknown> | 'default' | undefined;
      const baseStyle = rawStyle && rawStyle !== 'default' ? rawStyle : undefined;
      // Temporarily clear exclusions (they're preserved in layer.ExcludedFeatureIds for re-enable)
      updateTilesetStyleWithExclusions(tileset, new Set(), baseStyle);
    }

    // Remove tile load listener
    const remover = layer.TileListenerRemovers?.get(tilesetName);
    if (remover) {
      remover();
      layer.TileListenerRemovers!.delete(tilesetName);
    }
  }
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

    // Get mask config for this tileset
    const maskValue = mask[tilesetName];
    const config = parseMaskConfig(maskValue);
    const layerMaskPolygons = ownMaskPolygons?.get(tilesetName);

    // Re-setup instance hiding if that mode was used
    if (config.useInstanceHiding) {
      if (!layer.InstanceHidingRemovers?.has(tilesetName) && layerMaskPolygons) {
        layer.InstanceHidingRemovers ??= new Map();
        const remover = setupInstanceHiding(tileset, layerMaskPolygons, layer, tilesetName);
        layer.InstanceHidingRemovers.set(tilesetName, remover);
      }
      continue; // Skip clipping polygon setup for instance hiding mode
    }

    // Re-add clipping polygons
    if (tileset.clippingPolygons) {
      for (const polygon of polygons) {
        if (!tileset.clippingPolygons.contains(polygon)) {
          tileset.clippingPolygons.add(polygon);
        }
      }
    } else {
      tileset.clippingPolygons = new ClippingPolygonCollection({ polygons });
    }

    // Re-add mask polygons for tile visibility masking (unless skipTileVisibilityMasking)
    if (tilesetLayer && layerMaskPolygons && !config.skipTileVisibilityMasking) {
      tilesetLayer.AccumulatedMaskPolygons ??= [];
      tilesetLayer.AccumulatedMaskPolygons.push(...layerMaskPolygons);
    }

    // Re-apply excluded feature IDs
    if (config.removeIntersecting) {
      const excludedIds = layer.ExcludedFeatureIds?.get(tilesetName);
      if (excludedIds?.size) {
        const rawStyle = tilesetLayer?.get('style') as Record<string, unknown> | 'default' | undefined;
        const baseStyle = rawStyle && rawStyle !== 'default' ? rawStyle : undefined;
        updateTilesetStyleWithExclusions(tileset, excludedIds, baseStyle);
      }

      // Re-add tile load listener for new features
      if (!layer.TileListenerRemovers?.has(tilesetName)) {
        const footprintsLngLat = layerMaskPolygons ?? [];
        const rawStyle = tilesetLayer?.get('style') as Record<string, unknown> | 'default' | undefined;
        const baseStyle = rawStyle && rawStyle !== 'default' ? rawStyle : undefined;
        const excludedIdsSet = excludedIds ?? new Set<string>();

        const remover = tileset.tileLoad.addEventListener((tile) => {
          if (!tile.content) return;
          const content = tile.content as Cesium3DTileContent;
          const len = content.featuresLength ?? 0;
          let newExclusions = false;

          for (let i = 0; i < len; i++) {
            const feature = content.getFeature(i);
            if (!feature) continue;
            const id = getFeatureId(feature);
            if (!id || excludedIdsSet.has(id)) continue;
            const center = getFeatureCenter(feature, content);
            if (!center) continue;

            for (const poly of footprintsLngLat) {
              if (pointInPolygon2D(center, poly)) {
                excludedIdsSet.add(id);
                newExclusions = true;
                break;
              }
            }
          }

          if (newExclusions) updateTilesetStyleWithExclusions(tileset, excludedIdsSet, baseStyle);
        });

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
