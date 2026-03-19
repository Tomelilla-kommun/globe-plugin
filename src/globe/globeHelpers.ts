import * as Cesium from 'cesium';
import flatpickr from 'flatpickr';
import OLCesium from 'olcs/OLCesium';

import ViewShed from '../functions/ViewShed';
import StreetView from '../functions/StreetView';
import timeSetter from '../functions/timeSetter';
import { getCameraHeight, getIsStreetMode, isGlobeActive } from '../globeState';
import { streetViewHtml, cameraControlsHtml } from '../uiTemplates';
import { createElementFromMarkup, stopDomEvent } from './domUtils';

import type { OrigoButton } from 'Origo';
import type { CleanupFn } from './types';
import type { MeasureUiApi } from './measureUi';

export interface GlobeHelpersContext {
  target: string | undefined;
  showGlobe: boolean;
  flyTo: boolean;
  cameraControls: boolean;
  streetViewMap: string;
  deactivateControls: string[];
  getScene: () => Cesium.Scene | undefined;
  getGlobe: () => OLCesium | undefined;
  getFlatpickr: () => flatpickr.Instance | null;
  setFlatpickr: (fp: flatpickr.Instance | null) => void;
  getMeasureUi: () => MeasureUiApi | null;
  trackNode: (node: HTMLElement) => HTMLElement;
  requestSceneRender: () => void;
}

export interface GlobeHelpers {
  activeGlobeOnStart: (
    globeOnStart: boolean,
    hasActivatedOnStart: boolean,
    toggleGlobe: () => void,
    toggleButtons: () => void,
    viewer: any
  ) => boolean;
  showGlobeOption: () => void;
  cesiumCredits: () => void;
  setActiveControls: (globe: OLCesium, viewer: any) => void;
  initTimeSetter: () => CleanupFn | void;
  flyToDestination: (
    destination: Cesium.Cartesian3,
    duration: number,
    orientation?: { heading: number; pitch: number; roll: number }
  ) => void;
  setView: (
    destination: Cesium.Cartesian3,
    orientation: { heading: number; pitch: number; roll: number }
  ) => void;
  addStreetView: (
    streetViewEnabled: boolean,
    handler: Cesium.ScreenSpaceEventHandler,
    globe: OLCesium
  ) => CleanupFn | void;
  addViewShed: (
    viewShedEnabled: boolean,
    handler: Cesium.ScreenSpaceEventHandler,
    button: OrigoButton | null
  ) => void;
  addControls: () => CleanupFn | void;
  pickedFeatureStyle: (handler: Cesium.ScreenSpaceEventHandler) => CleanupFn | void;
  addMeasureTool: (oGlobe: OLCesium, measure: boolean) => CleanupFn | void;
}

/**
 * Creates helper functions for globe operations.
 * Separates concerns by accepting context through dependency injection.
 */
