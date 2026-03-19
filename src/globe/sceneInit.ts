import * as Cesium from 'cesium';
import OLCesium from 'olcs/OLCesium';
import flatpickr from 'flatpickr';

import dynamicResolutionScaling from '../functions/dynamicResolutionScaling';
import patchCollections from '../functions/patchCollections';
import CameraControls from '../functions/CameraControls';
import getFeatureInfoHandler from '../functions/featureinfo';

import { createPolygonUi } from './polygonUi';
import { createMeasureUi } from './measureUi';
import { configureGlobeAppearance, configureScene, loadGltfAssets, loadTerrainProvider, load3DTiles } from './sceneConfig';
import { createGlobeHelpers } from './globeHelpers';

import type { ResolvedGlobeOptions, DrawToolOptions } from './configValidation';
import type { PolygonUiApi } from './polygonUi';
import type { MeasureUiApi } from './measureUi';
import type { CleanupFn } from './types';
import type { GlobeHelpers } from './globeHelpers';

// ============================================================================
// Types
// ============================================================================

export interface SceneInitContext {
  viewer: any;
  map: any;
  oGlobeTarget: string;
  options: ResolvedGlobeOptions;
  getFlatpickr: () => flatpickr.Instance | null;
  setFlatpickr: (fp: flatpickr.Instance | null) => void;
  trackNode: (node: HTMLElement) => HTMLElement;
  injectIntoMap: (markup: string) => HTMLElement | undefined;
  registerCleanup: (fn?: CleanupFn) => void;
  registerOptionalCleanup: (fn?: CleanupFn | void) => void;
}

export interface SceneInitResult {
  oGlobe: OLCesium;
  scene: Cesium.Scene;
  handler: Cesium.ScreenSpaceEventHandler;
  polygonUi: PolygonUiApi | null;
  measureUi: MeasureUiApi | null;
  helpers: GlobeHelpers;
  requestSceneRender: () => void;
}

// ============================================================================
// OLCesium Creation
// ============================================================================

function createOLCesium(
  map: any,
  target: string,
  getFlatpickr: () => flatpickr.Instance | null
): OLCesium {
  return new (window as any).OLCesium({
    map,
    target,
    time() {
      const fp = getFlatpickr();
      const value = (fp?.input as HTMLInputElement | undefined)?.value;
      return Cesium.JulianDate.fromDate(value ? new Date(value) : new Date());
    },
  });
}

// ============================================================================
// Scene Configuration
// ============================================================================

function configureSceneRendering(scene: Cesium.Scene): void {
  scene.requestRenderMode = true;
  scene.maximumRenderTimeChange = Infinity;
}

function setupPostRenderPatch(
  scene: Cesium.Scene,
  registerCleanup: (fn?: CleanupFn) => void
): void {
  const onPostRender = () => patchCollections(scene);
  scene.postRender.addEventListener(onPostRender);
  registerCleanup(() => scene.postRender.removeEventListener(onPostRender));
}

// ============================================================================
// Tool Creation
// ============================================================================

function createTools(
  scene: Cesium.Scene,
  map: any,
  injectIntoMap: (markup: string) => HTMLElement | undefined,
  requestSceneRender: () => void,
  registerCleanup: (fn?: CleanupFn) => void,
  drawToolConfig: DrawToolOptions
): { polygonUi: PolygonUiApi | null; measureUi: MeasureUiApi | null } {
  // We need to import stopDomEvent here
  const { stopDomEvent } = require('./domUtils');
  
  const polygonUi = createPolygonUi({
    scene,
    map,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    stopDomEvent,
    drawToolOptions: drawToolConfig,
  });

  registerCleanup(() => {
    polygonUi?.destroy();
  });

  const measureUi = createMeasureUi({
    scene,
    map,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    stopDomEvent,
  });

  measureUi.mountMeasureToolbarIfNeeded();

  registerCleanup(() => {
    measureUi?.destroy();
  });

  return { polygonUi, measureUi };
}

// ============================================================================
// Main Initialization
// ============================================================================

/**
 * Initializes the Cesium scene and all related components.
 * This extracts the complex onAdd logic into a testable, reusable function.
 */
