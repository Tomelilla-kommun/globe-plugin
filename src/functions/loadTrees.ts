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


  if (cartos.length) {
    await sampleTerrainMostDetailed(scene.terrainProvider, cartos);
    for (let i = 0; i < metas.length; i++) {
      metas[i].height = cartos[i].height || 0;
    }
  }

  const scheduler = new TreeLoadScheduler(scene);

  for (const meta of metas) {
    scheduler.addTree(meta);
  }

  scheduler.start();

}
