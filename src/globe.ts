import OLCesium from 'olcs/OLCesium';
import Origo, { OrigoButton, OrigoElement } from 'Origo';
import flatpickr from 'flatpickr';
import * as Cesium from 'cesium';
import {
  Ion,
  IonResource,
  createWorldTerrainAsync,
  CesiumTerrainProvider,
  ScreenSpaceEventHandler,
  PostProcessStageLibrary,
  ScreenSpaceEventType,
  Color,
  SkyBox,
  JulianDate,
  Clock,
} from 'cesium';
import measureTool from './functions/measureTool';
import addGLTF from './layer/gltf';
import add3DTile from './layer/threedtile';
import { threedtile } from './layer/layerhelper';
import getFeatureInfo from './functions/featureinfo';
import ViewShed from './functions/ViewShed';
import StreetView from './functions/StreetView';
import CameraControls from './functions/CameraControls';
import dynamicResolutionScaling from './functions/dynamicResolutionScaling';
import patchCollections from './functions/patchCollections';
import quickTimePicker from './functions/quickTimePicker';
import { setCameraHeight, getCameraHeight, setIsStreetMode, getIsStreetMode, isGlobeActive } from './globeState';

type CleanupFn = () => void;

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

interface GLTFAsset {
  url: string;
  lat: number;
  lng: number;
  height: number;
  heightReference?: any;
  animation?: any;
}

interface SkyBoxSettings {
  url: string;
  images: { pX: string; nX: string; pY: string; nY: string; pZ: string; nZ: string };
}

interface ShadowSettings {
  darkness: number;
  fadingEnabled: boolean;
  maximumDistance: number;
  normalOffset: number;
  size: number;
  softShadows: boolean;
}

interface GlobeSettings {
  enableAtmosphere?: boolean;
  enableFog?: boolean;
  shadows?: ShadowSettings;
  depthTestAgainstTerrain?: boolean;
  showGroundAtmosphere?: boolean;
  skyBox?: SkyBoxSettings | false;
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
  shadowDates?: boolean;
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
  'shadowDates' |
  'fx'
>> & { deactivateControls: string[] } = {
  showGlobe: true,
  streetView: false,
  cameraControls: false,
  viewShed: false,
  measure: false,
  flyTo: false,
  shadowDates: false,
  fx: false,
  deactivateControls: [],
};

const configureScene = (scene: Cesium.Scene, settings: GlobeSettings): void => {
  // @ts-ignore: Ignore error if scene.clock is not writable
  scene.clock = new Clock();
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = settings.enableAtmosphere ?? false;
  }
  scene.fog.enabled = !!settings.enableFog;

  const shadowSettings = settings.shadows;
  const shadowMap = scene.shadowMap;
  if (shadowSettings && shadowMap) {
    shadowMap.darkness = shadowSettings.darkness;
    shadowMap.fadingEnabled = shadowSettings.fadingEnabled;
    shadowMap.maximumDistance = shadowSettings.maximumDistance;
    shadowMap.normalOffset = Boolean(shadowSettings.normalOffset);
    shadowMap.size = shadowSettings.size;
    shadowMap.softShadows = shadowSettings.softShadows;
  }

  const ambientOcclusion = scene.postProcessStages.ambientOcclusion;
  if (ambientOcclusion) {
    ambientOcclusion.enabled = false;
    const viewModel = {
      ambientOcclusionOnly: false,
      intensity: 0.3,
      bias: 0.2,
      lengthCap: 30,
      stepSize: 20.0,
      blurStepSize: 4,
    };
    ambientOcclusion.uniforms.ambientOcclusionOnly = Boolean(viewModel.ambientOcclusionOnly);
    ambientOcclusion.uniforms.intensity = Number(viewModel.intensity);
    ambientOcclusion.uniforms.bias = Number(viewModel.bias);
    ambientOcclusion.uniforms.lengthCap = viewModel.lengthCap;
    ambientOcclusion.uniforms.stepSize = Number(viewModel.stepSize);
    ambientOcclusion.uniforms.blurStepSize = Number(viewModel.blurStepSize);
  }
};

