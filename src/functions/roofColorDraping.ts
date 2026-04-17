/**
 * Roof Color Draping for 3D Tiles
 * 
 * Applies ortofoto texture or solid colors to roof surfaces of 3D tilesets.
 * Uses CustomShader with normal-based roof detection.
 */

import {
  Scene,
  Cesium3DTileset,
  Cartesian3,
  Cartographic,
  CustomShader,
  UniformType,
  VaryingType,
  TextureUniform,
  Math as CesiumMath
} from 'cesium';
import type OLMap from 'ol/Map';

// Precomputed constants
const DEG_TO_RAD = Math.PI / 180;

export interface RoofColorBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

interface RoofColorLodState {
  lastCenter: { lon: number; lat: number } | null;
  bgCenter: { lon: number; lat: number } | null;
  fetchInProgress: boolean;
  background: { imageUrl: string; bounds: RoofColorBounds } | null;
}

/**
 * Encode a Cartesian3 into high/low parts for GPU RTE (emulated double precision).
 */
function encodeCartesian3(cartesian: Cartesian3): { high: Cartesian3; low: Cartesian3 } {
  const highX = Math.fround(cartesian.x);
  const highY = Math.fround(cartesian.y);
  const highZ = Math.fround(cartesian.z);
  return {
    high: new Cartesian3(highX, highY, highZ),
    low: new Cartesian3(cartesian.x - highX, cartesian.y - highY, cartesian.z - highZ)
  };
}

/**
 * Parse hex color string to RGB values (0-1 range)
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return { r, g, b };
}

/**
 * Creates a CustomShader that applies a solid color to roof surfaces.
 */
