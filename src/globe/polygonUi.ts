import * as Cesium from 'cesium';

import polygonDrawTool from '../functions/polygonDrawTool';
import { polygonToolbarHtml } from '../uiTemplates';
import {
  decodeCompressedBase64UrlToJson,
  encodeCompressedJsonToBase64Url,
  roundGeoJsonForShare,
} from './shareCodec';

import type { CleanupFn, GeoJsonFeatureCollection } from './types';

const clamp01 = (value: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
};

const getCesiumColorByName = (name: string): Cesium.Color => {
  switch ((name ?? '').toLowerCase()) {
    case 'white': return Cesium.Color.WHITE;
    case 'red': return Cesium.Color.RED;
    case 'green': return Cesium.Color.LIME;
    case 'blue': return Cesium.Color.DODGERBLUE;
    case 'yellow': return Cesium.Color.YELLOW;
    case 'cyan': return Cesium.Color.CYAN;
    default: return Cesium.Color.WHITE;
  }
};

export interface PolygonUiApi {
  mountPolygonToolbarIfNeeded(): void;
  setPolygonToolbarVisible(visible: boolean): void;
  loadSharedPolygonsFromUrl(): CleanupFn | void;
  destroy(): void;
}

export const createPolygonUi = (deps: {
  scene: Cesium.Scene;
  map: any;
  injectIntoMap: (markup: string) => HTMLElement | undefined;
  requestSceneRender: () => void;
  registerCleanup: (cleanup?: CleanupFn) => void;
  stopDomEvent: (event: Event) => void;
}): PolygonUiApi => {
  const {
    scene,
    map,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    stopDomEvent,
  } = deps;

  let sharedPolygonLabelCollection: Cesium.LabelCollection | null = null;
  let sharedPolygonLabels: Cesium.Label[] = [];
  let sharedPolygonLabelsVisible = true;

  let sharedPolygonsCleanup: CleanupFn | null = null;
  let sharedPolygonsGeoJson: GeoJsonFeatureCollection | null = null;

  const renderSharedPolygonsFromFeatures = (
    targetScene: Cesium.Scene,
    features: any[],
    options: { flyTo?: boolean } = {}
  ): CleanupFn => {
    // Replace any previous shared labels
    if (sharedPolygonLabelCollection) {
      try {
        targetScene.primitives.remove(sharedPolygonLabelCollection);
      } catch {
        // ignore
      }
    }

    sharedPolygonLabels = [];
    const labelCollection = new Cesium.LabelCollection();
    sharedPolygonLabelCollection = labelCollection;
    targetScene.primitives.add(labelCollection);

    const createdPrimitives: Cesium.Primitive[] = [];
    const allPositions: Cesium.Cartesian3[] = [];

    const toPositions = (ring: any[], baseHeight: number) => {
      if (!Array.isArray(ring) || ring.length < 3) return [];
      // GeoJSON rings are typically closed; drop last coord if it matches first
      const coords = ring.slice();
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1]) {
        coords.pop();
      }
      return coords
        .filter((c) => Array.isArray(c) && c.length >= 2)
        .map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(Number(lng), Number(lat), baseHeight));
    };

    for (const feature of features) {
      if (feature?.geometry?.type !== 'Polygon') continue;
      const ring = feature.geometry?.coordinates?.[0];
      const baseHeight = Number(feature?.properties?.baseHeight ?? 0);
      const extrudeHeight = Number(feature?.properties?.extrudeHeight ?? 10);
      const area = Number(feature?.properties?.area ?? NaN);

      let baseColor = Cesium.Color.WHITE;
      const colorProp = feature?.properties?.color;
      if (typeof colorProp === 'string') {
        try {
          baseColor = Cesium.Color.fromCssColorString(colorProp) ?? baseColor;
        } catch {
          // ignore
        }
      }

      const fillAlpha = clamp01(feature?.properties?.fillAlpha, 0.7);
      const outlineColor = baseColor.withAlpha(1);
      const fillColor = baseColor.withAlpha(fillAlpha);

      const positions = toPositions(ring, baseHeight);
      if (positions.length < 3) continue;
      allPositions.push(...positions);

      // Outline
      const outlinePositions = [...positions, positions[0]];
      const outlineInstance = new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: outlinePositions,
          width: 2,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(outlineColor),
        },
      });

      const outlinePrimitive = new Cesium.Primitive({
        geometryInstances: [outlineInstance],
        appearance: new Cesium.PolylineColorAppearance({}),
      });
      targetScene.primitives.add(outlinePrimitive);
      createdPrimitives.push(outlinePrimitive);

      // Extruded polygon
      const polygonInstance = new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: { positions, holes: [] },
          extrudedHeight: baseHeight + extrudeHeight,
          perPositionHeight: false,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor),
        },
      });

      const polygonPrimitive = new Cesium.Primitive({
        geometryInstances: [polygonInstance],
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: fillAlpha < 1,
          closed: true,
        }),
        shadows: Cesium.ShadowMode.ENABLED,
      });
      targetScene.primitives.add(polygonPrimitive);
      createdPrimitives.push(polygonPrimitive);

      // Measurement label (Base/Height/Top/Area)
      // Compute a simple center from lon/lat averages (ring uses [lng,lat] degrees)
      let centerLng = 0;
      let centerLat = 0;
      let count = 0;
      if (Array.isArray(ring)) {
        // Drop closing coord if it's identical to the first
        const coords = ring.slice();
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1]) {
          coords.pop();
        }
        for (const c of coords) {
          if (!Array.isArray(c) || c.length < 2) continue;
          centerLng += Number(c[0]);
          centerLat += Number(c[1]);
          count += 1;
        }
      }

      if (count > 0) {
        centerLng /= count;
        centerLat /= count;

        const label = labelCollection.add({
          position: Cesium.Cartesian3.fromDegrees(centerLng, centerLat, baseHeight + extrudeHeight / 2),
          text: `Base: ${baseHeight.toFixed(2)}m\nHeight: ${extrudeHeight}m\nTop: ${(baseHeight + extrudeHeight).toFixed(2)}m${Number.isFinite(area) ? `\nArea: ${area.toFixed(1)} m²` : ''}`,
          font: '22px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: sharedPolygonLabelsVisible,
        });
        sharedPolygonLabels.push(label);
      }
    }

    // Zoom to extent (with some padding)
    if (options.flyTo && allPositions.length) {
      const rect = Cesium.Rectangle.fromCartesianArray(allPositions);

      // Pad the extent so we don't zoom in too tight
      const width = rect.east - rect.west;
      const height = rect.north - rect.south;
      const minPad = Cesium.Math.toRadians(0.002);
      const padX = Math.max(Math.abs(width) * 0.25, minPad);
      const padY = Math.max(Math.abs(height) * 0.25, minPad);

      const paddedRect = new Cesium.Rectangle(
        Math.max(-Math.PI, rect.west - padX),
        Math.max(-Cesium.Math.PI_OVER_TWO, rect.south - padY),
        Math.min(Math.PI, rect.east + padX),
        Math.min(Cesium.Math.PI_OVER_TWO, rect.north + padY)
      );

      targetScene.camera.flyTo({
        destination: paddedRect,
        duration: 2.0,
        complete: requestSceneRender,
      });
      requestSceneRender();
    }

    let disposed = false;
    const cleanup: CleanupFn = () => {
      if (disposed) return;
      disposed = true;

      createdPrimitives.forEach((p) => {
        try {
          targetScene.primitives.remove(p);
        } catch {
          // ignore
        }
      });

      if (labelCollection) {
        try {
          targetScene.primitives.remove(labelCollection);
        } catch {
          // ignore
        }
        if (sharedPolygonLabelCollection === labelCollection) {
          sharedPolygonLabelCollection = null;
          sharedPolygonLabels = [];
        }
      }

      if (sharedPolygonsCleanup === cleanup) {
        sharedPolygonsCleanup = null;
      }

      requestSceneRender();
    };

    return cleanup;
  };

  let polygonToolbarEl: HTMLElement | null = null;
  let polygonTool: ReturnType<typeof polygonDrawTool> | null = null;
  let polygonToolIsDrawing = false;

  const setPolygonToolbarVisible = (visible: boolean) => {
    if (!polygonToolbarEl) return;
    polygonToolbarEl.style.display = visible ? 'flex' : 'none';

    if (!visible) {
      const heightPopover = document.getElementById('polygon-height-popover') as HTMLElement | null;
      heightPopover?.classList.remove('o-active');
    }

    if (!visible && polygonTool && polygonToolIsDrawing && typeof (polygonTool as any).stopDrawing === 'function') {
      (polygonTool as any).stopDrawing();
      polygonToolIsDrawing = false;

      const drawBtn = document.getElementById('polygon-draw') as HTMLButtonElement | null;
      if (drawBtn) {
        drawBtn.classList.remove('active');
      }
      const heightInput = document.getElementById('polygon-height-compact') as HTMLInputElement | null;
      if (heightInput) {
        heightInput.disabled = false;
      }
      requestSceneRender();
    }
  };

  const mountPolygonToolbarIfNeeded = () => {
    if (polygonToolbarEl) return;
    if (!scene) return;

    polygonToolbarEl = injectIntoMap(polygonToolbarHtml()) ?? null;
    if (!polygonToolbarEl) return;
    polygonToolbarEl.style.display = 'none';

    const drawButton = document.getElementById('polygon-draw') as HTMLButtonElement | null;
    const heightButton = document.getElementById('polygon-height-button') as HTMLButtonElement | null;
    const heightPopover = document.getElementById('polygon-height-popover') as HTMLElement | null;
    const colorButton = document.getElementById('polygon-color-button') as HTMLButtonElement | null;
    const colorPopover = document.getElementById('polygon-color-popover') as HTMLElement | null;
    const colorSelect = document.getElementById('polygon-color-select') as HTMLSelectElement | null;
    const opacityButton = document.getElementById('polygon-opacity-toggle') as HTMLButtonElement | null;
    const clearButton = document.getElementById('polygon-clear-compact') as HTMLButtonElement | null;
    const downloadButton = document.getElementById('polygon-download-geojson') as HTMLButtonElement | null;
    const shareButton = document.getElementById('polygon-share') as HTMLButtonElement | null;
    const toggleLabelsButton = document.getElementById('polygon-toggle-labels') as HTMLButtonElement | null;
    const heightInput = document.getElementById('polygon-height-compact') as HTMLInputElement | null;

    polygonTool = polygonDrawTool(scene);
    polygonToolIsDrawing = false;

    // Defaults: transparent + white
    try {
      (polygonTool as any)?.setColorByName?.('white');
      (polygonTool as any)?.setOpaque?.(false);
    } catch {
      // ignore
    }

    const attachPopoverToggle = (
      buttonEl: HTMLElement | null,
      popoverEl: HTMLElement | null,
      options: { onOpen?: () => void } = {}
    ): void => {
      if (!buttonEl || !popoverEl) return;

      let isDisposed = false;
      const close = () => {
        if (isDisposed) return;
        popoverEl.classList.remove('o-active');
        try {
          map?.un?.('click', close);
        } catch {
          // ignore
        }
      };

      const onPopoverClick = (e: Event) => stopDomEvent(e);
      const onButtonClick = (e: Event) => {
        stopDomEvent(e);

        const isOpen = popoverEl.classList.contains('o-active');
        if (isOpen) {
          close();
          return;
        }

        popoverEl.classList.add('o-active');
        try {
          map?.once?.('click', close);
        } catch {
          // ignore
        }
        options.onOpen?.();
      };

      popoverEl.addEventListener('click', onPopoverClick);
      buttonEl.addEventListener('click', onButtonClick);

      const cleanup: CleanupFn = () => {
        if (isDisposed) return;
        isDisposed = true;
        close();
        popoverEl.removeEventListener('click', onPopoverClick);
        buttonEl.removeEventListener('click', onButtonClick);
      };
      registerCleanup(cleanup);
    };

    if (downloadButton) {
      downloadButton.addEventListener('click', () => {
        if (!polygonTool) return;
        const geojson = polygonTool.getGeoJSON();
        const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'drawn_polygons.geojson';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      });
    }

    if (shareButton) {
      shareButton.addEventListener('click', async () => {
        if (!polygonTool) return;
        const drawnGeojson = polygonTool.getGeoJSON();
        const drawnFeatures = Array.isArray(drawnGeojson?.features) ? drawnGeojson.features : [];
        const sharedFeatures = Array.isArray(sharedPolygonsGeoJson?.features) ? sharedPolygonsGeoJson.features : [];
        const combinedGeojson = {
          type: 'FeatureCollection',
          features: [...sharedFeatures, ...drawnFeatures],
        };

        const roundedGeojson = roundGeoJsonForShare(combinedGeojson, 6);
        const encoded = encodeCompressedJsonToBase64Url(roundedGeojson);

        const url = new URL(window.location.href);
        url.searchParams.set('display3dDrawing', 'true');
        url.searchParams.set('polygon', encoded);

        const shareUrl = url.toString();
        try {
          await navigator.clipboard.writeText(shareUrl);
          shareButton.classList.add('active');
          const oldTitle = shareButton.title;
          shareButton.title = 'Copied!';
          setTimeout(() => {
            shareButton.title = oldTitle;
            shareButton.classList.remove('active');
          }, 1200);
        } catch {
          window.prompt('Copy this link:', shareUrl);
        }
      });
    }

    if (toggleLabelsButton) {
      const getCurrentVisible = () => {
        if (polygonTool && typeof (polygonTool as any).getLabelsVisible === 'function') {
          return Boolean((polygonTool as any).getLabelsVisible());
        }
        return sharedPolygonLabelsVisible;
      };

      toggleLabelsButton.classList.toggle('active', getCurrentVisible());

      toggleLabelsButton.addEventListener('click', () => {
        const current = getCurrentVisible();
        const next = !current;

        if (polygonTool && typeof (polygonTool as any).setLabelsVisible === 'function') {
          (polygonTool as any).setLabelsVisible(next);
        }

        sharedPolygonLabelsVisible = next;
        sharedPolygonLabels.forEach((l) => {
          l.show = next;
        });

        toggleLabelsButton.classList.toggle('active', next);
        requestSceneRender();
      });
    }

    attachPopoverToggle(heightButton, heightPopover, {
      onOpen: () => {
        if (heightInput) {
          heightInput.focus();
          heightInput.select();
        }
      },
    });

    attachPopoverToggle(colorButton, colorPopover);

    if (colorSelect) {
      colorSelect.addEventListener('change', () => {
        if (!polygonTool) return;
        try {
          (polygonTool as any)?.setColorByName?.(String(colorSelect.value));
        } catch {
          // ignore
        }

        // Also update already-loaded shared polygons (from share URL)
        try {
          const colorCss = getCesiumColorByName(String(colorSelect.value)).toCssColorString();
          if (sharedPolygonsGeoJson?.features?.length) {
            sharedPolygonsGeoJson.features.forEach((f: any) => {
              if (!f?.properties) f.properties = {};
              f.properties.color = colorCss;
              // preserve existing fillAlpha; default if missing
              if (f.properties.fillAlpha == null) {
                const currentOpaque = Boolean((polygonTool as any)?.getOpaque?.() ?? false);
                f.properties.fillAlpha = currentOpaque ? 1 : 0.7;
              }
            });
            // Re-render without zooming the camera
            sharedPolygonsCleanup?.();
            sharedPolygonsCleanup = renderSharedPolygonsFromFeatures(scene, sharedPolygonsGeoJson.features, {
              flyTo: false,
            });
          }
        } catch {
          // ignore
        }

        if (polygonToolIsDrawing && typeof (polygonTool as any).updatePreviewWithLast === 'function') {
          (polygonTool as any).updatePreviewWithLast();
        }
        requestSceneRender();
      });
    }

    if (opacityButton) {
      let isOpaque = false;
      try {
        isOpaque = Boolean((polygonTool as any)?.getOpaque?.() ?? false);
      } catch {
        // ignore
      }
      opacityButton.classList.toggle('active', isOpaque);
      opacityButton.addEventListener('click', () => {
        if (!polygonTool) return;
        isOpaque = !isOpaque;
        try {
          (polygonTool as any)?.setOpaque?.(isOpaque);
        } catch {
          // ignore
        }

        // Also update already-loaded shared polygons (from share URL)
        try {
          const nextAlpha = isOpaque ? 1 : 0.7;
          if (sharedPolygonsGeoJson?.features?.length) {
            sharedPolygonsGeoJson.features.forEach((f: any) => {
              if (!f?.properties) f.properties = {};
              f.properties.fillAlpha = nextAlpha;
              // preserve existing color; default if missing
              if (typeof f.properties.color !== 'string') {
                const currentColorName = String(colorSelect?.value ?? 'white');
                f.properties.color = getCesiumColorByName(currentColorName).toCssColorString();
              }
            });
            // Re-render without zooming the camera
            sharedPolygonsCleanup?.();
            sharedPolygonsCleanup = renderSharedPolygonsFromFeatures(scene, sharedPolygonsGeoJson.features, {
              flyTo: false,
            });
          }
        } catch {
          // ignore
        }

        if (polygonToolIsDrawing && typeof (polygonTool as any).updatePreviewWithLast === 'function') {
          (polygonTool as any).updatePreviewWithLast();
        }

        opacityButton.classList.toggle('active', isOpaque);
        requestSceneRender();
      });
    }

    if (drawButton) {
      drawButton.addEventListener('click', () => {
        if (!polygonTool || !heightInput) return;

        if (!polygonToolIsDrawing) {
          const height = parseFloat(heightInput.value) || 10;
          polygonTool.setHeight(height);
          polygonTool.startDrawing();
          polygonToolIsDrawing = true;
          drawButton.classList.add('active');
        } else {
          if (typeof (polygonTool as any).stopDrawing === 'function') {
            (polygonTool as any).stopDrawing();
          }
          polygonToolIsDrawing = false;
          drawButton.classList.remove('active');
          heightInput.disabled = false;
        }
        requestSceneRender();
      });
    }

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        polygonTool?.clear();
        sharedPolygonsCleanup?.();
        sharedPolygonsGeoJson = null;
        requestSceneRender();
      });
    }

    if (heightInput) {
      heightInput.addEventListener('input', () => {
        if (!polygonTool) return;
        const height = parseFloat(heightInput.value) || 10;
        polygonTool.setHeight(height);
        if (polygonToolIsDrawing && typeof (polygonTool as any).updatePreviewWithLast === 'function') {
          (polygonTool as any).updatePreviewWithLast();
        }
        requestSceneRender();
      });
    }
  };

  const loadSharedPolygonsFromUrl = (): CleanupFn | void => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('display3dDrawing') !== 'true') return;

    const polygonParam = params.get('polygon');
    if (!polygonParam) return;

    let geojson: any;
    try {
      geojson = decodeCompressedBase64UrlToJson(polygonParam);
    } catch {
      console.warn('Invalid polygon share URL');
      return;
    }

    const features: any[] = Array.isArray(geojson?.features) ? geojson.features : [];
    if (!features.length) return;

    // Replace any previous shared polygons/primitives
    if (sharedPolygonsCleanup) {
      try {
        sharedPolygonsCleanup();
      } catch {
        // ignore
      }
    }

    // Store for re-share (merge with newly drawn polygons)
    sharedPolygonsGeoJson = {
      type: 'FeatureCollection',
      features: features.slice(),
    };

    sharedPolygonsCleanup = renderSharedPolygonsFromFeatures(scene, features, { flyTo: true });

    // Return a stable cleanup that always disposes the *current* shared render.
    // (Shared polygons can be re-rendered when user changes color/opacity.)
    const registeredCleanup: CleanupFn = () => {
      try {
        sharedPolygonsCleanup?.();
      } catch {
        // ignore
      }
      sharedPolygonsCleanup = null;
      sharedPolygonsGeoJson = null;
    };

    return registeredCleanup;
  };

  const destroy = () => {
    polygonTool?.destroy();
    polygonTool = null;
    polygonToolbarEl = null;
    polygonToolIsDrawing = false;

    try {
      sharedPolygonsCleanup?.();
    } catch {
      // ignore
    }
    sharedPolygonsCleanup = null;
    sharedPolygonsGeoJson = null;

    if (sharedPolygonLabelCollection) {
      try {
        scene.primitives.remove(sharedPolygonLabelCollection);
      } catch {
        // ignore
      }
      sharedPolygonLabelCollection = null;
      sharedPolygonLabels = [];
    }
  };

  return {
    mountPolygonToolbarIfNeeded,
    setPolygonToolbarVisible,
    loadSharedPolygonsFromUrl,
    destroy,
  };
};
