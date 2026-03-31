import {
  Cartesian3, HeadingPitchRoll, Transforms, Model, Scene, Matrix4, Ellipsoid, ModelAnimationLoop, JulianDate
} from "cesium";

export interface ObjectMeta {
  fid: string;
  lon: number;
  lat: number;
  height: number;
  scale: number;
  rot: number;
  url: string;
  animated?: boolean;
}

/**
 * Loads 3D GLB/GLTF objects with animation support.
 * Uses custom animation loop to bypass OLCesium's frozen clock.
 */
export class Object3DLoadScheduler {
  private readonly scene: Scene;
  private readonly queue: ObjectMeta[] = [];
  private readonly models = new Map<string, Model>();
  private readonly animated: { model: Model; offset: number }[] = [];
  private rafId: number | null = null;
  private t0 = 0;
  private visible = true;

  constructor(scene: Scene) { this.scene = scene; }

  addObjects(metas: ObjectMeta[]) { this.queue.push(...metas); }

  async start() {
    if (!this.queue.length) return;
    if (this.queue.some(m => m.animated)) this.runLoop();
    await Promise.all(this.queue.map(m => this.load(m)));
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.models.forEach(m => !m.isDestroyed?.() && this.scene.primitives.remove(m));
    this.models.clear();
    this.queue.length = 0;
    this.animated.length = 0;
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.models.forEach(m => m.show = v);
  }

  private runLoop() {
    this.scene.requestRenderMode = false;
    this.t0 = performance.now();
    const clock = JulianDate.now();
    let last = this.t0, frame = 0;

    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      frame++;

      JulianDate.addSeconds(clock, dt, clock);

      for (const { model, offset } of this.animated) {
        if (model.isDestroyed?.()) continue;
        const anims = model.activeAnimations as any;
        if (!anims?.update) continue;
        const time = JulianDate.clone(clock);
        JulianDate.addSeconds(time, offset, time);
        try { anims.update(model, { time, frameNumber: frame }); } catch {}
      }

      this.scene.requestRender();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private async load(meta: ObjectMeta) {
    if (this.models.has(meta.fid)) return;
    try {
      const pos = Cartesian3.fromDegrees(meta.lon, meta.lat, meta.height);
      const hpr = new HeadingPitchRoll(meta.rot, 0, 0);
      const tf = Transforms.localFrameToFixedFrameGenerator('north', 'west');
      const mx = Matrix4.multiplyByUniformScale(
        Transforms.headingPitchRollToFixedFrame(pos, hpr, Ellipsoid.WGS84, tf),
        meta.scale, new Matrix4()
      );

      const model = await Model.fromGltfAsync({ url: meta.url, modelMatrix: mx, scene: this.scene, minimumPixelSize: 1 });
      model.show = this.visible;
      this.scene.primitives.add(model);
      this.models.set(meta.fid, model);

      if (meta.animated) {
        const offset = Math.random() * 60, t0 = this.t0;
        model.readyEvent.addEventListener(() => {
          model.activeAnimations.addAll({
            loop: ModelAnimationLoop.REPEAT,
            multiplier: 1.0,
            animationTime: (d: number) => ((performance.now() - t0) / 1000 + offset) % d
          });
          this.animated.push({ model, offset });
        });
      }
    } catch (e) {
      console.error(`Failed to load ${meta.fid}:`, e);
    }
  }
}