import {
  Cartographic,
  Math as CesiumMath,
  sampleTerrainMostDetailed,
  Scene,
} from "cesium";
import GeoJSON from "ol/format/GeoJSON";
import { TreeLoadScheduler } from "./TreeLoadScheduler";

export async function loadTrees(
  layer: any,
  scene: Scene,
  modelCfg: any
) {
  const url = `${layer.get("dataSource")}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(
    layer.get("name")
  )}&outputFormat=application/json&srsName=EPSG:4326`;

  const gj = await (await fetch(url)).json();
  const feats = new GeoJSON().readFeatures(gj);

  const cartos: Cartographic[] = [];
  const metas: any[] = [];


  for (const f of feats) {
    const [lon, lat] = (f as any).getGeometry().getCoordinates();
    const spec = f.get(modelCfg.speciesAttr) || "_d";
    const set = modelCfg.species?.[spec];

    const meta = {
      fid: String(f.getId()),
      lon,
      lat,
      height: 0,
      rot: CesiumMath.toRadians(Math.random() * 360),
      scale:
        (parseFloat(f.get(modelCfg.heightAttr || "")) || 1) /
        (set?.modelHeight || modelCfg.baseModelHeight || 1),
      urlHigh: set?.high || modelCfg.high,
      urlMedium: set?.medium || modelCfg.medium,
      urlLow: set?.low || modelCfg.low
    };

    metas.push(meta);
    cartos.push(Cartographic.fromDegrees(lon, lat));
  }


  const TERRAIN_CHUNK_SIZE = 50;
  const scheduler = new TreeLoadScheduler(scene);
  layer.treeScheduler = scheduler;

  if (cartos.length) {
    // Process in chunks so the scheduler can start loading trees from the first
    // chunk while terrain data for later chunks is still being fetched.
    for (let chunkStart = 0; chunkStart < metas.length; chunkStart += TERRAIN_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + TERRAIN_CHUNK_SIZE, metas.length);
      const chunkCartos = cartos.slice(chunkStart, chunkEnd);
      const chunkMetas = metas.slice(chunkStart, chunkEnd);

      await sampleTerrainMostDetailed(scene.terrainProvider, chunkCartos);

      for (let j = 0; j < chunkMetas.length; j++) {
        chunkMetas[j].height = chunkCartos[j].height || 0;
      }

      scheduler.addTrees(chunkMetas);
      // Start the scheduler on the first chunk so loading begins immediately.
      if (chunkStart === 0) scheduler.start();
    }
  } else {
    scheduler.start();
  }

}
