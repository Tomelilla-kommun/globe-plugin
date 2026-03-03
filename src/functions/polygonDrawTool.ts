import { 
  Scene, ScreenSpaceEventHandler, ScreenSpaceEventType, Cartesian3, Cartesian2,
  Color, LabelCollection, Label, LabelStyle, VerticalOrigin, HorizontalOrigin,
  Primitive, GeometryInstance, PolylineGeometry, PolygonGeometry,
  ColorGeometryInstanceAttribute, PolylineColorAppearance,
  PerInstanceColorAppearance, Math as CesiumMath, Cartographic, ShadowMode
} from "cesium";

// Helper: compute area of polygon (in m^2) given array of Cartesian3 points (flattened to same Z)
function computePolygonArea(positions: Cartesian3[]): number {
  if (positions.length < 3) return 0;
  // Convert to Cartographic (lon, lat, height)
  const cartos = positions.map(p => Cartographic.fromCartesian(p));
  // Use planar approximation (small footprint, meters)
  // Project to local tangent plane (East-North-Up at centroid)
  const centroid = {
    lon: cartos.reduce((sum, c) => sum + c.longitude, 0) / cartos.length,
    lat: cartos.reduce((sum, c) => sum + c.latitude, 0) / cartos.length,
  };
  // Convert each point to meters offset from centroid
  const R = 6371000; // Earth radius in meters
  const xy = cartos.map(c => [
    (c.longitude - centroid.lon) * Math.cos(centroid.lat) * R,
    (c.latitude - centroid.lat) * R
  ]);
  // Shoelace formula
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export default function polygonDrawTool(scene: Scene) {
  const handler = new ScreenSpaceEventHandler(scene.canvas);
  const geojsonFeatures: any[] = [];

  let fillColor = Color.WHITE;
  let fillAlpha = 0.7;
  let featureIdCounter = 0;

  let points: Cartesian3[] = [];
  let isDrawing = false;
  let extrudeHeight = 10; // Default extrude height in meters
  let labelsVisible = true;

  const labelCollection = new LabelCollection();
  scene.primitives.add(labelCollection);

  const primitives: Primitive[] = [];
  const labels: Label[] = [];

  const outlineRefs: Array<{ primitive: Primitive; id: string }> = [];
  const fillRefs: Array<{ primitive: Primitive; id: string }> = [];

  let activePolylinePrimitive: Primitive | null = null;
  let activePolygonPrimitive: Primitive | null = null;
  let activeLabel: Label | null = null;
  let lastMousePos: Cartesian3 | null = null;

  const removeDrawingHandlers = () => {
    handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  };

  function stopDrawing() {
    if (!isDrawing) return;
    isDrawing = false;
    removeDrawingHandlers();
    points = [];

    // Remove active preview primitives/label (but keep finalized polygons)
    if (activePolylinePrimitive) {
      scene.primitives.remove(activePolylinePrimitive);
      activePolylinePrimitive = null;
    }
    if (activePolygonPrimitive) {
      scene.primitives.remove(activePolygonPrimitive);
      activePolygonPrimitive = null;
    }
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }

    scene.requestRender();
  }

  function clear() {
    stopDrawing();
    // Remove active preview primitives
    if (activePolylinePrimitive) {
      scene.primitives.remove(activePolylinePrimitive);
      activePolylinePrimitive = null;
    }
    if (activePolygonPrimitive) {
      scene.primitives.remove(activePolygonPrimitive);
      activePolygonPrimitive = null;
    }
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }

    // Remove all completed primitives
    primitives.forEach(p => scene.primitives.remove(p));
    primitives.length = 0;

    outlineRefs.length = 0;
    fillRefs.length = 0;

    // Remove all labels
    labels.forEach(l => labelCollection.remove(l));
    labels.length = 0;

    // Reset state
    points = [];
    isDrawing = false;

    scene.requestRender();
  }

  const clampAlpha = (a: number) => Math.min(1, Math.max(0, a));

  const updateExistingPrimitiveColors = () => {
    const outline = fillColor.withAlpha(1);
    const fill = fillColor.withAlpha(fillAlpha);

    outlineRefs.forEach(({ primitive, id }) => {
      try {
        const attrs: any = (primitive as any).getGeometryInstanceAttributes?.(id);
        if (attrs?.color) {
          attrs.color = ColorGeometryInstanceAttribute.toValue(outline);
        }
      } catch {
        // ignore
      }
    });

    fillRefs.forEach(({ primitive, id }) => {
      try {
        const attrs: any = (primitive as any).getGeometryInstanceAttributes?.(id);
        if (attrs?.color) {
          attrs.color = ColorGeometryInstanceAttribute.toValue(fill);
        }
        // Ensure appearance translucency matches current alpha
        (primitive as any).appearance = new PerInstanceColorAppearance({
          translucent: fillAlpha < 1,
          closed: true
        });
      } catch {
        // ignore
      }
    });

    geojsonFeatures.forEach((f) => {
      if (!f?.properties) f.properties = {};
      f.properties.color = fillColor.toCssColorString();
      f.properties.fillAlpha = fillAlpha;
    });

    scene.requestRender();
  };

  function setOpaque(opaque: boolean) {
    fillAlpha = opaque ? 1 : 0.7;
    fillAlpha = clampAlpha(fillAlpha);
    updateExistingPrimitiveColors();
  }

  function getOpaque() {
    return fillAlpha >= 0.999;
  }

  function setColorByName(name: string) {
    switch ((name ?? '').toLowerCase()) {
      case 'white': fillColor = Color.WHITE; break;
      case 'red': fillColor = Color.RED; break;
      case 'green': fillColor = Color.LIME; break;
      case 'blue': fillColor = Color.DODGERBLUE; break;
      case 'yellow': fillColor = Color.YELLOW; break;
      case 'cyan': fillColor = Color.CYAN; break;
      default: fillColor = Color.WHITE; break;
    }
    updateExistingPrimitiveColors();
  }

  function setHeight(height: number) {
    extrudeHeight = height;
  }

  function getLowestZValue(positions: Cartesian3[]): number {
    let minHeight = Number.POSITIVE_INFINITY;
    
    positions.forEach(position => {
      const cartographic = Cartographic.fromCartesian(position);
      if (cartographic.height < minHeight) {
        minHeight = cartographic.height;
      }
    });

    return minHeight;
  }

  function flattenPolygonToLowestZ(positions: Cartesian3[]): Cartesian3[] {
    const lowestZ = getLowestZValue(positions);
    
    return positions.map(position => {
      const cartographic = Cartographic.fromCartesian(position);
      return Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        lowestZ
      );
    });
  }

  function updatePreview(currentMousePos: Cartesian3) {
    lastMousePos = currentMousePos;
    if (points.length === 0) return;

    const previewPoints = [...points, currentMousePos];

    // Remove old preview polyline
    if (activePolylinePrimitive) {
      scene.primitives.remove(activePolylinePrimitive);
    }

    // Create preview polyline (outline)
    const polylinePositions = [...previewPoints, previewPoints[0]]; // Close the loop
    const polylineInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        positions: polylinePositions,
        width: 3,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(1))
      }
    });
    activePolylinePrimitive = new Primitive({
      geometryInstances: [polylineInstance],
      appearance: new PolylineColorAppearance({})
    });
    scene.primitives.add(activePolylinePrimitive);

    // Remove old preview polygon
    if (activePolygonPrimitive) {
      scene.primitives.remove(activePolygonPrimitive);
    }

    // Create preview polygon with flat bottom if we have at least 3 points
    let areaText = "";
    if (previewPoints.length >= 3) {
      const flattenedPoints = flattenPolygonToLowestZ(previewPoints);
      const lowestZ = getLowestZValue(previewPoints);

      const polygonInstance = new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: {
            positions: flattenedPoints,
            holes: []
          },
          extrudedHeight: lowestZ + extrudeHeight,
          perPositionHeight: false, // Use flat bottom
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(fillAlpha))
        }
      });

      activePolygonPrimitive = new Primitive({
        geometryInstances: [polygonInstance],
        appearance: new PerInstanceColorAppearance({
          translucent: fillAlpha < 1,
          closed: true
        }),
        shadows: ShadowMode.ENABLED,
      });
      scene.primitives.add(activePolygonPrimitive);

      // Compute area for preview
      const area = computePolygonArea(flattenedPoints);
      areaText = ` | Area: ${area.toFixed(1)} m²`;
    }

    // Update label with area/info
    if (activeLabel) {
      labelCollection.remove(activeLabel);
    }

    if (previewPoints.length >= 2) {
      const lastPoint = previewPoints[previewPoints.length - 1];
      activeLabel = labelCollection.add({
        position: lastPoint,
        text: `${previewPoints.length} points | Height: ${extrudeHeight}m${areaText}`,
        font: "22px sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cartesian2(10, 0),
        show: labelsVisible,
      });
    }

    scene.requestRender();
  }

  function finalizePolygon() {
    if (points.length < 3) {
      console.warn("Need at least 3 points to create a polygon");
      return;
    }

    // Flatten to lowest Z value
    const flattenedPoints = flattenPolygonToLowestZ(points);
    const lowestZ = getLowestZValue(points);

    const featureId = `poly-${featureIdCounter++}`;
    const outlineInstanceId = `${featureId}-outline`;
    const fillInstanceId = `${featureId}-fill`;

    // Create final polygon outline
    const outlinePositions = [...flattenedPoints, flattenedPoints[0]];
    const outlineInstance = new GeometryInstance({
      id: outlineInstanceId,
      geometry: new PolylineGeometry({
        positions: outlinePositions,
        width: 2,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(1))
      }
    });
    const outlinePrimitive = new Primitive({
      geometryInstances: [outlineInstance],
      appearance: new PolylineColorAppearance({})
    });
    scene.primitives.add(outlinePrimitive);
    primitives.push(outlinePrimitive);
    outlineRefs.push({ primitive: outlinePrimitive, id: outlineInstanceId });

    // Compute area for finalized polygon
    const area = computePolygonArea(flattenedPoints);

    // Create extruded polygon primitive
    const polygonInstance = new GeometryInstance({
      id: fillInstanceId,
      geometry: new PolygonGeometry({
        polygonHierarchy: {
          positions: flattenedPoints,
          holes: []
        },
        extrudedHeight: lowestZ + extrudeHeight,
        perPositionHeight: false,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(fillAlpha))
      }
    });
    const polygonPrimitive = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: fillAlpha < 1,
        closed: true
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(polygonPrimitive);
    primitives.push(polygonPrimitive);
    fillRefs.push({ primitive: polygonPrimitive, id: fillInstanceId });

    // Add label with info
    const center = Cartesian3.fromRadians(
      flattenedPoints.reduce((sum, p) => sum + Cartographic.fromCartesian(p).longitude, 0) / flattenedPoints.length,
      flattenedPoints.reduce((sum, p) => sum + Cartographic.fromCartesian(p).latitude, 0) / flattenedPoints.length,
      lowestZ + extrudeHeight / 2
    );
    const label = labelCollection.add({
      position: center,
      text: `Base: ${lowestZ.toFixed(2)}m\nHeight: ${extrudeHeight}m\nTop: ${(lowestZ + extrudeHeight).toFixed(2)}m\nArea: ${area.toFixed(1)} m²`,
      font: "22px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: labelsVisible,
    });
    labels.push(label);

    // Store GeoJSON feature
    const cartos: Cartographic[] = flattenedPoints.map((p: Cartesian3) => Cartographic.fromCartesian(p));
    // Export as 3D GeoJSON by including height as the 3rd coordinate (base height)
    const coords: [number, number, number][] = cartos.map((c: Cartographic) => [
      CesiumMath.toDegrees(c.longitude),
      CesiumMath.toDegrees(c.latitude),
      lowestZ,
    ]);
    geojsonFeatures.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coords.concat([coords[0]])], // close ring
      },
      properties: {
        extrudeHeight: extrudeHeight,
        baseHeight: lowestZ,
        area: area,
        color: fillColor.toCssColorString(),
        fillAlpha: fillAlpha,
      }
    });

    scene.requestRender();

    // Reset for next polygon
    points = [];
    isDrawing = false;
    
    // Clear preview
    if (activePolylinePrimitive) {
      scene.primitives.remove(activePolylinePrimitive);
      activePolylinePrimitive = null;
    }
    if (activePolygonPrimitive) {
      scene.primitives.remove(activePolygonPrimitive);
      activePolygonPrimitive = null;
    }
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }
  }

  function startDrawing() {
    isDrawing = true;

    interface ClickEvent {
      position: { x: number; y: number };
    }

    // Left click to add point
    handler.setInputAction((click: ClickEvent) => {
      const cartesian2Pos = new Cartesian2(click.position.x, click.position.y);
      let cartesian: Cartesian3 | undefined = scene.pickPosition(cartesian2Pos);
      
      if (!cartesian) {
        const ray = scene.camera.getPickRay(cartesian2Pos);
        if (!ray) return;
        cartesian = scene.globe.pick(ray, scene);
      }
      if (!cartesian) return;

      points.push(cartesian.clone());
      
      if (points.length > 0) {
        updatePreview(cartesian);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Right click to finish polygon
    handler.setInputAction(() => {
      if (points.length >= 3) {
        finalizePolygon();
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);

    // Mouse move for preview
    interface MouseMoveEvent {
      endPosition: { x: number; y: number };
    }

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (points.length === 0) return;

      const cartesian2Pos = new Cartesian2(movement.endPosition.x, movement.endPosition.y);
      let cartesian: Cartesian3 | undefined = scene.pickPosition(cartesian2Pos);
      
      if (!cartesian) {
        const ray = scene.camera.getPickRay(cartesian2Pos);
        if (!ray) return;
        cartesian = scene.globe.pick(ray, scene);
      }
      if (!cartesian) return;

      updatePreview(cartesian);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    // Expose a method to update preview with last mouse position
    // Useful for height changes
    tool.updatePreviewWithLast = () => {
      if (lastMousePos) updatePreview(lastMousePos);
    };
  }

  function destroy() {
    clear();
    removeDrawingHandlers();
    handler.destroy();
    scene.primitives.remove(labelCollection);
    scene.requestRender();
  }

  function setLabelsVisible(show: boolean) {
    labelsVisible = show;
    labels.forEach(l => { l.show = show; });
    if (activeLabel) {
      activeLabel.show = show;
    }
    scene.requestRender();
  }

  const tool = { startDrawing, stopDrawing, clear, destroy, setHeight, setLabelsVisible, setOpaque, getOpaque, setColorByName } as any;
  tool.getLabelsVisible = () => labelsVisible;
  tool.getGeoJSON = () => {
    return {
      type: "FeatureCollection",
      features: geojsonFeatures.slice(),
    };
  };
  return tool;
}