export function createGlobeHelpers(ctx: GlobeHelpersContext): GlobeHelpers {
  const injectAtBodyStart = (markup: string): HTMLElement | undefined => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const node = createElementFromMarkup(markup);
    if (!node) return undefined;
    document.body.insertBefore(node, document.body.firstChild);
    ctx.trackNode(node);
    return node;
  };

  return {
    activeGlobeOnStart(
      globeOnStart: boolean,
      hasActivatedOnStart: boolean,
      toggleGlobe: () => void,
      toggleButtons: () => void,
      viewer: any
    ): boolean {
      const globe = ctx.getGlobe();
      if (!globeOnStart || hasActivatedOnStart || !globe) return hasActivatedOnStart;
      
      toggleGlobe();
      toggleButtons();
      this.setActiveControls(globe, viewer);
      return true;
    },

    showGlobeOption(): void {
      const scene = ctx.getScene();
      if (!ctx.showGlobe && scene) {
        scene.globe.show = false;
        ctx.requestSceneRender();
      }
    },

    cesiumCredits(): void {
      const container = document.querySelector<HTMLElement>(
        '.cesium-credit-logoContainer'
      )?.parentNode as HTMLElement;
      if (container) container.style.display = 'none';
    },

    setActiveControls(globe: OLCesium, viewer: any): void {
      if (!viewer) return;
      ctx.deactivateControls.forEach((name: string) => {
        const control = viewer.getControlByName(name);
        if (!control) {
          console.error(`No control named "${name}" to hide/unhide for globe control`);
        } else if (isGlobeActive(globe)) {
          control.hide();
        } else {
          control.unhide();
        }
      });
    },

    initTimeSetter(): CleanupFn | void {
      if (!ctx.target) return;
      const result = timeSetter({
        target: ctx.target,
        trackNode: ctx.trackNode,
        requestSceneRender: ctx.requestSceneRender,
      });
      if (!result) return;
      ctx.setFlatpickr(result.fp);
      return () => {
        result.cleanup();
        ctx.setFlatpickr(null);
      };
    },

    flyToDestination(
      destination: Cesium.Cartesian3,
      duration: number,
      orientation = { heading: 0, pitch: 0, roll: 0 }
    ): void {
      if (getIsStreetMode()) return;
      const scene = ctx.getScene();
      if (!scene) return;

      if (ctx.flyTo) {
        scene.camera.flyTo({
          destination,
          duration,
          orientation,
          complete: ctx.requestSceneRender,
        });
      } else {
        const camera = scene.camera;
        const frozenDestination = Cesium.Cartesian3.clone(camera.positionWC);
        const frozenOrientation = {
          heading: camera.heading,
          pitch: camera.pitch,
          roll: camera.roll,
        };

        const freezeHandler = camera.changed.addEventListener(() => {
          camera.setView({
            destination: frozenDestination,
            orientation: frozenOrientation,
          });
        });

        setTimeout(() => {
          freezeHandler?.();
        }, 600);
      }
    },

    setView(
      destination: Cesium.Cartesian3,
      orientation: { heading: number; pitch: number; roll: number }
    ): void {
      if (getIsStreetMode()) return;
      const scene = ctx.getScene();
      if (!scene) return;

      scene.camera.setView({ destination, orientation });
      ctx.requestSceneRender();
    },

    addStreetView(
      streetViewEnabled: boolean,
      handler: Cesium.ScreenSpaceEventHandler,
      globe: OLCesium
    ): CleanupFn | void {
      if (!streetViewEnabled) return undefined;
      const scene = ctx.getScene();
      if (!scene) return undefined;

      const node = injectAtBodyStart(streetViewHtml(`${getCameraHeight().toFixed(2)} m`));
      void StreetView(scene, handler, globe, ctx.streetViewMap);
      return () => node?.remove();
    },

    addViewShed(
      viewShedEnabled: boolean,
      handler: Cesium.ScreenSpaceEventHandler,
      button: OrigoButton | null
    ): void {
      const scene = ctx.getScene();
      if (viewShedEnabled && scene && button) {
        ViewShed(scene, button, handler);
      }
    },

    addControls(): CleanupFn | void {
      if (!ctx.cameraControls) return undefined;
      const node = injectAtBodyStart(cameraControlsHtml());
      return () => node?.remove();
    },

    pickedFeatureStyle(handler: Cesium.ScreenSpaceEventHandler): CleanupFn | void {
      const scene = ctx.getScene();
      if (!scene) return;
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
        ctx.requestSceneRender();
      };

      handler.setInputAction(onMove, mouseMoveEvent);

      return () => {
        handler.removeInputAction(mouseMoveEvent);
        scene.postProcessStages.remove(silhouetteStage);
      };
    },

    addMeasureTool(oGlobe: OLCesium, measure: boolean): CleanupFn | void {
      if (!measure) return;

      const button = document.getElementsByClassName('o-measure')[0] as HTMLElement | undefined;
      if (!button) return;

      const originalOnClick = button.onclick;
      button.onclick = null;

      const onClick = (e: Event) => {
        if (!isGlobeActive(oGlobe)) {
          originalOnClick?.call(button, e as any);
          return;
        }

        stopDomEvent(e);

        const measureUi = ctx.getMeasureUi();
        if (!measureUi) return;

        const isVisible = measureUi.isMeasureToolbarVisible();
        measureUi.setMeasureToolbarVisible(!isVisible);
        button.classList.toggle('active', !isVisible);

        ctx.requestSceneRender();
      };

      button.addEventListener('click', onClick, true);

      return () => {
        button.removeEventListener('click', onClick, true);
        ctx.getMeasureUi()?.setMeasureToolbarVisible(false);
        button.onclick = originalOnClick ?? null;
        button.classList.remove('active');
      };
    },
  };
}
