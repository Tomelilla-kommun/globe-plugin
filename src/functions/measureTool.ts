import { 
  Scene, ScreenSpaceEventHandler, ScreenSpaceEventType, Cartesian3, Cartesian2,
  Color, LabelCollection, Label, LabelStyle, VerticalOrigin,
  Primitive, GeometryInstance, PolylineGeometry, ColorGeometryInstanceAttribute, HorizontalOrigin,
  PolylineColorAppearance, Cartographic, PolygonGeometry, PerInstanceColorAppearance,
  GroundPrimitive, ClassificationType, GroundPolylinePrimitive, GroundPolylineGeometry,
  PolylineMaterialAppearance, Material, EllipsoidTangentPlane, Ellipsoid
} from "cesium";
import { setMeasuring } from './../globeState';

export type MeasureMode = 'distance' | 'height' | 'footprint' | 'surface';

// Helper: compute footprint area by projecting to local tangent plane (horizontal projection)
// This gives the "shadow" area as if looking straight down - good for land plots, building footprints
function computeFootprintArea(positions: Cartesian3[]): number {
  if (positions.length < 3) return 0;
  
  // Create tangent plane at centroid of points
  const tangentPlane = EllipsoidTangentPlane.fromPoints(positions, Ellipsoid.WGS84);
  
  // Project all points to 2D on the tangent plane
  const positions2D = tangentPlane.projectPointsOntoPlane(positions);
  
  // Compute 2D polygon area using shoelace formula
  let area = 0;
  for (let i = 0; i < positions2D.length; i++) {
    const j = (i + 1) % positions2D.length;
    area += positions2D[i].x * positions2D[j].y;
    area -= positions2D[j].x * positions2D[i].y;
  }
  
  return Math.abs(area) / 2;
}

// Helper: compute true 3D surface area using triangulation
// Works for walls, roofs, slopes, terrain mounds - measures actual surface area
function compute3DSurfaceArea(positions: Cartesian3[]): number {
  if (positions.length < 3) return 0;
  
  let totalArea = 0;
  
  // Fan triangulation from first vertex
  const p0 = positions[0];
  for (let i = 1; i < positions.length - 1; i++) {
    const p1 = positions[i];
    const p2 = positions[i + 1];
    
    // Triangle area = 0.5 * |v1 × v2|
    const v1 = Cartesian3.subtract(p1, p0, new Cartesian3());
    const v2 = Cartesian3.subtract(p2, p0, new Cartesian3());
    const cross = Cartesian3.cross(v1, v2, new Cartesian3());
    const triangleArea = Cartesian3.magnitude(cross) / 2;
    totalArea += triangleArea;
  }
  
  return totalArea;
}

