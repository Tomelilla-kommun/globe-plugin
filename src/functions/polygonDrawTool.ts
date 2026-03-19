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

// Helper: compute distance between two Cartesian3 points in meters
function computeDistance(p1: Cartesian3, p2: Cartesian3): number {
  return Cartesian3.distance(p1, p2);
}

// Helper: compute 4 corners of rectangle from 2 opposite corners
// Returns corners in order: [corner1, corner2, corner3, corner4] forming a closed rectangle
function computeRectangleCorners(corner1: Cartesian3, corner3: Cartesian3): Cartesian3[] {
  const c1 = Cartographic.fromCartesian(corner1);
  const c3 = Cartographic.fromCartesian(corner3);
  
  // Get the lowest height for the base
  const baseHeight = Math.min(c1.height, c3.height);
  
  // Corner 2: same lat as corner1, same lon as corner3
  const c2 = new Cartographic(c3.longitude, c1.latitude, baseHeight);
  
  // Corner 4: same lon as corner1, same lat as corner3
  const c4 = new Cartographic(c1.longitude, c3.latitude, baseHeight);
  
  // Create Cartesian positions
  return [
    Cartesian3.fromRadians(c1.longitude, c1.latitude, baseHeight),
    Cartesian3.fromRadians(c2.longitude, c2.latitude, baseHeight),
    Cartesian3.fromRadians(c3.longitude, c3.latitude, baseHeight),
    Cartesian3.fromRadians(c4.longitude, c4.latitude, baseHeight),
  ];
}

// Data structure for a single completed polygon
export interface PolygonData {
  id: string;
  name: string;
  outlinePrimitive: Primitive;
  fillPrimitive: Primitive;
  outlineInstanceId: string;
  fillInstanceId: string;
  label: Label;
  positions: Cartesian3[];
  baseHeight: number;
  extrudeHeight: number;
  area: number;
  color: Color;
  fillAlpha: number;
  geojsonFeature: any;
}

export type PolygonSelectionCallback = (polygon: PolygonData | null) => void;