export function initializeGlobeScene(ctx: SceneInitContext): SceneInitResult {
  const { viewer, map, oGlobeTarget, options, getFlatpickr, setFlatpickr, trackNode, injectIntoMap, registerCleanup, registerOptionalCleanup } = ctx;

  // Set Cesium Ion token if provided
  if (options.cesiumIontoken) {
    Cesium.Ion.defaultAccessToken = options.cesiumIontoken;
  }

  // Create OLCesium instance
  const oGlobe = createOLCesium(map, oGlobeTarget, getFlatpickr);
  const scene = oGlobe.getCesiumScene();
  
  // Expose to window for debugging
  (window as any).oGlobe = oGlobe;

  // Configure scene rendering
  configureSceneRendering(scene);

  // Request render helper
  const requestSceneRender = () => scene?.requestRender();

  // Setup dynamic resolution scaling
  const resolutionScaler = dynamicResolutionScaling(oGlobe, scene, {
    forceLowEnd: false,
    forceHighEnd: false,
    debugLogs: true,
  });
  registerCleanup(() => resolutionScaler?.dispose?.());

  // Create tools (polygon draw tool, measure tool)
  const { polygonUi, measureUi } = createTools(
    scene,
    map,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    options.drawToolConfig
  );

  // Setup post-render patch
  setupPostRenderPatch(scene, registerCleanup);

  // Create Cesium event handler
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

  // Create helpers with context
  const helpers = createGlobeHelpers({
    target: options.target,
    showGlobe: options.showGlobe,
    flyTo: options.flyTo,
    cameraControls: options.cameraControls,
    streetViewMap: options.streetViewMap,
    deactivateControls: options.deactivateControls,
    getScene: () => scene,
    getGlobe: () => oGlobe,
    getFlatpickr,
    setFlatpickr,
    getMeasureUi: () => measureUi,
    trackNode,
    requestSceneRender,
  });

  // Initialize time setter
  registerOptionalCleanup(helpers.initTimeSetter());

  // Add optional features
  registerOptionalCleanup(helpers.addStreetView(options.streetView, handler, oGlobe));
  registerOptionalCleanup(helpers.addControls());
  registerOptionalCleanup(helpers.pickedFeatureStyle(handler));
  registerOptionalCleanup(helpers.addMeasureTool(oGlobe, options.measure));

  // Configure scene appearance
  helpers.showGlobeOption();
  helpers.cesiumCredits();

  // Initialize camera controls
  CameraControls(scene);

  // Setup feature info handler
  const featureInfo = viewer.getControlByName('featureInfo');
  getFeatureInfoHandler(scene, viewer, map, featureInfo, helpers.flyToDestination);

  // Apply scene configuration
  configureScene(scene, options.settings);
  configureGlobeAppearance(scene, options.settings);

  // Load terrain
  loadTerrainProvider(scene, {
    cesiumTerrainProvider: options.cesiumTerrainProvider,
    cesiumIonassetIdTerrain: options.cesiumIonassetIdTerrain,
    cesiumIontoken: options.cesiumIontoken,
  }).catch((error) => console.error('Failed to load terrain provider', error));

  // Load 3D tiles and GLTF assets
  load3DTiles(scene, map, options.cesiumIontoken);
  loadGltfAssets(scene, options.gltf);

  // Try to load shared polygons from URL
  try {
    registerOptionalCleanup(polygonUi?.loadSharedPolygonsFromUrl());
  } catch (e) {
    // ignore
  }

  return {
    oGlobe,
    scene,
    handler,
    polygonUi,
    measureUi,
    helpers,
    requestSceneRender,
  };
}

// ============================================================================
// Scene Cleanup
// ============================================================================

export function cleanupGlobeScene(
  oGlobe: OLCesium | null,
  handler: Cesium.ScreenSpaceEventHandler | undefined,
  flushCleanups: () => void,
  cleanupDom: () => void
): void {
  // Disable 3D first (releases some things in olcs)
  try {
    oGlobe?.setEnabled(false);
  } catch (error) {
    console.warn('Failed to disable globe on remove', error);
  }

  flushCleanups();
  
  // Cleanup handler
  try {
    handler?.destroy();
  } catch (error) {
    console.warn('Failed to destroy handler', error);
  }

  cleanupDom();
}