// Format distance for display
function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${meters.toFixed(2)} m`;
}

// Format area for display
function formatArea(sqMeters: number): string {
  if (sqMeters >= 1000000) {
    return `${(sqMeters / 1000000).toFixed(2)} km²`;
  } else if (sqMeters >= 10000) {
    return `${(sqMeters / 10000).toFixed(2)} ha`;
  }
  return `${sqMeters.toFixed(2)} m²`;
}

export default function measureTool(scene: Scene) {
  const handler = new ScreenSpaceEventHandler(scene.canvas);

  let start: Cartesian3 | null = null;
  let end: Cartesian3 | null = null;

  const labelCollection = new LabelCollection();
  scene.primitives.add(labelCollection);

  // Store multiple measurements (can be Primitive, GroundPrimitive, or GroundPolylinePrimitive)
  const primitives: (Primitive | GroundPrimitive | GroundPolylinePrimitive)[] = [];
  const labels: Label[] = [];

  let moving = false;
  let currentMode: MeasureMode = 'distance';
  let isActive = false;

  // Area measurement state
  let areaPoints: Cartesian3[] = [];
  let areaPreviewPrimitive: Primitive | GroundPrimitive | GroundPolylinePrimitive | null = null;
  let areaFillPrimitive: Primitive | GroundPrimitive | null = null;

  let activePrimitive: Primitive | null = null;
  let activeLabel: Label | null = null;

  interface ClickEvent {
    position: { x: number; y: number };
  }

  interface MouseMoveEvent {
    endPosition: { x: number; y: number };
  }

  function getCartesianFromScreen(screenPos: { x: number; y: number }): Cartesian3 | undefined {
    const cartesian2Pos = new Cartesian2(screenPos.x, screenPos.y);
    let cartesian: Cartesian3 | undefined = scene.pickPosition(cartesian2Pos);
    if (!cartesian) {
      const ray = scene.camera.getPickRay(cartesian2Pos);
      if (!ray) return undefined;
      cartesian = scene.globe.pick(ray, scene);
    }
    return cartesian;
  }

  function clearActivePreview() {
    if (activePrimitive) {
      scene.primitives.remove(activePrimitive);
      activePrimitive = null;
    }
    if (activeLabel) {
      labelCollection.remove(activeLabel);
      activeLabel = null;
    }
    if (areaPreviewPrimitive) {
      scene.primitives.remove(areaPreviewPrimitive);
      areaPreviewPrimitive = null;
    }
    if (areaFillPrimitive) {
      scene.primitives.remove(areaFillPrimitive);
      areaFillPrimitive = null;
    }
  }

  function clear() {
    clearActivePreview();

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
    areaPoints = [];

    scene.requestRender();
  }

  function removeHandlers() {
    handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
    handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK);
  }

  function stopMeasuring() {
    isActive = false;
    setMeasuring(false);
    removeHandlers();
    clearActivePreview();
    start = null;
    end = null;
    moving = false;
    areaPoints = [];
    scene.requestRender();
  }

  function createLabel(position: Cartesian3, text: string): Label {
    return labelCollection.add({
      position,
      text,
      font: "16px sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }

  function createPolylinePrimitive(positions: Cartesian3[], color: Color = Color.YELLOW): Primitive {
    const instance = new GeometryInstance({
      geometry: new PolylineGeometry({
        positions,
        width: 2,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(color)
      }
    });
    return new Primitive({
      geometryInstances: [instance],
      appearance: new PolylineColorAppearance({})
    });
  }

  function measureDistance() {
    currentMode = 'distance';
    isActive = true;
    setMeasuring(true);
    removeHandlers();
    clearActivePreview();
    start = null;
    end = null;
    moving = false;

    handler.setInputAction((click: ClickEvent) => {
      const cartesian = getCartesianFromScreen(click.position);
      if (!cartesian) return;

      if (!start) {
        start = cartesian.clone();
        moving = true;
      } else {
        end = cartesian.clone();
        moving = false;

        // Create final polyline
        const primitive = createPolylinePrimitive([start, end]);
        scene.primitives.add(primitive);
        primitives.push(primitive);

        // Add label
        const mid = Cartesian3.midpoint(start, end, new Cartesian3());
        const distance = Cartesian3.distance(start, end);
        const label = createLabel(mid, formatDistance(distance));
        labels.push(label);

        // Clear preview
        clearActivePreview();
        scene.requestRender();

        // Reset for next measurement
        start = null;
        end = null;
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (!start || !moving) return;

      const cartesian = getCartesianFromScreen(movement.endPosition);
      if (!cartesian) return;

      end = cartesian.clone();

      // Update dynamic primitive
      if (activePrimitive) scene.primitives.remove(activePrimitive);
      activePrimitive = createPolylinePrimitive([start, end]);
      scene.primitives.add(activePrimitive);

      // Update label
      if (activeLabel) labelCollection.remove(activeLabel);
      const mid = Cartesian3.midpoint(start, end, new Cartesian3());
      const distance = Cartesian3.distance(start, end);
      activeLabel = createLabel(mid, formatDistance(distance));

      scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function measureHeight() {
    currentMode = 'height';
    isActive = true;
    setMeasuring(true);
    removeHandlers();
    clearActivePreview();
    start = null;
    end = null;
    moving = false;

    handler.setInputAction((click: ClickEvent) => {
      const cartesian = getCartesianFromScreen(click.position);
      if (!cartesian) return;

      if (!start) {
        start = cartesian.clone();
        moving = true;
      } else {
        end = cartesian.clone();
        moving = false;

        // Calculate heights
        const startCarto = Cartographic.fromCartesian(start);
        const endCarto = Cartographic.fromCartesian(end);
        const heightDiff = endCarto.height - startCarto.height;

        let verticalStart: Cartesian3;
        let verticalEnd: Cartesian3;
        let horizontalStart: Cartesian3;
        let horizontalEnd: Cartesian3;

        if (heightDiff >= 0) {
          // Positive delta: vertical line at start point (going up from start to end's height)
          verticalStart = start;
          verticalEnd = Cartesian3.fromRadians(startCarto.longitude, startCarto.latitude, endCarto.height);
          horizontalStart = verticalEnd;
          horizontalEnd = end;
        } else {
          // Negative delta: vertical line at end point (going down from start's height to end)
          verticalStart = Cartesian3.fromRadians(endCarto.longitude, endCarto.latitude, startCarto.height);
          verticalEnd = end;
          horizontalStart = start;
          horizontalEnd = verticalStart;
        }

        // Create lines: horizontal line, then vertical line
        const horizontalPrimitive = createPolylinePrimitive([horizontalStart, horizontalEnd], Color.CYAN);
        scene.primitives.add(horizontalPrimitive);
        primitives.push(horizontalPrimitive);

        const verticalPrimitive = createPolylinePrimitive([verticalStart, verticalEnd], Color.YELLOW);
        scene.primitives.add(verticalPrimitive);
        primitives.push(verticalPrimitive);

        // Add height label at midpoint of vertical line
        const verticalMid = Cartesian3.midpoint(verticalStart, verticalEnd, new Cartesian3());
        const heightText = heightDiff >= 0 ? `+${formatDistance(heightDiff)}` : formatDistance(heightDiff);
        const label = createLabel(verticalMid, `Δh: ${heightText}`);
        labels.push(label);

        // Add horizontal distance label
        const horizontalDist = Cartesian3.distance(horizontalStart, horizontalEnd);
        if (horizontalDist > 1) {
          const horizontalMid = Cartesian3.midpoint(horizontalStart, horizontalEnd, new Cartesian3());
          const hLabel = createLabel(horizontalMid, formatDistance(horizontalDist));
          labels.push(hLabel);
        }

        clearActivePreview();
        scene.requestRender();

        start = null;
        end = null;
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (!start || !moving) return;

      const cartesian = getCartesianFromScreen(movement.endPosition);
      if (!cartesian) return;

      end = cartesian.clone();

      // Clear previous preview
      if (activePrimitive) scene.primitives.remove(activePrimitive);
      if (areaPreviewPrimitive) scene.primitives.remove(areaPreviewPrimitive);
      if (activeLabel) labelCollection.remove(activeLabel);

      const startCarto = Cartographic.fromCartesian(start);
      const endCarto = Cartographic.fromCartesian(end);
      const heightDiff = endCarto.height - startCarto.height;

      let verticalStart: Cartesian3;
      let verticalEnd: Cartesian3;
      let horizontalStart: Cartesian3;
      let horizontalEnd: Cartesian3;

      if (heightDiff >= 0) {
        // Positive delta: vertical line at start point
        verticalStart = start;
        verticalEnd = Cartesian3.fromRadians(startCarto.longitude, startCarto.latitude, endCarto.height);
        horizontalStart = verticalEnd;
        horizontalEnd = end;
      } else {
        // Negative delta: vertical line at end point
        verticalStart = Cartesian3.fromRadians(endCarto.longitude, endCarto.latitude, startCarto.height);
        verticalEnd = end;
        horizontalStart = start;
        horizontalEnd = verticalStart;
      }

      // Horizontal preview line
      activePrimitive = createPolylinePrimitive([horizontalStart, horizontalEnd], Color.CYAN);
      scene.primitives.add(activePrimitive);

      // Vertical preview line
      areaPreviewPrimitive = createPolylinePrimitive([verticalStart, verticalEnd], Color.YELLOW);
      scene.primitives.add(areaPreviewPrimitive);

      // Height label
      const verticalMid = Cartesian3.midpoint(verticalStart, verticalEnd, new Cartesian3());
      const heightText = heightDiff >= 0 ? `+${formatDistance(Math.abs(heightDiff))}` : `-${formatDistance(Math.abs(heightDiff))}`;
      activeLabel = createLabel(verticalMid, `Δh: ${heightText}`);

      scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function measureFootprint() {
    currentMode = 'footprint';
    isActive = true;
    setMeasuring(true);
    removeHandlers();
    clearActivePreview();
    areaPoints = [];

    handler.setInputAction((click: ClickEvent) => {
      const cartesian = getCartesianFromScreen(click.position);
      if (!cartesian) return;

      areaPoints.push(cartesian.clone());
      scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Right-click to finish polygon
    handler.setInputAction(() => {
      if (areaPoints.length < 3) return;

      // Create final polygon outline that drapes on terrain and 3D tiles
      const outlinePositions = [...areaPoints, areaPoints[0]];
      const outlineInstance = new GeometryInstance({
        geometry: new GroundPolylineGeometry({
          positions: outlinePositions,
          width: 3,
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
        }
      });
      const outlinePrimitive = new GroundPolylinePrimitive({
        geometryInstances: outlineInstance,
        appearance: new PolylineMaterialAppearance({
          material: Material.fromType('Color', {
            color: Color.YELLOW
          })
        }),
        classificationType: ClassificationType.BOTH,
      });
      scene.primitives.add(outlinePrimitive);
      primitives.push(outlinePrimitive);

      // Create filled polygon that drapes on terrain and 3D tiles
      const fillInstance = new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: {
            positions: areaPoints,
            holes: []
          },
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW.withAlpha(0.4))
        }
      });
      const fillPrimitive = new GroundPrimitive({
        geometryInstances: [fillInstance],
        appearance: new PerInstanceColorAppearance({
          translucent: true,
          flat: true,
        }),
        classificationType: ClassificationType.BOTH,
      });
      scene.primitives.add(fillPrimitive);
      primitives.push(fillPrimitive);

      // Calculate and display footprint area (horizontal projection)
      const area = computeFootprintArea(areaPoints);
      
      // Calculate label position at visual center of polygon
      const cartos = areaPoints.map(p => Cartographic.fromCartesian(p));
      const avgLon = cartos.reduce((sum, c) => sum + c.longitude, 0) / cartos.length;
      const avgLat = cartos.reduce((sum, c) => sum + c.latitude, 0) / cartos.length;
      const maxHeight = Math.max(...cartos.map(c => c.height));
      
      // Sample actual surface height at centroid for accurate label placement
      const centroidCartographic = new Cartographic(avgLon, avgLat);
      const sampledHeight = scene.sampleHeight(centroidCartographic);
      const labelHeight = (sampledHeight !== undefined ? sampledHeight : maxHeight) + 2;
      const labelPosition = Cartesian3.fromRadians(avgLon, avgLat, labelHeight);

      const label = createLabel(labelPosition, formatArea(area));
      labels.push(label);

      // Clear preview and reset
      clearActivePreview();
      areaPoints = [];
      scene.requestRender();
    }, ScreenSpaceEventType.RIGHT_CLICK);

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (areaPoints.length === 0) return;

      const cartesian = getCartesianFromScreen(movement.endPosition);
      if (!cartesian) return;

      // Clear previous preview
      if (areaPreviewPrimitive) scene.primitives.remove(areaPreviewPrimitive);
      if (areaFillPrimitive) scene.primitives.remove(areaFillPrimitive);
      if (activeLabel) labelCollection.remove(activeLabel);

      const previewPoints = [...areaPoints, cartesian];

      // Draw outline preview that drapes on terrain and 3D tiles
      const outlinePositions = [...previewPoints, previewPoints[0]];
      const outlineInstance = new GeometryInstance({
        geometry: new GroundPolylineGeometry({
          positions: outlinePositions,
          width: 3,
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW)
        }
      });
      areaPreviewPrimitive = new GroundPolylinePrimitive({
        geometryInstances: outlineInstance,
        appearance: new PolylineMaterialAppearance({
          material: Material.fromType('Color', {
            color: Color.YELLOW
          })
        }),
        classificationType: ClassificationType.BOTH,
        asynchronous: false, // Synchronous for preview responsiveness
      });
      scene.primitives.add(areaPreviewPrimitive);

      // Draw fill preview if we have enough points
      if (previewPoints.length >= 3) {
        const fillInstance = new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: {
              positions: previewPoints,
              holes: []
            },
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.YELLOW.withAlpha(0.25))
          }
        });
        areaFillPrimitive = new GroundPrimitive({
          geometryInstances: [fillInstance],
          appearance: new PerInstanceColorAppearance({
            translucent: true,
            flat: true,
          }),
          classificationType: ClassificationType.BOTH,
          asynchronous: false, // Synchronous for preview responsiveness
        });
        scene.primitives.add(areaFillPrimitive);

        // Show footprint area preview
        const area = computeFootprintArea(previewPoints);
        
        // Calculate label position at visual center of polygon
        const cartos = previewPoints.map(p => Cartographic.fromCartesian(p));
        const avgLon = cartos.reduce((sum, c) => sum + c.longitude, 0) / cartos.length;
        const avgLat = cartos.reduce((sum, c) => sum + c.latitude, 0) / cartos.length;
        const maxHeight = Math.max(...cartos.map(c => c.height));
        
        // Sample actual surface height at centroid for accurate label placement
        const centroidCartographic = new Cartographic(avgLon, avgLat);
        const sampledHeight = scene.sampleHeight(centroidCartographic);
        const labelHeight = (sampledHeight !== undefined ? sampledHeight : maxHeight) + 2;
        const labelPosition = Cartesian3.fromRadians(avgLon, avgLat, labelHeight);
        
        activeLabel = createLabel(labelPosition, formatArea(area));
      }

      scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function measureSurface() {
    currentMode = 'surface';
    isActive = true;
    setMeasuring(true);
    removeHandlers();
    clearActivePreview();
    areaPoints = [];

    handler.setInputAction((click: ClickEvent) => {
      const cartesian = getCartesianFromScreen(click.position);
      if (!cartesian) return;

      areaPoints.push(cartesian.clone());
      scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Right-click to finish polygon
    handler.setInputAction(() => {
      if (areaPoints.length < 3) return;

      // Create polygon outline connecting clicked points (not ground-draped - stays on actual surface)
      const outlinePositions = [...areaPoints, areaPoints[0]];
      const outlinePrimitive = createPolylinePrimitive(outlinePositions, Color.CYAN);
      scene.primitives.add(outlinePrimitive);
      primitives.push(outlinePrimitive);

      // Create filled polygon on the actual 3D surface (not ground-draped)
      const fillInstance = new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: {
            positions: areaPoints,
            holes: []
          },
          perPositionHeight: true, // Keep actual heights - don't flatten to ground
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(Color.CYAN.withAlpha(0.4))
        }
      });
      const fillPrimitive = new Primitive({
        geometryInstances: [fillInstance],
        appearance: new PerInstanceColorAppearance({
          translucent: true,
          flat: true,
        }),
      });
      scene.primitives.add(fillPrimitive);
      primitives.push(fillPrimitive);

      // Calculate true 3D surface area
      const area = compute3DSurfaceArea(areaPoints);
      
      // Calculate label position at centroid of the actual polygon
      const centroid = areaPoints.reduce(
        (acc, p) => Cartesian3.add(acc, p, acc),
        new Cartesian3(0, 0, 0)
      );
      Cartesian3.divideByScalar(centroid, areaPoints.length, centroid);
      
      // Offset label slightly above the surface
      const centroidCarto = Cartographic.fromCartesian(centroid);
      const labelPosition = Cartesian3.fromRadians(
        centroidCarto.longitude,
        centroidCarto.latitude,
        centroidCarto.height + 2
      );

      const label = createLabel(labelPosition, `⬡ ${formatArea(area)}`);
      labels.push(label);

      // Clear preview and reset
      clearActivePreview();
      areaPoints = [];
      scene.requestRender();
    }, ScreenSpaceEventType.RIGHT_CLICK);

    handler.setInputAction((movement: MouseMoveEvent) => {
      if (areaPoints.length === 0) return;

      const cartesian = getCartesianFromScreen(movement.endPosition);
      if (!cartesian) return;

      // Clear previous preview
      if (areaPreviewPrimitive) scene.primitives.remove(areaPreviewPrimitive);
      if (areaFillPrimitive) scene.primitives.remove(areaFillPrimitive);
      if (activeLabel) labelCollection.remove(activeLabel);

      const previewPoints = [...areaPoints, cartesian];

      // Draw outline preview on actual surface
      const outlinePositions = [...previewPoints, previewPoints[0]];
      areaPreviewPrimitive = createPolylinePrimitive(outlinePositions, Color.CYAN);
      scene.primitives.add(areaPreviewPrimitive);

      // Draw fill preview if we have enough points
      if (previewPoints.length >= 3) {
        const fillInstance = new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: {
              positions: previewPoints,
              holes: []
            },
            perPositionHeight: true,
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.CYAN.withAlpha(0.25))
          }
        });
        areaFillPrimitive = new Primitive({
          geometryInstances: [fillInstance],
          appearance: new PerInstanceColorAppearance({
            translucent: true,
            flat: true,
          }),
          asynchronous: false,
        });
        scene.primitives.add(areaFillPrimitive);

        // Show 3D surface area preview
        const area = compute3DSurfaceArea(previewPoints);
        
        // Calculate label position at centroid
        const centroid = previewPoints.reduce(
          (acc, p) => Cartesian3.add(acc, p, acc),
          new Cartesian3(0, 0, 0)
        );
        Cartesian3.divideByScalar(centroid, previewPoints.length, centroid);
        const centroidCarto = Cartographic.fromCartesian(centroid);
        const labelPosition = Cartesian3.fromRadians(
          centroidCarto.longitude,
          centroidCarto.latitude,
          centroidCarto.height + 2
        );
        
        activeLabel = createLabel(labelPosition, `⬡ ${formatArea(area)}`);
      }

      scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  function setMode(mode: MeasureMode) {
    currentMode = mode;
    stopMeasuring();
    
    switch (mode) {
      case 'distance':
        measureDistance();
        break;
      case 'height':
        measureHeight();
        break;
      case 'footprint':
        measureFootprint();
        break;
      case 'surface':
        measureSurface();
        break;
    }
  }

  function getMode(): MeasureMode {
    return currentMode;
  }

  function getIsActive(): boolean {
    return isActive;
  }

  function destroy() {
    setMeasuring(false);
    isActive = false;
    clear();
    handler.destroy();
    scene.primitives.remove(labelCollection);
    scene.requestRender();
  }

  return { 
    measureDistance, 
    measureHeight,
    measureFootprint,
    measureSurface,
    setMode,
    getMode,
    getIsActive,
    stopMeasuring,
    clear, 
    destroy 
  };
}
