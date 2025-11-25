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

  // Store multiple measurements
  const primitives: Primitive[] = [];
  const labels: Label[] = [];

  let moving = false;

  function clear() {
    // Remove dynamic preview line
    if (activePrimitive) {
      scene.primitives.remove(activePrimitive);
      activePrimitive = null;
    }

    // Remove dynamic preview label
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }

    // Remove all completed measurement lines
    primitives.forEach(p => scene.primitives.remove(p));
    primitives.length = 0;

    // Remove all completed measurement labels
    labels.forEach(l => labelCollection.remove(l));
    labels.length = 0;

    // Reset state
    start = null;
    end = null;
    moving = false;

    // Render once after all removals
    scene.requestRender();
  }


  function measureDistance() {
    setMeasuring(true);
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

        // Create final polyline
        const instance = new GeometryInstance({
          geometry: new PolylineGeometry({
            positions: [start, end],
            width: 2,
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
          }
        });
        const primitive = new Primitive({
          geometryInstances: [instance],
          appearance: new PolylineColorAppearance({})
        });
        scene.primitives.add(primitive);
        primitives.push(primitive);
        scene.requestRender();
        

        // Add label
        const mid = Cartesian3.midpoint(start, end, new Cartesian3());
        const distance = Cartesian3.distance(start, end);
        const label = labelCollection.add({
          position: mid,
          text: `${(distance).toFixed(2)} m`,
          font: "16px sans-serif",
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        labels.push(label);
        scene.requestRender();

        // Reset start/end for next measurement
        start = null;
        end = null;
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

      end = cartesian.clone();

      // Update dynamic primitive (remove previous temporary)
      if (activePrimitive) scene.primitives.remove(activePrimitive);
      const instance = new GeometryInstance({
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
      scene.requestRender();

      // Update label
      if (activeLabel) labelCollection.remove(activeLabel);
      const mid = Cartesian3.midpoint(start, end, new Cartesian3());
      const distance = Cartesian3.distance(start, end);
      activeLabel = labelCollection.add({
        position: mid,
        text: `${(distance).toFixed(2)} m`,
        font: "16px sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  let activePrimitive: Primitive | null = null;
  let activeLabel: Label | null = null;

  function destroy() {
    setMeasuring(false);
    clear();
    handler.destroy();
    scene.primitives.remove(labelCollection);
    scene.requestRender();
  }

  return { measureDistance, clear, destroy };
}
