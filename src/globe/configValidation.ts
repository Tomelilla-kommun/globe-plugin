import type { GlobeSettings, ShadowSettings, SkyBoxSettings } from './types';

// ============================================================================
// Globe Options Interface
// ============================================================================

export interface DrawToolExportOptions {
  geojson?: boolean;
  dxf?: boolean;
  dxfCrs?: string[];
}

export interface DrawToolOptions {
  active?: boolean;
  options?: {
    export?: DrawToolExportOptions | boolean;
    share?: boolean;
    defaultColor?: string;
    defaultHeight?: number;
  };
}

export interface DirectCesiumLayerConfig {
  /** Layer name or id to match in OL map */
  layerName: string;
  /** Optional: override WMS URL */
  url?: string;
  /** Optional: override WMS layers param */
  layers?: string;
  /** Optional: image format (default: image/jpeg) */
  format?: string;
  /** Optional: maximum imagery level */
  maximumLevel?: number;
}

export interface GlobeOptions {
  target?: string;
  globeOnStart?: boolean;
  showGlobe?: boolean;
  streetView?: boolean;
  streetViewMap?: string;
  cameraControls?: boolean;
  viewShed?: boolean;
  measure?: boolean;
  flyTo?: boolean;
  quickTimeShadowPicker?: boolean;
  drawTool?: boolean | DrawToolOptions;
  fx?: boolean;
  indexJson?: any;
  resolutionScale?: number;
  settings?: GlobeSettings;
  cesiumTerrainProvider?: string;
  cesiumIontoken?: string;
  cesiumIonassetIdTerrain?: number;
  gltf?: GLTFAssetOptions[];
  deactivateControls?: string[];
  /** Layers to bypass OLImageryProvider for faster loading (use native Cesium WMS) */
  directCesiumLayers?: DirectCesiumLayerConfig[];
  /**
   * CSS selectors for 2D controls/tools to hide when globe (3D) is active.
   * Example: ['.o-measure', '.o-draw', '#myTool']
   * These will be hidden in 3D mode and shown in 2D mode.
   */
  hide2DControlsInGlobe?: string[];
}

export interface GLTFAssetOptions {
  url: string;
  lat: number;
  lng: number;
  height: number;
  heightReference?: any;
  animation?: any;
}

// ============================================================================
// Resolved Options (all fields present after merging with defaults)
// ============================================================================

