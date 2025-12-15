import {
  Scene,
  Cesium3DTileset,
  createOsmBuildingsAsync,
  Color,
  Cesium3DTileStyle,
  Cartesian3,
  Cartographic,
  sampleTerrainMostDetailed,
  ShadowMode,
  Model,
  Transforms,
  HeadingPitchRoll,
  Ellipsoid,
  Primitive,
  GeometryInstance,
  PolygonGeometry,
  PolygonHierarchy,
  ColorGeometryInstanceAttribute,
  PerInstanceColorAppearance,
  Math as CesiumMath
} from 'cesium';
import GeoJSON from 'ol/format/GeoJSON';
import Map from 'ol/Map';
import { loadTrees } from '../functions/loadTrees';

interface LayerOptions {
  dataSource?: string;
  name?: string;
  extrusion?: any;
  model?: any;
  visible?: boolean;
  url?: string | number;
  maximumScreenSpaceError?: number;
  showOutline?: boolean;
  outlineColor?: string;
  style?: any;
  filter?: any;
  CesiumModels?: any[];
  CesiumExtrusions?: any[];
  [key: string]: any;
}

export default async function load3DLayers(
  scene: Scene,
  map: Map,
  cesiumIontoken: string,
): Promise<void> {
  const layers: LayerOptions[] = map.getLayers().getArray();

  for (const layer of layers) {
    const type = layer.get('type');
    const extrusion = layer.get('extrusion');
    const style = layer.get('style') || {};
    const show = layer.get('filter') ?? undefined;
    const model = layer.get('model');
    const dataType = layer.get('dataType')  ?? undefined;

    if (type === 'THREEDTILE' && dataType === 'extrusion') {
      const url = `${layer.get('dataSource')}?service=WFS&version=1.0.0&request=GetFeature&typeName=${layer.get('name')}&outputFormat=application/json&srsName=EPSG:4326`;
      try {
        const geojson = await (await fetch(url)).json();
        const features = new GeoJSON().readFeatures(geojson);
        layer.CesiumExtrusions = [];

        for (const feature of features) {
          const geometry = feature.getGeometry();
          let coords: [number, number][] | undefined;
          if (geometry && geometry.getType() === 'Polygon') {
            coords = (geometry as any).getCoordinates()?.[0];
          } else if (geometry && geometry.getType() === 'MultiPolygon') {
            coords = (geometry as any).getCoordinates()?.[0]?.[0];
          }
          if (!coords) continue;

          const ground = parseFloat(feature.get(extrusion.groundAttr)) || 0;
          const roof = parseFloat(feature.get(extrusion.roofAttr)) || ground + 5;

          const positions = coords.map(([lon, lat]: [number, number]) => Cartesian3.fromDegrees(lon, lat, ground));

          let color: Color;
          if (extrusion.color) {
            const colorName = extrusion.color.toUpperCase();
            color = (Color as any)[colorName] || Color.LIGHTGRAY;
          } else {
            color = Color.LIGHTGRAY;
          }
          color = color.withAlpha(extrusion.opacity ?? 1.0);

          const polygon = new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(positions),
            height: ground,
            extrudedHeight: roof
          });

          const geomInstance = new GeometryInstance({
            geometry: polygon,
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(color),
            },
            id: feature.getId()
          });

          const primitive = new Primitive({
            geometryInstances: geomInstance,
            appearance: new PerInstanceColorAppearance({
              flat: true,
              translucent: true,
              closed: true,
            }),
            asynchronous: false,
            releaseGeometryInstances: false,
            show: layer.get('visible')
          });

          layer.CesiumExtrusions.push(primitive);
          scene.primitives.add(primitive);
        }
      } catch (err) {
        console.error('Error loading WFS extruded buildings:', err);
      }

    } else if (type === 'THREEDTILE' && model) {
      await loadTrees(layer, scene, model);
    } else if (type === 'THREEDTILE' && dataType === 'model') {
      const models = layer.get('models');

      for (const model of models) {
        const url = layer.get('url') + model.fileName;
        const lat = model.lat;
        const lng = model.lng;
        const height = model.height || 0;
        const heightReference = !model.heightReference || model.heightReference === 'NONE' ? undefined : model.heightReference;
        const pitch = model.rotPitch || 0;
        const roll = model.rotRoll || 0;
        const heading = model.rotHeading || 0;
        let animation = model.animation || false;

        const position = Cartesian3.fromDegrees(lng, lat, height);
        const hpr = new HeadingPitchRoll(heading, pitch, roll);
        const modelMatrix = Transforms.headingPitchRollToFixedFrame(position, hpr, Ellipsoid.WGS84);

        const modelPrimitive = await Model.fromGltfAsync({
          url: url,
          modelMatrix: modelMatrix,
          minimumPixelSize: 0,
          asynchronous: true,
          heightReference: heightReference,
        });

        modelPrimitive.show = layer.get('visible');

        layer.CesiumModels = layer.CesiumModels || [];
        layer.CesiumModels.push(modelPrimitive);
        scene.primitives.add(modelPrimitive);
      }

    } else if (type === 'THREEDTILE') {
      const url = layer.get('url');
      let layerTileset: Cesium3DTileset | undefined;

      try {
        if (typeof url === 'number' && cesiumIontoken !== "") {
          layerTileset = await Cesium3DTileset.fromIonAssetId(url, {
            instanceFeatureIdLabel: layer.get('name'),
            maximumScreenSpaceError: layer.get('maximumScreenSpaceError'),
            dynamicScreenSpaceError: true,
            show: layer.get('visible'),
          });

        } else if (url === 'OSM-Buildings' && cesiumIontoken !== "") {
          layerTileset = await createOsmBuildingsAsync({
            showOutline: layer.get('showOutline')
          });
        } else if (typeof url === 'string') {
          layerTileset = await Cesium3DTileset.fromUrl(url, {
            maximumScreenSpaceError: layer.get('maximumScreenSpaceError'),
            dynamicScreenSpaceError: true,
            // preloadFlightDestinations: true,
            show: layer.get('visible')
          });
          // layerTileset.debugShowBoundingVolume = true;
          // layerTileset.debugShowContentBoundingVolume = true;
          // layerTileset.debugShowViewerRequestVolume = true;
          // layerTileset.debugWireframe = true;
        }

        const tileset = scene.primitives.add(layerTileset!);
        layer.CesiumTileset = tileset;
        (layer.CesiumTileset as any).OrigoLayerName = layer.get('name');

        if (style !== "default") {
          layerTileset!.style = new Cesium3DTileStyle({ ...style, show });
        } else {
          layerTileset!.style = new Cesium3DTileStyle({ color: "color('white', 1)", show });
        }

      } catch (err) {
        console.error('Error loading 3D Tileset:', err);
      }
    }
  }
}
