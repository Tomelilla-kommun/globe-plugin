import * as Cesium from 'cesium';
import measureTool, { MeasureMode } from '../functions/measureTool';
import { measureToolbarHtml } from '../uiTemplates';

type CleanupFn = () => void;

export interface MeasureUiApi {
  mountMeasureToolbarIfNeeded(): void;
  setMeasureToolbarVisible(visible: boolean): void;
  isMeasureToolbarVisible(): boolean;
  destroy(): void;
}

export const createMeasureUi = (deps: {
  scene: Cesium.Scene;
  map: any;
  injectIntoMap: (markup: string) => HTMLElement | undefined;
  requestSceneRender: () => void;
  registerCleanup: (cleanup?: CleanupFn) => void;
  stopDomEvent: (event: Event) => void;
}): MeasureUiApi => {
  const {
    scene,
    injectIntoMap,
    requestSceneRender,
    registerCleanup,
    stopDomEvent,
  } = deps;

  let measureToolbarEl: HTMLElement | null = null;
  let tool: ReturnType<typeof measureTool> | null = null;
  let currentMode: MeasureMode = 'distance';

  const updateModeButtons = () => {
    const distanceBtn = document.getElementById('measure-distance');
    const heightBtn = document.getElementById('measure-height');
    const footprintBtn = document.getElementById('measure-footprint');
    const surfaceBtn = document.getElementById('measure-surface');

    distanceBtn?.classList.toggle('active', currentMode === 'distance');
    heightBtn?.classList.toggle('active', currentMode === 'height');
    footprintBtn?.classList.toggle('active', currentMode === 'footprint');
    surfaceBtn?.classList.toggle('active', currentMode === 'surface');
  };

  const setMeasureToolbarVisible = (visible: boolean) => {
    if (!measureToolbarEl) return;
    measureToolbarEl.style.display = visible ? 'flex' : 'none';

    if (visible) {
      // Initialize tool if not already
      if (!tool) {
        tool = measureTool(scene);
      }
      // Start with current mode
      tool.setMode(currentMode);
      updateModeButtons();
    } else {
      // Stop measuring when hidden
      if (tool) {
        tool.stopMeasuring();
      }
    }

    requestSceneRender();
  };

  const isMeasureToolbarVisible = (): boolean => {
    return measureToolbarEl?.style.display === 'flex';
  };

  const mountMeasureToolbarIfNeeded = () => {
    if (measureToolbarEl) return;
    if (!scene) return;

    measureToolbarEl = injectIntoMap(measureToolbarHtml()) ?? null;
    if (!measureToolbarEl) return;
    measureToolbarEl.style.display = 'none';

    const distanceBtn = document.getElementById('measure-distance') as HTMLButtonElement | null;
    const heightBtn = document.getElementById('measure-height') as HTMLButtonElement | null;
    const footprintBtn = document.getElementById('measure-footprint') as HTMLButtonElement | null;
    const surfaceBtn = document.getElementById('measure-surface') as HTMLButtonElement | null;
    const clearBtn = document.getElementById('measure-clear') as HTMLButtonElement | null;
    const closeBtn = document.getElementById('measure-close') as HTMLButtonElement | null;

    // Prevent events from bubbling to map
    const preventBubbling = (el: HTMLElement | null) => {
      if (!el) return;
      el.addEventListener('click', stopDomEvent);
      el.addEventListener('mousedown', stopDomEvent);
      el.addEventListener('pointerdown', stopDomEvent);
    };

    preventBubbling(measureToolbarEl);

    // Mode selection handlers
    if (distanceBtn) {
      distanceBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        currentMode = 'distance';
        if (tool) {
          tool.setMode('distance');
        }
        updateModeButtons();
      });
    }

    if (heightBtn) {
      heightBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        currentMode = 'height';
        if (tool) {
          tool.setMode('height');
        }
        updateModeButtons();
      });
    }

    if (footprintBtn) {
      footprintBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        currentMode = 'footprint';
        if (tool) {
          tool.setMode('footprint');
        }
        updateModeButtons();
      });
    }

    if (surfaceBtn) {
      surfaceBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        currentMode = 'surface';
        if (tool) {
          tool.setMode('surface');
        }
        updateModeButtons();
      });
    }

    // Clear measurements
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        if (tool) {
          tool.clear();
          // Restart current mode after clearing
          tool.setMode(currentMode);
        }
        requestSceneRender();
      });
    }

    // Close toolbar
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        stopDomEvent(e);
        setMeasureToolbarVisible(false);
        
        // Find and deactivate the measure button in the main toolbar
        const measureButton = document.getElementsByClassName('o-measure')[0] as HTMLElement | undefined;
        if (measureButton) {
          measureButton.classList.remove('active');
        }
      });
    }

    registerCleanup(() => {
      if (measureToolbarEl) {
        measureToolbarEl.remove();
        measureToolbarEl = null;
      }
    });
  };

  const destroy = () => {
    tool?.destroy();
    tool = null;
    if (measureToolbarEl) {
      measureToolbarEl.remove();
      measureToolbarEl = null;
    }
  };

  return {
    mountMeasureToolbarIfNeeded,
    setMeasureToolbarVisible,
    isMeasureToolbarVisible,
    destroy,
  };
};
