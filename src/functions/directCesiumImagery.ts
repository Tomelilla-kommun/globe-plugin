/**
 * Direct Cesium Imagery Layer
 * 
 * Bypasses OLImageryProvider for faster WMS tile loading.
 * Sets `olcs_skip: true` on OL layer source, then adds native Cesium
 * WebMapServiceImageryProvider with visibility/opacity sync.
 */

import * as Cesium from 'cesium';
import proj4 from 'proj4';
import type OLMap from 'ol/Map';
import type BaseLayer from 'ol/layer/Base';
import type TileLayer from 'ol/layer/Tile';
import type TileWMS from 'ol/source/TileWMS';
import type ImageWMS from 'ol/source/ImageWMS';
import type { DirectCesiumLayerConfig } from '../globe/configValidation';

export interface DirectCesiumImageryOptions {
  /** Extent in source CRS [minX, minY, maxX, maxY] */
  extent?: [number, number, number, number];
  /** Source CRS (e.g. 'EPSG:3857'). Defaults to 'EPSG:3857' */
  crs?: string;
}

interface SyncedLayer {
  olLayer: BaseLayer;
  cesiumLayer: Cesium.ImageryLayer;
  listeners: (() => void)[];
}

const syncedLayers: SyncedLayer[] = [];

/**
 * Convert extent from source CRS to Cesium Rectangle (WGS84 radians).
 */
function extentToRectangle(
  extent: [number, number, number, number],
  crs: string
): Cesium.Rectangle | undefined {
  try {
    // Convert corners to WGS84
    const [minX, minY, maxX, maxY] = extent;
    const sw = proj4(crs, 'EPSG:4326', [minX, minY]);
    const ne = proj4(crs, 'EPSG:4326', [maxX, maxY]);
    
    return Cesium.Rectangle.fromDegrees(sw[0], sw[1], ne[0], ne[1]);
  } catch (e) {
    console.warn('[directCesiumImagery] Failed to convert extent to rectangle:', e);
    return undefined;
  }
}

/**
 * Sets up direct Cesium imagery layers for specified WMS layers.
 * Call this BEFORE enabling OLCesium (before oGlobe.setEnabled(true)).
 * 
 * @param map - OpenLayers map
 * @param scene - Cesium scene
 * @param configs - Array of layer configs to handle directly
 * @param options - Optional extent/CRS to limit tile fetching
 * @returns Cleanup function
 */
export function setupDirectCesiumImagery(
  map: OLMap,
  scene: Cesium.Scene,
  configs: DirectCesiumLayerConfig[],
  options?: DirectCesiumImageryOptions
): () => void {
  const allLayers = map.getLayers().getArray();
  
  // Convert extent to Cesium Rectangle if provided
  const rectangle = options?.extent
    ? extentToRectangle(options.extent, options.crs ?? 'EPSG:3857')
    : undefined;
  
  for (const config of configs) {
    // Find the OL layer by name or id
    const olLayer = allLayers.find(
      (layer) => layer.get('name') === config.layerName || layer.get('id') === config.layerName
    ) as TileLayer<TileWMS> | undefined;
    
    if (!olLayer) {
      console.warn(`[directCesiumImagery] Layer "${config.layerName}" not found`);
      continue;
    }
    
    const source = (olLayer as any).getSource?.() as TileWMS | ImageWMS | null;
    if (!source) {
      console.warn(`[directCesiumImagery] Layer "${config.layerName}" has no source`);
      continue;
    }
    
    // Tell OLCesium to skip this layer
    source.set('olcs_skip', true);
    
    // Extract WMS URL and layers from source
    let wmsUrl: string | undefined;
    let wmsLayers: string | undefined;
    
    if (typeof (source as any).getUrls === 'function') {
      const urls = (source as TileWMS).getUrls();
      wmsUrl = urls?.[0];
    } else if (typeof (source as any).getUrl === 'function') {
      wmsUrl = (source as ImageWMS).getUrl() ?? undefined;
    }
    
    if (typeof (source as any).getParams === 'function') {
      const params = (source as TileWMS).getParams();
      wmsLayers = params?.LAYERS;
    }
    
    // Use config overrides
    wmsUrl = config.url ?? wmsUrl;
    wmsLayers = config.layers ?? wmsLayers;
    
    if (!wmsUrl || !wmsLayers) {
      console.warn(`[directCesiumImagery] Layer "${config.layerName}" missing URL or LAYERS`);
      continue;
    }
    
    // Create native Cesium WMS provider
    const provider = new Cesium.WebMapServiceImageryProvider({
      url: wmsUrl,
      layers: wmsLayers,
      parameters: {
        FORMAT: config.format ?? 'image/jpeg', // JPEG is faster than PNG
        TRANSPARENT: 'false'
      },
      maximumLevel: config.maximumLevel,
      rectangle // Limit tile fetching to this extent
    });
    
    // Create Cesium ImageryLayer
    const cesiumLayer = new Cesium.ImageryLayer(provider, {
      show: olLayer.getVisible(),
      alpha: olLayer.getOpacity()
    });
    
    // Add to scene at the bottom (terrain imagery goes below 3D tiles)
    scene.imageryLayers.add(cesiumLayer, 0);
    
    // Set up sync listeners
    const listeners: (() => void)[] = [];
    
    // Sync visibility
    const visibleKey = olLayer.on('change:visible', () => {
      cesiumLayer.show = olLayer.getVisible();
      if (scene.requestRenderMode) scene.requestRender();
    });
    listeners.push(() => olLayer.un('change:visible', visibleKey.listener));
    
    // Sync opacity
    const opacityKey = olLayer.on('change:opacity', () => {
      cesiumLayer.alpha = olLayer.getOpacity();
      if (scene.requestRenderMode) scene.requestRender();
    });
    listeners.push(() => olLayer.un('change:opacity', opacityKey.listener));
    
    syncedLayers.push({
      olLayer,
      cesiumLayer,
      listeners
    });
    
    console.info(`[directCesiumImagery] Layer "${config.layerName}" using direct Cesium provider`);
  }
  
  // Return cleanup function
  return () => {
    for (const synced of syncedLayers) {
      // Remove listeners
      for (const unsub of synced.listeners) {
        unsub();
      }
      
      // Remove Cesium layer
      scene.imageryLayers.remove(synced.cesiumLayer, true);
      
      // Re-enable OLCesium sync (in case globe is re-enabled)
      const source = (synced.olLayer as any).getSource?.();
      if (source) {
        source.set('olcs_skip', false);
      }
    }
    syncedLayers.length = 0;
  };
}

/**
 * Check if a layer is being handled by direct Cesium imagery.
 */
export function isDirectCesiumLayer(layerName: string): boolean {
  return syncedLayers.some(
    (s) => s.olLayer.get('name') === layerName || s.olLayer.get('id') === layerName
  );
}
