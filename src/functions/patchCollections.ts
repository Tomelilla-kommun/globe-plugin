import * as Cesium from 'cesium';
import type { Scene } from 'cesium';

const ON_TOP = Number.POSITIVE_INFINITY;

function patchBillboards(bc: Cesium.BillboardCollection) {
  for (let i = 0; i < bc.length; i++) bc.get(i).disableDepthTestDistance = ON_TOP;
}

function patchLabels(lc: Cesium.LabelCollection) {
  for (let i = 0; i < lc.length; i++) lc.get(i).disableDepthTestDistance = ON_TOP;
}

function patchPoints(pc: Cesium.PointPrimitiveCollection) {
  for (let i = 0; i < pc.length; i++) pc.get(i).disableDepthTestDistance = ON_TOP;
}

function walk(node: any): void {
  if (!node) return;

  if (node instanceof Cesium.BillboardCollection) return patchBillboards(node);
  if (node instanceof Cesium.LabelCollection) return patchLabels(node);
  if (node instanceof Cesium.PointPrimitiveCollection) return patchPoints(node);

  if (node instanceof Cesium.PrimitiveCollection) {
    for (let i = 0; i < node.length; i++) walk(node.get(i));
    return;
  }

  for (const key in node) {
    const val = node[key];
    if (val && typeof val === 'object' && typeof val.get === 'function' && typeof val.length === 'number') {
      walk(val);
    }
  }
}

export default function patchCollections(scene: Scene): void {
  if (scene?.primitives) walk(scene.primitives);
}