const configureGlobeAppearance = (scene: Cesium.Scene, settings: GlobeSettings): void => {
  const globe = scene.globe;
  globe.depthTestAgainstTerrain = !!settings.depthTestAgainstTerrain;
  globe.showGroundAtmosphere = !!settings.showGroundAtmosphere;
  if (settings.skyBox) {
    const url = settings.skyBox.url;
    scene.skyBox = new SkyBox({
      sources: {
        positiveX: `${url}${settings.skyBox.images.pX}`,
        negativeX: `${url}${settings.skyBox.images.nX}`,
        positiveY: `${url}${settings.skyBox.images.pY}`,
        negativeY: `${url}${settings.skyBox.images.nY}`,
        positiveZ: `${url}${settings.skyBox.images.pZ}`,
        negativeZ: `${url}${settings.skyBox.images.nZ}`
      }
    });
  }
};

const loadTerrainProvider = async (
  scene: Cesium.Scene,
  options: { cesiumTerrainProvider?: string; cesiumIonassetIdTerrain?: number; cesiumIontoken?: string }
): Promise<void> => {
  const { cesiumTerrainProvider, cesiumIonassetIdTerrain, cesiumIontoken } = options;
  if (cesiumTerrainProvider) {
    scene.terrainProvider = await CesiumTerrainProvider.fromUrl(cesiumTerrainProvider, { requestVertexNormals: false });
    return;
  }
  if (cesiumIonassetIdTerrain && cesiumIontoken) {
    scene.terrainProvider = await CesiumTerrainProvider.fromUrl(
      IonResource.fromAssetId(cesiumIonassetIdTerrain),
      { requestVertexNormals: true }
    );
    return;
  }
  if (cesiumIontoken) {
    scene.terrainProvider = await createWorldTerrainAsync({ requestVertexNormals: true });
  }
};

const load3DTiles = (scene: Cesium.Scene, map: any, ionToken?: string): void => {
  add3DTile(scene, map, ionToken ?? '');
};

