// Types
export type { CleanupFn, GLTFAsset, GlobeSettings, ShadowSettings, SkyBoxSettings, GeoJsonFeatureCollection } from './types';

// Configuration
export { processGlobeOptions, resolveGlobeOptions, validateGlobeOptions } from './configValidation';
export type { GlobeOptions, ResolvedGlobeOptions, DrawToolOptions, DrawToolExportOptions, GLTFAssetOptions } from './configValidation';

// State (prefer using centralized state manager)
export * from './globeStateManager';

// Scene configuration
export { configureGlobeAppearance, configureScene, loadGltfAssets, loadTerrainProvider, load3DTiles } from './sceneConfig';

// Scene initialization
export { initializeGlobeScene, cleanupGlobeScene } from './sceneInit';
export type { SceneInitContext, SceneInitResult } from './sceneInit';

// Helpers
export { createGlobeHelpers } from './globeHelpers';
export type { GlobeHelpersContext, GlobeHelpers } from './globeHelpers';

// UI Components
export { createPolygonUi } from './polygonUi';
export type { PolygonUiApi } from './polygonUi';

export { createMeasureUi } from './measureUi';
export type { MeasureUiApi } from './measureUi';

// DOM utilities
export { createElementFromMarkup, stopDomEvent } from './domUtils';

// SVG Icons
export { initializeSvgIcons, addCustomIcon, addCustomIcons, hasIcon, GLOBE_ICONS } from './svgIcons';
export type { SvgIconDef } from './svgIcons';

// Share codec
export * from './shareCodec';
