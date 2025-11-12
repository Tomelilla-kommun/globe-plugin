import { getIsStreetMode } from '../globeState';
import * as Cesium from 'cesium';

export default async function CameraControls(scene: Cesium.Scene): Promise<void> {
  function orbitAroundCamera(direction: 'left' | 'right' = 'left', angle = Cesium.Math.toRadians(2)): void {
    const sign = direction === 'right' ? 1 : -1;
    scene.camera.setView({
      destination: scene.camera.positionWC,
      orientation: {
        heading: scene.camera.heading + sign * angle,
        pitch: scene.camera.pitch,
        roll: scene.camera.roll,
      },
    });
  }

  function orbitAroundCenter(direction: 'left' | 'right' = 'left', baseAngle = 0.15): void {
    const screenCenter = new Cesium.Cartesian2(
      scene.canvas.clientWidth / 2,
      scene.canvas.clientHeight / 2
    );

    // Try to pick a position on terrain or 3D tiles
    let center: Cesium.Cartesian3 | undefined = scene.pickPosition(screenCenter);
    if (!Cesium.defined(center)) {
      const ray = scene.camera.getPickRay(screenCenter);
      if (!ray) return;
      const hit = Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84);
      if (!hit) return;
      center = Cesium.Ray.getPoint(ray, hit.start);
    }

    if (!center) return;

    const cameraPosition = Cesium.Cartesian3.clone(scene.camera.positionWC);
    const directionVector = Cesium.Cartesian3.clone(scene.camera.directionWC);
    const upVector = Cesium.Cartesian3.clone(scene.camera.upWC);
    const angle = direction === 'right' ? baseAngle : -baseAngle;

    // Get local ENU transform
    const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const inverse = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());

    // Convert camera position and orientation to local space
    const localPos = Cesium.Matrix4.multiplyByPoint(inverse, cameraPosition, new Cesium.Cartesian3());
    const localDir = Cesium.Matrix4.multiplyByPointAsVector(inverse, directionVector, new Cesium.Cartesian3());
    const localUp = Cesium.Matrix4.multiplyByPointAsVector(inverse, upVector, new Cesium.Cartesian3());

    // Rotate around local Z (up)
    const rotMatrix = Cesium.Matrix3.fromRotationZ(angle);
    const rotatedPos = Cesium.Matrix3.multiplyByVector(rotMatrix, localPos, new Cesium.Cartesian3());
    const rotatedDir = Cesium.Matrix3.multiplyByVector(rotMatrix, localDir, new Cesium.Cartesian3());
    const rotatedUp = Cesium.Matrix3.multiplyByVector(rotMatrix, localUp, new Cesium.Cartesian3());

    const newPos = Cesium.Matrix4.multiplyByPoint(enuTransform, rotatedPos, new Cesium.Cartesian3());
    const newDir = Cesium.Matrix4.multiplyByPointAsVector(enuTransform, rotatedDir, new Cesium.Cartesian3());
    const newUp = Cesium.Matrix4.multiplyByPointAsVector(enuTransform, rotatedUp, new Cesium.Cartesian3());

    scene.camera.setView({
      destination: newPos,
      orientation: {
        direction: Cesium.Cartesian3.normalize(newDir, new Cesium.Cartesian3()),
        up: Cesium.Cartesian3.normalize(newUp, new Cesium.Cartesian3()),
      },
    });
  }

  // --- Camera movement buttons ---
  const btnUp = document.getElementById('cam-up');
  const btnDown = document.getElementById('cam-down');
  const btnLeft = document.getElementById('cam-left');
  const btnRight = document.getElementById('cam-right');

  if (btnUp) {
    btnUp.onclick = () => scene.camera.lookUp(Cesium.Math.toRadians(3));
  }

  if (btnDown) {
    btnDown.onclick = () => scene.camera.lookDown(Cesium.Math.toRadians(3));
  }

  if (btnLeft) {
    btnLeft.onclick = () =>
      getIsStreetMode() ? orbitAroundCamera('left') : orbitAroundCenter('left');
  }

  if (btnRight) {
    btnRight.onclick = () =>
      getIsStreetMode() ? orbitAroundCamera('right') : orbitAroundCenter('right');
  }
}