const loadGltfAssets = (
  scene: Cesium.Scene,
  gltfAssets?: GLTFAsset[]
): void => {
  gltfAssets?.forEach(({ url, lat, lng, height, heightReference, animation }) => {
    addGLTF(scene, url, lat, lng, height, heightReference, animation);
  });
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
    shadowDates,
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
    const template = document.createElement('div');
    template.innerHTML = markup.trim();
    const node = template.firstElementChild as HTMLElement | null;
    if (!node) return undefined;
    document.body.insertBefore(node, document.body.firstChild);
    trackNode(node);
    return node;
  };
  const cleanupCesiumHandlers = () => {
    cesiumHandler?.destroy(); cesiumHandler = undefined;
    pickHandler?.destroy(); pickHandler = undefined;
  };

  const buttons: OrigoButton[] = [];

  if (cesiumIontoken) {
    Ion.defaultAccessToken = cesiumIontoken;
  }

  const requestSceneRender = () => {
    if (scene) {
      scene.requestRender();
    }
  };

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

    const isActive = globeButtonEl?.classList.contains('active') ?? false;
    flatpickrButtonEl?.classList.toggle('hidden', !isActive);
    viewshedButtonEl?.classList.toggle('hidden', !isActive);
    toggleShadowsButtonEl?.classList.toggle('hidden', !isActive);
    quickTimePickerButtonEl?.classList.toggle('hidden', !isActive);
    toggleFXButtonEl?.classList.toggle('hidden', !isActive);
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
      if (document.getElementById('globe-svg-sprite')) return;
      const svgIcons = `
      <svg xmlns="http://www.w3.org/2000/svg" style="display: none;">
        <symbol viewBox="0 0 24 24" id="ic_cube_24px">
          <path d="M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15Z" />
        </symbol>
        <symbol viewBox="0 0 24 24" id="ic_clock-time-four_24px">
          <path d="M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C17.5 22 22 17.5 22 12S17.5 2 12 2M16.3 15.2L11 12.3V7H12.5V11.4L17 13.9L16.3 15.2Z" />
        </symbol>
          <svg viewBox="0 0 24 24" id="ic_box-shadow_24px"><path d="M3,3H18V18H3V3M19,19H21V21H19V19M19,16H21V18H19V16M19,13H21V15H19V13M19,10H21V12H19V10M19,7H21V9H19V7M16,19H18V21H16V19M13,19H15V21H13V19M10,19H12V21H10V19M7,19H9V21H7V19Z" />
        </symbol>
      </svg>
      `;
      const spriteWrapper = document.createElement('div');
      spriteWrapper.id = 'globe-svg-sprite';
      spriteWrapper.innerHTML = svgIcons;
      document.body.insertBefore(spriteWrapper, document.body.firstChild ?? null);
      trackNode(spriteWrapper);
    },
    addStreetView:(streetViewEnabled: boolean, handler: Cesium.ScreenSpaceEventHandler, globe: any): CleanupFn | void => {
      if (streetViewEnabled) {
        const streetViewHtml = `
        <div id="streetView" style="
          position: absolute;
          bottom: 102px;
          left: 10px;
          z-index: 100;
          cursor: pointer;
          background: rgba(255, 255, 255, 0.7);
          border-radius: 4px;
          padding: 3px;
          display: flex;
          align-items: center;
          gap: 8px;
        ">

          <div id="" style="
            border: 1px solid #424242;
            border-radius: 4px;
            display: flex;
          ">
            <div id="street-mode-toggle" style=" padding-top: 2px;">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="gray" xmlns="http://www.w3.org/2000/svg">
                <path d="M15 4.5C15 5.88071 13.8807 7 12.5 7C11.1193 7 10 5.88071 10 4.5C10 3.11929 11.1193 2 12.5 2C13.8807 2 15 3.11929 15 4.5Z" fill="hsl(0, 0%, 29%)"/>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M10.9292 9.2672C11.129 9.25637 11.3217 9.25 11.5 9.25C12.0541 9.25 12.6539 9.31158 13.1938 9.38913C14.7154 9.60766 15.8674 10.7305 16.3278 12.1117C16.4321 12.4245 16.7484 12.6149 17.0737 12.5607L18.8767 12.2602C19.2853 12.1921 19.6717 12.4681 19.7398 12.8767C19.8079 13.2853 19.5319 13.6717 19.1233 13.7398L17.3203 14.0403C16.2669 14.2159 15.2425 13.599 14.9048 12.586C14.5975 11.6642 13.862 11.0005 12.9806 10.8739C12.7129 10.8354 12.4404 10.8029 12.1757 10.7809L11.9045 13.4923C11.8206 14.332 11.8108 14.5537 11.8675 14.7518C11.9241 14.9498 12.0497 15.1328 12.5652 15.8009L16.9942 21.5419C17.2473 21.8698 17.1865 22.3408 16.8585 22.5938C16.5306 22.8468 16.0596 22.7861 15.8066 22.4581L11.3775 16.7172C11.3536 16.6862 11.33 16.6556 11.3066 16.6254C10.896 16.0941 10.5711 15.6738 10.4253 15.1645C10.2796 14.6551 10.3329 14.1265 10.4004 13.4585C10.4042 13.4205 10.4081 13.382 10.412 13.3431L10.6661 10.8023C8.99274 11.076 7.75003 12.6491 7.75003 14.5C7.75003 14.9142 7.41424 15.25 7.00003 15.25C6.58581 15.25 6.25003 14.9142 6.25003 14.5C6.25003 11.8593 8.16383 9.41707 10.9292 9.2672ZM10.1471 16.7646C10.5533 16.8458 10.8167 17.2409 10.7355 17.6471C10.3779 19.4349 9.4014 21.0394 7.97772 22.1783L7.46855 22.5857C7.1451 22.8444 6.67313 22.792 6.41438 22.4685C6.15562 22.1451 6.20806 21.6731 6.53151 21.4143L7.04067 21.007C8.18877 20.0885 8.97625 18.7946 9.26459 17.3529C9.34583 16.9467 9.74094 16.6833 10.1471 16.7646Z" fill="hsl(0, 0%, 29%)"/>
              </svg>
            </div>
            <div id="height-controls" style="
              display: none;
              flex-direction: row;
              align-items: center;
              justify-content: center;
              border-left: 1px solid;
              padding: 2px;
              font-family: sans-serif;
              font-size: 14px;
              color: hsl(0, 0%, 29%);
            ">
              <div style="padding-left: 3px; padding-right: 3px;">
                <div id="height-up" style="margin-bottom: -3px; color: hsl(0, 0%, 29%);">▲</div>
                <div id="height-down" style="margin-top: -3px; color: hsl(0, 0%, 29%);">▼</div>
              </div>
              <div id="height-display">${getCameraHeight().toFixed(2)} m</div>
            </div>
          </div>
        </div>
        `;
        const node = injectAtBodyStart(streetViewHtml);
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
        const cameraControlHtml = `
          <div id="controlUI" style="
            position: absolute;
            bottom: 35px;
            left: 10px;
            z-index: 99;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 1rem;
            font-weight: 400;
            line-height: 1.5;
            -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
            box-sizing: border-box;
            background: rgba(255, 255, 255, 0.7);
            border-radius: 4px;
            display: inline-block;
            padding: 3px;
          ">
            <div id="camera-controls" style="
              display: flex;
              flex-direction: column;
              align-items: center;
              border: 1px solid #424242;
              border-radius: 4px;
              color: #424242;
            ">
              <button id="cam-up" style="margin-bottom: -17px; margin-top: -6px; background: none; border: none; cursor: pointer; padding: 4px;">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="hsl(0, 0%, 29%)" style="transform: rotate(-90deg);">
                  <use xlink:href="#ic_chevron_right_24px"></use>
                </svg>
              </button>
              <div style="display: flex; gap: 4px;">
                <button id="cam-left" style="margin-left: -7px; background: none; border: none; cursor: pointer; padding: 4px;">
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="hsl(0, 0%, 29%)" style="transform: rotate(180deg);">
                    <use xlink:href="#ic_chevron_right_24px"></use>
                  </svg>
                </button>
                <button id="cam-right" style="margin-right: -6px; margin-left: -3px; background: none; border: none; cursor: pointer; padding: 4px;">
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="hsl(0, 0%, 29%)">
                    <use xlink:href="#ic_chevron_right_24px"></use>
                  </svg>
                </button>
              </div>
              <button id="cam-down" style="margin-top: -19px; margin-bottom: -6px; background: none; border: none; cursor: pointer; padding: 4px;">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="hsl(0, 0%, 29%)" style="transform: rotate(90deg);">
                  <use xlink:href="#ic_chevron_right_24px"></use>
                </svg>
              </button>
            </div>
          </div>
        `;
        const node = injectAtBodyStart(cameraControlHtml);
        return () => node?.remove();
      }
      return undefined;
    },
    pickedFeatureStyle: (handler: Cesium.ScreenSpaceEventHandler): CleanupFn | void => {
      if (!PostProcessStageLibrary.isSilhouetteSupported(scene)) return;

      const silhouette = PostProcessStageLibrary.createEdgeDetectionStage();
      silhouette.uniforms.color = Color.ROYALBLUE;
      silhouette.uniforms.length = 0.01;
      silhouette.selected = [];

      const silhouetteStage = PostProcessStageLibrary.createSilhouetteStage([silhouette]);
      scene.postProcessStages.add(silhouetteStage);

      let lastPickTime = 0;
      const mouseMoveEvent = ScreenSpaceEventType.MOUSE_MOVE;
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
        e.preventDefault();
        (e as any).stopImmediatePropagation?.();
        e.stopPropagation();

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
            return JulianDate.fromDate(value ? new Date(value) : new Date());
          }
        });
      }
      scene = oGlobe.getCesiumScene();
      window.oGlobe = oGlobe;
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;
      const resolutionScaler = dynamicResolutionScaling(oGlobe, scene,{ forceLowEnd: false, forceHighEnd: false, debugLogs: true });
      registerCleanup(() => resolutionScaler?.dispose?.());

      const onPostRender = () => patchCollections(scene);
      scene.postRender.addEventListener(onPostRender);
      registerCleanup(() => scene.postRender.removeEventListener(onPostRender));

      const handler = new ScreenSpaceEventHandler(scene.canvas);
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

      if (shadowDates) {
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

        if (shadowDates) {
          appendButton(quickTimePickerButton);
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
