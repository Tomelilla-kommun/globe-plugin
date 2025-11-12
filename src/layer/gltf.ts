import {
  Scene,
  HeightReference,
  Cartesian3,
  HeadingPitchRoll,
  Transforms,
  Model,
  Ellipsoid,
  ModelAnimationLoop,
} from 'cesium';

/**
 * Loads a GLTF model into a Cesium scene with optional animation.
 *
 * @param scene - The Cesium Scene to add the model to.
 * @param url - The URL of the GLTF or GLB model.
 * @param lat - The latitude coordinate in degrees.
 * @param lng - The longitude coordinate in degrees.
 * @param height - The height above ellipsoid in meters.
 * @param heightRef - The HeightReference key ('NONE' | 'CLAMP_TO_GROUND' | 'RELATIVE_TO_GROUND').
 * @param animation - Whether to enable looping animation if the model contains it.
 */
export default async function loadModel(
  scene: Scene,
  url: string,
  lat: number,
  lng: number,
  height: number,
  heightRef: keyof typeof HeightReference = 'NONE',
  animation = false
): Promise<void> {
  let animations: any[] | undefined;

  const heightReference = HeightReference[heightRef];
  const position = Cartesian3.fromDegrees(lng, lat, height); // note: Cesium expects (lon, lat)
  const hpr = new HeadingPitchRoll();
  const fixedFrameTransform = Transforms.localFrameToFixedFrameGenerator('north', 'west');

  try {
    const model = await Model.fromGltfAsync({
      url,
      modelMatrix: Transforms.headingPitchRollToFixedFrame(
        position,
        hpr,
        Ellipsoid.WGS84,
        fixedFrameTransform
      ),
      heightReference,
      scene,
      minimumPixelSize: 1,
      gltfCallback: (gltf: any) => {
        animations = gltf.animations;
      }
    });

    scene.primitives.add(model);

    if (animation && animations?.length) {
      model.readyEvent.addEventListener(() => {
        model.activeAnimations.add({
          index: animations!.length - 1,
          loop: ModelAnimationLoop.REPEAT,
          multiplier: 0.5
        });
      });
    }
  } catch (error) {
    console.error(`Failed to load model:`, error);
  }
}
