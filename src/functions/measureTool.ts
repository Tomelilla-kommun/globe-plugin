import { 
  Scene, ScreenSpaceEventHandler, ScreenSpaceEventType, Cartesian3, Cartesian2,
  Color, LabelCollection, Label, LabelStyle, VerticalOrigin,
  Primitive, GeometryInstance, PolylineGeometry, ColorGeometryInstanceAttribute, HorizontalOrigin
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

    interface ClickEvent {
      position: Cartesian2;
    }

    handler.setInputAction((click: ClickEvent) => {
      const cartesian2Pos: Cartesian2 = new Cartesian2(click.position.x, click.position.y);
      
      // const ray = scene.camera.getPickRay(cartesian2Pos);
      // if (!ray) return;

      const ray = scene.camera.getPickRay(cartesian2Pos);
      let cartesian = scene.pickPosition(cartesian2Pos); // try picking from 3D Tiles first
      if (!cartesian) {
          // fallback to terrain
          if (!ray) return;
          const picked = scene.globe.pick(ray, scene);
          if (!picked) return;
          cartesian = picked;
      }
      if (!cartesian) return;

      if (!start) {
      start = cartesian.clone();
      } else {
      end = cartesian.clone();

      interface PolylineGeometryInstanceAttributes {
        color: ColorGeometryInstanceAttribute;
      }

      const instance: GeometryInstance = new GeometryInstance({
        geometry: new PolylineGeometry({
        positions: [start, end],
        width: 2
        }),
        attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
        } as PolylineGeometryInstanceAttributes
      });

      activePrimitive = new Primitive({
        geometryInstances: [instance],
        appearance: new (require("cesium").PolylineColorAppearance)({})
      });

      scene.primitives.add(activePrimitive);

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
