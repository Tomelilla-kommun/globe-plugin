import * as Cesium from 'cesium';
import type { Scene } from 'cesium';

const ON_TOP = Number.POSITIVE_INFINITY; // fully disables depth testing for sprites
const eye = new Cesium.Cartesian3(0, 0, -1.0e6); // optional nudge toward camera

function patchBillboards(bc: Cesium.BillboardCollection) {
  for (let i = 0; i < bc.length; i++) {
    const it = bc.get(i);
    it.disableDepthTestDistance = ON_TOP;
    // it.eyeOffset = eye;
  }
}

function patchLabels(lc: Cesium.LabelCollection) {
  for (let i = 0; i < lc.length; i++) {
    const it = lc.get(i);
    it.disableDepthTestDistance = ON_TOP;
    // it.eyeOffset = eye;
  }
}

function patchPoints(pc: Cesium.PointPrimitiveCollection) {
  for (let i = 0; i < pc.length; i++) {
    const it = pc.get(i);
    it.disableDepthTestDistance = ON_TOP;
    // PointPrimitives typically don’t need eyeOffset; add if you see ordering issues:
    // it.eyeOffset = eye;
  }
}

function walk(node: any): void {
  if (!node) return;

  // Direct collection types
  if (node instanceof Cesium.BillboardCollection) {
    patchBillboards(node);
    return;
  }
  if (node instanceof Cesium.LabelCollection) {
    patchLabels(node);
    return;
  }
  if (node instanceof Cesium.PointPrimitiveCollection) {
    patchPoints(node);
    return;
  }

  // A collection of primitives (can contain nested collections or other primitives)
  if (node instanceof Cesium.PrimitiveCollection) {
    for (let i = 0; i < node.length; i++) {
      walk(node.get(i));
    }
    return;
  }

  // Some primitives may expose nested collections via known properties; recurse cautiously if present
  // (Keeps it generic without assuming internal Cesium types)
  for (const key in node) {
    const val = (node as any)[key];
    // Recurse into any child that looks like a collection with "length" and "get"
    if (val && typeof val === 'object' && typeof (val as any).get === 'function' && typeof (val as any).length === 'number') {
      walk(val);
    }
  }
}

export default function patchCollections(scene: Scene): void {
  if (!scene || !scene.primitives) return;
  walk(scene.primitives);
}