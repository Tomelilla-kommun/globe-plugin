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
import isGlobeActive from './functions/isglobeactive';
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
import { setCameraHeight, getCameraHeight, setIsStreetMode, getIsStreetMode } from './globeState';

declare global {
  interface Window {
    Cesium: typeof Cesium;
    OLCesium: typeof OLCesium;
    oGlobe?: any;
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
  viewShed?: boolean;
  fx?: boolean;
  resolutionScale?: number;
  settings?: GlobeSettings;
  cesiumTerrainProvider?: string;
  cesiumIontoken?: string;
  cesiumIonassetIdTerrain?: number;
  gltf?: GLTFAsset[];
  deactivateControls?: string[];
}

setCameraHeight(1.6);
setIsStreetMode(false);
window.Cesium = Cesium;
window.OLCesium = OLCesium;

const Globe = function Globe(options: GlobeOptions = {}) {
  let {
    target,
    globeOnStart,
    showGlobe = true,
    resolutionScale = window.devicePixelRatio,
    settings = {},
    cesiumTerrainProvider,
    cesiumIontoken,
    cesiumIonassetIdTerrain,
    gltf,
    deactivateControls = [],
    streetView = false,
    viewShed = false,
    fx = false,
  } = options;

  let map: any;
  let viewer: any;
  let oGlobe: OLCesium;
  let oGlobeTarget: string;
  let terrain: Cesium.TerrainProvider;
  let featureInfo: any;
  let scene: Cesium.Scene;
  let fp: flatpickr.Instance;

  let globeEl: OrigoElement;
  let globeButton: OrigoButton;
  let flatpickrButton: OrigoButton;
  let viewshedButton: OrigoButton;
  let toggleShadowsButton: OrigoButton;
  let quickTimePickerButton: OrigoButton;
  let toggleFXButton: OrigoButton;
  let htmlString: string;
  let el: HTMLElement;

  const buttons: OrigoButton[] = [];

  if (cesiumIontoken) {
    Ion.defaultAccessToken = cesiumIontoken;
  }

  const toggleGlobe = (): void => {
    if (viewer.getProjectionCode() === 'EPSG:4326' || viewer.getProjectionCode() === 'EPSG:3857') {
      console.log(!isGlobeActive(oGlobe))
      oGlobe.setEnabled(!isGlobeActive(oGlobe));
      const streetView = document.getElementById('streetView');
      const controlUI = document.getElementById('controlUI');
      const oToolsBottom = document.getElementById('o-tools-bottom');
      const oConsole = document.getElementById('o-console');
      const oFooterMiddle = document.getElementsByClassName('o-footer-middle')[0] as HTMLElement;
      const oMeasure = document.getElementsByClassName('o-measure')[0] as HTMLElement;

      // if (oMeasure) {
      //   oMeasure.style.display = isGlobeActive(oGlobe) ? 'none' : 'flex';
      // }
      if (oFooterMiddle) {
        oFooterMiddle.style.paddingLeft = isGlobeActive(oGlobe) ? '5px' : '0px';
      }
      if (oToolsBottom) {
        oToolsBottom.style.display = isGlobeActive(oGlobe) ? 'none' : 'flex';
      }
      if (oConsole) {
        oConsole.style.display = isGlobeActive(oGlobe) ? 'none' : 'flex';
      }

      if (streetView && controlUI) {
        streetView.style.display = !isGlobeActive(oGlobe) ? 'none' : 'flex';
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
    const viewshedButtonEl = document.getElementById(viewshedButton.getId());
    const toggleShadowsButtonEl = document.getElementById(toggleShadowsButton.getId());
    const quickTimePickerButtonEl = document.getElementById(quickTimePickerButton.getId());
    const toggleFXButtonEl = document.getElementById(toggleFXButton.getId());

    const isActive = globeButtonEl?.classList.contains('active') ?? false;
    flatpickrButtonEl?.classList.toggle('hidden', !isActive);
    viewshedButtonEl?.classList.toggle('hidden', !isActive);
    toggleShadowsButtonEl?.classList.toggle('hidden', !isActive);
    quickTimePickerButtonEl?.classList.toggle('hidden', !isActive);
    toggleFXButtonEl?.classList.toggle('hidden', !isActive);
  };

  const helpers = {
    activeGlobeOnStart: (): void => {
      if (globeOnStart) {
        toggleGlobe();
        toggleButtons();
      }
    },
    showGlobeOption: (): void => {
      if (!showGlobe && scene) {
        scene.globe.show = false;
      }
    },
    cesiumCredits: (): void => {
      const container = document.querySelector<HTMLElement>('.cesium-credit-logoContainer')?.parentNode as HTMLElement;
      if (container) container.style.display = 'none';
    },
    setActiveControls: (getGlobe: OLCesium, v: any): void => {
      deactivateControls.forEach((name) => {
        const control = v.getControlByName(name);
        if (!control) console.error(`No control named "${name}" to hide/unhide for globe control`);
        else if (isGlobeActive(getGlobe)) control.hide();
        else control.unhide();
      });
    },
    timeSetter: (): void => {
      const flatpickrEl = Origo.ui.Element({ tagName: 'div', cls: 'flatpickrEl z-index-ontop-top-times20' });
      document.getElementById(target!)?.appendChild(Origo.ui.dom.html(flatpickrEl.render()));
      fp = flatpickr(document.getElementById(flatpickrEl.getId())!, {
        enableTime: true,
        defaultDate: new Date(),
        enableSeconds: true,
        disableMobile: false,
        time_24hr: true,
      });
    },
    flyTo: (destination: Cesium.Cartesian3, duration: number, orientation = { heading: 0, pitch: 0, roll: 0 }) => {
      if (getIsStreetMode()) return;
      scene.camera.flyTo({
        destination,
        duration,
        orientation
      });
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
    },
    addSvgIcons: () => {
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
      const div = document.createElement('div');
      div.innerHTML = svgIcons;
      document.body.insertBefore(div, document.body.childNodes[0]);
    },
    addStreetView:(streetView: boolean, handler: Cesium.ScreenSpaceEventHandler, globe: any) => {
      if (streetView) {
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
        const div = document.createElement('div');
        div.innerHTML = streetViewHtml;
        document.body.insertBefore(div, document.body.childNodes[0]);
        StreetView(scene, handler, globe);
      }
    },
    addViewShed:(viewShed: boolean, handler: Cesium.ScreenSpaceEventHandler) => {
      if (viewShed && scene) {
        ViewShed(scene, viewshedButton, handler);
      }
    },
    addControls: () => {
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
      const div = document.createElement('div');
      div.innerHTML = cameraControlHtml;
      document.body.insertBefore(div, document.body.childNodes[0]);
    },
    pickedFeatureStyle: (): void => {
      const handler = new ScreenSpaceEventHandler(scene.canvas);

      if (PostProcessStageLibrary.isSilhouetteSupported(scene)) {
        const silhouette = PostProcessStageLibrary.createEdgeDetectionStage();
        silhouette.uniforms.color = Color.ROYALBLUE;
        silhouette.uniforms.length = 0.01;
        silhouette.selected = [];

        scene.postProcessStages.add(PostProcessStageLibrary.createSilhouetteStage([silhouette]));

        let lastPickTime = 0;

        handler.setInputAction(({ position }: { position: Cesium.Cartesian2 }) => {
          const now = performance.now();
          if (now - lastPickTime < 120) return;
          lastPickTime = now;

          // Only pick if position exists
          if (position) {
            const pickedFeature = scene.pick(position);
            silhouette.selected = pickedFeature ? [pickedFeature] : [];
          }
        }, ScreenSpaceEventType.MOUSE_MOVE);
      }
    },
    addMeasureTool: (scene: Cesium.Scene): void => {
      let tool: ReturnType<typeof measureTool> | null = null;
      const originalButton = document.getElementsByClassName('o-measure')[0] as HTMLElement;

      // Clone the element to remove existing listeners
      const newButton = originalButton.cloneNode(true) as HTMLElement;
      originalButton.replaceWith(newButton);

      // Add your own toggle behavior
      newButton.addEventListener('click', () => {
        if (!tool) {
          // Start measuring
          tool = measureTool(scene);
          tool.measureDistance();
          newButton.classList.add('active'); // optional visual highlight
        } else {
          // Clear/destroy measurement
          tool.destroy();
          tool = null;
          newButton.classList.remove('active');
        }
      });
    }
  };

  const assets = {
    terrainProviders: async (): Promise<void> => {
      if (cesiumTerrainProvider) {
        terrain = await CesiumTerrainProvider.fromUrl(cesiumTerrainProvider, { requestVertexNormals: false});
        scene.terrainProvider = terrain;
      } else if (cesiumIonassetIdTerrain && cesiumIontoken) {
        terrain = await CesiumTerrainProvider.fromUrl(IonResource.fromAssetId(cesiumIonassetIdTerrain), { requestVertexNormals: true });
        scene.terrainProvider = terrain;
      } else if (cesiumIontoken) {
        terrain = await createWorldTerrainAsync({ requestVertexNormals: true });
        scene.terrainProvider = terrain;
      }
    },
    cesium3DtilesProviders: (): void => { add3DTile(scene, map, cesiumIontoken ? cesiumIontoken : ""); },
    gltfProviders: (): void => {
      gltf?.forEach(({ url, lat, lng, height, heightReference, animation }) => {
        addGLTF(scene, url, lat, lng, height, heightReference, animation);
      });
    },
  };


  const cesiumSettings = {
    // Configure options for Scene
    scene: () => {
      // @ts-ignore: Ignore error if scene.clock is not writable
      scene.clock = new Clock();
      // Enables/disables atmosphere
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = settings.enableAtmosphere ?? false;
      }
      // Enables fog/disables
      scene.fog.enabled = !!settings.enableFog;
      // Shadow settings
      const shadowSettings = settings.shadows;
      const shadowMap = scene.shadowMap;
      if (shadowSettings) {
        shadowMap.darkness = shadowSettings.darkness;
        shadowMap.fadingEnabled = shadowSettings.fadingEnabled;
        shadowMap.maximumDistance = shadowSettings.maximumDistance;
        shadowMap.normalOffset = Boolean(shadowSettings.normalOffset);
        shadowMap.size = shadowSettings.size;
        shadowMap.softShadows = shadowSettings.softShadows;
      }

      var viewModel = {
        ambientOcclusionOnly: false,
        intensity: 0.3,
        bias: 0.2,
        lengthCap: 30,
        stepSize: 20.0,
        blurStepSize: 4,
      };
      const ambientOcclusion = scene.postProcessStages.ambientOcclusion;
      ambientOcclusion.enabled = false;

      ambientOcclusion.uniforms.ambientOcclusionOnly = Boolean(
        viewModel.ambientOcclusionOnly
      );
      ambientOcclusion.uniforms.intensity = Number(viewModel.intensity);
      ambientOcclusion.uniforms.bias = Number(viewModel.bias);
      ambientOcclusion.uniforms.lengthCap = (viewModel.lengthCap);
      ambientOcclusion.uniforms.stepSize = Number(viewModel.stepSize);
      ambientOcclusion.uniforms.blurStepSize = Number(viewModel.blurStepSize);
    },
    // Configure options for Globe
    globe: () => {
      const globe = scene.globe;

      // scene.requestRenderMode = true;

      // Enables/disables depthTestAgainstTerrain
      globe.depthTestAgainstTerrain = !!settings.depthTestAgainstTerrain;
      // Enables/disables enableGroundAtmosphere
      globe.showGroundAtmosphere = !!settings.showGroundAtmosphere;
      // Options to set different skyboxes
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
      settings.skyBox = false;
    }
  };

  return Origo.ui.Component({
    name: 'globe',
    onAdd(evt: any) {
      viewer = evt.target;
      if (!target) target = `${viewer.getMain().getNavigation().getId()}`;
      oGlobeTarget = viewer.getId();
      map = viewer.getMap();
      featureInfo = viewer.getControlByName('featureInfo');
      // Init flatpickr to set the datetime in oGlobe.time
      helpers.timeSetter();
      // Init OLCesium
      oGlobe = new window.OLCesium({
        map,
        target: oGlobeTarget,
        time() {
          return JulianDate.fromDate(new Date((fp.element as HTMLInputElement).value));
        }
      });
      // OLCesium needs to be global
      window.oGlobe = oGlobe;
      // Gets Scene
      scene = oGlobe.getCesiumScene();
      // setResolutionScale as configuration option
      dynamicResolutionScaling(oGlobe, scene);

      scene.postRender.addEventListener(() => patchCollections(scene));

      const handler = new ScreenSpaceEventHandler(scene.canvas);

      helpers.addStreetView(streetView, handler, oGlobe);
      helpers.addViewShed(viewShed, handler);
      helpers.addControls();
      helpers.showGlobeOption();
      helpers.cesiumCredits();
      helpers.addSvgIcons();
      helpers.setActiveControls(oGlobe, viewer);
      helpers.pickedFeatureStyle();
      helpers.addMeasureTool(scene);

      CameraControls(scene);
      getFeatureInfo(scene, viewer, map, featureInfo, helpers.flyTo);

      Object.values(cesiumSettings).forEach((s) => s());
      Object.values(assets).forEach((a) => a());

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
          // Toggles globe on/off
          toggleGlobe();
          // Toggles globe subbuttons unhide/hide
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
          let toggleFlatpickrButtonEl = document.getElementById(flatpickrButton.getId());
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

      viewshedButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow',
        click() {
          const el = document.getElementById(viewshedButton.getId());
          if (el) {
            el.classList.toggle('active');
          }
        },
        icon: '#ic_visibility_24px',
        tooltipText: 'Siktanalys',
        tooltipPlacement: 'east'
      });
      if (viewShed) buttons.push(viewshedButton);

      const quickTimeContainer = document.createElement('div');
      quickTimeContainer.classList.add('quick-time-container', 'origo-popup', 'animate');
      quickTimeContainer.style.display = 'none';
      quickTimeContainer.style.position = 'absolute';
      quickTimeContainer.style.zIndex = '9999';
      quickTimeContainer.style.padding = '10px';
      quickTimeContainer.style.background = '#fff';
      quickTimeContainer.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
      quickTimeContainer.style.borderRadius = '6px';
      document.body.appendChild(quickTimeContainer);

      // Fill it with the time buttons
      const predefinedTimes = [
        { date: '2025-03-20', label: '20 Mars' },
        { date: '2025-06-21', label: '21 Juni' },
        { date: '2025-09-22', label: '22 September' },
        { date: '2025-09-23', label: '23 September' },
        { date: '2025-12-21', label: '21 December' }
      ];
      const hours = [9, 12, 16];

      predefinedTimes.forEach((dateObj) => {
        const dateLabel = document.createElement('div');
        dateLabel.innerText = dateObj.label;
        dateLabel.style.fontWeight = 'bold';
        quickTimeContainer.appendChild(dateLabel);

        hours.forEach((hour) => {
          const btn = document.createElement('button');
          btn.innerText = `${hour}:00`;
          btn.classList.add('quick-time-button', 'small');
          btn.style.marginRight = '4px';
          btn.addEventListener('click', () => {
            const selectedDate = new Date(dateObj.date);
            selectedDate.setHours(hour, 0, 0);
            fp.setDate(selectedDate, true);
            quickTimeContainer.style.display = 'none'; // Hide after click
          });
          quickTimeContainer.appendChild(btn);
        });

        const spacer = document.createElement('div');
        spacer.style.marginBottom = '10px';
        quickTimeContainer.appendChild(spacer);
      });

      quickTimePickerButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow quick-time-button',
        click() {
          const isVisible = quickTimeContainer.style.display === 'block';
          quickTimeContainer.style.display = isVisible ? 'none' : 'block';
      
          if (!isVisible) {
            const btnEl = document.getElementById(quickTimePickerButton.getId());
            if (btnEl) {
              const rect = btnEl.getBoundingClientRect();
              quickTimeContainer.style.left = `${rect.right + 10}px`;
              quickTimeContainer.style.top = `${rect.top}px`;
            }
          }
        },
        icon: '#ic_clock-time-four_24px',
        tooltipText: 'Snabbval för tid',
        tooltipPlacement: 'east'
      });
      buttons.push(quickTimePickerButton);

      toggleShadowsButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow',
        click() {
          let toggleShadowsButtonEl = document.getElementById(toggleShadowsButton.getId());
          if (toggleShadowsButtonEl) {
            toggleShadowsButtonEl.classList.toggle('active');
            toggleShadowsButtonEl.classList.contains('active') ? scene.shadowMap.enabled = true : scene.shadowMap.enabled = false;
          }
        },
        icon: '#ic_box-shadow_24px',
        tooltipText: 'Slå på/av skuggor',
        tooltipPlacement: 'east'
      });
      buttons.push(toggleShadowsButton);

      toggleFXButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow active',
        click() {
          const el = document.getElementById(toggleFXButton.getId());
          let active = false;
          if (el) {
            active = el.classList.toggle('active');
          }

          // scene.fog.enabled = active && !!settings.enableFog;
          const shadowMap = scene.shadowMap;
          const shadowSettings = settings.shadows;
          // shadowMap.fadingEnabled = active ? shadowSettings.fadingEnabled : false;
          shadowMap.normalOffset = active && shadowSettings ? Boolean(shadowSettings.normalOffset) : false;
          shadowMap.size = active && shadowSettings ? shadowSettings.size : 1024;
          // shadowMap.softShadows = active ? shadowSettings.softShadows : false;
          // scene.postProcessStages.ambientOcclusion.enabled = active;
        },
        icon: '#ic_cube_24px',
        tooltipText: 'Toggle FX Settings',
        tooltipPlacement: 'east'
      });
      if (fx) buttons.push(toggleFXButton);
    },
    render() {

      const globeElDomTar = document.getElementById(target ?? '');
      if(globeElDomTar) {
        htmlString = `${globeEl.render()}`;
        el = Origo.ui.dom.html(htmlString);
        globeElDomTar.appendChild(el);
      }

      const globeElDom = document.getElementById(globeEl.getId());
      if (globeElDom) {

        htmlString = globeButton.render();
        el = Origo.ui.dom.html(htmlString);
        globeElDom.appendChild(el);

        htmlString = flatpickrButton.render();
        el = Origo.ui.dom.html(htmlString);
        globeElDom.appendChild(el);

        htmlString = quickTimePickerButton.render();
        el = Origo.ui.dom.html(htmlString);
        globeElDom.appendChild(el);

        if (viewShed) {
          htmlString = viewshedButton.render();
          el = Origo.ui.dom.html(htmlString);
          globeElDom.appendChild(el);
        }

        htmlString = toggleShadowsButton.render();
        el = Origo.ui.dom.html(htmlString);
        globeElDom.appendChild(el);

        if (fx) {
          htmlString = toggleFXButton.render();
          el = Origo.ui.dom.html(htmlString);
          globeElDom.appendChild(el);
        }
      }
      console.log('globe render');

      helpers.activeGlobeOnStart();
      this.dispatch('render');

      // forceNoDepthTestForIconsAndText(scene);

    },
    isGlobeActive: (): boolean => isGlobeActive(oGlobe),
    threedtiletype: () => threedtile,
    gltftype: () => addGLTF,
    globalOLCesium: () => OLCesium,
  });
};

export default Globe;
