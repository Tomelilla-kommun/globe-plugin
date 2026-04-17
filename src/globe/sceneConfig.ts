import * as Cesium from 'cesium';

import addGLTF from '../layer/gltf';
import add3DTile from '../layer/threedtile';

import type { GLTFAsset, GlobeSettings } from './types';

export const configureScene = (scene: Cesium.Scene, settings: GlobeSettings): void => {
  // @ts-ignore: Ignore error if scene.clock is not writable
  const clock = new Cesium.Clock({
    shouldAnimate: true,  // Enable clock animation for model animations
    multiplier: 1.0
  });
  // @ts-ignore
  scene.clock = clock;
  
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = settings.enableAtmosphere ?? false;
  }
  scene.fog.enabled = !!settings.enableFog;

  const shadowSettings = settings.shadows;
  const shadowMap = scene.shadowMap;
  if (shadowSettings && shadowMap) {
    shadowMap.darkness = shadowSettings.darkness;
    shadowMap.fadingEnabled = shadowSettings.fadingEnabled;
    shadowMap.maximumDistance = shadowSettings.maximumDistance;
    shadowMap.normalOffset = Boolean(shadowSettings.normalOffset);
    shadowMap.size = shadowSettings.size;
    shadowMap.softShadows = shadowSettings.softShadows;
  }

  const ambientOcclusion = scene.postProcessStages.ambientOcclusion;
  if (ambientOcclusion) {
    ambientOcclusion.enabled = false;
    const viewModel = {
      ambientOcclusionOnly: false,
      intensity: 0.3,
      bias: 0.2,
      lengthCap: 30,
      stepSize: 20.0,
      blurStepSize: 4,
    };
    ambientOcclusion.uniforms.ambientOcclusionOnly = Boolean(viewModel.ambientOcclusionOnly);
    ambientOcclusion.uniforms.intensity = Number(viewModel.intensity);
    ambientOcclusion.uniforms.bias = Number(viewModel.bias);
    ambientOcclusion.uniforms.lengthCap = viewModel.lengthCap;
    ambientOcclusion.uniforms.stepSize = Number(viewModel.stepSize);
    ambientOcclusion.uniforms.blurStepSize = Number(viewModel.blurStepSize);
  }
};

export const configureGlobeAppearance = (scene: Cesium.Scene, settings: GlobeSettings): void => {
  const globe = scene.globe;
  globe.depthTestAgainstTerrain = !!settings.depthTestAgainstTerrain;
  globe.showGroundAtmosphere = !!settings.enableGroundAtmosphere;
  globe.enableLighting = !!settings.enableLighting;
  if (settings.skyBox) {
    const url = settings.skyBox.url;
    scene.skyBox = new Cesium.SkyBox({
      sources: {
        positiveX: `${url}${settings.skyBox.images.pX}`,
        negativeX: `${url}${settings.skyBox.images.nX}`,
        positiveY: `${url}${settings.skyBox.images.pY}`,
        negativeY: `${url}${settings.skyBox.images.nY}`,
        positiveZ: `${url}${settings.skyBox.images.pZ}`,
        negativeZ: `${url}${settings.skyBox.images.nZ}`,
      },
    });
  }
};

export const loadTerrainProvider = async (
  scene: Cesium.Scene,
  options: { cesiumTerrainProvider?: string; cesiumIonassetIdTerrain?: number; cesiumIontoken?: string }
): Promise<void> => {
  const { cesiumTerrainProvider, cesiumIonassetIdTerrain, cesiumIontoken } = options;
  if (cesiumTerrainProvider) {
    scene.terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(cesiumTerrainProvider, {
      requestVertexNormals: false,
    });
    return;
  }

  if (cesiumIonassetIdTerrain && cesiumIontoken) {
    scene.terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
      Cesium.IonResource.fromAssetId(cesiumIonassetIdTerrain),
      { requestVertexNormals: true }
    );
    return;
  }

  if (cesiumIontoken) {
    scene.terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true });
  }
};

export const load3DTiles = (scene: Cesium.Scene, map: any, ionToken?: string): void => {
  add3DTile(scene, map, ionToken ?? '');
};

export const loadGltfAssets = (scene: Cesium.Scene, gltfAssets?: GLTFAsset[]): void => {
  gltfAssets?.forEach(({ url, lat, lng, height, heightReference, animation }) => {
    addGLTF(scene, url, lat, lng, height, heightReference, animation);
  });
};
