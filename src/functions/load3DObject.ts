import { Cartographic, Math as CesiumMath, sampleTerrainMostDetailed, Scene } from "cesium";
import GeoJSON from "ol/format/GeoJSON";
import { Object3DLoadScheduler, ObjectMeta } from "./Object3DLoadScheduler";

interface ModelConfig {
  type?: string;
  height?: string;
  rotation?: string;
  baseModelHeight?: number;
  types?: Record<string, { baseModel: string; modelHeight?: number; animated?: boolean }>;
}

/** Load 3D objects from WFS and place on terrain */
export async function load3DObject(layer: any, scene: Scene, cfg: ModelConfig) {
  try {
    const url = `${layer.get("dataSource")}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(layer.get("name"))}&outputFormat=application/json&srsName=EPSG:4326`;
    const res = await fetch(url);
    if (!res.ok) return;
    
    const features = new GeoJSON().readFeatures(await res.json());
    if (!features.length) return;

    const typeAttr = cfg.type || "type";
    const heightAttr = cfg.height || "height";
    const rotAttr = cfg.rotation || "rotation";
    const metas: ObjectMeta[] = [];
    const cartos: Cartographic[] = [];

    for (const f of features) {
      const geom = (f as any).getGeometry?.();
      if (!geom) continue;
      
      const [lon, lat] = geom.getCoordinates();
      const typeCfg = cfg.types?.[f.get(typeAttr) as string];
      if (!typeCfg?.baseModel) continue;

      const h = parseFloat(f.get(heightAttr)) || 1;
      const mh = typeCfg.modelHeight || cfg.baseModelHeight || 1;
      const rotVal = f.get(rotAttr);
      const rot = rotVal != null && !isNaN(parseFloat(rotVal)) 
        ? CesiumMath.toRadians(parseFloat(rotVal)) 
        : CesiumMath.toRadians(Math.random() * 360);

      metas.push({ fid: String(f.getId()), lon, lat, height: 0, rot, scale: h / mh, url: typeCfg.baseModel, animated: typeCfg.animated === true });
      cartos.push(Cartographic.fromDegrees(lon, lat));
    }

    if (!metas.length) return;

    await sampleTerrainMostDetailed(scene.terrainProvider, cartos);
    metas.forEach((m, i) => m.height = cartos[i].height || 0);

    const scheduler = new Object3DLoadScheduler(scene);
    layer.objectScheduler = scheduler;
    scheduler.addObjects(metas);
    await scheduler.start();
  } catch (e) {
    console.error('[load3DObject] Error:', e);
  }
}
