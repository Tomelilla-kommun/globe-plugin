import { 
  Scene, ScreenSpaceEventHandler, ScreenSpaceEventType, Cartesian3, Cartesian2,
  Color, LabelCollection, Label, LabelStyle, VerticalOrigin,
  Primitive, GeometryInstance, PolylineGeometry, ColorGeometryInstanceAttribute, HorizontalOrigin,
  PolylineColorAppearance
} from "cesium";
import { setMeasuring } from './../globeState';

export default function measureTool(scene: Scene) {
  const handler = new ScreenSpaceEventHandler(scene.canvas);

  let start: Cartesian3 | null = null;
  let end: Cartesian3 | null = null;

  const labelCollection = new LabelCollection();
  scene.primitives.add(labelCollection);

  let activePrimitive: Primitive | null = null;
  let activeLabel: Label | null = null;

  function clear() {
    start = null;
    end = null;
    if (activePrimitive) {
      scene.primitives.remove(activePrimitive);
      activePrimitive = null;
    }
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }
  }

  function measureDistance() {
    setMeasuring(true);
    clear();

    let moving = false;

    interface ClickEvent {
      position: { x: number; y: number };
    }

    handler.setInputAction((click: ClickEvent) => {
      const cartesian2Pos = new Cartesian2(click.position.x, click.position.y);
      let cartesian: Cartesian3 | undefined = scene.pickPosition(cartesian2Pos);
      if (!cartesian) {
      const ray = scene.camera.getPickRay(cartesian2Pos);
      if (!ray) return;
      cartesian = scene.globe.pick(ray, scene);
      }
      if (!cartesian) return;

      if (!start) {
      start = cartesian.clone();
      moving = true;
      } else {
      end = cartesian.clone();
      moving = false;

      // Finalize polyline
      if (activePrimitive) scene.primitives.remove(activePrimitive);
      const instance: GeometryInstance = new GeometryInstance({
        geometry: new PolylineGeometry({
        positions: [start, end],
        width: 2
        }),
        attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
        }
      });
      activePrimitive = new Primitive({
        geometryInstances: [instance],
        appearance: new PolylineColorAppearance({})
      });
      scene.primitives.add(activePrimitive);

      // Add label
      const mid: Cartesian3 = Cartesian3.midpoint(start, end, new Cartesian3());
      const distance: number = Cartesian3.distance(start, end);
      activeLabel = labelCollection.add({
        position: mid,
        text: `${(distance / 1000).toFixed(2)} km`,
        font: "14px sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER
      });

      handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Mouse move handler for dynamic line
    interface MouseMoveEvent {
      endPosition: { x: number; y: number };
    }

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (!start || !moving) return;

      const cartesian2Pos = new Cartesian2(movement.endPosition.x, movement.endPosition.y);
      let cartesian: Cartesian3 | undefined = scene.pickPosition(cartesian2Pos);
      if (!cartesian) {
      const ray = scene.camera.getPickRay(cartesian2Pos);
      if (!ray) return;
      cartesian = scene.globe.pick(ray, scene);
      }
      if (!cartesian) return;

      // Update end point
      end = cartesian.clone();

      // Update primitive
      if (activePrimitive) scene.primitives.remove(activePrimitive);
      const instance: GeometryInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        positions: [start, end],
        width: 2
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
      }
      });
      activePrimitive = new Primitive({
      geometryInstances: [instance],
      appearance: new PolylineColorAppearance({})
      });
      scene.primitives.add(activePrimitive);

      // Update label
      if (activeLabel) labelCollection.remove(activeLabel);
      const mid: Cartesian3 = Cartesian3.midpoint(start, end, new Cartesian3());
      const distance: number = Cartesian3.distance(start, end);
      activeLabel = labelCollection.add({
      position: mid,
      text: `${(distance / 1000).toFixed(2)} km`,
      font: "14px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER
      });
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function destroy() {
    setMeasuring(false);
    clear();
    handler.destroy();
    if (activePrimitive) scene.primitives.remove(activePrimitive);
    scene.primitives.remove(labelCollection);
  }

  return { measureDistance, clear, destroy };
}
