/**
 * Globe Plugin - Refactored Version
 * 
 * A modular 3D globe visualization plugin for Origo using Cesium/OLCesium.
 * 
 * Key improvements:
 * - Modular button system (ButtonManager)
 * - Centralized state management
 * - Configuration validation
 * - Extracted helpers and scene initialization
 * - SVG icons module
 */

import * as Cesium from 'cesium';
import flatpickr from 'flatpickr';
import OLCesium from 'olcs/OLCesium';
import Origo, { OrigoButton, OrigoElement } from 'Origo';

// Layer utilities
import addGLTF from './layer/gltf';
import { threedtile } from './layer/layerhelper';

// Function imports
import quickTimePicker from './functions/quickTimePicker';
import timeSetter from './functions/timeSetter';
import ViewShed from './functions/ViewShed';
import StreetView, { forceExitStreetMode } from './functions/StreetView';
import CameraControls from './functions/CameraControls';
import dynamicResolutionScaling from './functions/dynamicResolutionScaling';
import patchCollections from './functions/patchCollections';
import getFeatureInfo from './functions/featureinfo';
import { setupDirectCesiumImagery } from './functions/directCesiumImagery';

// Globe module imports
import { CleanupFn, GlobeSettings } from './globe/types';
import { PolygonUiApi, createPolygonUi } from './globe/polygonUi';
import { MeasureUiApi, createMeasureUi } from './globe/measureUi';
import { setCameraHeight, setIsStreetMode, getCameraHeight, getIsStreetMode, isGlobeActive } from './globeState';
import { processGlobeOptions } from './globe/configValidation';
import { configureScene, configureGlobeAppearance, loadTerrainProvider, load3DTiles, loadGltfAssets } from './globe/sceneConfig';
import { createElementFromMarkup, stopDomEvent } from './globe/domUtils';
import { initializeSvgIcons } from './globe/svgIcons';

// Button system
import {
  ButtonManager,
  BUTTON_IDS,
  GLOBE_DEPENDENT_BUTTONS,
  SHADOW_DEPENDENT_BUTTONS,
  getGlobeButtonConfigs,
  type ButtonInstance,
} from './buttons';

// UI Templates
import { streetViewHtml, cameraControlsHtml } from './uiTemplates';

// Re-export types
export type { DrawToolExportOptions, DrawToolOptions, GlobeOptions, DirectCesiumLayerConfig } from './globe/configValidation';
import type { DirectCesiumLayerConfig } from './globe/configValidation';

// ============================================================================
// Types
// ============================================================================

interface GlobeOptionsInput {
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
  drawTool?: boolean | { active?: boolean; options?: any };
  fx?: boolean;
  indexJson?: any;
  resolutionScale?: number;
  settings?: GlobeSettings;
  cesiumTerrainProvider?: string;
  cesiumIontoken?: string;
  cesiumIonassetIdTerrain?: number;
  gltf?: any[];
  deactivateControls?: string[];
  /** Layers to bypass OLImageryProvider for faster loading (use native Cesium WMS) */
  directCesiumLayers?: DirectCesiumLayerConfig[];
}

// ============================================================================
// Cleanup Stack
// ============================================================================

class CleanupStack {
  private stack: CleanupFn[] = [];

  push(fn?: CleanupFn): void {
    if (fn) this.stack.push(fn);
  }

  pushOptional(fn?: CleanupFn | void): void {
    if (typeof fn === 'function') this.push(fn);
  }

  flush(): void {
    while (this.stack.length) {
      try {
        this.stack.pop()?.();
      } catch (error) {
        console.warn('Globe cleanup failed', error);
      }
    }
  }
}

// ============================================================================
// Global Setup
// ============================================================================

declare global {
  interface Window {
    Cesium: typeof Cesium;
    OLCesium: typeof OLCesium;
    oGlobe?: any;
  }
}

setCameraHeight(1.6);
setIsStreetMode(false);
window.Cesium = Cesium;
window.OLCesium = OLCesium;

// ============================================================================
// Globe Plugin
// ============================================================================

