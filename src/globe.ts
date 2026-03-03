import * as Cesium from 'cesium';
import flatpickr from 'flatpickr';
import OLCesium from 'olcs/OLCesium';
import Origo, { OrigoButton, OrigoElement } from 'Origo';

import measureTool from './functions/measureTool';
import addGLTF from './layer/gltf';
import { threedtile } from './layer/layerhelper';
import getFeatureInfo from './functions/featureinfo';
import ViewShed from './functions/ViewShed';
import StreetView from './functions/StreetView';
import CameraControls from './functions/CameraControls';
import dynamicResolutionScaling from './functions/dynamicResolutionScaling';
import patchCollections from './functions/patchCollections';
import quickTimePicker from './functions/quickTimePicker';
import { setCameraHeight, getCameraHeight, setIsStreetMode, getIsStreetMode, isGlobeActive } from './globeState';
import { streetViewHtml, cameraControlsHtml } from './uiTemplates';
import { createElementFromMarkup, stopDomEvent } from './globe/domUtils';
import { configureGlobeAppearance, configureScene, loadGltfAssets, loadTerrainProvider, load3DTiles } from './globe/sceneConfig';
import { createPolygonUi } from './globe/polygonUi';

import type { PolygonUiApi } from './globe/polygonUi';
import type { CleanupFn, GLTFAsset, GlobeSettings } from './globe/types';

class CleanupStack {
  private stack: CleanupFn[] = [];

  push(fn?: CleanupFn): void {
    if (fn) {
      this.stack.push(fn);
    }
  }

  flush(): void {
    while (this.stack.length) {
      const dispose = this.stack.pop();
      try {
        dispose?.();
      } catch (error) {
        console.warn('Globe cleanup failed', error);
      }
    }
  }
}

declare global {
  interface Window {
    Cesium: typeof Cesium;
    OLCesium: typeof OLCesium;
    oGlobe?: any;
  }
  interface ImportMeta {
    hot?: {
      dispose(callback: () => void): void;
    };
  }
}

interface GlobeOptions {
  target?: string;
  globeOnStart?: boolean;
  showGlobe?: boolean;
  streetView?: boolean;
  cameraControls?: boolean;
  viewShed?: boolean;
  measure?: boolean;
  flyTo?: boolean;
  quickTimeShadowPicker?: boolean;
  drawTool?: boolean;
  fx?: boolean;
  resolutionScale?: number;
  settings?: GlobeSettings;
  cesiumTerrainProvider?: string;
  cesiumIontoken?: string;
  cesiumIonassetIdTerrain?: number;
  gltf?: GLTFAsset[];
  deactivateControls?: string[];
}

const DEFAULT_OPTIONS: Required<Pick<GlobeOptions,
  'showGlobe' |
  'streetView' |
  'cameraControls' |
  'viewShed' |
  'measure' |
  'flyTo' |
  'quickTimeShadowPicker' |
  'drawTool' |
  'fx'
>> & { deactivateControls: string[] } = {
  showGlobe: true,
  streetView: false,
  cameraControls: false,
  viewShed: false,
  measure: false,
  flyTo: false,
  quickTimeShadowPicker: false,
  drawTool: false,
  fx: false,
  deactivateControls: [],
};

setCameraHeight(1.6);
setIsStreetMode(false);
window.Cesium = Cesium;
window.OLCesium = OLCesium;