export function createSolidRoofColorShader(colorHex: string, normalThreshold = 0.7): CustomShader {
  const { r, g, b } = parseHexColor(colorHex);
  
  return new CustomShader({
    uniforms: {
      u_roofColor: { type: UniformType.VEC3, value: new Cartesian3(r, g, b) },
      u_normalThreshold: { type: UniformType.FLOAT, value: normalThreshold }
    },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 positionWC = (czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0)).xyz;
        vec3 upWC = normalize(positionWC);
        vec3 normalWC = normalize(czm_inverseViewRotation * fsInput.attributes.normalEC);
        
        if (dot(normalWC, upWC) > u_normalThreshold) {
          material.diffuse = u_roofColor;
        }
      }
    `
  });
}

/**
 * Creates a shader that samples roof color from ortofoto with optional background layer.
 */
export function createOrtofotoRoofColorShader(
  ortofotoData: { imageUrl: string; bounds: RoofColorBounds },
  normalThreshold = 0.7,
  background?: { imageUrl: string; bounds: RoofColorBounds }
): CustomShader {
  const westDeg = CesiumMath.toDegrees(ortofotoData.bounds.west);
  const eastDeg = CesiumMath.toDegrees(ortofotoData.bounds.east);
  const southDeg = CesiumMath.toDegrees(ortofotoData.bounds.south);
  const northDeg = CesiumMath.toDegrees(ortofotoData.bounds.north);
  
  const centerLonDeg = (westDeg + eastDeg) / 2;
  const centerLatDeg = (southDeg + northDeg) / 2;
  const centerLonRad = centerLonDeg * DEG_TO_RAD;
  const centerLatRad = centerLatDeg * DEG_TO_RAD;
  const cosLat = Math.cos(centerLatRad);
  
  const imageCenterECEF = Cartesian3.fromRadians(centerLonRad, centerLatRad, 0);
  const encodedCenter = encodeCartesian3(imageCenterECEF);
  
  const sinLon = Math.sin(centerLonRad);
  const cosLon = Math.cos(centerLonRad);
  const sinLat = Math.sin(centerLatRad);
  
  const metersPerDegLon = 111320 * cosLat;
  const metersPerDegLat = 110540;
  
  const widthMeters = (eastDeg - westDeg) * metersPerDegLon;
  const heightMeters = (northDeg - southDeg) * metersPerDegLat;
  
  const uvScaleX = 1.0 / widthMeters;
  const uvScaleY = 1.0 / heightMeters;
  const eastVecScaled = new Cartesian3(-sinLon * uvScaleX, cosLon * uvScaleX, 0);
  const northVecScaled = new Cartesian3(-sinLat * cosLon * uvScaleY, -sinLat * sinLon * uvScaleY, cosLat * uvScaleY);
  
  // Build uniforms - add background texture if provided
  const uniforms: Record<string, any> = {
    u_ortofoto: {
      type: UniformType.SAMPLER_2D,
      value: new TextureUniform({ url: ortofotoData.imageUrl })
    },
    u_imageCenterHigh: { type: UniformType.VEC3, value: encodedCenter.high },
    u_imageCenterLow: { type: UniformType.VEC3, value: encodedCenter.low },
    u_eastVecScaled: { type: UniformType.VEC3, value: eastVecScaled },
    u_northVecScaled: { type: UniformType.VEC3, value: northVecScaled },
    u_normalThreshold: { type: UniformType.FLOAT, value: normalThreshold }
  };
  
  // Add background layer uniforms if provided
  if (background) {
    const bgWest = CesiumMath.toDegrees(background.bounds.west);
    const bgEast = CesiumMath.toDegrees(background.bounds.east);
    const bgSouth = CesiumMath.toDegrees(background.bounds.south);
    const bgNorth = CesiumMath.toDegrees(background.bounds.north);
    
    const bgCenterLon = (bgWest + bgEast) / 2 * DEG_TO_RAD;
    const bgCenterLat = (bgSouth + bgNorth) / 2 * DEG_TO_RAD;
    const bgCosLat = Math.cos(bgCenterLat);
    
    const bgCenterECEF = Cartesian3.fromRadians(bgCenterLon, bgCenterLat, 0);
    const bgEncoded = encodeCartesian3(bgCenterECEF);
    
    const bgSinLon = Math.sin(bgCenterLon);
    const bgCosLon = Math.cos(bgCenterLon);
    const bgSinLat = Math.sin(bgCenterLat);
    
    const bgWidth = (bgEast - bgWest) * 111320 * bgCosLat;
    const bgHeight = (bgNorth - bgSouth) * 110540;
    
    const bgUvScaleX = 1.0 / bgWidth;
    const bgUvScaleY = 1.0 / bgHeight;
    
    uniforms.u_bgOrtofoto = {
      type: UniformType.SAMPLER_2D,
      value: new TextureUniform({ url: background.imageUrl })
    };
    uniforms.u_bgCenterHigh = { type: UniformType.VEC3, value: bgEncoded.high };
    uniforms.u_bgCenterLow = { type: UniformType.VEC3, value: bgEncoded.low };
    uniforms.u_bgEastVecScaled = { type: UniformType.VEC3, value: new Cartesian3(-bgSinLon * bgUvScaleX, bgCosLon * bgUvScaleX, 0) };
    uniforms.u_bgNorthVecScaled = { type: UniformType.VEC3, value: new Cartesian3(-bgSinLat * bgCosLon * bgUvScaleY, -bgSinLat * bgSinLon * bgUvScaleY, bgCosLat * bgUvScaleY) };
  }
  
  return new CustomShader({
    uniforms,
    varyings: background ? {
      v_roofUV: VaryingType.VEC2,
      v_bgUV: VaryingType.VEC2,
      v_isRoof: VaryingType.FLOAT
    } : {
      v_roofUV: VaryingType.VEC2,
      v_isRoof: VaryingType.FLOAT
    },
    vertexShaderText: background ? `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        vec3 positionWC = (czm_model * vec4(vsInput.attributes.positionMC, 1.0)).xyz;
        float invLen = inversesqrt(dot(positionWC, positionWC));
        vec3 upWC = positionWC * invLen;
        vec3 normalWC = czm_inverseViewRotation * (czm_normal * vsInput.attributes.normalMC);
        invLen = inversesqrt(dot(normalWC, normalWC));
        normalWC *= invLen;
        v_isRoof = dot(normalWC, upWC) > u_normalThreshold ? 1.0 : 0.0;
        
        // Detail layer UV
        vec3 offsetWC = (positionWC - u_imageCenterHigh) - u_imageCenterLow;
        v_roofUV = vec2(
          dot(offsetWC, u_eastVecScaled) + 0.5,
          dot(offsetWC, u_northVecScaled) + 0.5
        );
        
        // Background layer UV
        vec3 bgOffset = (positionWC - u_bgCenterHigh) - u_bgCenterLow;
        v_bgUV = vec2(
          dot(bgOffset, u_bgEastVecScaled) + 0.5,
          dot(bgOffset, u_bgNorthVecScaled) + 0.5
        );
      }
    ` : `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        vec3 positionWC = (czm_model * vec4(vsInput.attributes.positionMC, 1.0)).xyz;
        float invLen = inversesqrt(dot(positionWC, positionWC));
        vec3 upWC = positionWC * invLen;
        vec3 normalWC = czm_inverseViewRotation * (czm_normal * vsInput.attributes.normalMC);
        invLen = inversesqrt(dot(normalWC, normalWC));
        normalWC *= invLen;
        v_isRoof = dot(normalWC, upWC) > u_normalThreshold ? 1.0 : 0.0;
        
        vec3 offsetWC = (positionWC - u_imageCenterHigh) - u_imageCenterLow;
        v_roofUV = vec2(
          dot(offsetWC, u_eastVecScaled) + 0.5,
          dot(offsetWC, u_northVecScaled) + 0.5
        );
      }
    `,
    fragmentShaderText: background ? `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        if (v_isRoof < 0.5) return;
        
        vec2 uv = v_roofUV;
        float inDetailBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        
        vec3 roofColor;
        
        // Try detail layer first, fall back to background
        if (inDetailBounds > 0.5) {
          roofColor = texture(u_ortofoto, uv).rgb;
        } else {
          vec2 bgUv = v_bgUV;
          float inBgBounds = step(0.0, bgUv.x) * step(bgUv.x, 1.0) * step(0.0, bgUv.y) * step(bgUv.y, 1.0);
          if (inBgBounds < 0.5) return;
          roofColor = texture(u_bgOrtofoto, bgUv).rgb;
        }
        
        material.diffuse = vec3(0.0);
        material.specular = vec3(0.0);
        material.emissive = roofColor;
        material.alpha = 1.0;
      }
    ` : `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        if (v_isRoof < 0.5) return;
        
        vec2 uv = v_roofUV;
        float inBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        if (inBounds < 0.5) return;
        
        vec3 roofColor = texture(u_ortofoto, uv).rgb;
        material.diffuse = vec3(0.0);
        material.specular = vec3(0.0);
        material.emissive = roofColor;
        material.alpha = 1.0;
      }
    `
  });
}

// LRU cache for ortofoto tiles
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}
  
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        const oldValue = this.map.get(firstKey);
        if (oldValue && typeof (oldValue as any).imageUrl === 'string' && (oldValue as any).imageUrl.startsWith('blob:')) {
          URL.revokeObjectURL((oldValue as any).imageUrl);
        }
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }
}

const ortofotoCache = new LRUCache<string, { imageUrl: string; bounds: RoofColorBounds }>(100);
const roofColorLodListeners = new Map<Cesium3DTileset, () => void>();

/**
 * Loads pre-generated roof color data from a JSON file.
 */
export async function loadRoofColorData(
  dataUrl: string
): Promise<{ imageUrl: string; bounds: RoofColorBounds } | null> {
  try {
    const response = await fetch(dataUrl);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data.imageUrl || !data.bounds) return null;
    
    const bounds = data.bounds;
    const needsConversion = Math.abs(bounds.west) > Math.PI * 2;
    
    return {
      imageUrl: data.imageUrl,
      bounds: needsConversion ? {
        west: CesiumMath.toRadians(bounds.west),
        east: CesiumMath.toRadians(bounds.east),
        south: CesiumMath.toRadians(bounds.south),
        north: CesiumMath.toRadians(bounds.north)
      } : bounds
    };
  } catch {
    return null;
  }
}

/**
 * Fetches ortofoto for an area around a point.
 */
async function fetchHighResOrtofoto(
  lon: number,
  lat: number,
  radius: number,
  wmsUrl: string,
  wmsLayers: string,
  imageSize: number
): Promise<{ imageUrl: string; bounds: RoofColorBounds } | null> {
  // Round to ~100m grid for cache efficiency
  const grid = 0.001;
  const gLon = Math.round(lon / grid) * grid;
  const gLat = Math.round(lat / grid) * grid;
  const key = `${wmsLayers}:${gLon.toFixed(3)},${gLat.toFixed(3)}:${radius}`;
  
  const cached = ortofotoCache.get(key);
  if (cached) return cached;
  
  const cosLat = Math.cos(lat * DEG_TO_RAD);
  const wDeg = radius / (111000 * cosLat);
  const hDeg = radius / 111000;
  
  const west = lon - wDeg, east = lon + wDeg;
  const south = lat - hDeg, north = lat + hDeg;
  
  const url = `${wmsUrl}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${encodeURIComponent(wmsLayers)}&STYLES=&FORMAT=image/jpeg&TRANSPARENT=false&SRS=EPSG:4326&BBOX=${west},${south},${east},${north}&WIDTH=${imageSize}&HEIGHT=${imageSize}`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const result = {
      imageUrl: URL.createObjectURL(await res.blob()),
      bounds: {
        west: CesiumMath.toRadians(west),
        east: CesiumMath.toRadians(east),
        south: CesiumMath.toRadians(south),
        north: CesiumMath.toRadians(north)
      }
    };
    ortofotoCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Gets WMS URL and layer name from an OpenLayers WMS layer by name.
 */
export function getWmsLayerInfo(map: OLMap, layerName: string): { url: string; layers: string } | null {
  const allLayers = map.getLayers().getArray();
  
  let foundLayer = allLayers.find((layer) => layer.get('id') === layerName);
  if (!foundLayer) {
    foundLayer = allLayers.find((layer) => layer.get('name') === layerName);
  }
  
  if (!foundLayer || typeof (foundLayer as any).getSource !== 'function') {
    return null;
  }
  
  const source = (foundLayer as any).getSource();
  if (!source || typeof source.getUrls !== 'function' || typeof source.getParams !== 'function') {
    return null;
  }
  
  const urls = source.getUrls();
  const params = source.getParams();
  
  if (!urls?.length || !params?.LAYERS) {
    return null;
  }
  
  return {
    url: urls[0],
    layers: params.LAYERS
  };
}

/**
 * Sets up LOD-based roof color tiled sampling.
 * Fetches high-res ortofoto tiles around camera when below lodDistance.
 * Quality scales with altitude - closer = smaller area = more detail.
 * Keeps a low-res background layer for buildings outside the detail area.
 */
export function setupLodRoofColor(
  scene: Scene,
  tileset: Cesium3DTileset,
  normalThreshold: number,
  wmsUrl: string,
  wmsLayers: string,
  lodDistance: number,
  imageSize: number,
  fetchRadius: number
): void {
  const state: RoofColorLodState = { 
    lastCenter: null, 
    bgCenter: null,
    fetchInProgress: false, 
    background: null 
  };
  
  // Remove existing listener
  const existing = roofColorLodListeners.get(tileset);
  if (existing) scene.preRender.removeEventListener(existing);
  
  let frame = 0;
  let lastRadius = 0;
  
  const lodListener = () => {
    if (++frame < 4) return;
    frame = 0;
    
    if (state.fetchInProgress) return;
    
    const carto = Cartographic.fromCartesian(scene.camera.positionWC);
    if (!carto || carto.height >= lodDistance) return;
    
    const lon = CesiumMath.toDegrees(carto.longitude);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const cosLat = Math.cos(lat * DEG_TO_RAD);
    
    // Dynamic radius based on altitude
    const altRatio = Math.max(0.2, Math.min(1, carto.height / lodDistance));
    const radius = fetchRadius * altRatio;
    
    // Check if background needs refresh (moved 60% of full radius from bg center)
    let needsBackgroundRefresh = !state.background;
    if (state.bgCenter) {
      const dLon = (lon - state.bgCenter.lon) * 111000 * cosLat;
      const dLat = (lat - state.bgCenter.lat) * 111000;
      needsBackgroundRefresh = dLon * dLon + dLat * dLat > (fetchRadius * 0.6) ** 2;
    }
    
    // Check if detail tile needs refresh
    const refetchDist = radius * 0.5;
    const radiusShrank = lastRadius > 0 && radius < lastRadius * 0.7;
    let needsDetailRefresh = radiusShrank || needsBackgroundRefresh;
    
    if (!needsDetailRefresh && state.lastCenter) {
      const dLon = (lon - state.lastCenter.lon) * 111000 * cosLat;
      const dLat = (lat - state.lastCenter.lat) * 111000;
      needsDetailRefresh = dLon * dLon + dLat * dLat > refetchDist * refetchDist;
    }
    
    if (!needsDetailRefresh && !needsBackgroundRefresh) return;
    
    state.fetchInProgress = true;
    lastRadius = radius;
    
    // Fetch background and detail in PARALLEL for faster response
    if (needsBackgroundRefresh && altRatio < 0.9) {
      // Both needed - fetch in parallel, show bg immediately when ready
      const bgPromise = fetchHighResOrtofoto(lon, lat, fetchRadius, wmsUrl, wmsLayers, imageSize);
      const detailPromise = fetchHighResOrtofoto(lon, lat, radius, wmsUrl, wmsLayers, imageSize);
      
      // Show background as soon as it arrives (don't wait for detail)
      bgPromise.then(bgData => {
        if (bgData) {
          state.background = bgData;
          state.bgCenter = { lon, lat };
          // Apply bg-only shader immediately for faster feedback
          tileset.customShader = createOrtofotoRoofColorShader(bgData, normalThreshold);
        }
      }).catch(() => {});
      
      // Upgrade to detail+bg shader when detail arrives
      Promise.all([bgPromise, detailPromise])
        .then(([bgData, detailData]) => {
          if (detailData && bgData) {
            tileset.customShader = createOrtofotoRoofColorShader(detailData, normalThreshold, bgData);
          }
          state.lastCenter = { lon, lat };
          state.fetchInProgress = false;
        })
        .catch(() => { state.fetchInProgress = false; });
        
    } else if (needsBackgroundRefresh) {
      // Only background needed (far away)
      fetchHighResOrtofoto(lon, lat, fetchRadius, wmsUrl, wmsLayers, imageSize)
        .then(bgData => {
          if (bgData) {
            state.background = bgData;
            state.bgCenter = { lon, lat };
            tileset.customShader = createOrtofotoRoofColorShader(bgData, normalThreshold);
            state.lastCenter = { lon, lat };
          }
          state.fetchInProgress = false;
        })
        .catch(() => { state.fetchInProgress = false; });
        
    } else {
      // Just detail tile with existing background
      fetchHighResOrtofoto(lon, lat, radius, wmsUrl, wmsLayers, imageSize)
        .then(data => {
          if (data) {
            tileset.customShader = createOrtofotoRoofColorShader(
              data, 
              normalThreshold,
              state.background ?? undefined
            );
            state.lastCenter = { lon, lat };
          }
          state.fetchInProgress = false;
        })
        .catch(() => { state.fetchInProgress = false; });
    }
  };
  
  scene.preRender.addEventListener(lodListener);
  roofColorLodListeners.set(tileset, lodListener);
}

/**
 * Removes the LOD listener for a tileset (cleanup).
 */
export function removeRoofColorLodListener(scene: Scene, tileset: Cesium3DTileset): void {
  const listener = roofColorLodListeners.get(tileset);
  if (listener) {
    scene.preRender.removeEventListener(listener);
    roofColorLodListeners.delete(tileset);
  }
}
