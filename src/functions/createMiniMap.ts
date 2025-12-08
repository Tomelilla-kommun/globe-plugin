import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import OSM from 'ol/source/OSM';
import * as Cesium from 'cesium';
import { fromLonLat } from 'ol/proj';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Style from 'ol/style/Style';
import CircleStyle from 'ol/style/Circle';
import Fill from 'ol/style/Fill';
import { defaults as defaultInteractions } from 'ol/interaction';
import Polygon from 'ol/geom/Polygon';
import Stroke from 'ol/style/Stroke';
import TileWMS from 'ol/source/TileWMS';

// Helper to create cone coordinates
function getConeCoordinates(camera: Cesium.Camera, distance = 1000, angleDeg = 60) {
  // Step 1: pick a point in front of the camera
  const forward = Cesium.Cartesian3.add(
    camera.position,
    Cesium.Cartesian3.multiplyByScalar(camera.direction, distance, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  // Step 2: convert both center and forward point to lon/lat
  const centerCarto = Cesium.Cartographic.fromCartesian(camera.position);
  const forwardCarto = Cesium.Cartographic.fromCartesian(forward);

  const centerLonLat: [number, number] = [
    Cesium.Math.toDegrees(centerCarto.longitude),
    Cesium.Math.toDegrees(centerCarto.latitude),
  ];
  const forwardLonLat: [number, number] = [
    Cesium.Math.toDegrees(forwardCarto.longitude),
    Cesium.Math.toDegrees(forwardCarto.latitude),
  ];

  // Step 3: convert to map coordinates
  const c = fromLonLat(centerLonLat);
  const f = fromLonLat(forwardLonLat);

  // Step 4: compute heading in 2D
  const heading = Math.atan2(f[1] - c[1], f[0] - c[0]);
  const halfAngle = Cesium.Math.toRadians(angleDeg / 2);

  // Step 5: left/right cone points
  const leftX = c[0] + distance * Math.cos(heading - halfAngle);
  const leftY = c[1] + distance * Math.sin(heading - halfAngle);

  const rightX = c[0] + distance * Math.cos(heading + halfAngle);
  const rightY = c[1] + distance * Math.sin(heading + halfAngle);

  return [[
    c,
    [leftX, leftY],
    [rightX, rightY],
    c
  ]];
}

type Globe = {
  getOlMap: () => Map;
  getOlView: () => View;
  getCesiumScene: () => Cesium.Scene;
};

function getCenterFromCamera(camera: Cesium.Camera) {
  const carto = Cesium.Cartographic.fromCartesian(camera.position);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  return fromLonLat([lon, lat]); // EPSG:3857
}

export function createMiniMap(globe: Globe, containerDiv: HTMLDivElement) {
  const mainView = globe.getOlView();
  const scene = globe.getCesiumScene();
  const camera = scene.camera;

  const miniView = new View({
    center: getCenterFromCamera(camera),
    zoom: 8,
    projection: mainView.getProjection(),
    rotation: 0,
  });

  
// https://kartor.tomelilla.se/geoserver/webservices/wms?REQUEST=GetMap&SERVICE=WMS&VERSION=1.1.1&FORMAT=image%2Fpng&STYLES=&TRANSPARENT=true&LAYERS=webservices%3Atopowebbkartan&TILED=true&WIDTH=256&HEIGHT=256&SRS=EPSG%3A3008&BBOX=169827.1250
  const miniMap = new Map({
    target: undefined,
    layers: [
        new TileLayer({
            source: new TileWMS({
            url: 'https://kartor.tomelilla.se/geoserver/webservices/ows',
            params: {
                LAYERS: 'webservices:topowebbkartan',
                FORMAT: 'image/jpeg',
                // TRANSPARENT: false,
                VERSION: '1.1.1',
            },
            serverType: 'geoserver',
            crossOrigin: 'anonymous',
            })
        })
    ],
    view: miniView,
    controls: [],
        interactions: defaultInteractions({ 
        dragPan: false, 
        mouseWheelZoom: true, 
        pinchZoom: false, 
        doubleClickZoom: true,
        shiftDragZoom: false,
        keyboard: false,
        altShiftDragRotate: false,
        pinchRotate: false
    })
  });

  const preRenderHandler = () => {
    miniView.setCenter(getCenterFromCamera(camera));
  };

  const centerFeature = new Feature({
  geometry: new Point(getCenterFromCamera(camera)) // initial position
});

const centerLayer = new VectorLayer({
  source: new VectorSource({
    features: [centerFeature]
  }),
  style: new Style({
    image: new CircleStyle({
      radius: 5,
      fill: new Fill({ color: 'blue' })
    })
  })
});

// Add to the minimap
miniMap.addLayer(centerLayer);

// Create the feature
const coneFeature = new Feature({
  geometry: new Polygon(getConeCoordinates(camera))
});

// Style it
const coneLayer = new VectorLayer({
  source: new VectorSource({ features: [coneFeature] }),
  style: new Style({
    stroke: new Stroke({ color: 'rgba(126, 92, 92, 0.49)', width: 2 }),
    fill: new Fill({ color: 'rgba(155, 61, 61, 0.36)' })
  })
});

// Add to minimap
miniMap.addLayer(coneLayer);

// Update cone on camera move
const updateCone = () => {
  const coords = getConeCoordinates(camera);
  (coneFeature.getGeometry() as Polygon).setCoordinates(coords);
};

scene.preRender.addEventListener(updateCone);

// Update the dot when minimap center changes
miniView.on('change:center', () => {
  centerFeature.getGeometry()?.setCoordinates(miniView.getCenter()!);
});

  let mounted = false;
  let rafId: number | null = null;

function applyContainerStyle() {
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        Object.assign(containerDiv.style, {
            position: 'absolute',
            top: '',
            right: '0px',
            left: '',
            bottom: '25px',
            width: '100vw',
            height: '30vh',
            zIndex: '10',
            background: 'rgba(255,255,255,0.8)',
            borderRadius: '',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            padding: '0',
            overflow: 'hidden',
            display: 'block',
        });
    } else {
        Object.assign(containerDiv.style, {
            position: 'absolute',
            left: '5px',
            bottom: '35px',
            top: '',
            right: '',
            width: '35vw',
            height: '30vh',
            zIndex: '10',
            background: 'rgba(255,255,255,0.8)',
            borderRadius: '8px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            padding: '0',
            overflow: 'hidden',
            display: 'block',
        });
    }
}

  function mount() {
    if (mounted) return;

    applyContainerStyle();
    miniMap.setTarget(containerDiv);

    scene.preRender.addEventListener(preRenderHandler);

    rafId = requestAnimationFrame(() => {
      miniMap.updateSize();
      miniMap.renderSync();
      rafId = null;
    });

    mounted = true;
  }
  
  function destroy() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Remove Cesium listener
    scene.preRender.removeEventListener(preRenderHandler);

    // Detach OL map and free resources
    miniMap.setTarget(undefined);
    try {
      // OL 6/7: dispose exists; if not, this is harmless
      (miniMap as any).dispose?.();
    } catch { /* ignore */ }

    // Clear layers so sources stop network/timers
    miniMap.getLayers().clear();

    // Hide and empty the container
    containerDiv.style.display = 'none';
    containerDiv.innerHTML = '';

    mounted = false;
  }

  function toggle() {
    if (mounted) {
      destroy();
    } else {
      mount();
    }
  }

  return {
    miniMap,
    mount,
    destroy,
    toggle,
    get isMounted() {
      return mounted;
    },
  };
}