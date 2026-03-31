import * as Cesium from 'cesium';

import polygonDrawTool, { PolygonData } from '../functions/polygonDrawTool';
import { polygonToolbarHtml, polygonEditPanelHtml, polygonTranslateArrowsHtml, PolygonToolbarOptions } from '../uiTemplates';
import {
  decodeCompressedBase64UrlToJson,
  encodeCompressedJsonToBase64Url,
  roundGeoJsonForShare,
} from './shareCodec';

import type { CleanupFn } from './types';

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
  drawToolOptions?: DrawToolOptions;
}): PolygonUiApi => {
  const {
    scene,
    map,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    stopDomEvent,
    drawToolOptions = {},
  } = deps;

  // Parse drawTool options
  console.log('[Globe DEBUG] drawToolOptions received:', JSON.stringify(drawToolOptions, null, 2));
  const toolOptions = drawToolOptions.options || {};
  console.log('[Globe DEBUG] toolOptions:', JSON.stringify(toolOptions, null, 2));
  const exportConfig = typeof toolOptions.export === 'object' ? toolOptions.export : 
    (toolOptions.export === false ? { geojson: false, dxf: false } : { geojson: true, dxf: true });
  console.log('[Globe DEBUG] exportConfig:', JSON.stringify(exportConfig, null, 2));
  const showShare = toolOptions.share !== false;
  const defaultColor = toolOptions.defaultColor || 'white';
  const defaultHeight = toolOptions.defaultHeight ?? 10;
  const dxfCrs = exportConfig.dxfCrs || ['EPSG:3006'];
  const showGeojson = exportConfig.geojson !== false;
  const showDxf = exportConfig.dxf !== false;
  console.log('[Globe DEBUG] Final config: dxfCrs=', dxfCrs, 'showGeojson=', showGeojson, 'showDxf=', showDxf);

  let polygonToolbarEl: HTMLElement | null = null;
  let polygonEditPanelEl: HTMLElement | null = null;
  let polygonTranslateArrowsEl: HTMLElement | null = null;
  let polygonTool: ReturnType<typeof polygonDrawTool> | null = null;
  let polygonToolIsDrawing = false;
  let rectangleToolIsDrawing = false;
  let selectedPolygonForArrows: PolygonData | null = null;
  let cameraChangeListener: Cesium.Event.RemoveCallback | null = null;

  // Disable/enable draw toolbar when polygon is selected/deselected
  const setDrawToolbarEnabled = (enabled: boolean) => {
    const toolbarButtons = [
      'polygon-draw',
      'rectangle-draw', 
      'polygon-height-button',
      'polygon-color-button',
      'polygon-opacity-toggle',
      'polygon-labels-toggle',
      'polygon-download-button',
      'polygon-share',
      'polygon-clear',
    ];
    
    toolbarButtons.forEach(id => {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '1' : '0.4';
        btn.style.pointerEvents = enabled ? 'auto' : 'none';
      }
    });
  };

  const hideEditPanel = () => {
    if (polygonEditPanelEl) {
      polygonEditPanelEl.style.display = 'none';
    }
    // Close any open popovers
    document.getElementById('polygon-edit-height-popover')?.classList.remove('o-active');
    document.getElementById('polygon-edit-color-popover')?.classList.remove('o-active');
    // Hide translate arrows
    hideTranslateArrows();
    // Re-enable the draw toolbar
    setDrawToolbarEnabled(true);
  };

  const showEditPanel = (polygon: PolygonData) => {
    if (!polygonEditPanelEl) return;

    polygonEditPanelEl.style.display = 'flex';
    showTranslateArrows(polygon);
    // Disable the draw toolbar while editing
    setDrawToolbarEnabled(false);

    // Populate fields with polygon data
    const nameInput = document.getElementById('polygon-edit-name') as HTMLInputElement | null;
    const heightInput = document.getElementById('polygon-edit-height-input') as HTMLInputElement | null;
    const colorSelect = document.getElementById('polygon-edit-color-select') as HTMLSelectElement | null;
    const opacityButton = document.getElementById('polygon-edit-opacity-toggle') as HTMLButtonElement | null;

    if (nameInput) {
      nameInput.value = polygon.name || '';
    }
    if (heightInput) {
      heightInput.value = String(polygon.extrudeHeight || 10);
    }
    if (colorSelect) {
      // Try to match color
      const colorCss = polygon.color?.toCssColorString?.() || '';
      const colorName = getColorNameFromCss(colorCss);
      colorSelect.value = colorName;
    }
    if (opacityButton) {
      const isOpaque = polygon.fillAlpha >= 0.999;
      opacityButton.classList.toggle('active', isOpaque);
    }
  };

  const getColorNameFromCss = (css: string): string => {
    const lower = css.toLowerCase();
    if (lower.includes('255, 255, 255') || lower === '#ffffff' || lower === 'white') return 'white';
    if (lower.includes('255, 0, 0') || lower === '#ff0000' || lower === 'red') return 'red';
    if (lower.includes('0, 255, 0') || lower === '#00ff00' || lower === 'lime') return 'green';
    if (lower.includes('30, 144, 255') || lower.includes('dodgerblue')) return 'blue';
    if (lower.includes('255, 255, 0') || lower === '#ffff00' || lower === 'yellow') return 'yellow';
    if (lower.includes('0, 255, 255') || lower === '#00ffff' || lower === 'cyan') return 'cyan';
    return 'white';
  };

  // Translate arrows overlay management
  const hideTranslateArrows = () => {
    if (polygonTranslateArrowsEl) {
      polygonTranslateArrowsEl.style.display = 'none';
    }
    selectedPolygonForArrows = null;
  };

  const showTranslateArrows = (polygon: PolygonData) => {
    selectedPolygonForArrows = polygon;
    if (!polygonTranslateArrowsEl) return;
    polygonTranslateArrowsEl.style.display = 'block';
    updateTranslateArrowsPosition();
  };

  const updateTranslateArrowsPosition = () => {
    if (!polygonTranslateArrowsEl || !selectedPolygonForArrows || !scene) return;

    const polygon = selectedPolygonForArrows;
    
    // Calculate centroid of polygon positions
    const positions = polygon.positions;
    if (!positions || positions.length === 0) return;

    const centroid = Cesium.Cartesian3.fromRadians(
      positions.reduce((sum, p) => sum + Cesium.Cartographic.fromCartesian(p).longitude, 0) / positions.length,
      positions.reduce((sum, p) => sum + Cesium.Cartographic.fromCartesian(p).latitude, 0) / positions.length,
      polygon.baseHeight + polygon.extrudeHeight / 2
    );

    // Convert to screen coordinates
    const screenPos = Cesium.SceneTransforms.worldToWindowCoordinates(scene, centroid);
    if (!screenPos) {
      polygonTranslateArrowsEl.style.display = 'none';
      return;
    }

    // Position the drag handle at centroid
    const handle = document.getElementById('polygon-translate-handle') as HTMLElement | null;
    if (handle) {
      handle.style.left = `${screenPos.x}px`;
      handle.style.top = `${screenPos.y}px`;
    }

    polygonTranslateArrowsEl.style.display = 'block';
  };

  const mountTranslateArrowsIfNeeded = () => {
    if (polygonTranslateArrowsEl) return;
    if (!scene) return;

    polygonTranslateArrowsEl = injectIntoMap(polygonTranslateArrowsHtml()) ?? null;
    if (!polygonTranslateArrowsEl) return;

    const handle = document.getElementById('polygon-translate-handle') as HTMLElement | null;
    if (!handle) return;

    // Drag state
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    // Apply translation in world coordinates (east=dx, north=dy)
    const applyTranslation = (dx: number, dy: number) => {
      if (!polygonTool || !selectedPolygonForArrows) return;
      polygonTool.translatePolygon?.(selectedPolygonForArrows.id, dx, dy);
      // Update the reference to the polygon after translation
      selectedPolygonForArrows = polygonTool.getSelectedPolygon?.() || null;
      updateTranslateArrowsPosition();
      requestSceneRender();
    };

    // Convert screen pixel delta to world meters based on camera
    const screenPixelsToMeters = (pixelDx: number, pixelDy: number) => {
      if (!scene) return { dx: 0, dy: 0 };
      
      // Get approximate meters per pixel based on camera altitude
      const cameraHeight = scene.camera.positionCartographic?.height || 1000;
      // Rough approximation: at ground level, 1 pixel ≈ cameraHeight / 1000 meters
      // This gives a reasonable feel for dragging at various zoom levels
      const metersPerPixel = Math.max(0.01, cameraHeight / 1500);
      
      const heading = scene.camera.heading; // radians, 0=north, increases clockwise
      
      // Screen up direction in world: (sin(heading), cos(heading)) = (east, north)
      // Screen right direction in world: (cos(heading), -sin(heading))
      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);
      
      // Invert Y because screen Y increases downward but we want up = forward
      const screenDx = pixelDx * metersPerPixel;
      const screenDy = -pixelDy * metersPerPixel;
      
      // Convert screen-relative to world coordinates
      const worldDx = screenDy * sinH + screenDx * cosH;  // east component
      const worldDy = screenDy * cosH - screenDx * sinH;  // north component
      
      return { dx: worldDx, dy: worldDy };
    };

    const onMouseDown = (e: MouseEvent) => {
      stopDomEvent(e);
      isDragging = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      handle.style.cursor = 'grabbing';
      handle.style.background = 'rgba(200,220,255,0.95)';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      stopDomEvent(e);
      
      const deltaX = e.clientX - lastMouseX;
      const deltaY = e.clientY - lastMouseY;
      
      if (Math.abs(deltaX) > 0 || Math.abs(deltaY) > 0) {
        const { dx, dy } = screenPixelsToMeters(deltaX, deltaY);
        applyTranslation(dx, dy);
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!isDragging) return;
      stopDomEvent(e);
      isDragging = false;
      handle.style.cursor = 'move';
      handle.style.background = 'rgba(255,255,255,0.95)';
    };

    // Mouse events
    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Touch events for mobile
    handle.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length === 1) {
        stopDomEvent(e);
        isDragging = true;
        lastMouseX = e.touches[0].clientX;
        lastMouseY = e.touches[0].clientY;
        handle.style.background = 'rgba(200,220,255,0.95)';
      }
    });

    document.addEventListener('touchmove', (e: TouchEvent) => {
      if (!isDragging || e.touches.length !== 1) return;
      
      const deltaX = e.touches[0].clientX - lastMouseX;
      const deltaY = e.touches[0].clientY - lastMouseY;
      
      if (Math.abs(deltaX) > 0 || Math.abs(deltaY) > 0) {
        const { dx, dy } = screenPixelsToMeters(deltaX, deltaY);
        applyTranslation(dx, dy);
        lastMouseX = e.touches[0].clientX;
        lastMouseY = e.touches[0].clientY;
      }
    });

    document.addEventListener('touchend', () => {
      isDragging = false;
      handle.style.background = 'rgba(255,255,255,0.95)';
    });

    // Listen for camera changes to update handle position
    cameraChangeListener = scene.camera.changed.addEventListener(() => {
      if (selectedPolygonForArrows) {
        updateTranslateArrowsPosition();
      }
    });

    // Also update on preRender for smoother tracking during camera movement
    scene.preRender.addEventListener(() => {
      if (selectedPolygonForArrows) {
        updateTranslateArrowsPosition();
      }
    });
  };

  const setPolygonToolbarVisible = (visible: boolean) => {
    if (!polygonToolbarEl) return;
    polygonToolbarEl.style.display = visible ? 'flex' : 'none';

    if (!visible) {
      const heightPopover = document.getElementById('polygon-height-popover') as HTMLElement | null;
      heightPopover?.classList.remove('o-active');
      hideEditPanel();
      
      // Disable selection when toolbar is hidden
      if (polygonTool && typeof (polygonTool as any).disableSelection === 'function') {
        (polygonTool as any).disableSelection();
      }
    } else {
      // Enable selection when toolbar is shown
      if (polygonTool && typeof (polygonTool as any).enableSelection === 'function') {
        (polygonTool as any).enableSelection((polygon: PolygonData | null) => {
          if (polygon) {
            showEditPanel(polygon);
          } else {
            hideEditPanel();
          }
        });
      }
    }

    if (!visible && polygonTool) {
      // Stop polygon drawing if active
      if (polygonToolIsDrawing && typeof (polygonTool as any).stopDrawing === 'function') {
        (polygonTool as any).stopDrawing();
        polygonToolIsDrawing = false;

        const drawBtn = document.getElementById('polygon-draw') as HTMLButtonElement | null;
        if (drawBtn) {
          drawBtn.classList.remove('active');
        }
      }

      // Stop rectangle drawing if active
      if (rectangleToolIsDrawing && typeof (polygonTool as any).stopDrawingRectangle === 'function') {
        (polygonTool as any).stopDrawingRectangle();
        rectangleToolIsDrawing = false;

        const rectBtn = document.getElementById('rectangle-draw') as HTMLButtonElement | null;
        if (rectBtn) {
          rectBtn.classList.remove('active');
        }
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

    const toolbarOptions: PolygonToolbarOptions = {
      showGeojson,
      showDxf,
      dxfCrs,
      showShare,
    };
    polygonToolbarEl = injectIntoMap(polygonToolbarHtml(toolbarOptions)) ?? null;
    if (!polygonToolbarEl) return;
    polygonToolbarEl.style.display = 'none';

    const drawButton = document.getElementById('polygon-draw') as HTMLButtonElement | null;
    const rectangleButton = document.getElementById('rectangle-draw') as HTMLButtonElement | null;
    const heightButton = document.getElementById('polygon-height-button') as HTMLButtonElement | null;
    const heightPopover = document.getElementById('polygon-height-popover') as HTMLElement | null;
    const colorButton = document.getElementById('polygon-color-button') as HTMLButtonElement | null;
    const colorPopover = document.getElementById('polygon-color-popover') as HTMLElement | null;
    const colorSelect = document.getElementById('polygon-color-select') as HTMLSelectElement | null;
    const opacityButton = document.getElementById('polygon-opacity-toggle') as HTMLButtonElement | null;
    const clearButton = document.getElementById('polygon-clear-compact') as HTMLButtonElement | null;
    const downloadButton = document.getElementById('polygon-download-button') as HTMLButtonElement | null;
    const downloadPopover = document.getElementById('polygon-download-popover') as HTMLElement | null;
    const downloadGeojsonButton = document.getElementById('polygon-download-geojson') as HTMLButtonElement | null;
    const shareButton = document.getElementById('polygon-share') as HTMLButtonElement | null;
    const toggleLabelsButton = document.getElementById('polygon-toggle-labels') as HTMLButtonElement | null;
    const heightInput = document.getElementById('polygon-height-compact') as HTMLInputElement | null;

    polygonTool = polygonDrawTool(scene);
    polygonToolIsDrawing = false;
    rectangleToolIsDrawing = false;

    // Apply defaults from config
    try {
      (polygonTool as any)?.setColorByName?.(defaultColor);
      (polygonTool as any)?.setOpaque?.(false);
      (polygonTool as any)?.setHeight?.(defaultHeight);
    } catch {
      // ignore
    }

    // Set default height in input
    if (heightInput) {
      heightInput.value = String(defaultHeight);
    }
    // Set default color in select
    if (colorSelect) {
      colorSelect.value = defaultColor;
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
        document.removeEventListener('click', onDocumentClick, true);
        try {
          map?.un?.('click', close);
        } catch {
          // ignore
        }
      };

      const onDocumentClick = (e: MouseEvent) => {
        // Close if click is outside the popover and button
        const target = e.target as Node;
        if (!popoverEl.contains(target) && !buttonEl.contains(target)) {
          close();
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
        // Use setTimeout to avoid the current click triggering the close
        setTimeout(() => {
          document.addEventListener('click', onDocumentClick, true);
        }, 0);
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
        document.removeEventListener('click', onDocumentClick, true);
        popoverEl.removeEventListener('click', onPopoverClick);
        buttonEl.removeEventListener('click', onButtonClick);
      };
      registerCleanup(cleanup);
    };

    // Download popover
    attachPopoverToggle(downloadButton, downloadPopover);

    if (downloadGeojsonButton) {
      downloadGeojsonButton.addEventListener('click', () => {
        if (!polygonTool) return;
        const geojson = polygonTool.getGeoJSON();
        const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'drawn_polygons_EPSG4326.geojson';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        // Close popover
        downloadPopover?.classList.remove('o-active');
      });
    }

    // Wire up dynamic DXF buttons
    const dxfButtons = document.querySelectorAll('.polygon-download-dxf-btn');
    dxfButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!polygonTool) return;
        const crs = (btn as HTMLElement).dataset.crs || 'EPSG:3006';
        const dxf = polygonTool.getDXF(crs);
        const blob = new Blob([dxf], { type: 'application/dxf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeCrs = crs.replace(/[^a-zA-Z0-9]/g, '_');
        a.download = `drawn_polygons_${safeCrs}.dxf`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        // Close popover
        downloadPopover?.classList.remove('o-active');
      });
    });

    // Popup for share confirmation
    const showSharePopup = () => {
      // Remove any existing popup
      const existingPopup = document.getElementById('share-confirmation-popup');
      if (existingPopup) {
        existingPopup.remove();
      }

      // Create popup element
      const popup = document.createElement('div');
      popup.id = 'share-confirmation-popup';
      popup.innerHTML = `
        <div id="share-popup-backdrop" style="
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.3);
          z-index: 9998;
        "></div>
        <div id="share-popup-content" style="
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: white;
          padding: 20px 30px;
          border-radius: 8px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          text-align: center;
          min-width: 250px;
        ">
          <button id="share-popup-close" style="
            position: absolute;
            top: 8px;
            right: 8px;
            background: none;
            border: none;
            font-size: 20px;
            cursor: pointer;
            color: #666;
            padding: 4px 8px;
            line-height: 1;
          " aria-label="Stäng">×</button>
          <p style="
            margin: 0;
            font-size: 15px;
            color: #333;
          ">Länk har sparats till urklipp</p>
        </div>
      `;
      document.body.appendChild(popup);

      const closePopup = () => {
        popup.remove();
      };

      // Close on backdrop click
      const backdrop = document.getElementById('share-popup-backdrop');
      backdrop?.addEventListener('click', closePopup);

      // Close on X button click
      const closeBtn = document.getElementById('share-popup-close');
      closeBtn?.addEventListener('click', closePopup);

      // Auto-close after 3 seconds
      setTimeout(closePopup, 3000);
    };

    if (shareButton) {
      shareButton.addEventListener('click', async () => {
        if (!polygonTool) return;
        // All polygons (including imported shared ones) are now in polygonTool
        const geojson = polygonTool.getGeoJSON();
        const features = Array.isArray(geojson?.features) ? geojson.features : [];

        if (features.length === 0) {
          shareButton.title = 'No polygons to share';
          return;
        }

        const roundedGeojson = roundGeoJsonForShare({ type: 'FeatureCollection', features }, 6);
        const encoded = encodeCompressedJsonToBase64Url(roundedGeojson);

        const url = new URL(window.location.href);
        url.searchParams.set('display3dDrawing', 'true');
        url.searchParams.set('polygon', encoded);

        const shareUrl = url.toString();
        try {
          await navigator.clipboard.writeText(shareUrl);
          showSharePopup();
        } catch {
          window.prompt('Kopiera denna länk:', shareUrl);
        }
      });
    }

    if (toggleLabelsButton) {
      const getCurrentVisible = () => {
        if (polygonTool && typeof (polygonTool as any).getLabelsVisible === 'function') {
          return Boolean((polygonTool as any).getLabelsVisible());
        }
        return true;
      };

      toggleLabelsButton.classList.toggle('active', getCurrentVisible());

      toggleLabelsButton.addEventListener('click', () => {
        const current = getCurrentVisible();
        const next = !current;

        if (polygonTool && typeof (polygonTool as any).setLabelsVisible === 'function') {
          (polygonTool as any).setLabelsVisible(next);
        }

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

        // All polygons (including imported shared ones) are now managed by polygonTool
        // so setColorByName already updated them

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

        // All polygons (including imported shared ones) are now managed by polygonTool
        // so setOpaque already updated them

        if (polygonToolIsDrawing && typeof (polygonTool as any).updatePreviewWithLast === 'function') {
          (polygonTool as any).updatePreviewWithLast();
        }

        opacityButton.classList.toggle('active', isOpaque);
        requestSceneRender();
      });
    }

    // Helper to stop both drawing modes
    const stopAllDrawing = () => {
      if (polygonToolIsDrawing && typeof (polygonTool as any).stopDrawing === 'function') {
        (polygonTool as any).stopDrawing();
        polygonToolIsDrawing = false;
        drawButton?.classList.remove('active');
      }
      if (rectangleToolIsDrawing && typeof (polygonTool as any).stopDrawingRectangle === 'function') {
        (polygonTool as any).stopDrawingRectangle();
        rectangleToolIsDrawing = false;
        rectangleButton?.classList.remove('active');
      }
    };

    // ESC key cancels drawing
    const onEscKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && (polygonToolIsDrawing || rectangleToolIsDrawing)) {
        e.preventDefault();
        e.stopPropagation();
        
        // Blur any focused button to prevent grayed-out appearance
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        
        stopAllDrawing();
        requestSceneRender();
      }
    };
    document.addEventListener('keydown', onEscKey, true); // Use capture phase
    registerCleanup(() => document.removeEventListener('keydown', onEscKey, true));

    if (drawButton) {
      drawButton.addEventListener('click', () => {
        if (!polygonTool || !heightInput) return;

        if (!polygonToolIsDrawing) {
          // Stop rectangle drawing if active
          if (rectangleToolIsDrawing) {
            (polygonTool as any).stopDrawingRectangle?.();
            rectangleToolIsDrawing = false;
            rectangleButton?.classList.remove('active');
          }

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

    if (rectangleButton) {
      rectangleButton.addEventListener('click', () => {
        if (!polygonTool || !heightInput) return;

        if (!rectangleToolIsDrawing) {
          // Stop polygon drawing if active
          if (polygonToolIsDrawing) {
            (polygonTool as any).stopDrawing?.();
            polygonToolIsDrawing = false;
            drawButton?.classList.remove('active');
          }

          const height = parseFloat(heightInput.value) || 10;
          polygonTool.setHeight(height);
          (polygonTool as any).startDrawingRectangle();
          rectangleToolIsDrawing = true;
          rectangleButton.classList.add('active');
        } else {
          if (typeof (polygonTool as any).stopDrawingRectangle === 'function') {
            (polygonTool as any).stopDrawingRectangle();
          }
          rectangleToolIsDrawing = false;
          rectangleButton.classList.remove('active');
          heightInput.disabled = false;
        }
        requestSceneRender();
      });
    }

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        // All polygons (including imported shared ones) are now managed by polygonTool
        polygonTool?.clear();
        // Also stop any active drawing
        stopAllDrawing();
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

    // Mount edit panel
    mountEditPanelIfNeeded();
  };

  const mountEditPanelIfNeeded = () => {
    if (polygonEditPanelEl) return;
    if (!scene) return;

    polygonEditPanelEl = injectIntoMap(polygonEditPanelHtml()) ?? null;
    if (!polygonEditPanelEl) return;
    polygonEditPanelEl.style.display = 'none';

    const nameInput = document.getElementById('polygon-edit-name') as HTMLInputElement | null;
    const heightButton = document.getElementById('polygon-edit-height-button') as HTMLButtonElement | null;
    const heightPopover = document.getElementById('polygon-edit-height-popover') as HTMLElement | null;
    const heightInput = document.getElementById('polygon-edit-height-input') as HTMLInputElement | null;
    const colorButton = document.getElementById('polygon-edit-color-button') as HTMLButtonElement | null;
    const colorPopover = document.getElementById('polygon-edit-color-popover') as HTMLElement | null;
    const colorSelect = document.getElementById('polygon-edit-color-select') as HTMLSelectElement | null;
    const opacityButton = document.getElementById('polygon-edit-opacity-toggle') as HTMLButtonElement | null;
    const rotateButton = document.getElementById('polygon-edit-rotate-button') as HTMLButtonElement | null;
    const rotatePopover = document.getElementById('polygon-edit-rotate-popover') as HTMLElement | null;
    const rotateInput = document.getElementById('polygon-edit-rotate-input') as HTMLInputElement | null;
    const rotateCcwButton = document.getElementById('polygon-rotate-ccw') as HTMLButtonElement | null;
    const rotateCwButton = document.getElementById('polygon-rotate-cw') as HTMLButtonElement | null;
    const deleteButton = document.getElementById('polygon-edit-delete') as HTMLButtonElement | null;
    const deselectButton = document.getElementById('polygon-edit-deselect') as HTMLButtonElement | null;

    // Helper for edit panel popovers
    const attachEditPopoverToggle = (
      buttonEl: HTMLElement | null,
      popoverEl: HTMLElement | null,
      options: { onOpen?: () => void } = {}
    ): void => {
      if (!buttonEl || !popoverEl) return;

      const closePopover = () => {
        popoverEl.classList.remove('o-active');
        document.removeEventListener('click', onDocumentClick);
      };

      const onDocumentClick = (e: Event) => {
        // Check if click is outside the popover and button
        const target = e.target as HTMLElement;
        if (!popoverEl.contains(target) && !buttonEl.contains(target)) {
          closePopover();
        }
      };

      const onButtonClick = (e: Event) => {
        stopDomEvent(e);
        const isOpen = popoverEl.classList.contains('o-active');
        if (isOpen) {
          closePopover();
        } else {
          // Close any other open edit popovers first
          document.getElementById('polygon-edit-height-popover')?.classList.remove('o-active');
          document.getElementById('polygon-edit-color-popover')?.classList.remove('o-active');
          document.getElementById('polygon-edit-rotate-popover')?.classList.remove('o-active');
          
          popoverEl.classList.add('o-active');
          options.onOpen?.();
          
          // Add document click listener after a small delay to avoid immediate close
          setTimeout(() => {
            document.addEventListener('click', onDocumentClick);
          }, 0);
        }
      };

      buttonEl.addEventListener('click', onButtonClick);
    };

    attachEditPopoverToggle(heightButton, heightPopover, {
      onOpen: () => {
        if (heightInput) {
          heightInput.focus();
          heightInput.select();
        }
      },
    });

    attachEditPopoverToggle(colorButton, colorPopover);
    attachEditPopoverToggle(rotateButton, rotatePopover);

    // Name change handler
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        if (!polygonTool) return;
        const selected = polygonTool.getSelectedPolygon?.();
        if (!selected) return;
        polygonTool.setPolygonName?.(selected.id, nameInput.value);
      });
    }

    // Height change handler
    if (heightInput) {
      heightInput.addEventListener('input', () => {
        if (!polygonTool) return;
        const selected = polygonTool.getSelectedPolygon?.();
        if (!selected) return;
        const newHeight = parseFloat(heightInput.value) || 10;
        polygonTool.setPolygonHeight?.(selected.id, newHeight);
      });
    }

    // Color change handler
    if (colorSelect) {
      colorSelect.addEventListener('change', () => {
        if (!polygonTool) return;
        const selected = polygonTool.getSelectedPolygon?.();
        if (!selected) return;
        polygonTool.setPolygonColor?.(selected.id, colorSelect.value);
        requestSceneRender();
      });
    }

    // Opacity toggle handler
    if (opacityButton) {
      opacityButton.addEventListener('click', () => {
        if (!polygonTool) return;
        const selected = polygonTool.getSelectedPolygon?.();
        if (!selected) return;
        const currentOpaque = selected.fillAlpha >= 0.999;
        polygonTool.setPolygonOpacity?.(selected.id, !currentOpaque);
        opacityButton.classList.toggle('active', !currentOpaque);
        requestSceneRender();
      });
    }

    // Rotation handlers
    const applyRotation = (angle: number) => {
      if (!polygonTool) return;
      const selected = polygonTool.getSelectedPolygon?.();
      if (!selected) return;
      polygonTool.rotatePolygon?.(selected.id, angle);
      requestSceneRender();
    };

    if (rotateCcwButton) {
      rotateCcwButton.addEventListener('click', () => {
        const angle = parseFloat(rotateInput?.value || '15') || 15;
        applyRotation(-angle);
      });
    }

    if (rotateCwButton) {
      rotateCwButton.addEventListener('click', () => {
        const angle = parseFloat(rotateInput?.value || '15') || 15;
        applyRotation(angle);
      });
    }

    // Mount translate arrows overlay
    mountTranslateArrowsIfNeeded();

    // Delete handler
    if (deleteButton) {
      deleteButton.addEventListener('click', () => {
        if (!polygonTool) return;
        const selected = polygonTool.getSelectedPolygon?.();
        if (!selected) return;
        polygonTool.deletePolygon?.(selected.id);
        hideEditPanel();
        requestSceneRender();
      });
    }

    // Deselect handler
    if (deselectButton) {
      deselectButton.addEventListener('click', () => {
        if (!polygonTool) return;
        polygonTool.deselectPolygon?.();
        hideEditPanel();
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

    // Ensure polygon tool is initialized
    mountPolygonToolbarIfNeeded();
    if (!polygonTool) {
      console.warn('Could not initialize polygon tool for shared polygons');
      return;
    }

    // Import each shared polygon into the polygon tool (making them editable)
    const importedPolygons: PolygonData[] = [];
    for (const feature of features) {
      const imported = polygonTool.importPolygonFromGeoJSON(feature);
      if (imported) {
        importedPolygons.push(imported);
      }
    }

    if (!importedPolygons.length) return;

    // Fly to imported polygons
    const allPositions: Cesium.Cartesian3[] = [];
    for (const polygon of importedPolygons) {
      allPositions.push(...polygon.positions);
    }

    if (allPositions.length) {
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

      scene.camera.flyTo({
        destination: paddedRect,
        duration: 2.0,
        complete: requestSceneRender,
      });
      requestSceneRender();
    }

    // Enable selection so user can edit imported polygons
    polygonTool.enableSelection((polygon: PolygonData | null) => {
      if (polygon) {
        showEditPanel(polygon);
      } else {
        hideEditPanel();
      }
    });
    mountEditPanelIfNeeded();

    // Return cleanup that will clear imported polygons
    const registeredCleanup: CleanupFn = () => {
      // Polygons are now managed by polygonTool, so clear() will handle them
      // We don't need separate cleanup for shared polygons anymore
    };

    return registeredCleanup;
  };

  const destroy = () => {
    polygonTool?.destroy();
    polygonTool = null;
    polygonToolbarEl = null;
    polygonEditPanelEl = null;
    polygonTranslateArrowsEl = null;
    polygonToolIsDrawing = false;
    selectedPolygonForArrows = null;
    if (cameraChangeListener) {
      cameraChangeListener();
      cameraChangeListener = null;
    }
    // All polygons (including imported shared ones) are now managed by polygonTool.destroy()
  };

  return {
    mountPolygonToolbarIfNeeded,
    setPolygonToolbarVisible,
    loadSharedPolygonsFromUrl,
    destroy,
  };
};
