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

  const miniMap = new Map({
    target: undefined,
    layers: [new TileLayer({ source: new OSM() })],
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

// Update the dot when minimap center changes
miniView.on('change:center', () => {
  centerFeature.getGeometry()?.setCoordinates(miniView.getCenter()!);
});

  let mounted = false;
  let rafId: number | null = null;

  function applyContainerStyle() {
    Object.assign(containerDiv.style, {
      position: 'absolute',
      left: '130px',
      bottom: '40px',
      width: '300px',
      height: '200px',
      zIndex: '9999',
      background: 'rgba(255,255,255,0.8)',
      borderRadius: '8px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
      padding: '0',
      overflow: 'hidden',
      display: 'block',
    });
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