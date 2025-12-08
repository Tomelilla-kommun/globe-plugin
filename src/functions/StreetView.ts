import * as Cesium from 'cesium';
import { getCameraHeight, getIsStreetMode, setIsStreetMode, setCameraHeight } from '../globeState';
import { createMiniMap } from './createMiniMap';

const bottomrightDiv = document.createElement('div');
bottomrightDiv.id = 'mini-map-div';
document.body.appendChild(bottomrightDiv);

let miniMapController: (ReturnType<typeof createMiniMap> & { destroy: () => void }) | null = null;


type CleanupFn = () => void;

let streetModeCleanup: CleanupFn | null = null;
let isCameraAnimating = false;
let isDragging = false;
let lastMousePosition: Cesium.Cartesian2 | null = null;

const MOVE_KEYS = {
  KeyW: 'moveForward',
  KeyS: 'moveBackward',
  KeyA: 'moveLeft',
  KeyD: 'moveRight',
  KeyQ: 'moveUp',
  KeyE: 'moveDown',
} as const;

const moveFlags = Object.fromEntries(
  Object.values(MOVE_KEYS).map(k => [k, false])
) as Record<(typeof MOVE_KEYS)[keyof typeof MOVE_KEYS], boolean>;

export default async function setupStreetMode(
  scene: Cesium.Scene,
  handler: Cesium.ScreenSpaceEventHandler,
  globe: any
): Promise<void> {
  const heightPanel = document.getElementById('height-controls') as HTMLDivElement | null;
  const streetBtn = document.getElementById('street-mode-toggle') as HTMLButtonElement | null;
  const heightDisplay = document.getElementById('height-display');
  const heightUp = document.getElementById('height-up');
  const heightDown = document.getElementById('height-down');

  const controller = scene.screenSpaceCameraController;

  /** Utility: safely toggle element display */
  const toggleDisplay = (el?: HTMLElement | null) => {
    if (el) el.style.display = el.style.display === 'flex' ? 'none' : 'flex';
  };

  /** Updates height text in UI */
  const updateHeightDisplay = () => {
    if (heightDisplay) heightDisplay.textContent = `${getCameraHeight().toFixed(2)} m`;
  };

  /** Adjusts camera height value */
  const adjustHeight = (delta: number) => {
    const newHeight = Math.max(1, Math.min(getCameraHeight() + delta, 9999));
    setCameraHeight(newHeight);
    updateHeightDisplay();
  };

  heightUp?.addEventListener('click', () => adjustHeight(+0.05));
  heightDown?.addEventListener('click', () => adjustHeight(-0.05));

  /** Enables/disables camera controller features */
  const setControllerState = (disabled: boolean) => {
    Object.assign(controller, {
      enableZoom: !disabled,
      enableTilt: !disabled,
      enableWheelZoom: !disabled,
      enablePinchZoom: !disabled,
      enableRotate: !disabled,
      enableLook: false,
      enableCollisionDetection: !disabled,
    });
  };

  /** Keeps camera height above terrain */
  const adjustCameraHeight = () => {
    if (isCameraAnimating) return;
    const carto = Cesium.Cartographic.fromCartesian(scene.camera.position);
    const groundHeight = scene.globe.getHeight(carto);
    if (groundHeight == null) return;

    const desiredHeight = groundHeight + getCameraHeight();
    if (Math.abs(carto.height - desiredHeight) > 0.01) {
      carto.height = desiredHeight;
      scene.camera.position = Cesium.Cartesian3.fromRadians(
        carto.longitude, carto.latitude, desiredHeight
      );
    }
  };

  /** Smooth camera flyTo helper */
  const flyToCarto = (
    carto: Cesium.Cartographic,
    duration = 1,
    complete?: () => void
  ) => {
    scene.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
      orientation: { heading: scene.camera.heading, pitch: 0, roll: 0 },
      duration,
      complete,
    });
  };

  /** Keyboard handlers */
  const streetKeyDown = (e: KeyboardEvent) => {
    const key = MOVE_KEYS[e.code as keyof typeof MOVE_KEYS];
    if (key) moveFlags[key] = true;
  };

  const streetKeyUp = (e: KeyboardEvent) => {
    const key = MOVE_KEYS[e.code as keyof typeof MOVE_KEYS];
    if (key) moveFlags[key] = false;
  };

  /** Start street mode at a given position */
  const enterStreetMode = (position: Cesium.Cartesian3) => {
    miniMapController = createMiniMap(globe, bottomrightDiv);
    miniMapController.mount();
    
    const carto = Cesium.Cartographic.fromCartesian(position);
    carto.height += getCameraHeight();

    setControllerState(true);
    scene.canvas.setAttribute('tabindex', '0');
    scene.canvas.onclick = () => scene.canvas.focus();

    streetModeCleanup = () => {
      scene.postRender.removeEventListener(adjustCameraHeight);
      document.removeEventListener('keydown', streetKeyDown);
      document.removeEventListener('keyup', streetKeyUp);
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN);
      handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP);
      handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    };

    // Maintain camera height
    scene.postRender.addEventListener(adjustCameraHeight);

    // Mouse look
    handler.setInputAction(
      (event: { position: Cesium.Cartesian2 }) => {
        isDragging = true;
        lastMousePosition = Cesium.Cartesian2.clone(event.position);
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN
    );

    handler.setInputAction(
      (event: { endPosition: Cesium.Cartesian2 }) => {
        if (!isDragging || !lastMousePosition) return;
        const delta = Cesium.Cartesian2.subtract(
          event.endPosition,
          lastMousePosition,
          new Cesium.Cartesian2()
        );
        lastMousePosition = Cesium.Cartesian2.clone(event.endPosition);

        const lookFactor = 0.0015;
        const heading = scene.camera.heading - delta.x * lookFactor;
        const pitch = Cesium.Math.clamp(
          scene.camera.pitch + delta.y * lookFactor,
          Cesium.Math.toRadians(-89),
          Cesium.Math.toRadians(89)
        );
        scene.camera.setView({ orientation: { heading, pitch, roll: 0 } });
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE
    );

    handler.setInputAction(
      () => (isDragging = false),
      Cesium.ScreenSpaceEventType.LEFT_UP
    );

    // Move camera when clicking a new point
    handler.setInputAction(({ position }: { position: Cesium.Cartesian2 }) => {
      const pos = scene.pickPosition(position);
      if (!pos) return alert('Ogiltig position');

      const newCarto = Cesium.Cartographic.fromCartesian(pos);
      newCarto.height += getCameraHeight();

      isCameraAnimating = true;
      flyToCarto(newCarto, 1, () => (isCameraAnimating = false));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    document.addEventListener('keydown', streetKeyDown);
    document.addEventListener('keyup', streetKeyUp);

    flyToCarto(carto);
    setIsStreetMode(true);
  };

  /** Exit street mode cleanly */
  const exitStreetMode = () => {
    if (!getIsStreetMode()) return;

      try {
      miniMapController?.destroy();
    } finally {
      miniMapController = null;
    }

    streetModeCleanup?.();
    streetModeCleanup = null;

    const carto = Cesium.Cartographic.fromCartesian(scene.camera.position);
    const groundHeight = scene.globe.getHeight(carto) ?? 0;
    carto.height = groundHeight + 70;

    setControllerState(false);
    setIsStreetMode(false);
    toggleDisplay(heightPanel);

    scene.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
      orientation: {
        heading: scene.camera.heading,
        pitch: Cesium.Math.toRadians(-15),
        roll: 0,
      },
      duration: 1,
    });
  };

  /** Button click toggles mode */
  streetBtn?.addEventListener('click', () => {
    if (getIsStreetMode()) return exitStreetMode();

    alert('Klicka på kartan för att starta gatuläge\nFör att gå ur, klicka på knappen igen');

    const clickHandler = (e: MouseEvent) => {
      document.removeEventListener('click', clickHandler, true);
      if (e.target !== scene.canvas) return toggleDisplay(heightPanel);

      const rect = scene.canvas.getBoundingClientRect();
      const clickPos = scene.pickPosition(
        new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top)
      );

      if (clickPos) {
        toggleDisplay(heightPanel);
        enterStreetMode(clickPos);
      } else {
        alert('Kan inte starta gatuläge här');
      }
    };

    document.addEventListener('click', clickHandler, true);
  });
}