const Globe = function Globe(options: GlobeOptions = {}) {
  const resolvedOptions = {
    resolutionScale: window.devicePixelRatio,
    settings: {},
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let {
    target,
    globeOnStart,
    showGlobe,
    resolutionScale,
    settings,
    cesiumTerrainProvider,
    cesiumIontoken,
    cesiumIonassetIdTerrain,
    gltf,
    deactivateControls,
    streetView,
    viewShed,
    cameraControls,
    measure,
    flyTo,
    quickTimeShadowPicker,
    drawTool,
    fx,
  } = resolvedOptions;

  let map: any;
  let viewer: any;
  let oGlobe: OLCesium;
  let oGlobeTarget: string;
  let featureInfo: any;
  let scene: Cesium.Scene;
  let fp: flatpickr.Instance | null = null;

  let globeEl: OrigoElement;
  let globeButton: OrigoButton;
  let flatpickrButton: OrigoButton;
  let viewshedButton: OrigoButton | null = null;
  let toggleShadowsButton: OrigoButton;
  let quickTimePickerButton: OrigoButton | null = null;
  let drawToolButton: OrigoButton | null = null;
  let toggleFXButton: OrigoButton | null = null;

  let cesiumHandler: Cesium.ScreenSpaceEventHandler | undefined;
  let pickHandler: Cesium.ScreenSpaceEventHandler | undefined;

  const cleanupStack = new CleanupStack();
  const registerCleanup = (cleanup?: CleanupFn) => cleanupStack.push(cleanup);
  const flushCleanups = () => cleanupStack.flush();
  const registerOptionalCleanup = (maybeCleanup?: CleanupFn | void) => {
    if (typeof maybeCleanup === 'function') {
      registerCleanup(maybeCleanup);
    }
  };

  const ownedDomNodes: HTMLElement[] = []; // track nodes mounted outside component root for cleanup
  const trackNode = (node: HTMLElement) => { ownedDomNodes.push(node); return node; };
  const cleanupDom = () => { ownedDomNodes.splice(0).forEach(n => n.remove()); };

  const injectAtBodyStart = (markup: string): HTMLElement | undefined => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const node = createElementFromMarkup(markup);
    if (!node) return undefined;
    document.body.insertBefore(node, document.body.firstChild);
    trackNode(node);
    return node;
  };
  const injectIntoMap = (markup: string): HTMLElement | undefined => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const node = createElementFromMarkup(markup);
    if (!node) return undefined;

    const parent = (target ? document.getElementById(target) : null)
      ?? (document.querySelector('.o-map') as HTMLElement | null)
      ?? document.body;
    parent.appendChild(node);
    trackNode(node);
    return node;
  };
  const cleanupCesiumHandlers = () => {
    cesiumHandler?.destroy(); cesiumHandler = undefined;
    pickHandler?.destroy(); pickHandler = undefined;
  };

  const buttons: OrigoButton[] = [];

  if (cesiumIontoken) {
    Cesium.Ion.defaultAccessToken = cesiumIontoken;
  }

  const requestSceneRender = () => scene?.requestRender();

  let polygonUi: PolygonUiApi | null = null;

  const toggleGlobe = (): void => {
    if (!viewer || !oGlobe || !scene) {
      console.warn('Globe toggle ignored because viewer or scene is unavailable');
      return;
    }

    const projection = viewer.getProjectionCode();
    if (projection === 'EPSG:4326' || projection === 'EPSG:3857') {
      oGlobe.setEnabled(!isGlobeActive(oGlobe));
      requestSceneRender();
      const streetViewEl = document.getElementById('streetView');
      const controlUI = document.getElementById('controlUI');
      const oToolsBottom = document.getElementById('o-tools-bottom');
      const oConsole = document.getElementById('o-console');
      const oFooterMiddle = document.getElementsByClassName('o-footer-middle')[0] as HTMLElement;
      if (oFooterMiddle) {
        oFooterMiddle.style.paddingLeft = isGlobeActive(oGlobe) ? '5px' : '0px';
      }
      if (oToolsBottom) {
        oToolsBottom.style.display = isGlobeActive(oGlobe) ? 'none' : 'flex';
      }
      if (oConsole) {
        oConsole.style.display = isGlobeActive(oGlobe) ? 'none' : 'flex';
      }

      if (streetViewEl && controlUI) {
        streetViewEl.style.display = !isGlobeActive(oGlobe) ? 'none' : 'flex';
        controlUI.style.display = !isGlobeActive(oGlobe) ? 'none' : 'flex';
      }
    } else {
      console.error('Map projection must be EPSG:4326 or EPSG:3857 to be able to use globe mode.');
    }
  };

  const toggleButtons = (): void => {
    const globeButtonEl = document.getElementById(globeButton.getId());
    globeButtonEl?.classList.toggle('active');

    const flatpickrButtonEl = document.getElementById(flatpickrButton.getId());
    const viewshedButtonEl = viewshedButton ? document.getElementById(viewshedButton.getId()) : null;
    const toggleShadowsButtonEl = document.getElementById(toggleShadowsButton.getId());
    const quickTimePickerButtonEl = quickTimePickerButton ? document.getElementById(quickTimePickerButton.getId()) : null;
    const toggleFXButtonEl = toggleFXButton ? document.getElementById(toggleFXButton.getId()) : null;
    const drawToolButtonEl = drawToolButton ? document.getElementById(drawToolButton.getId()) : null;

    const isActive = globeButtonEl?.classList.contains('active') ?? false;
    flatpickrButtonEl?.classList.toggle('hidden', !isActive);
    viewshedButtonEl?.classList.toggle('hidden', !isActive);
    toggleShadowsButtonEl?.classList.toggle('hidden', !isActive);
    quickTimePickerButtonEl?.classList.toggle('hidden', !isActive);
    toggleFXButtonEl?.classList.toggle('hidden', !isActive);
    drawToolButtonEl?.classList.toggle('hidden', !isActive);

    if (!isActive) {
      drawToolButtonEl?.classList.remove('active');
      polygonUi?.setPolygonToolbarVisible(false);
    }
  };

  let hasActivatedOnStart = false;

  const helpers = {
    activeGlobeOnStart: (): void => {
      if (!globeOnStart || hasActivatedOnStart || !oGlobe) return;
      hasActivatedOnStart = true;
      toggleGlobe();
      toggleButtons();
      helpers.setActiveControls(oGlobe, viewer);
    },
    showGlobeOption: (): void => {
      if (!showGlobe && scene) {
        scene.globe.show = false;
        requestSceneRender();
      }
    },
    cesiumCredits: (): void => {
      const container = document.querySelector<HTMLElement>('.cesium-credit-logoContainer')?.parentNode as HTMLElement;
      if (container) container.style.display = 'none';
    },
    setActiveControls: (getGlobe: OLCesium, v: any): void => {
      if (!v) return;
      deactivateControls.forEach((name) => {
        const control = v.getControlByName(name);
        if (!control) console.error(`No control named "${name}" to hide/unhide for globe control`);
        else if (isGlobeActive(getGlobe)) control.hide();
        else control.unhide();
      });
    },
    timeSetter: (): CleanupFn | void => {
      if (!target) return;
      const parent = document.getElementById(target);
      if (!parent) return;
      const flatpickrEl = Origo.ui.Element({ tagName: 'div', cls: 'flatpickrEl z-index-ontop-top-times20' });
      const markup = flatpickrEl.render();
      const htmlNode = Origo.ui.dom.html(markup) as (HTMLElement | DocumentFragment | null);
      const targetElement = htmlNode instanceof HTMLElement
        ? htmlNode
        : htmlNode?.firstElementChild as HTMLElement | null;
      if (!htmlNode || !targetElement) return;
      parent.appendChild(htmlNode);
      trackNode(targetElement);
      fp = flatpickr(targetElement, {
        enableTime: true,
        defaultDate: new Date(),
        enableSeconds: true,
        disableMobile: true,
        time_24hr: true,
      });
      return () => {
        fp?.destroy();
        fp = null;
        targetElement.remove();
      };
    },
    flyTo: (destination: Cesium.Cartesian3, duration: number, orientation = { heading: 0, pitch: 0, roll: 0 }) => {
      if (getIsStreetMode()) return;
      if (flyTo) {
        scene.camera.flyTo({
          destination,
          duration,
          orientation,
          complete: requestSceneRender
        });
      } else {
        if (scene && scene.camera) {
          const camera = scene.camera;
          const destination = Cesium.Cartesian3.clone(camera.positionWC);
          const orientation = {
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll
          };

          const freezeHandler = camera.changed.addEventListener(() => {
            camera.setView({
              destination,
              orientation
            });
          });

          setTimeout(() => {
            if (freezeHandler) {
              freezeHandler();
            }
          }, 600);
        }
      }
    },
    setView: (
      destination: Cesium.Cartesian3,
      orientation: { heading: number; pitch: number; roll: number }
        ) => {
      if (getIsStreetMode()) return;
      scene.camera.setView({
        destination,
        orientation
      });
      requestSceneRender();
    },
    addSvgIcons: () => {
      if (typeof document === 'undefined' || !document.body) return;

      const svgNs = 'http://www.w3.org/2000/svg';
      let spriteWrapper = document.getElementById('globe-svg-sprite') as HTMLElement | null;

      if (!spriteWrapper) {
        spriteWrapper = document.createElement('div');
        spriteWrapper.id = 'globe-svg-sprite';
        spriteWrapper.style.display = 'none';

        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('xmlns', svgNs);
        spriteWrapper.appendChild(svg);

        document.body.insertBefore(spriteWrapper, document.body.firstChild ?? null);
        trackNode(spriteWrapper);
      }

      let spriteSvg = spriteWrapper.querySelector('svg') as SVGSVGElement | null;
      if (!spriteSvg) {
        spriteSvg = document.createElementNS(svgNs, 'svg');
        spriteSvg.setAttribute('xmlns', svgNs);
        spriteWrapper.appendChild(spriteSvg);
      }

      const ensureSymbol = (id: string, viewBox: string, innerSvg: string) => {
        if (document.getElementById(id)) return;
        const symbol = document.createElementNS(svgNs, 'symbol');
        symbol.setAttribute('id', id);
        symbol.setAttribute('viewBox', viewBox);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (symbol as any).innerHTML = innerSvg;
        spriteSvg!.appendChild(symbol);
      };

      // Existing globe icons
      ensureSymbol(
        'ic_cube_24px',
        '0 0 24 24',
        '<path d="M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15Z" />'
      );
      ensureSymbol(
        'ic_clock-time-four_24px',
        '0 0 24 24',
        '<path d="M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C17.5 22 22 17.5 22 12S17.5 2 12 2M16.3 15.2L11 12.3V7H12.5V11.4L17 13.9L16.3 15.2Z" />'
      );
      ensureSymbol(
        'ic_box-shadow_24px',
        '0 0 24 24',
        '<path d="M3,3H18V18H3V3M19,19H21V21H19V19M19,16H21V18H19V16M19,13H21V15H19V13M19,10H21V12H19V10M19,7H21V9H19V7M16,19H18V21H16V19M13,19H15V21H13V19M10,19H12V21H10V19M7,19H9V21H7V19Z" />'
      );
      ensureSymbol(
        'ic_chevron_right_24px',
        '0 0 24 24',
        '<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />'
      );

      // Origo-style toolbar icons (fallbacks). If Origo already provides these IDs,
      // we don't override them.
      ensureSymbol(
        'o_polygon_24px',
        '0 0 24 24',
        '<path d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zm2.92 2.08H5v-1.92l9.06-9.06 1.92 1.92-9.06 9.06zm13.06-12.19c.39-.39.39-1.02 0-1.41l-2.34-2.34a.995.995 0 0 0-1.41 0l-1.13 1.13 3.75 3.75 1.13-1.13z" />'
      );
      ensureSymbol(
        'ic_height_24px',
        '0 0 24 24',
        '<path d="M7 2h10v2H7V2zm0 18h10v2H7v-2zM11 6h2v12h-2V6zm-3 3l-3 3 3 3V9zm8 0v6l3-3-3-3z" />'
      );
      ensureSymbol(
        'ic_delete_24px',
        '0 0 24 24',
        '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />'
      );
      ensureSymbol(
        'ic_share_24px',
        '0 0 24 24',
        '<path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.53.5 1.23.81 2.01.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.07 8.81C7.53 8.31 6.83 8 6.05 8c-1.66 0-3 1.34-3 3s1.34 3 3 3c.78 0 1.48-.31 2.01-.81l7.12 4.17c-.05.21-.08.43-.08.64 0 1.52 1.23 2.75 2.75 2.75s2.75-1.23 2.75-2.75-1.23-2.75-2.75-2.75z" />'
      );
      ensureSymbol(
        'ic_title_24px',
        '0 0 24 24',
        '<path d="M3 5v14h18V5H3zm16 12H5V7h14v10z" /><path d="M7 9h10v2H7V9zm0 4h6v2H7v-2z" />'
      );
      ensureSymbol(
        'ic_download_24px',
        '0 0 24 24',
        '<path d="M5 20h14v-2H5v2zm7-18c-.55 0-1 .45-1 1v10.59l-3.29-3.29c-.63-.63-1.71-.18-1.71.71 0 .39.16.77.44 1.06l5 5c.39.39 1.02.39 1.41 0l5-5c.28-.29.44-.67.44-1.06 0-.89-1.08-1.34-1.71-.71L13 13.59V3c0-.55-.45-1-1-1z" />'
      );
    },
    addStreetView:(streetViewEnabled: boolean, handler: Cesium.ScreenSpaceEventHandler, globe: any): CleanupFn | void => {
      if (streetViewEnabled) {
        const node = injectAtBodyStart(streetViewHtml(`${getCameraHeight().toFixed(2)} m`));
        void StreetView(scene, handler, globe);
        return () => node?.remove();
      }
      return undefined;
    },
    addViewShed:(viewShedEnabled: boolean, handler: Cesium.ScreenSpaceEventHandler, button: OrigoButton | null) => {
      if (viewShedEnabled && scene && button) {
        ViewShed(scene, button, handler);
      }
    },
    addControls: () => {
      if (cameraControls) {
        const node = injectAtBodyStart(cameraControlsHtml());
        return () => node?.remove();
      }
      return undefined;
    },
    pickedFeatureStyle: (handler: Cesium.ScreenSpaceEventHandler): CleanupFn | void => {
      if (!Cesium.PostProcessStageLibrary.isSilhouetteSupported(scene)) return;

      const silhouette = Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
      silhouette.uniforms.color = Cesium.Color.ROYALBLUE;
      silhouette.uniforms.length = 0.01;
      silhouette.selected = [];

      const silhouetteStage = Cesium.PostProcessStageLibrary.createSilhouetteStage([silhouette]);
      scene.postProcessStages.add(silhouetteStage);

      let lastPickTime = 0;
      const mouseMoveEvent = Cesium.ScreenSpaceEventType.MOUSE_MOVE;
      const onMove = ({ position }: { position: Cesium.Cartesian2 }) => {
        const now = performance.now();
        if (now - lastPickTime < 120) return;
        lastPickTime = now;

        const pickedFeature = position ? scene.pick(position) : undefined;
        silhouette.selected = pickedFeature ? [pickedFeature] : [];
        requestSceneRender();
      };
      handler.setInputAction(onMove, mouseMoveEvent);

      return () => {
        handler.removeInputAction(mouseMoveEvent);
        scene.postProcessStages.remove(silhouetteStage);
      };
    },
    addMeasureTool: (scene: Cesium.Scene): (() => void) | undefined => {
      if (!measure) return;

      const button = document.getElementsByClassName('o-measure')[0] as HTMLElement | undefined;
      if (!button) return;

      let tool: ReturnType<typeof measureTool> | null = null;

      const originalOnClick = button.onclick; // keep default 2D handler
      button.onclick = null; // avoid duplicate firing when globe mode hijacks the button

      const onClick = (e: Event) => {
        if (!isGlobeActive(oGlobe)) {
          originalOnClick?.call(button, e as any);
          return;
        }

        // Consume the event so Origo's 2D logic stays disabled while the globe is active
        stopDomEvent(e);

        if (!tool) {
          tool = measureTool(scene);
          tool.measureDistance();
          button.classList.add('active');
        } else {
          tool.destroy();
          tool = null;
          button.classList.remove('active');
        }

        requestSceneRender();
      };

      button.addEventListener('click', onClick, true); // capture ensures we intercept before Origo handlers

      return () => {
        button.removeEventListener('click', onClick, true);

        tool?.destroy();
        tool = null;

        button.onclick = originalOnClick ?? null; // restore default handler
        button.classList.remove('active');
      };
    },
  };

  return Origo.ui.Component({
    name: 'globe',
    onAdd(evt: any) {
      viewer = evt.target;
      if (!target) target = `${viewer.getMain().getNavigation().getId()}`;
      oGlobeTarget = viewer.getId();
      map = viewer.getMap();
      featureInfo = viewer.getControlByName('featureInfo');
      registerOptionalCleanup(helpers.timeSetter());
      if (!oGlobe) {
        oGlobe = new window.OLCesium({
          map,
          target: oGlobeTarget,
          time() {
            const value = (fp?.input as HTMLInputElement | undefined)?.value;
            return Cesium.JulianDate.fromDate(value ? new Date(value) : new Date());
          }
        });
      }
      scene = oGlobe.getCesiumScene();
      window.oGlobe = oGlobe;
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;
      const resolutionScaler = dynamicResolutionScaling(oGlobe, scene,{ forceLowEnd: false, forceHighEnd: false, debugLogs: true });
      registerCleanup(() => resolutionScaler?.dispose?.());

      polygonUi = createPolygonUi({
        scene,
        map,
        injectIntoMap,
        requestSceneRender,
        registerCleanup,
        stopDomEvent,
      });
      registerCleanup(() => {
        polygonUi?.destroy();
        polygonUi = null;
      });

      const onPostRender = () => patchCollections(scene);
      scene.postRender.addEventListener(onPostRender);
      registerCleanup(() => scene.postRender.removeEventListener(onPostRender));

      const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      cesiumHandler = handler;

      registerOptionalCleanup(helpers.addStreetView(streetView, handler, oGlobe));
      helpers.addViewShed(viewShed, handler, viewshedButton);
      registerOptionalCleanup(helpers.addControls());
      helpers.showGlobeOption();
      helpers.cesiumCredits();
      helpers.addSvgIcons();
      helpers.setActiveControls(oGlobe, viewer);
      registerOptionalCleanup(helpers.pickedFeatureStyle(handler));
      registerOptionalCleanup(helpers.addMeasureTool(scene));

      // If opened via a share URL, auto-enable 3D and load/zoom to polygons
      try {
        registerOptionalCleanup(polygonUi?.loadSharedPolygonsFromUrl());
      } catch (e) {
        // ignore
      }

      CameraControls(scene);
      getFeatureInfo(scene, viewer, map, featureInfo, helpers.flyTo);

      configureScene(scene, settings);
      configureGlobeAppearance(scene, settings);
      loadTerrainProvider(scene, { cesiumTerrainProvider, cesiumIonassetIdTerrain, cesiumIontoken })
        .catch((error) => console.error('Failed to load terrain provider', error));
      load3DTiles(scene, map, cesiumIontoken);
      loadGltfAssets(scene, gltf);

      this.on('render', this.onRender as () => void);
      this.addComponents(buttons);
      this.render();
    },
    onInit() {
      globeEl = Origo.ui.Element({
        tagName: 'div',
        cls: 'flex column z-index-ontop-top-times20'
      });
      globeButton = Origo.ui.Button({
        cls: 'o-globe padding-small margin-bottom-smaller icon-smaller round light box-shadow',
        click() {
          toggleGlobe();
          toggleButtons();
          helpers.setActiveControls(oGlobe, viewer);
        },
        icon: '#ic_cube_24px',
        tooltipText: 'Slå på/av 3D-vy',
        tooltipPlacement: 'east'
      });
      buttons.push(globeButton);

      flatpickrButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow hidden',
        click() {
          if (!fp) return;
          const toggleFlatpickrButtonEl = document.getElementById(flatpickrButton.getId());
          if (toggleFlatpickrButtonEl) {
            toggleFlatpickrButtonEl.classList.toggle('active');
            toggleFlatpickrButtonEl.classList.contains('active') ? fp.open() : fp.close();
          }
        },
        icon: '#ic_clock-time-four_24px',
        tooltipText: 'Val av tid',
        tooltipPlacement: 'east'
      });
      buttons.push(flatpickrButton);

      if (viewShed) {
        viewshedButton = Origo.ui.Button({
          cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow',
          click() {
            if (!viewshedButton) return;
            const el = document.getElementById(viewshedButton.getId());
            if (el) {
              el.classList.toggle('active');
            }
          },
          icon: '#ic_visibility_24px',
          tooltipText: 'Siktanalys',
          tooltipPlacement: 'east'
        });
        buttons.push(viewshedButton);
      }

      if (drawTool) {
        drawToolButton = Origo.ui.Button({
          cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow',
          click() {
            if (!drawToolButton) return;
            const el = document.getElementById(drawToolButton.getId());
            if (el) {
              const active = el.classList.toggle('active');
              if (active) {
                polygonUi?.mountPolygonToolbarIfNeeded();
                polygonUi?.setPolygonToolbarVisible(true);
              } else {
                polygonUi?.setPolygonToolbarVisible(false);
              }
            }
          },
          icon: '#fa-pencil',
          tooltipText: 'Ritverktyg',
          tooltipPlacement: 'east'
        });
        buttons.push(drawToolButton);
      }

      if (quickTimeShadowPicker) {
        const quickPicker = quickTimePicker(() => fp);
        if (quickPicker) {
          quickTimePickerButton = quickPicker.button;
          if (quickTimePickerButton) {
            buttons.push(quickTimePickerButton);
          }
          registerCleanup(quickPicker.dispose);
        }
      }

      toggleShadowsButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow',
        click() {
          if (!scene) return;
          const toggleShadowsButtonEl = document.getElementById(toggleShadowsButton.getId());
          if (!toggleShadowsButtonEl || !scene.shadowMap) return;
          toggleShadowsButtonEl.classList.toggle('active');
          scene.shadowMap.enabled = toggleShadowsButtonEl.classList.contains('active');
          requestSceneRender();
        },
        icon: '#ic_box-shadow_24px',
        tooltipText: 'Slå på/av skuggor',
        tooltipPlacement: 'east'
      });
      buttons.push(toggleShadowsButton);

      if (fx) {
        toggleFXButton = Origo.ui.Button({
          cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow active',
          click() {
            if (!toggleFXButton || !scene) return;
            const el = document.getElementById(toggleFXButton.getId());
            let active = false;
            if (el) {
              active = el.classList.toggle('active');
            }

            const shadowMap = scene.shadowMap;
            const shadowSettings = settings.shadows;
            if (!shadowMap) return;
            shadowMap.normalOffset = active && shadowSettings ? Boolean(shadowSettings.normalOffset) : false;
            shadowMap.size = active && shadowSettings ? shadowSettings.size : 1024;
            requestSceneRender();
          },
          icon: '#ic_cube_24px',
          tooltipText: 'Toggle FX Settings',
          tooltipPlacement: 'east'
        });
        buttons.push(toggleFXButton);
      }
    },
    render() {

      const globeElDomTar = document.getElementById(target ?? '');
      if (globeElDomTar) {
        const globeMarkup = globeEl.render();
        const globeNode = Origo.ui.dom.html(globeMarkup);
        globeElDomTar.appendChild(globeNode);
      }

      const globeElDom = document.getElementById(globeEl.getId());
      if (globeElDom) {
        const appendButton = (button?: OrigoButton | null) => {
          if (!button) return;
          const markup = button.render();
          const node = Origo.ui.dom.html(markup);
          globeElDom.appendChild(node);
        };

        appendButton(globeButton);
        appendButton(flatpickrButton);

        if (quickTimeShadowPicker) {
          appendButton(quickTimePickerButton);
        }

        if (drawTool) {
          appendButton(drawToolButton);
        }

        if (viewShed) {
          appendButton(viewshedButton);
        }

        appendButton(toggleShadowsButton);

        if (fx) {
          appendButton(toggleFXButton);
        }
      }

      helpers.activeGlobeOnStart();
      this.dispatch('render');

    },
    onRemove() {
      // disable 3D first (releases some things in olcs)
      try { oGlobe?.setEnabled(false); } catch (error) {
        console.warn('Failed to disable globe on remove', error);
      }

      flushCleanups();
      cleanupCesiumHandlers();
      cleanupDom();
      hasActivatedOnStart = false;
    },
    isGlobeActive: (): boolean => isGlobeActive(oGlobe),
    threedtiletype: () => threedtile,
    gltftype: () => addGLTF,
    globalOLCesium: () => OLCesium,
  });
};


export default Globe;
