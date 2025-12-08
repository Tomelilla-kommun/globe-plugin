import * as Cesium from 'cesium';
import SensorShadow from './SensorShadow';
import { getCameraHeight } from '../globeState';
import type { Scene } from "cesium";

type Points = {
  start: Cesium.Cartesian3 | null;
  end: Cesium.Cartesian3 | null;
};

let sensorShadowInstance: SensorShadow | null = null;
let points: Points = { start: null, end: null };
let primitives: Cesium.PointPrimitiveCollection | null = null;
let redPoint: Cesium.PointPrimitive | null = null;
let pickedEntity: Cesium.PointPrimitive | null = null;
let isViewShed = false;

/** Sets up the Viewshed interaction tool */
export default function setupViewshed(
  scene: Scene,
  viewshedButton: { getId: () => string },
  handler: Cesium.ScreenSpaceEventHandler
): void {
  /** Wait until button exists before attaching click listener */
  const observer = new MutationObserver(() => {
    const button = document.getElementById(viewshedButton.getId());
    if (!button) return;
    observer.disconnect();
    button.onclick = toggleViewshed;
  });
  observer.observe(document.body, { childList: true, subtree: true });

  /** Toggles viewshed on/off */
  function toggleViewshed(): void {
    isViewShed ? disableViewshed() : enableViewshed();
  }

  /** Enables viewshed mode */
  function enableViewshed(): void {
    isViewShed = true;
    scene.globe.shadows = Cesium.ShadowMode.ENABLED;
    alert('Klicka på kartan för att placera startpunkten. Klicka igen för att placera slutpunkten.');
    document.addEventListener('click', handleMapClick, true);
  }

  /** Disables and cleans up viewshed mode */
  function disableViewshed(): void {
    isViewShed = false;
    scene.globe.shadows = Cesium.ShadowMode.DISABLED;
    points = { start: null, end: null };

    // Remove all primitives
    if (primitives) {
      scene.primitives.remove(primitives);
      primitives = null;
      redPoint = null;
    }

    // Destroy sensor shadow
    if (sensorShadowInstance && !sensorShadowInstance.isDestroyed()) {
      sensorShadowInstance.destroy();
      sensorShadowInstance = null;
    }

    handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP);
    document.removeEventListener('click', handleMapClick, true);

    alert('Viewshed-läge avstängt.');
  }

  /** Handles clicks to place start/end points */
  function handleMapClick(event: MouseEvent): void {
    if (!isViewShed) return;

    const rect = scene.canvas.getBoundingClientRect();
    const clickPos = new Cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
    const worldPos = scene.pickPosition(clickPos);

    if (!worldPos) {
      alert('Kan inte starta viewshed här.');
      return;
    }

    const carto = Cesium.Cartographic.fromCartesian(worldPos);
    carto.height += getCameraHeight();
    const adjustedPos = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);

    if (!points.start) {
      points.start = adjustedPos;
    } else {
      points.end = adjustedPos;
      document.removeEventListener('click', handleMapClick, true);
      initViewshed();
    }
  }

  /** Creates points and sensor shadow after both positions are chosen */
  function initViewshed(): void {
    if (!points.start || !points.end) return;

    // Create red point for start
    primitives = new Cesium.PointPrimitiveCollection();
    redPoint = primitives.add({
      position: points.start,
      pixelSize: 10,
      color: Cesium.Color.BLUE,
    });
    scene.primitives.add(primitives);

    // Initialize sensor shadow instance
    sensorShadowInstance = new SensorShadow(scene, {
      cameraPosition: points.start,
      viewPosition: points.end,
    });

    initDragHandlers();
  }

  /** Enables drag interactions for adjusting the start point */
  function initDragHandlers(): void {
    const controller = scene.screenSpaceCameraController;

    // Start drag
    interface ClickEvent {
      position: Cesium.Cartesian2;
    }

    handler.setInputAction((click: ClickEvent) => {
      const pickedObject = scene.pick(click.position);
      if (pickedObject?.primitive === redPoint) {
      pickedEntity = redPoint;
      controller.enableInputs = false;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // Update drag movement
    interface DragMovement {
      endPosition: Cesium.Cartesian2;
    }

    handler.setInputAction((movement: DragMovement) => {
      if (!pickedEntity) return;
      const newCartesian: Cesium.Cartesian3 | undefined = scene.camera.pickEllipsoid(movement.endPosition, scene.globe.ellipsoid);
      if (!newCartesian) return;

      const newCarto: Cesium.Cartographic = Cesium.Cartographic.fromCartesian(newCartesian);
      const originalCarto: Cesium.Cartographic = Cesium.Cartographic.fromCartesian(pickedEntity.position);
      newCarto.height = originalCarto.height;

      const updatedPos: Cesium.Cartesian3 = Cesium.Cartographic.toCartesian(newCarto);
      pickedEntity.position = updatedPos;
      (sensorShadowInstance as SensorShadow).cameraPosition = new Cesium.ConstantPositionProperty(updatedPos);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // End drag
    handler.setInputAction(() => {
      pickedEntity = null;
      controller.enableInputs = true;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
  }
}