const Globe = function Globe(options: GlobeOptionsInput = {}) {
  // DEBUG: Log incoming options
  console.log('[Globe DEBUG] Globe() called with options:', options);
  console.log('[Globe DEBUG] options.indexJson exists?', !!options.indexJson);
  console.log('[Globe DEBUG] options.indexJson["3D"]:', options.indexJson?.['3D']);
  
  // Process and validate configuration
  const { resolved: config } = processGlobeOptions(options);
  
  // DEBUG: Log resolved config
  console.log('[Globe DEBUG] Resolved config:', config);
  console.log('[Globe DEBUG] config.drawToolConfig:', config.drawToolConfig);

  // Extract commonly used options
  const {
    globeOnStart,
    viewShed,
    quickTimeShadowPicker,
    drawTool,
    fx,
    streetView,
    streetViewMap,
    cameraControls,
    measure,
    settings,
  } = config;

  // Mutable target (may be set on init)
  let target = config.target;

  // ============================================================================
  // State
  // ============================================================================

  let map: any;
  let viewer: any;
  let oGlobe: OLCesium;
  let oGlobeTarget: string;
  let featureInfo: any;
  let scene: Cesium.Scene;
  let fp: flatpickr.Instance | null = null;
  let cesiumHandler: Cesium.ScreenSpaceEventHandler | undefined;

  // UI references
  let globeEl: OrigoElement;
  let polygonUi: PolygonUiApi | null = null;
  let measureUi: MeasureUiApi | null = null;

  // Button manager
  const buttonManager = new ButtonManager();
  let quickTimeButton: OrigoButton | null = null;

  // Lifecycle
  let hasActivatedOnStart = false;

  // ============================================================================
  // Cleanup Management
  // ============================================================================

  const cleanupStack = new CleanupStack();
  const registerCleanup = (fn?: CleanupFn) => cleanupStack.push(fn);
  const registerOptionalCleanup = (fn?: CleanupFn | void) => cleanupStack.pushOptional(fn);
  const flushCleanups = () => cleanupStack.flush();

  // DOM tracking
  const ownedDomNodes: HTMLElement[] = [];
  const trackNode = (node: HTMLElement) => { ownedDomNodes.push(node); return node; };
  const cleanupDom = () => { ownedDomNodes.splice(0).forEach(n => n.remove()); };

  // ============================================================================
  // DOM Injection Helpers
  // ============================================================================

  const injectAtBodyStart = (markup: string): HTMLElement | undefined => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const node = createElementFromMarkup(markup);
    if (!node) return undefined;
    document.body.insertBefore(node, document.body.firstChild);
    return trackNode(node);
  };

  const injectIntoMap = (markup: string): HTMLElement | undefined => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const node = createElementFromMarkup(markup);
    if (!node) return undefined;
    
    const parent = (target ? document.getElementById(target) : null)
      ?? document.querySelector('.o-map')
      ?? document.body;
    parent.appendChild(node);
    return trackNode(node);
  };

  // ============================================================================
  // Request Render
  // ============================================================================

  const requestSceneRender = () => scene?.requestRender();

  // Set Cesium Ion token
  if (config.cesiumIontoken) {
    Cesium.Ion.defaultAccessToken = config.cesiumIontoken;
  }

  // ============================================================================
  // 2D/3D Control Visibility Management
  // ============================================================================

  /**
   * Toggles visibility of 2D controls based on globe state.
   * When globe (3D) is active, hides 2D controls.
   * When globe is inactive (2D mode), shows all 2D controls.
   */
  const toggle2DControls = (globeActive: boolean): void => {
    const hide2DSelectors = config.hide2DControlsInGlobe;

    if (!hide2DSelectors || hide2DSelectors.length === 0) return;

    hide2DSelectors.forEach(selector => {
      try {
        const elements = document.querySelectorAll<HTMLElement>(selector);
        elements.forEach(el => {
          // Hide in 3D mode, show in 2D mode
          el.style.display = globeActive ? 'none' : '';
        });
      } catch (e) {
        console.warn(`[Globe] Invalid selector for hide2DControlsInGlobe: ${selector}`, e);
      }
    });
  };

  // ============================================================================
  // Globe Toggle Logic
  // ============================================================================

  const toggleGlobe = (): void => {
    if (!viewer || !oGlobe || !scene) {
      console.warn('Globe toggle ignored - viewer/scene unavailable');
      return;
    }

    const projection = viewer.getProjectionCode();
    if (projection !== 'EPSG:4326' && projection !== 'EPSG:3857') {
      console.error('Map projection must be EPSG:4326 or EPSG:3857 for globe mode');
      return;
    }

    oGlobe.setEnabled(!isGlobeActive(oGlobe));
    requestSceneRender();

    const active = isGlobeActive(oGlobe);

    // Exit street mode when switching to 2D
    if (!active) {
      forceExitStreetMode();
    }

    // Toggle UI visibility
    const updates: [string | null, string, string][] = [
      ['streetView', active ? 'flex' : 'none', 'flex'],
      ['controlUI', active ? 'flex' : 'none', 'flex'],
      ['o-tools-bottom', active ? 'none' : 'flex', 'flex'],
      ['o-console', active ? 'none' : 'flex', 'flex'],
    ];

    updates.forEach(([id, activeStyle]) => {
      if (id) {
        const el = document.getElementById(id);
        if (el) el.style.display = activeStyle;
      }
    });

    const footer = document.getElementsByClassName('o-footer-middle')[0] as HTMLElement;
    if (footer) footer.style.paddingLeft = active ? '5px' : '0px';

    // Toggle 2D controls visibility based on globe state
    toggle2DControls(active);
  };

  // ============================================================================
  // Button State Management
  // ============================================================================

  const toggleButtons = (): void => {
    const globeBtn = buttonManager.get(BUTTON_IDS.GLOBE);
    if (!globeBtn) return;

    const isActive = !globeBtn.isActive();
    globeBtn.setActive(isActive);

    // Show/hide dependent buttons
    GLOBE_DEPENDENT_BUTTONS.forEach(id => {
      buttonManager.get(id)?.setVisible(isActive);
    });

    // Also handle quickTime button if it exists
    if (quickTimeButton) {
      const el = document.getElementById(quickTimeButton.getId());
      el?.classList.toggle('hidden', !isActive);
    }

    // Disable time pickers when shadows are off
    const shadowsActive = buttonManager.get(BUTTON_IDS.SHADOWS)?.isActive() ?? false;
    SHADOW_DEPENDENT_BUTTONS.forEach(id => {
      buttonManager.get(id)?.setDisabled(!shadowsActive);
    });
    if (quickTimeButton) {
      const el = document.getElementById(quickTimeButton.getId()) as HTMLButtonElement;
      if (el) {
        el.classList.toggle('disabled', !shadowsActive);
        el.disabled = !shadowsActive;
      }
    }

    // Deactivate draw tool when globe disabled
    if (!isActive) {
      buttonManager.get(BUTTON_IDS.DRAW_TOOL)?.setActive(false);
      polygonUi?.setPolygonToolbarVisible(false);
    }
  };

  const setActiveControls = (globe: OLCesium, v: any): void => {
    console.log(v);
    if (!v) return;
    config.deactivateControls.forEach((name: string) => {
      const control = v.getControlByName(name);
      if (!control) {
        console.error(`No control "${name}" to toggle for globe`);
      } else if (isGlobeActive(globe)) {
        control.hide();
      } else {
        control.unhide();
      }
    });
  };

  // ============================================================================
  // Button Click Handlers
  // ============================================================================

  const buttonHandlers: Record<string, (btn: ButtonInstance, el: HTMLElement) => void> = {
    [BUTTON_IDS.GLOBE]: () => {
      toggleGlobe();
      toggleButtons();
      setActiveControls(oGlobe, viewer);
    },

    [BUTTON_IDS.SHADOWS]: (btn) => {
      if (!scene?.shadowMap) return;
      const active = !btn.isActive();
      btn.setActive(active);
      scene.shadowMap.enabled = active;

      SHADOW_DEPENDENT_BUTTONS.forEach(id => {
        buttonManager.get(id)?.setDisabled(!active);
      });
      if (quickTimeButton) {
        const el = document.getElementById(quickTimeButton.getId()) as HTMLButtonElement;
        if (el) {
          el.classList.toggle('disabled', !active);
          el.disabled = !active;
        }
      }
      requestSceneRender();
    },

    [BUTTON_IDS.FLATPICKR]: (btn) => {
      if (!fp) return;
      const active = !btn.isActive();
      btn.setActive(active);
      active ? fp.open() : fp.close();
    },

    [BUTTON_IDS.VIEWSHED]: (btn) => {
      btn.setActive(!btn.isActive());
    },

    [BUTTON_IDS.DRAW_TOOL]: (btn) => {
      const active = !btn.isActive();
      btn.setActive(active);
      if (active) {
        polygonUi?.mountPolygonToolbarIfNeeded();
        polygonUi?.setPolygonToolbarVisible(true);
      } else {
        polygonUi?.setPolygonToolbarVisible(false);
      }
    },

    [BUTTON_IDS.MEASURE_3D]: (btn) => {
      if (!measureUi) return;
      const active = !btn.isActive();
      btn.setActive(active);
      if (active) {
        measureUi.mountMeasureToolbarIfNeeded();
        measureUi.setMeasureToolbarVisible(true);
      } else {
        measureUi.setMeasureToolbarVisible(false);
      }
      requestSceneRender();
    },

    [BUTTON_IDS.FX]: (btn) => {
      if (!scene?.shadowMap) return;
      const active = !btn.isActive();
      btn.setActive(active);

      const shadows = settings?.shadows;
      scene.shadowMap.normalOffset = active && shadows ? Boolean(shadows.normalOffset) : false;
      scene.shadowMap.size = active && shadows ? shadows.size : 1024;
      requestSceneRender();
    },
  };

  // ============================================================================
  // Helper Functions
  // ============================================================================

  const initTimeSetter = (): CleanupFn | void => {
    if (!target) return;
    const result = timeSetter({ target, trackNode, requestSceneRender });
    if (!result) return;
    fp = result.fp;
    return () => {
      result.cleanup();
      fp = null;
    };
  };

  const flyTo = (
    destination: Cesium.Cartesian3,
    duration: number,
    orientation = { heading: 0, pitch: 0, roll: 0 }
  ) => {
    if (getIsStreetMode() || !scene) return;

    if (config.flyTo) {
      scene.camera.flyTo({
        destination,
        duration,
        orientation,
        complete: requestSceneRender,
      });
    } else {
      const camera = scene.camera;
      const frozenDest = Cesium.Cartesian3.clone(camera.positionWC);
      const frozenOrient = {
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      };
      const handler = camera.changed.addEventListener(() => {
        camera.setView({ destination: frozenDest, orientation: frozenOrient });
      });
      setTimeout(() => handler?.(), 600);
    }
  };

  const addStreetView = (handler: Cesium.ScreenSpaceEventHandler): CleanupFn | void => {
    if (!streetView) return;
    const node = injectAtBodyStart(streetViewHtml(`${getCameraHeight().toFixed(2)} m`));
    void StreetView(scene, handler, oGlobe, streetViewMap);
    return () => node?.remove();
  };

  const addCameraControls = (): CleanupFn | void => {
    if (!cameraControls) return;
    const node = injectAtBodyStart(cameraControlsHtml());
    return () => node?.remove();
  };

  const addPickedFeatureStyle = (handler: Cesium.ScreenSpaceEventHandler): CleanupFn | void => {
    if (!Cesium.PostProcessStageLibrary.isSilhouetteSupported(scene)) return;

    const silhouette = Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
    silhouette.uniforms.color = Cesium.Color.ROYALBLUE;
    silhouette.uniforms.length = 0.01;
    silhouette.selected = [];

    const stage = Cesium.PostProcessStageLibrary.createSilhouetteStage([silhouette]);
    scene.postProcessStages.add(stage);

    let lastPick = 0;
    const onMove = ({ position }: { position: Cesium.Cartesian2 }) => {
      const now = performance.now();
      if (now - lastPick < 120) return;
      lastPick = now;
      const picked = position ? scene.pick(position) : undefined;
      silhouette.selected = picked ? [picked] : [];
      requestSceneRender();
    };

    handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      scene.postProcessStages.remove(stage);
    };
  };

  const activeGlobeOnStart = (): void => {
    if (!globeOnStart || hasActivatedOnStart || !oGlobe) return;
    hasActivatedOnStart = true;
    toggleGlobe();
    toggleButtons();
    setActiveControls(oGlobe, viewer);
  };

  const showGlobeOption = (): void => {
    if (!config.showGlobe && scene) {
      scene.globe.show = false;
      requestSceneRender();
    }
  };

  const cesiumCredits = (): void => {
    const container = document.querySelector<HTMLElement>('.cesium-credit-logoContainer')?.parentNode as HTMLElement;
    if (container) container.style.display = 'none';
  };

  // ============================================================================
  // Origo Component
  // ============================================================================

  return Origo.ui.Component({
    name: 'globe',

    onInit() {
      // Create container element
      globeEl = Origo.ui.Element({
        tagName: 'div',
        cls: 'flex column z-index-ontop-top-times20',
      });

      // Register buttons with ButtonManager
      const buttonConfigs = getGlobeButtonConfigs({
        viewShed,
        drawTool: !!drawTool,
        quickTimeShadowPicker,
        fx,
        measure,
      });

      buttonConfigs.forEach(cfg => {
        const handler = buttonHandlers[cfg.id];
        if (handler || cfg.id === BUTTON_IDS.GLOBE) {
          buttonManager.register({
            ...cfg,
            onClick: (btn, el) => (handler || buttonHandlers[BUTTON_IDS.GLOBE])?.(btn, el),
          });
        }
      });

      // Handle quickTimePicker separately (has custom button creation)
      if (quickTimeShadowPicker) {
        const picker = quickTimePicker(() => fp);
        if (picker?.button) {
          quickTimeButton = picker.button;
          registerCleanup(picker.dispose);
        }
      }
    },

    onAdd(evt: any) {
      viewer = evt.target;
      if (!target) target = viewer.getMain().getNavigation().getId();
      oGlobeTarget = viewer.getId();
      map = viewer.getMap();
      featureInfo = viewer.getControlByName('featureInfo');

      // Initialize time setter
      registerOptionalCleanup(initTimeSetter());

      // Create OLCesium
      oGlobe = new window.OLCesium({
        map,
        target: oGlobeTarget,
        time: () => {
          // Static time for shadow positioning from time picker
          const val = (fp?.input as HTMLInputElement)?.value;
          return Cesium.JulianDate.fromDate(val ? new Date(val) : new Date());
        },
        sceneOptions: {
          contextOptions: {
            webgl: {
              preserveDrawingBuffer: true
            }
          }
        }
      });

      scene = oGlobe.getCesiumScene();
      window.oGlobe = oGlobe;

      // Setup direct Cesium imagery layers (bypasses OLImageryProvider for speed)
      // Read from config (merged from indexJson["3D"])
      const directLayers = config.directCesiumLayers;
      if (directLayers?.length) {
        // Get projection extent to limit tile fetching
        const view = map.getView();
        const projection = view.getProjection();
        const projExtent = projection.getExtent();
        const projCode = projection.getCode();
        
        const directImageryCleanup = setupDirectCesiumImagery(map, scene, directLayers, {
          extent: projExtent ? [projExtent[0], projExtent[1], projExtent[2], projExtent[3]] : undefined,
          crs: projCode
        });
        registerCleanup(directImageryCleanup);
      }

      // Configure rendering
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;

      // Dynamic resolution scaling
      const scaler = dynamicResolutionScaling(oGlobe, scene, {
        forceLowEnd: false,
        forceHighEnd: false,
        debugLogs: true,
      });
      registerCleanup(() => scaler?.dispose?.());

      // Create tools
      polygonUi = createPolygonUi({
        scene,
        map,
        injectIntoMap,
        requestSceneRender,
        registerCleanup,
        stopDomEvent,
        drawToolOptions: config.drawToolConfig,
      });
      registerCleanup(() => { polygonUi?.destroy(); polygonUi = null; });

      measureUi = createMeasureUi({
        scene,
        map,
        injectIntoMap,
        requestSceneRender,
        registerCleanup,
        stopDomEvent,
      });
      measureUi.mountMeasureToolbarIfNeeded();
      registerCleanup(() => { measureUi?.destroy(); measureUi = null; });

      // Post-render patches
      const onPostRender = () => patchCollections(scene);
      scene.postRender.addEventListener(onPostRender);
      registerCleanup(() => scene.postRender.removeEventListener(onPostRender));

      // Event handler
      cesiumHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

      // Add features
      registerOptionalCleanup(addStreetView(cesiumHandler));
      if (viewShed) {
        const viewshedBtn = buttonManager.get(BUTTON_IDS.VIEWSHED)?.button;
        if (viewshedBtn) {
          ViewShed(scene, viewshedBtn, cesiumHandler);
        }
      }
      registerOptionalCleanup(addCameraControls());
      showGlobeOption();
      cesiumCredits();
      initializeSvgIcons(trackNode);
      setActiveControls(oGlobe, viewer);
      registerOptionalCleanup(addPickedFeatureStyle(cesiumHandler));

      // Load shared polygons from URL
      try {
        registerOptionalCleanup(polygonUi?.loadSharedPolygonsFromUrl());
      } catch { /* ignore */ }

      // Camera controls
      CameraControls(scene);

      // Feature info
      getFeatureInfo(scene, viewer, map, featureInfo, flyTo);

      // Scene configuration
      configureScene(scene, settings);
      configureGlobeAppearance(scene, settings);

      // Load terrain and assets
      loadTerrainProvider(scene, {
        cesiumTerrainProvider: config.cesiumTerrainProvider,
        cesiumIonassetIdTerrain: config.cesiumIonassetIdTerrain,
        cesiumIontoken: config.cesiumIontoken,
      }).catch((e: Error) => console.error('Terrain load failed', e));

      load3DTiles(scene, map, config.cesiumIontoken);
      loadGltfAssets(scene, config.gltf);

      // Add components and render
      const components = [...buttonManager.getOrigoButtons()];
      if (quickTimeButton) {
        components.push(quickTimeButton);
      }
      this.addComponents(components);
      this.render();
    },

    render() {
      // Render container
      const targetEl = document.getElementById(target ?? '');
      if (targetEl) {
        const globeNode = Origo.ui.dom.html(globeEl.render());
        targetEl.appendChild(globeNode);
      }

      // Render buttons
      const container = document.getElementById(globeEl.getId());
      if (container) {
        buttonManager.renderInto(container);

        // Insert quickTime button before flatpickr button (so it appears above)
        if (quickTimeButton) {
          const node = Origo.ui.dom.html(quickTimeButton.render());
          const flatpickrBtn = buttonManager.get(BUTTON_IDS.FLATPICKR);
          const flatpickrEl = flatpickrBtn?.getElement();
          if (flatpickrEl) {
            flatpickrEl.parentNode?.insertBefore(node, flatpickrEl);
          } else {
            container.appendChild(node);
          }
        }
      }

      activeGlobeOnStart();
      this.dispatch('render');
    },

    onRemove() {
      try { oGlobe?.setEnabled(false); } catch (e) {
        console.warn('Failed to disable globe', e);
      }

      flushCleanups();
      cesiumHandler?.destroy();
      cesiumHandler = undefined;
      cleanupDom();
      buttonManager.clear();
      hasActivatedOnStart = false;
    },

    // Public API
    isGlobeActive: () => isGlobeActive(oGlobe),
    threedtiletype: () => threedtile,
    gltftype: () => addGLTF,
    globalOLCesium: () => OLCesium,
  });
};

export default Globe;