export default function polygonDrawTool(scene: Scene) {
  const handler = new ScreenSpaceEventHandler(scene.canvas);
  const selectionHandler = new ScreenSpaceEventHandler(scene.canvas);
  
  // Store all completed polygons
  const polygons: PolygonData[] = [];
  let selectedPolygonId: string | null = null;
  let selectionCallback: PolygonSelectionCallback | null = null;
  let selectionEnabled = false;

  let fillColor = Color.WHITE;
  let fillAlpha = 0.7;
  let featureIdCounter = 0;

  let points: Cartesian3[] = [];
  let isDrawing = false;
  let extrudeHeight = 10; // Default extrude height in meters
  let labelsVisible = true;

  // Rectangle drawing state
  let isDrawingRectangle = false;
  let rectangleCorner1: Cartesian3 | null = null;
  let rectangleSideLabels: Label[] = [];

  const labelCollection = new LabelCollection();
  scene.primitives.add(labelCollection);

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

    // Remove all completed polygons
    polygons.forEach(p => {
      scene.primitives.remove(p.outlinePrimitive);
      scene.primitives.remove(p.fillPrimitive);
      labelCollection.remove(p.label);
    });
    polygons.length = 0;

    // Reset selection
    selectedPolygonId = null;
    selectionCallback?.(null);

    // Reset state
    points = [];
    isDrawing = false;

    scene.requestRender();
  }

  const clampAlpha = (a: number) => Math.min(1, Math.max(0, a));

  const updateExistingPrimitiveColors = () => {
    const outline = fillColor.withAlpha(1);
    const fill = fillColor.withAlpha(fillAlpha);

    polygons.forEach((polygon) => {
      try {
        const outlineAttrs: any = (polygon.outlinePrimitive as any).getGeometryInstanceAttributes?.(polygon.outlineInstanceId);
        if (outlineAttrs?.color) {
          outlineAttrs.color = ColorGeometryInstanceAttribute.toValue(outline);
        }
      } catch {
        // ignore
      }

      try {
        const fillAttrs: any = (polygon.fillPrimitive as any).getGeometryInstanceAttributes?.(polygon.fillInstanceId);
        if (fillAttrs?.color) {
          fillAttrs.color = ColorGeometryInstanceAttribute.toValue(fill);
        }
        // Ensure appearance translucency matches current alpha
        (polygon.fillPrimitive as any).appearance = new PerInstanceColorAppearance({
          translucent: fillAlpha < 1,
          closed: true,
          flat: true,
          faceForward: false
        });
      } catch {
        // ignore
      }

      // Update stored values
      polygon.color = fillColor.clone();
      polygon.fillAlpha = fillAlpha;
      if (polygon.geojsonFeature?.properties) {
        polygon.geojsonFeature.properties.color = fillColor.toCssColorString();
        polygon.geojsonFeature.properties.fillAlpha = fillAlpha;
      }
    });

    scene.requestRender();
  };

  function setOpaque(opaque: boolean) {
    fillAlpha = opaque ? 1 : 0.7;
    fillAlpha = clampAlpha(fillAlpha);
    // Only affects new polygons, not existing ones
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
    // Only affects new polygons, not existing ones
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
          closed: true,
          flat: true,
          faceForward: false
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
        font: "20px sans-serif",
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
    const fillPrimitive = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: fillAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(fillPrimitive);

    // Add label with info
    const center = Cartesian3.fromRadians(
      flattenedPoints.reduce((sum, p) => sum + Cartographic.fromCartesian(p).longitude, 0) / flattenedPoints.length,
      flattenedPoints.reduce((sum, p) => sum + Cartographic.fromCartesian(p).latitude, 0) / flattenedPoints.length,
      lowestZ + extrudeHeight / 2
    );
    const defaultName = `Polygon ${featureIdCounter}`;
    const label = labelCollection.add({
      position: center,
      text: `${defaultName}\nBase: ${lowestZ.toFixed(2)}m\nHeight: ${extrudeHeight}m\nTop: ${(lowestZ + extrudeHeight).toFixed(2)}m\nArea: ${area.toFixed(1)} m²`,
      font: "20px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: labelsVisible,
    });

    // Store GeoJSON feature
    const cartos: Cartographic[] = flattenedPoints.map((p: Cartesian3) => Cartographic.fromCartesian(p));
    // Export as 3D GeoJSON by including height as the 3rd coordinate (base height)
    const coords: [number, number, number][] = cartos.map((c: Cartographic) => [
      CesiumMath.toDegrees(c.longitude),
      CesiumMath.toDegrees(c.latitude),
      lowestZ,
    ]);
    const geojsonFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coords.concat([coords[0]])], // close ring
      },
      properties: {
        id: featureId,
        name: defaultName,
        extrudeHeight: extrudeHeight,
        baseHeight: lowestZ,
        area: area,
        color: fillColor.toCssColorString(),
        fillAlpha: fillAlpha,
      }
    };

    // Store all polygon data together
    const polygonData: PolygonData = {
      id: featureId,
      name: defaultName,
      outlinePrimitive,
      fillPrimitive,
      outlineInstanceId,
      fillInstanceId,
      label,
      positions: flattenedPoints.slice(),
      baseHeight: lowestZ,
      extrudeHeight,
      area,
      color: fillColor.clone(),
      fillAlpha,
      geojsonFeature,
    };
    polygons.push(polygonData);

    scene.requestRender();

    // Reset for next polygon (keep isDrawing true so user can draw more polygons)
    points = [];
    
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

  // Rectangle drawing functions
  function clearRectangleSideLabels() {
    rectangleSideLabels.forEach(label => labelCollection.remove(label));
    rectangleSideLabels = [];
  }

  function updateRectanglePreview(currentMousePos: Cartesian3) {
    if (!rectangleCorner1) return;
    lastMousePos = currentMousePos;

    // Compute rectangle corners from corner1 and current mouse position
    const corners = computeRectangleCorners(rectangleCorner1, currentMousePos);

    // Remove old preview polyline
    if (activePolylinePrimitive) {
      scene.primitives.remove(activePolylinePrimitive);
    }

    // Create preview polyline (outline) - close the loop
    const polylinePositions = [...corners, corners[0]];
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

    // Get base height for extrusion
    const lowestZ = getLowestZValue(corners);

    // Create preview polygon (extruded rectangle)
    const polygonInstance = new GeometryInstance({
      geometry: new PolygonGeometry({
        polygonHierarchy: {
          positions: corners,
          holes: []
        },
        extrudedHeight: lowestZ + extrudeHeight,
        perPositionHeight: false,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(fillAlpha))
      }
    });

    activePolygonPrimitive = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: fillAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(activePolygonPrimitive);

    // Clear old side labels
    clearRectangleSideLabels();

    // Compute and display side lengths
    const side1Length = computeDistance(corners[0], corners[1]); // Bottom
    const side2Length = computeDistance(corners[1], corners[2]); // Right
    const side3Length = computeDistance(corners[2], corners[3]); // Top
    const side4Length = computeDistance(corners[3], corners[0]); // Left

    // Create labels at midpoint of each side
    const createSideLabel = (p1: Cartesian3, p2: Cartesian3, length: number): Label => {
      const midpoint = Cartesian3.midpoint(p1, p2, new Cartesian3());
      // Raise the label a bit above the surface for visibility
      const midCarto = Cartographic.fromCartesian(midpoint);
      const labelPos = Cartesian3.fromRadians(midCarto.longitude, midCarto.latitude, midCarto.height + 2);
      
      return labelCollection.add({
        position: labelPos,
        text: `${length.toFixed(1)} m`,
        font: "bold 16px sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: true,
      });
    };

    rectangleSideLabels.push(createSideLabel(corners[0], corners[1], side1Length));
    rectangleSideLabels.push(createSideLabel(corners[1], corners[2], side2Length));
    rectangleSideLabels.push(createSideLabel(corners[2], corners[3], side3Length));
    rectangleSideLabels.push(createSideLabel(corners[3], corners[0], side4Length));

    // Compute area
    const area = computePolygonArea(corners);

    // Update info label
    if (activeLabel) {
      labelCollection.remove(activeLabel);
    }

    activeLabel = labelCollection.add({
      position: currentMousePos,
      text: `Height: ${extrudeHeight}m | Area: ${area.toFixed(1)} m²`,
      font: "20px sans-serif",
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

    scene.requestRender();
  }

  function finalizeRectangle(corner3: Cartesian3) {
    if (!rectangleCorner1) return;

    const corners = computeRectangleCorners(rectangleCorner1, corner3);
    const lowestZ = getLowestZValue(corners);

    const featureId = `poly-${featureIdCounter++}`;
    const outlineInstanceId = `${featureId}-outline`;
    const fillInstanceId = `${featureId}-fill`;

    // Create final rectangle outline
    const outlinePositions = [...corners, corners[0]];
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

    // Compute measurements
    const side1Length = computeDistance(corners[0], corners[1]);
    const side2Length = computeDistance(corners[1], corners[2]);
    const area = computePolygonArea(corners);

    // Create extruded polygon primitive
    const polygonInstance = new GeometryInstance({
      id: fillInstanceId,
      geometry: new PolygonGeometry({
        polygonHierarchy: {
          positions: corners,
          holes: []
        },
        extrudedHeight: lowestZ + extrudeHeight,
        perPositionHeight: false,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(fillColor.withAlpha(fillAlpha))
      }
    });
    const fillPrimitive = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: fillAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(fillPrimitive);

    // Add label with info
    const center = Cartesian3.fromRadians(
      corners.reduce((sum, p) => sum + Cartographic.fromCartesian(p).longitude, 0) / corners.length,
      corners.reduce((sum, p) => sum + Cartographic.fromCartesian(p).latitude, 0) / corners.length,
      lowestZ + extrudeHeight / 2
    );
    const defaultName = `Rectangle ${featureIdCounter}`;
    const label = labelCollection.add({
      position: center,
      text: `${defaultName}\n${side1Length.toFixed(1)}m × ${side2Length.toFixed(1)}m\nHeight: ${extrudeHeight}m\nArea: ${area.toFixed(1)} m²`,
      font: "20px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: labelsVisible,
    });

    // Store GeoJSON feature
    const cartos: Cartographic[] = corners.map((p: Cartesian3) => Cartographic.fromCartesian(p));
    const coords: [number, number, number][] = cartos.map((c: Cartographic) => [
      CesiumMath.toDegrees(c.longitude),
      CesiumMath.toDegrees(c.latitude),
      lowestZ,
    ]);
    const geojsonFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coords.concat([coords[0]])],
      },
      properties: {
        id: featureId,
        name: defaultName,
        extrudeHeight: extrudeHeight,
        baseHeight: lowestZ,
        area: area,
        sideLength1: side1Length,
        sideLength2: side2Length,
        color: fillColor.toCssColorString(),
        fillAlpha: fillAlpha,
      }
    };

    // Store all polygon data
    const polygonData: PolygonData = {
      id: featureId,
      name: defaultName,
      outlinePrimitive,
      fillPrimitive,
      outlineInstanceId,
      fillInstanceId,
      label,
      positions: corners.slice(),
      baseHeight: lowestZ,
      extrudeHeight,
      area,
      color: fillColor.clone(),
      fillAlpha,
      geojsonFeature,
    };
    polygons.push(polygonData);

    scene.requestRender();

    // Reset for next rectangle
    rectangleCorner1 = null;
    clearRectangleSideLabels();
    
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

  function startDrawingRectangle() {
    isDrawingRectangle = true;
    rectangleCorner1 = null;

    interface ClickEvent {
      position: { x: number; y: number };
    }

    // Left click - first click sets corner 1, second click sets corner 3 (opposite)
    handler.setInputAction((click: ClickEvent) => {
      const cartesian2Pos = new Cartesian2(click.position.x, click.position.y);
      
      const ray = scene.camera.getPickRay(cartesian2Pos);
      let cartesian: Cartesian3 | undefined;
      
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }
      
      if (!cartesian) {
        cartesian = scene.pickPosition(cartesian2Pos);
      }
      if (!cartesian) return;

      if (!rectangleCorner1) {
        // First click - set corner 1
        rectangleCorner1 = cartesian.clone();
        
        // Show a marker at corner 1
        if (activeLabel) {
          labelCollection.remove(activeLabel);
        }
        activeLabel = labelCollection.add({
          position: cartesian,
          text: "Corner 1 - click opposite corner",
          font: "18px sans-serif",
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelOffset: new Cartesian2(10, 0),
          show: true,
        });
        scene.requestRender();
      } else {
        // Second click - finalize rectangle
        finalizeRectangle(cartesian);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Right click to cancel
    handler.setInputAction(() => {
      rectangleCorner1 = null;
      clearRectangleSideLabels();
      
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
    }, ScreenSpaceEventType.RIGHT_CLICK);

    // Mouse move for preview
    interface MouseMoveEvent {
      endPosition: { x: number; y: number };
    }

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (!rectangleCorner1) return;

      const cartesian2Pos = new Cartesian2(movement.endPosition.x, movement.endPosition.y);
      
      const ray = scene.camera.getPickRay(cartesian2Pos);
      let cartesian: Cartesian3 | undefined;
      
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }
      
      if (!cartesian) {
        cartesian = scene.pickPosition(cartesian2Pos);
      }
      if (!cartesian) return;

      updateRectanglePreview(cartesian);
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function stopDrawingRectangle() {
    if (!isDrawingRectangle) return;
    isDrawingRectangle = false;
    removeDrawingHandlers();
    rectangleCorner1 = null;
    clearRectangleSideLabels();

    // Remove active preview primitives/labels
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

  function startDrawing() {
    isDrawing = true;

    interface ClickEvent {
      position: { x: number; y: number };
    }

    // Left click to add point
    handler.setInputAction((click: ClickEvent) => {
      const cartesian2Pos = new Cartesian2(click.position.x, click.position.y);
      
      // Always pick on terrain first to avoid picking on drawn geometry
      const ray = scene.camera.getPickRay(cartesian2Pos);
      let cartesian: Cartesian3 | undefined;
      
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }
      
      // Fall back to pickPosition only if terrain pick fails (e.g., for 3D tiles)
      if (!cartesian) {
        cartesian = scene.pickPosition(cartesian2Pos);
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
      
      // Always pick on terrain first to avoid picking on drawn geometry
      const ray = scene.camera.getPickRay(cartesian2Pos);
      let cartesian: Cartesian3 | undefined;
      
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }
      
      // Fall back to pickPosition only if terrain pick fails (e.g., for 3D tiles)
      if (!cartesian) {
        cartesian = scene.pickPosition(cartesian2Pos);
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
    disableSelection();
    removeDrawingHandlers();
    handler.destroy();
    selectionHandler.destroy();
    scene.primitives.remove(labelCollection);
    scene.requestRender();
  }

  function setLabelsVisible(show: boolean) {
    labelsVisible = show;
    polygons.forEach(p => { p.label.show = show; });
    if (activeLabel) {
      activeLabel.show = show;
    }
    scene.requestRender();
  }

  // Selection and editing methods
  function enableSelection(callback?: PolygonSelectionCallback) {
    if (selectionEnabled) return;
    selectionEnabled = true;
    selectionCallback = callback || null;

    interface ClickEvent {
      position: { x: number; y: number };
    }

    selectionHandler.setInputAction((click: ClickEvent) => {
      // Don't select while drawing
      if (isDrawing && points.length > 0) return;

      const pickedObject = scene.pick(new Cartesian2(click.position.x, click.position.y));
      
      if (pickedObject) {
        // Check by instance ID (string)
        if (pickedObject.id && typeof pickedObject.id === 'string') {
          const polygon = polygons.find(p => 
            p.fillInstanceId === pickedObject.id || 
            p.outlineInstanceId === pickedObject.id
          );
          if (polygon) {
            selectPolygon(polygon.id);
            return;
          }
        }

        // Check by primitive reference (for cases where id is not set or different)
        if (pickedObject.primitive) {
          const polygon = polygons.find(p => 
            p.fillPrimitive === pickedObject.primitive || 
            p.outlinePrimitive === pickedObject.primitive
          );
          if (polygon) {
            selectPolygon(polygon.id);
            return;
          }
        }
      }

      // Clicked elsewhere - deselect
      deselectPolygon();
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  function disableSelection() {
    if (!selectionEnabled) return;
    selectionEnabled = false;
    selectionHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    deselectPolygon();
  }

  function selectPolygon(polygonId: string) {
    const polygon = polygons.find(p => p.id === polygonId);
    if (!polygon) return;

    selectedPolygonId = polygonId;
    
    // Visual feedback - make outline thicker/brighter (we'll change outline width by replacing)
    try {
      const outlineAttrs: any = (polygon.outlinePrimitive as any).getGeometryInstanceAttributes?.(polygon.outlineInstanceId);
      if (outlineAttrs?.color) {
        outlineAttrs.color = ColorGeometryInstanceAttribute.toValue(Color.YELLOW.withAlpha(1));
      }
    } catch {
      // ignore
    }

    scene.requestRender();
    selectionCallback?.(polygon);
  }

  function deselectPolygon() {
    if (!selectedPolygonId) return;

    const polygon = polygons.find(p => p.id === selectedPolygonId);
    if (polygon) {
      // Restore original outline color
      try {
        const outlineAttrs: any = (polygon.outlinePrimitive as any).getGeometryInstanceAttributes?.(polygon.outlineInstanceId);
        if (outlineAttrs?.color) {
          outlineAttrs.color = ColorGeometryInstanceAttribute.toValue(polygon.color.withAlpha(1));
        }
      } catch {
        // ignore
      }
    }

    selectedPolygonId = null;
    scene.requestRender();
    selectionCallback?.(null);
  }

  function getSelectedPolygon(): PolygonData | null {
    if (!selectedPolygonId) return null;
    return polygons.find(p => p.id === selectedPolygonId) || null;
  }

  function updatePolygonLabel(polygon: PolygonData) {
    polygon.label.text = `${polygon.name}\nBase: ${polygon.baseHeight.toFixed(2)}m\nHeight: ${polygon.extrudeHeight}m\nTop: ${(polygon.baseHeight + polygon.extrudeHeight).toFixed(2)}m\nArea: ${polygon.area.toFixed(1)} m²`;
  }

  function setPolygonName(polygonId: string, name: string) {
    const polygon = polygons.find(p => p.id === polygonId);
    if (!polygon) return;

    polygon.name = name;
    if (polygon.geojsonFeature?.properties) {
      polygon.geojsonFeature.properties.name = name;
    }
    updatePolygonLabel(polygon);
    scene.requestRender();
  }

  function setPolygonColor(polygonId: string, colorName: string) {
    const polygon = polygons.find(p => p.id === polygonId);
    if (!polygon) return;

    let newColor: Color;
    switch ((colorName ?? '').toLowerCase()) {
      case 'white': newColor = Color.WHITE; break;
      case 'red': newColor = Color.RED; break;
      case 'green': newColor = Color.LIME; break;
      case 'blue': newColor = Color.DODGERBLUE; break;
      case 'yellow': newColor = Color.YELLOW; break;
      case 'cyan': newColor = Color.CYAN; break;
      default: newColor = Color.WHITE; break;
    }

    polygon.color = newColor.clone();
    if (polygon.geojsonFeature?.properties) {
      polygon.geojsonFeature.properties.color = newColor.toCssColorString();
    }

    // Update outline (unless selected, then keep yellow)
    if (selectedPolygonId !== polygonId) {
      try {
        const outlineAttrs: any = (polygon.outlinePrimitive as any).getGeometryInstanceAttributes?.(polygon.outlineInstanceId);
        if (outlineAttrs?.color) {
          outlineAttrs.color = ColorGeometryInstanceAttribute.toValue(newColor.withAlpha(1));
        }
      } catch {
        // ignore
      }
    }

    // Update fill
    try {
      const fillAttrs: any = (polygon.fillPrimitive as any).getGeometryInstanceAttributes?.(polygon.fillInstanceId);
      if (fillAttrs?.color) {
        fillAttrs.color = ColorGeometryInstanceAttribute.toValue(newColor.withAlpha(polygon.fillAlpha));
      }
    } catch {
      // ignore
    }

    scene.requestRender();
  }

  function setPolygonOpacity(polygonId: string, opaque: boolean) {
    const polygon = polygons.find(p => p.id === polygonId);
    if (!polygon) return;

    const newAlpha = opaque ? 1 : 0.7;
    polygon.fillAlpha = newAlpha;
    if (polygon.geojsonFeature?.properties) {
      polygon.geojsonFeature.properties.fillAlpha = newAlpha;
    }

    // Update fill
    try {
      const fillAttrs: any = (polygon.fillPrimitive as any).getGeometryInstanceAttributes?.(polygon.fillInstanceId);
      if (fillAttrs?.color) {
        fillAttrs.color = ColorGeometryInstanceAttribute.toValue(polygon.color.withAlpha(newAlpha));
      }
      (polygon.fillPrimitive as any).appearance = new PerInstanceColorAppearance({
        translucent: newAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      });
    } catch {
      // ignore
    }

    scene.requestRender();
  }

  function rebuildPolygonWithHeight(polygon: PolygonData, newHeight: number) {
    // Remove old primitives
    scene.primitives.remove(polygon.outlinePrimitive);
    scene.primitives.remove(polygon.fillPrimitive);
    labelCollection.remove(polygon.label);

    // Update height
    polygon.extrudeHeight = newHeight;
    if (polygon.geojsonFeature?.properties) {
      polygon.geojsonFeature.properties.extrudeHeight = newHeight;
    }

    // Recreate outline
    const outlinePositions = [...polygon.positions, polygon.positions[0]];
    const outlineInstance = new GeometryInstance({
      id: polygon.outlineInstanceId,
      geometry: new PolylineGeometry({
        positions: outlinePositions,
        width: 2,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(
          selectedPolygonId === polygon.id ? Color.YELLOW : polygon.color.withAlpha(1)
        )
      }
    });
    polygon.outlinePrimitive = new Primitive({
      geometryInstances: [outlineInstance],
      appearance: new PolylineColorAppearance({})
    });
    scene.primitives.add(polygon.outlinePrimitive);

    // Recreate fill
    const polygonInstance = new GeometryInstance({
      id: polygon.fillInstanceId,
      geometry: new PolygonGeometry({
        polygonHierarchy: {
          positions: polygon.positions,
          holes: []
        },
        extrudedHeight: polygon.baseHeight + newHeight,
        perPositionHeight: false,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(polygon.color.withAlpha(polygon.fillAlpha))
      }
    });
    polygon.fillPrimitive = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: polygon.fillAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(polygon.fillPrimitive);

    // Recreate label at new center height
    const center = Cartesian3.fromRadians(
      polygon.positions.reduce((sum, p) => sum + Cartographic.fromCartesian(p).longitude, 0) / polygon.positions.length,
      polygon.positions.reduce((sum, p) => sum + Cartographic.fromCartesian(p).latitude, 0) / polygon.positions.length,
      polygon.baseHeight + newHeight / 2
    );
    polygon.label = labelCollection.add({
      position: center,
      text: `${polygon.name}\nBase: ${polygon.baseHeight.toFixed(2)}m\nHeight: ${newHeight}m\nTop: ${(polygon.baseHeight + newHeight).toFixed(2)}m\nArea: ${polygon.area.toFixed(1)} m²`,
      font: "20px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: labelsVisible,
    });

    scene.requestRender();
  }

  function setPolygonHeight(polygonId: string, height: number) {
    const polygon = polygons.find(p => p.id === polygonId);
    if (!polygon) return;

    rebuildPolygonWithHeight(polygon, height);
  }

  function deletePolygon(polygonId: string) {
    const index = polygons.findIndex(p => p.id === polygonId);
    if (index === -1) return;

    const polygon = polygons[index];
    
    // If this was selected, deselect first
    if (selectedPolygonId === polygonId) {
      selectedPolygonId = null;
      selectionCallback?.(null);
    }

    // Remove from scene
    scene.primitives.remove(polygon.outlinePrimitive);
    scene.primitives.remove(polygon.fillPrimitive);
    labelCollection.remove(polygon.label);

    // Remove from array
    polygons.splice(index, 1);

    scene.requestRender();
  }

  function getAllPolygons(): PolygonData[] {
    return polygons.slice();
  }

  // Import a polygon from GeoJSON feature (used for shared polygons)
  function importPolygonFromGeoJSON(feature: any): PolygonData | null {
    if (feature?.geometry?.type !== 'Polygon') return null;
    
    const ring = feature.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;

    const baseHeight = Number(feature?.properties?.baseHeight ?? 0);
    const importExtrudeHeight = Number(feature?.properties?.extrudeHeight ?? 10);
    const area = Number(feature?.properties?.area ?? 0);

    // Parse color from CSS string
    let importColor = Color.WHITE;
    const colorProp = feature?.properties?.color;
    if (typeof colorProp === 'string') {
      try {
        const parsed = Color.fromCssColorString(colorProp);
        if (parsed) importColor = parsed;
      } catch {
        // ignore
      }
    }

    const importFillAlpha = clampAlpha(Number(feature?.properties?.fillAlpha ?? 0.7));
    const importName = String(feature?.properties?.name ?? `Polygon ${featureIdCounter + 1}`);

    // Parse coordinates - drop closing coord if it matches first
    const coords = ring.slice();
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1]) {
      coords.pop();
    }

    // Convert to Cartesian3 positions
    const positions = coords
      .filter((c: any) => Array.isArray(c) && c.length >= 2)
      .map(([lng, lat]: [number, number]) => Cartesian3.fromDegrees(Number(lng), Number(lat), baseHeight));

    if (positions.length < 3) return null;

    // Create polygon using existing logic
    const featureId = `poly-${featureIdCounter++}`;
    const outlineInstanceId = `${featureId}-outline`;
    const fillInstanceId = `${featureId}-fill`;

    // Create outline
    const outlinePositions = [...positions, positions[0]];
    const outlineInstance = new GeometryInstance({
      id: outlineInstanceId,
      geometry: new PolylineGeometry({
        positions: outlinePositions,
        width: 2,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(importColor.withAlpha(1))
      }
    });
    const outlinePrimitive = new Primitive({
      geometryInstances: [outlineInstance],
      appearance: new PolylineColorAppearance({})
    });
    scene.primitives.add(outlinePrimitive);

    // Create extruded polygon
    const polygonInstance = new GeometryInstance({
      id: fillInstanceId,
      geometry: new PolygonGeometry({
        polygonHierarchy: {
          positions,
          holes: []
        },
        extrudedHeight: baseHeight + importExtrudeHeight,
        perPositionHeight: false,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(importColor.withAlpha(importFillAlpha))
      }
    });
    const fillPrimitivePoly = new Primitive({
      geometryInstances: [polygonInstance],
      appearance: new PerInstanceColorAppearance({
        translucent: importFillAlpha < 1,
        closed: true,
        flat: true,
        faceForward: false
      }),
      shadows: ShadowMode.ENABLED,
    });
    scene.primitives.add(fillPrimitivePoly);

    // Add label
    const center = Cartesian3.fromRadians(
      positions.reduce((sum: number, p: Cartesian3) => sum + Cartographic.fromCartesian(p).longitude, 0) / positions.length,
      positions.reduce((sum: number, p: Cartesian3) => sum + Cartographic.fromCartesian(p).latitude, 0) / positions.length,
      baseHeight + importExtrudeHeight / 2
    );
    const label = labelCollection.add({
      position: center,
      text: `${importName}\nBase: ${baseHeight.toFixed(2)}m\nHeight: ${importExtrudeHeight}m\nTop: ${(baseHeight + importExtrudeHeight).toFixed(2)}m\nArea: ${area.toFixed(1)} m²`,
      font: "20px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: labelsVisible,
    });

    // Build geojson feature to store
    const geojsonFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: feature.geometry.coordinates,
      },
      properties: {
        id: featureId,
        name: importName,
        extrudeHeight: importExtrudeHeight,
        baseHeight: baseHeight,
        area: area,
        color: importColor.toCssColorString(),
        fillAlpha: importFillAlpha,
      }
    };

    const polygonData: PolygonData = {
      id: featureId,
      name: importName,
      outlinePrimitive,
      fillPrimitive: fillPrimitivePoly,
      outlineInstanceId,
      fillInstanceId,
      label,
      positions: positions.slice(),
      baseHeight,
      extrudeHeight: importExtrudeHeight,
      area,
      color: importColor.clone(),
      fillAlpha: importFillAlpha,
      geojsonFeature,
    };
    polygons.push(polygonData);

    scene.requestRender();
    return polygonData;
  }

  const tool = { 
    startDrawing, 
    stopDrawing, 
    clear, 
    destroy, 
    setHeight, 
    setLabelsVisible, 
    setOpaque, 
    getOpaque, 
    setColorByName,
    // Rectangle drawing
    startDrawingRectangle,
    stopDrawingRectangle,
    isDrawingRectangle: () => isDrawingRectangle,
    // Selection
    enableSelection,
    disableSelection,
    selectPolygon,
    deselectPolygon,
    getSelectedPolygon,
    // Per-polygon editing
    setPolygonName,
    setPolygonColor,
    setPolygonOpacity,
    setPolygonHeight,
    deletePolygon,
    getAllPolygons,
    // Import
    importPolygonFromGeoJSON,
    // Helpers
    isSelectionEnabled: () => selectionEnabled,
    isDrawing: () => isDrawing,
  } as any;
  
  tool.getLabelsVisible = () => labelsVisible;
  tool.getGeoJSON = () => {
    // Export as 2D GeoJSON (no Z coordinate) but keep all properties including extrudeHeight, baseHeight
    return {
      type: "FeatureCollection",
      features: polygons.map(p => {
        const feature = JSON.parse(JSON.stringify(p.geojsonFeature)); // Deep clone
        // Convert 3D coordinates to 2D by removing Z
        if (feature.geometry?.coordinates?.[0]) {
          feature.geometry.coordinates[0] = feature.geometry.coordinates[0].map(
            (coord: number[]) => coord.length >= 2 ? [coord[0], coord[1]] : coord
          );
        }
        return feature;
      }),
    };
  };

  // DXF export - generates 3D extruded polygons (R12 format for maximum compatibility)
  // Supports SWEREF99 zones (EPSG:3006-3018)
  // Note: EPSG:4326 is NOT supported - degrees for X/Y with meters for Z causes distorted geometry
  tool.getDXF = (crs: string = 'EPSG:3006') => {
    const lines: string[] = [];
    
    // WGS84 ellipsoid parameters
    const a = 6378137; // WGS84 semi-major axis
    const f = 1 / 298.257222101; // WGS84 flattening
    const e2 = 2 * f - f * f; // eccentricity squared

    // SWEREF99 zone definitions: { centralMeridian (degrees), falseEasting }
    const sweref99Zones: Record<string, { lon0: number; falseEasting: number }> = {
      'EPSG:3006': { lon0: 15, falseEasting: 500000 },      // SWEREF99 TM (national)
      'EPSG:3007': { lon0: 12, falseEasting: 150000 },      // SWEREF99 12 00
      'EPSG:3008': { lon0: 13.5, falseEasting: 150000 },    // SWEREF99 13 30
      'EPSG:3009': { lon0: 15, falseEasting: 150000 },      // SWEREF99 15 00
      'EPSG:3010': { lon0: 16.5, falseEasting: 150000 },    // SWEREF99 16 30
      'EPSG:3011': { lon0: 18, falseEasting: 150000 },      // SWEREF99 18 00
      'EPSG:3012': { lon0: 14.25, falseEasting: 150000 },   // SWEREF99 14 15
      'EPSG:3013': { lon0: 15.75, falseEasting: 150000 },   // SWEREF99 15 45
      'EPSG:3014': { lon0: 17.25, falseEasting: 150000 },   // SWEREF99 17 15
      'EPSG:3015': { lon0: 18.75, falseEasting: 150000 },   // SWEREF99 18 45
      'EPSG:3016': { lon0: 20.25, falseEasting: 150000 },   // SWEREF99 20 15
      'EPSG:3017': { lon0: 21.75, falseEasting: 150000 },   // SWEREF99 21 45
      'EPSG:3018': { lon0: 23.25, falseEasting: 150000 },   // SWEREF99 23 15
    };
    
    // Convert WGS84 (radians) to SWEREF99 / Transverse Mercator
    const toSWEREF99 = (lonRad: number, latRad: number, lon0Deg: number, falseEasting: number) => {
      const lat = latRad;
      const lon = lonRad;
      const lon0 = lon0Deg * Math.PI / 180;
      const k0 = crs.toUpperCase() === 'EPSG:3006' ? 0.9996 : 1.0; // TM uses 0.9996, local zones use 1.0
      const falseNorthing = 0;
      
      const N = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
      const T = Math.tan(lat) * Math.tan(lat);
      const C = (e2 / (1 - e2)) * Math.cos(lat) * Math.cos(lat);
      const A = (lon - lon0) * Math.cos(lat);
      
      // Meridian arc length
      const e4 = e2 * e2;
      const e6 = e4 * e2;
      const M = a * (
        (1 - e2/4 - 3*e4/64 - 5*e6/256) * lat
        - (3*e2/8 + 3*e4/32 + 45*e6/1024) * Math.sin(2*lat)
        + (15*e4/256 + 45*e6/1024) * Math.sin(4*lat)
        - (35*e6/3072) * Math.sin(6*lat)
      );
      
      const x = falseEasting + k0 * N * (A + (1-T+C)*A*A*A/6 + (5-18*T+T*T+72*C-58*(e2/(1-e2)))*A*A*A*A*A/120);
      const y = falseNorthing + k0 * (M + N * Math.tan(lat) * (A*A/2 + (5-T+9*C+4*C*C)*A*A*A*A/24 + (61-58*T+T*T+600*C-330*(e2/(1-e2)))*A*A*A*A*A*A/720));
      
      return { x, y };
    };

    // Select coordinate transform based on CRS
    const crsUpper = crs.toUpperCase();
    let zoneConfig = sweref99Zones[crsUpper];
    
    // EPSG:4326 is not supported for 3D DXF - fall back to EPSG:3006
    if (crsUpper === 'EPSG:4326' || crsUpper === 'WGS84') {
      console.warn('EPSG:4326 is not supported for DXF export (X/Y in degrees, Z in meters causes distortion). Using EPSG:3006.');
      zoneConfig = sweref99Zones['EPSG:3006'];
    }
    
    const transformCoord = (lonRad: number, latRad: number): { x: number; y: number } => {
      if (zoneConfig) {
        return toSWEREF99(lonRad, latRad, zoneConfig.lon0, zoneConfig.falseEasting);
      }
      // Default to EPSG:3006
      return toSWEREF99(lonRad, latRad, 15, 500000);
    };

    // Set units based on CRS (6 = meters, 4 = degrees)
    const insUnits = (crsUpper === 'EPSG:4326' || crsUpper === 'WGS84') ? '4' : '6';
    
    // DXF Header - R12 format (AC1009) for maximum compatibility
    lines.push('0', 'SECTION');
    lines.push('2', 'HEADER');
    lines.push('9', '$ACADVER');
    lines.push('1', 'AC1009');
    lines.push('9', '$INSUNITS');
    lines.push('70', insUnits);
    lines.push('0', 'ENDSEC');
    
    // Tables section
    lines.push('0', 'SECTION');
    lines.push('2', 'TABLES');
    lines.push('0', 'TABLE');
    lines.push('2', 'LAYER');
    lines.push('70', '1');
    lines.push('0', 'LAYER');
    lines.push('2', '0');
    lines.push('70', '0');
    lines.push('62', '7');
    lines.push('6', 'CONTINUOUS');
    lines.push('0', 'ENDTAB');
    lines.push('0', 'ENDSEC');
    
    // Entities section
    lines.push('0', 'SECTION');
    lines.push('2', 'ENTITIES');
    
    polygons.forEach((polygon) => {
      // Convert coordinates using selected CRS
      const coords = polygon.positions.map(p => {
        const c = Cartographic.fromCartesian(p);
        return transformCoord(c.longitude, c.latitude);
      });
      
      const baseZ = polygon.baseHeight;
      const topZ = polygon.baseHeight + polygon.extrudeHeight;
      const layerName = polygon.name.replace(/[^a-zA-Z0-9_]/g, '_');
      
      // Bottom outline as LINE entities
      for (let i = 0; i < coords.length; i++) {
        const c1 = coords[i];
        const c2 = coords[(i + 1) % coords.length];
        lines.push('0', 'LINE');
        lines.push('8', layerName);
        lines.push('10', String(c1.x));
        lines.push('20', String(c1.y));
        lines.push('30', String(baseZ));
        lines.push('11', String(c2.x));
        lines.push('21', String(c2.y));
        lines.push('31', String(baseZ));
      }
      
      // Top outline as LINE entities
      for (let i = 0; i < coords.length; i++) {
        const c1 = coords[i];
        const c2 = coords[(i + 1) % coords.length];
        lines.push('0', 'LINE');
        lines.push('8', layerName);
        lines.push('10', String(c1.x));
        lines.push('20', String(c1.y));
        lines.push('30', String(topZ));
        lines.push('11', String(c2.x));
        lines.push('21', String(c2.y));
        lines.push('31', String(topZ));
      }
      
      // Vertical edges as LINE entities
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        lines.push('0', 'LINE');
        lines.push('8', layerName);
        lines.push('10', String(c.x));
        lines.push('20', String(c.y));
        lines.push('30', String(baseZ));
        lines.push('11', String(c.x));
        lines.push('21', String(c.y));
        lines.push('31', String(topZ));
      }
      
      // Side faces as 3DFACE entities
      for (let i = 0; i < coords.length; i++) {
        const c1 = coords[i];
        const c2 = coords[(i + 1) % coords.length];
        
        lines.push('0', '3DFACE');
        lines.push('8', layerName);
        lines.push('10', String(c1.x));
        lines.push('20', String(c1.y));
        lines.push('30', String(baseZ));
        lines.push('11', String(c2.x));
        lines.push('21', String(c2.y));
        lines.push('31', String(baseZ));
        lines.push('12', String(c2.x));
        lines.push('22', String(c2.y));
        lines.push('32', String(topZ));
        lines.push('13', String(c1.x));
        lines.push('23', String(c1.y));
        lines.push('33', String(topZ));
      }
      
      // Bottom face as 3DFACE (triangulated for >3 points)
      if (coords.length === 3) {
        lines.push('0', '3DFACE');
        lines.push('8', layerName);
        lines.push('10', String(coords[0].x));
        lines.push('20', String(coords[0].y));
        lines.push('30', String(baseZ));
        lines.push('11', String(coords[1].x));
        lines.push('21', String(coords[1].y));
        lines.push('31', String(baseZ));
        lines.push('12', String(coords[2].x));
        lines.push('22', String(coords[2].y));
        lines.push('32', String(baseZ));
        lines.push('13', String(coords[2].x));
        lines.push('23', String(coords[2].y));
        lines.push('33', String(baseZ));
      } else if (coords.length === 4) {
        lines.push('0', '3DFACE');
        lines.push('8', layerName);
        lines.push('10', String(coords[0].x));
        lines.push('20', String(coords[0].y));
        lines.push('30', String(baseZ));
        lines.push('11', String(coords[1].x));
        lines.push('21', String(coords[1].y));
        lines.push('31', String(baseZ));
        lines.push('12', String(coords[2].x));
        lines.push('22', String(coords[2].y));
        lines.push('32', String(baseZ));
        lines.push('13', String(coords[3].x));
        lines.push('23', String(coords[3].y));
        lines.push('33', String(baseZ));
      } else {
        // Fan triangulation for polygons with more than 4 vertices
        for (let i = 1; i < coords.length - 1; i++) {
          lines.push('0', '3DFACE');
          lines.push('8', layerName);
          lines.push('10', String(coords[0].x));
          lines.push('20', String(coords[0].y));
          lines.push('30', String(baseZ));
          lines.push('11', String(coords[i].x));
          lines.push('21', String(coords[i].y));
          lines.push('31', String(baseZ));
          lines.push('12', String(coords[i + 1].x));
          lines.push('22', String(coords[i + 1].y));
          lines.push('32', String(baseZ));
          lines.push('13', String(coords[i + 1].x));
          lines.push('23', String(coords[i + 1].y));
          lines.push('33', String(baseZ));
        }
      }
      
      // Top face as 3DFACE (triangulated for >3 points)
      if (coords.length === 3) {
        lines.push('0', '3DFACE');
        lines.push('8', layerName);
        lines.push('10', String(coords[0].x));
        lines.push('20', String(coords[0].y));
        lines.push('30', String(topZ));
        lines.push('11', String(coords[1].x));
        lines.push('21', String(coords[1].y));
        lines.push('31', String(topZ));
        lines.push('12', String(coords[2].x));
        lines.push('22', String(coords[2].y));
        lines.push('32', String(topZ));
        lines.push('13', String(coords[2].x));
        lines.push('23', String(coords[2].y));
        lines.push('33', String(topZ));
      } else if (coords.length === 4) {
        lines.push('0', '3DFACE');
        lines.push('8', layerName);
        lines.push('10', String(coords[0].x));
        lines.push('20', String(coords[0].y));
        lines.push('30', String(topZ));
        lines.push('11', String(coords[1].x));
        lines.push('21', String(coords[1].y));
        lines.push('31', String(topZ));
        lines.push('12', String(coords[2].x));
        lines.push('22', String(coords[2].y));
        lines.push('32', String(topZ));
        lines.push('13', String(coords[3].x));
        lines.push('23', String(coords[3].y));
        lines.push('33', String(topZ));
      } else {
        // Fan triangulation for polygons with more than 4 vertices
        for (let i = 1; i < coords.length - 1; i++) {
          lines.push('0', '3DFACE');
          lines.push('8', layerName);
          lines.push('10', String(coords[0].x));
          lines.push('20', String(coords[0].y));
          lines.push('30', String(topZ));
          lines.push('11', String(coords[i].x));
          lines.push('21', String(coords[i].y));
          lines.push('31', String(topZ));
          lines.push('12', String(coords[i + 1].x));
          lines.push('22', String(coords[i + 1].y));
          lines.push('32', String(topZ));
          lines.push('13', String(coords[i + 1].x));
          lines.push('23', String(coords[i + 1].y));
          lines.push('33', String(topZ));
        }
      }
    });
    
    lines.push('0', 'ENDSEC');
    lines.push('0', 'EOF');
    
    return lines.join('\n');
  };

  return tool;
}