export interface ResolvedGlobeOptions {
  target: string | undefined;
  globeOnStart: boolean;
  showGlobe: boolean;
  streetView: boolean;
  streetViewMap: string;
  cameraControls: boolean;
  viewShed: boolean;
  measure: boolean;
  flyTo: boolean;
  quickTimeShadowPicker: boolean;
  drawTool: boolean | DrawToolOptions;
  fx: boolean;
  resolutionScale: number;
  settings: GlobeSettings;
  cesiumTerrainProvider: string | undefined;
  cesiumIontoken: string | undefined;
  cesiumIonassetIdTerrain: number | undefined;
  gltf: GLTFAssetOptions[] | undefined;
  deactivateControls: string[];
  directCesiumLayers?: DirectCesiumLayerConfig[];
  hide2DControlsInGlobe: string[];
  // Parsed
  drawToolConfig: DrawToolOptions;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_OPTIONS: Omit<ResolvedGlobeOptions, 'target' | 'cesiumTerrainProvider' | 'cesiumIontoken' | 'cesiumIonassetIdTerrain' | 'gltf' | 'drawToolConfig'> = {
  globeOnStart: false,
  showGlobe: true,
  streetView: false,
  streetViewMap: '',
  cameraControls: false,
  viewShed: false,
  measure: false,
  flyTo: false,
  quickTimeShadowPicker: false,
  drawTool: false,
  fx: false,
  resolutionScale: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  settings: {},
  deactivateControls: [],
  hide2DControlsInGlobe: [],
};

const DEFAULT_SHADOW_SETTINGS: ShadowSettings = {
  darkness: 0.3,
  fadingEnabled: true,
  maximumDistance: 5000,
  normalOffset: 1,
  size: 2048,
  softShadows: true,
};

// ============================================================================
// Validation Helpers
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

function validateShadowSettings(shadows?: Partial<ShadowSettings>): ValidationResult {
  const result: ValidationResult = { valid: true, warnings: [], errors: [] };
  
  if (!shadows) return result;
  
  if (shadows.size !== undefined && (shadows.size < 256 || shadows.size > 8192)) {
    result.warnings.push(`Shadow map size ${shadows.size} is outside recommended range (256-8192)`);
  }
  
  if (shadows.darkness !== undefined && (shadows.darkness < 0 || shadows.darkness > 1)) {
    result.warnings.push(`Shadow darkness ${shadows.darkness} should be between 0 and 1`);
  }
  
  if (shadows.maximumDistance !== undefined && shadows.maximumDistance < 0) {
    result.errors.push('Shadow maximumDistance cannot be negative');
    result.valid = false;
  }
  
  return result;
}

function validateSkyBoxSettings(skyBox?: SkyBoxSettings | false): ValidationResult {
  const result: ValidationResult = { valid: true, warnings: [], errors: [] };
  
  if (!skyBox) return result;
  
  if (!skyBox.url) {
    result.errors.push('SkyBox requires a url');
    result.valid = false;
  }
  
  const requiredImages = ['pX', 'nX', 'pY', 'nY', 'pZ', 'nZ'] as const;
  const missingImages = requiredImages.filter(key => !skyBox.images?.[key]);
  
  if (missingImages.length > 0) {
    result.errors.push(`SkyBox missing required images: ${missingImages.join(', ')}`);
    result.valid = false;
  }
  
  return result;
}

function validateGltfAssets(gltf?: GLTFAssetOptions[]): ValidationResult {
  const result: ValidationResult = { valid: true, warnings: [], errors: [] };
  
  if (!gltf || gltf.length === 0) return result;
  
  gltf.forEach((asset, index) => {
    if (!asset.url) {
      result.errors.push(`GLTF asset ${index} missing url`);
      result.valid = false;
    }
    
    if (typeof asset.lat !== 'number' || typeof asset.lng !== 'number') {
      result.errors.push(`GLTF asset ${index} requires numeric lat/lng`);
      result.valid = false;
    }
    
    if (Math.abs(asset.lat) > 90) {
      result.errors.push(`GLTF asset ${index} lat ${asset.lat} is out of range (-90 to 90)`);
      result.valid = false;
    }
    
    if (Math.abs(asset.lng) > 180) {
      result.errors.push(`GLTF asset ${index} lng ${asset.lng} is out of range (-180 to 180)`);
      result.valid = false;
    }
  });
  
  return result;
}

// ============================================================================
// Main Configuration Functions
// ============================================================================

/**
 * Validates globe options and returns validation result
 */
export function validateGlobeOptions(options: GlobeOptions): ValidationResult {
  const result: ValidationResult = { valid: true, warnings: [], errors: [] };
  
  // Validate shadow settings
  const shadowValidation = validateShadowSettings(options.settings?.shadows);
  result.warnings.push(...shadowValidation.warnings);
  result.errors.push(...shadowValidation.errors);
  if (!shadowValidation.valid) result.valid = false;
  
  // Validate skybox
  const skyBoxValidation = validateSkyBoxSettings(options.settings?.skyBox);
  result.warnings.push(...skyBoxValidation.warnings);
  result.errors.push(...skyBoxValidation.errors);
  if (!skyBoxValidation.valid) result.valid = false;
  
  // Validate GLTF assets
  const gltfValidation = validateGltfAssets(options.gltf);
  result.warnings.push(...gltfValidation.warnings);
  result.errors.push(...gltfValidation.errors);
  if (!gltfValidation.valid) result.valid = false;
  
  // Check for conflicting options
  if (options.streetView && !options.streetViewMap) {
    result.warnings.push('streetView is enabled but no streetViewMap URL provided');
  }
  
  if (options.cesiumIonassetIdTerrain && !options.cesiumIontoken) {
    result.warnings.push('cesiumIonassetIdTerrain requires cesiumIontoken');
  }
  
  // Log warnings
  result.warnings.forEach(w => console.warn(`[Globe Config] ${w}`));
  result.errors.forEach(e => console.error(`[Globe Config] ${e}`));
  
  return result;
}

/**
 * Resolves globe options by merging defaults with provided options and indexJson
 */
export function resolveGlobeOptions(options: GlobeOptions = {}): ResolvedGlobeOptions {
  // Extract indexJson first to read 3D settings from it
  console.log('[Globe DEBUG resolveGlobeOptions] options received:', Object.keys(options));
  console.log('[Globe DEBUG resolveGlobeOptions] options.indexJson type:', typeof options.indexJson);
  const indexJson = options.indexJson;
  console.log('[Globe DEBUG resolveGlobeOptions] indexJson keys:', indexJson ? Object.keys(indexJson) : 'null');
  const indexJson3D = indexJson?.['3D'] || {};
  console.log('[Globe DEBUG resolveGlobeOptions] indexJson3D:', JSON.stringify(indexJson3D, null, 2));
  
  // Deep merge settings object
  const mergedSettings: GlobeSettings = {
    ...(indexJson3D.settings || {}),
    ...(options.settings || {}),
  };
  
  // Apply default shadow settings if shadows are used but incomplete
  if (mergedSettings.shadows) {
    mergedSettings.shadows = {
      ...DEFAULT_SHADOW_SETTINGS,
      ...mergedSettings.shadows,
    };
  }
  
  // Merge: defaults -> indexJson['3D'] settings -> explicitly passed options
  // Resolve drawTool from options first, then indexJson3D
  console.log('[Globe DEBUG] indexJson3D.drawTool:', JSON.stringify(indexJson3D.drawTool, null, 2));
  console.log('[Globe DEBUG] options.drawTool:', JSON.stringify(options.drawTool, null, 2));
  const mergedDrawTool = options.drawTool ?? indexJson3D.drawTool;
  console.log('[Globe DEBUG] mergedDrawTool:', JSON.stringify(mergedDrawTool, null, 2));
  const drawToolConfig: DrawToolOptions = typeof mergedDrawTool === 'object'
    ? mergedDrawTool
    : { active: !!mergedDrawTool };
  console.log('[Globe DEBUG] Final drawToolConfig:', JSON.stringify(drawToolConfig, null, 2));

  const resolved: ResolvedGlobeOptions = {
    ...DEFAULT_OPTIONS,
    ...indexJson3D,
    ...options,
    settings: mergedSettings,
    target: options.target,
    cesiumTerrainProvider: options.cesiumTerrainProvider ?? indexJson3D.cesiumTerrainProvider,
    cesiumIontoken: options.cesiumIontoken ?? indexJson3D.cesiumIontoken,
    cesiumIonassetIdTerrain: options.cesiumIonassetIdTerrain ?? indexJson3D.cesiumIonassetIdTerrain,
    gltf: options.gltf ?? indexJson3D.gltf,
    resolutionScale: options.resolutionScale ?? indexJson3D.resolutionScale ?? DEFAULT_OPTIONS.resolutionScale,
    drawToolConfig,
  };
  
  return resolved;
}

/**
 * Validates and resolves options in one call
 */
export function processGlobeOptions(options: GlobeOptions = {}): {
  resolved: ResolvedGlobeOptions;
  validation: ValidationResult;
} {
  const validation = validateGlobeOptions(options);
  const resolved = resolveGlobeOptions(options);
  
  return { resolved, validation };
}
