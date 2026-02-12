import Origo from 'Origo';
import proj4 from 'proj4';
import * as Cesium from 'cesium';
import { getMeasuring } from './../globeState';

/**
 * Handles feature info clicks in globe mode (Cesium + Origo integration)
 */

const orientation = new Cesium.HeadingPitchRoll(
  Cesium.Math.toRadians(0.0),
  Cesium.Math.toRadians(-20.0),
  0.0
);

export default function getFeatureInfo(
  scene: Cesium.Scene,
  viewer: any, // Origo viewer (unknown TS types)
  map: any, // Origo map
  featureInfo: any, // Origo featureInfo control
  flyTo: (destination: Cesium.Cartesian3, duration: number, orientation: Cesium.HeadingPitchRoll) => void
): void {
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  const obj2D: Record<string, any> = {};
  const obj3D: Record<string, any> = {};
  const Layer = Origo.ol.layer.Layer;
  const Feature = Origo.ol.Feature;
  const Point = Origo.ol.geom.Point;

  let title: string | undefined;
  let coordinate: number[] | undefined;
  let lon: number;
  let lat: number;
  let alt: number;
  let destination: Cesium.Cartesian3 | undefined;

  handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const feature = scene.pick(click.position);
    const cartesian = scene.pickPosition(click.position);
    if (getMeasuring()) {
      return; // Do not show feature info when measuring
    }

    if (cartesian) {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      lon = Cesium.Math.toDegrees(cartographic.longitude);
      lat = Cesium.Math.toDegrees(cartographic.latitude);
      alt = cartographic.height + 150;
      destination = Cesium.Cartesian3.fromDegrees(lon, lat - 0.006, alt);
      coordinate = [lon, lat];

      const allLayers = map.getAllLayers();

      for (const layer of allLayers) {
        if (
          layer instanceof Origo.ol.layer.Image &&
          layer.isVisible(map.getView()) &&
          layer.getProperties().queryable
        ) {
          const showFeatureInfoData = {
            title: layer.get('title'),
            layerName: layer.get('name'),
            layer
          };

          if (viewer.getProjectionCode() === 'EPSG:3857') {
            coordinate = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
          }

          const featureInfoUrl = layer
            .getSource()
            .getFeatureInfoUrl(
              coordinate,
              map.getView().getResolution(),
              viewer.getProjectionCode(),
              { INFO_FORMAT: 'application/json' }
            );

          if (featureInfoUrl) {
            fetch(featureInfoUrl)
              .then((response) => response.text())
              .then((featureText) => {
                const features = new Origo.ol.format.GeoJSON().readFeatures(featureText);
                featureInfo.showFeatureInfo({ ...showFeatureInfoData, feature: features });
              });
          }
        }
      }
    }

    // Handle Cesium 3D Tiles feature
    if (Cesium.defined(feature) && feature instanceof Cesium.Cesium3DTileFeature) {
      const layerName = (feature.primitive as any).OrigoLayerName;
      const propertyIds = feature.getPropertyIds();
      const contentItems: string[] = [];

      if (destination) {
        flyTo(destination, 3, orientation);
      }

      if (viewer.getProjectionCode() === 'EPSG:3857') {
        coordinate = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
      }

      propertyIds.forEach((propertyId: string) => {
        const propValue = feature.getProperty(propertyId);
        title = feature.getProperty('name') || 'Anonym';
        if (title === undefined) {
          title = `#ID: ${feature.getProperty('elementId')}`;
        }
        if (propValue !== undefined) {
          const content = `<ul><li><b>${propertyId
            .split(/(?:#|:)+/)
            .pop()
            ?.replace(/^\w/, (c) => c.toUpperCase())}:</b> ${propValue}</li>`;
          contentItems.push(content);
        }
      });

      obj3D.title = title;
      obj3D.layerName = layerName;
      obj3D.layer = new Layer({});
      obj3D.feature = new Feature({
        geometry: new Point(coordinate ?? [0, 0]),
        content: `${contentItems.join(' ')}</ul>`
      });

      featureInfo.showFeatureInfo(obj3D);
    }
    // Handle case where no feature was picked
    else if (!Cesium.defined(feature)) {
      featureInfo.clear();
    }
    // Handle 2D vector features linked to Cesium primitives
    else if ((feature.primitive as any).olFeature) {
      // if (destination) flyTo(destination, 3, orientation);
      coordinate = (feature.primitive as any).olFeature.getGeometry().getCoordinates();
      const primitive = (feature.primitive as any).olFeature;
      const layer = (feature.primitive as any).olLayer;
      obj2D.layer = layer;
      obj2D.layerName = layer.get('name');
      obj2D.feature = primitive;

      featureInfo.showFeatureInfo(obj2D);
    }

    // Always clear previous feature info
    featureInfo.clear();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
