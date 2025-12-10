import {
  ConstantPositionProperty,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  EllipsoidTerrainProvider,
  Color,
  PostProcessStageComposite,
  PerspectiveFrustum,
  ShadowMap,
  PostProcessStage,
  Camera,
  JulianDate
} from "cesium";
import type { Scene } from "cesium";
import { Math as CesiumMath } from "cesium";
import fsText from "./SensorShadow.fragment.shader";

const fsShader = fsText.replace("export default `", "").replace("`;", "");

interface SensorShadowOptions {
  cameraPosition?: ConstantPositionProperty | Cartesian3;
  viewPosition?: ConstantPositionProperty | Cartesian3;
  viewAreaColor?: Color;
  shadowAreaColor?: Color;
  alpha?: number;
  shadowAlpha?: number;
  frustum?: boolean;
  size?: number;
  depthBias?: number;
}

const defaultValues = {
  cameraPosition: new ConstantPositionProperty(),
  viewPosition: new ConstantPositionProperty(),
  viewAreaColor: new Color(0, 1, 0),
  shadowAreaColor: new Color(1, 0, 0),
  alpha: 0.6,
  shadowAlpha: 0.5,
  frustum: true,
  size: 4096,
  depthBias: .00001,
};

class SensorShadow {
  private scene: Scene | null;
  private shadow: ShadowMap | null = null;
  private post: PostProcessStage | PostProcessStageComposite | null = null;

  private preUpdateFn: (() => void) | null = null;
  private destroyed = false;

  // Internal
  private _size: number;
  private _depthBias: number;
  private _cameraPosition: ConstantPositionProperty;
  private _viewPosition: ConstantPositionProperty;
  private _frustum: boolean;
  private _distance = 0;

  private _viewAreaColor: Color;
  private _shadowAreaColor: Color;
  private _alpha: number;
  private _shadowAlpha: number;

  constructor(scene: Scene, opts: SensorShadowOptions = {}) {
    this.scene = scene;

    const {
      cameraPosition = defaultValues.cameraPosition,
      viewPosition = defaultValues.viewPosition,
      viewAreaColor = defaultValues.viewAreaColor,
      shadowAreaColor = defaultValues.shadowAreaColor,
      alpha = defaultValues.alpha,
      shadowAlpha = defaultValues.shadowAlpha,
      frustum = defaultValues.frustum,
      size = defaultValues.size,
      depthBias = defaultValues.depthBias,
    } = opts;

    this._cameraPosition =
      cameraPosition instanceof ConstantPositionProperty
        ? cameraPosition
        : new ConstantPositionProperty(cameraPosition);

    this._viewPosition =
      viewPosition instanceof ConstantPositionProperty
        ? viewPosition
        : new ConstantPositionProperty(viewPosition);

    this._viewAreaColor = viewAreaColor;
    this._shadowAreaColor = shadowAreaColor;
    this._alpha = alpha;
    this._shadowAlpha = shadowAlpha;
    this._size = size;
    this._frustum = frustum;
    this._depthBias = depthBias;

    this._init();
  }

  /** ------------------------------------------------------------
   * Compact vector getter
   * ------------------------------------------------------------- */
  private get _vectors() {
    const time = JulianDate.now();
    if (!time)
      return { pos: Cartesian3.ZERO, view: Cartesian3.ZERO };

    const get = (p: ConstantPositionProperty) =>
      p.getValue(time) ?? Cartesian3.ZERO;

    let pos = get(this._cameraPosition);
    let view = get(this._viewPosition);

    const dist = Cartesian3.distance(view, pos);
    if (dist > 10000) {
      const t = 1 - 10000 / dist;
      pos = Cartesian3.lerp(pos, view, t, new Cartesian3());
    }

    return { pos, view };
  }

  /** ------------------------------------------------------------
   * Init
   * ------------------------------------------------------------- */
  private _init() {
    this._createShadow(false);
    this._createPostProcess();
    this.scene!.primitives.add(this as any);
  }

  /** ------------------------------------------------------------
   * Shadow creation/updates
   * ------------------------------------------------------------- */
  private _createShadow(updateOnly: boolean) {
    if (!this.scene) return; // guard

    const { pos, view } = this._vectors;
    this._distance = +Cartesian3.distance(view, pos).toFixed(1);

    // Reuse camera if shadow already exists
    let cam: Camera;
    if (updateOnly && this.shadow) {
      cam = (this.shadow as any)._lightCamera;
    } else {
      cam = new Camera(this.scene); // safe now
    }

    cam.position = pos;
    Cartesian3.subtract(view, pos, cam.direction);
    Cartesian3.normalize(cam.direction, cam.direction); // normalize the direction

    cam.frustum = new PerspectiveFrustum({
      fov: CesiumMath.toRadians(130),
      aspectRatio: this.scene.canvas.clientWidth / this.scene.canvas.clientHeight,
      near: 0.1,
      far: this._distance,
    });

    if (!updateOnly || !this.shadow) {
      // @ts-ignore private context
      this.shadow = new ShadowMap({
        // @ts-ignore private context
        context: this.scene.context,
        lightCamera: cam,
        enable: true,
        isSpotLight: true,
        size: this._size,
        maximumDistance: this._distance,
        pointLightRadius: this._distance,
        cascadesEnabled: false,
        fromLightSource: false,
      });
    } else {
      // Keep camera already set above
    }

    const sh: any = this.shadow;
    sh.normalOffset = true;
    sh._terrainBias.depthBias = 0.0;
  }

  /** ------------------------------------------------------------
   * Post-process stage
   * ------------------------------------------------------------- */
  private _createPostProcess() {
    const s = this.scene!;
    const shadow = this.shadow!;
    const sh: any = shadow;
    const bias = sh._isPointLight ? sh._pointBias : sh._primitiveBias;

    this.post = s.postProcessStages.add(
      new PostProcessStage({
        fragmentShader: fsShader,
        uniforms: {
          view_distance: () => this._distance,
          viewArea_color: () => this._viewAreaColor,
          shadowArea_color: () => this._shadowAreaColor,
          percentShade: () => this._alpha,
          shadowAlpha: () => this._shadowAlpha,
          shadowMap: () => sh._shadowMapTexture,
          shadowDepthStart: () => 10.0,                // start fade at 10 meters
          shadowDepthEnd:   () => Math.max(100.0, this._distance), // fully opaque at 100m or _distance
          shadowMap_matrix: () => sh._shadowMapMatrix,
          shadowMap_camera_positionEC: () => sh._lightPositionEC,
          shadowMap_camera_directionEC: () => sh._lightDirectionEC,

          cameraPosition_WC: () => s.camera.positionWC,
          // @ts-ignore: Ignore error if scene.clock is not writable
          viewPosition_WC: () => this._viewPosition.getValue(JulianDate.now()),

          shadowMap_camera_up: () => sh._lightCamera.up,
          shadowMap_camera_dir: () => sh._lightCamera.direction,
          shadowMap_camera_right: () => sh._lightCamera.right,

          ellipsoidInverseRadii: () => {
            const r = s.globe.ellipsoid.radii;
            return new Cartesian3(1 / r.x, 1 / r.y, 1 / r.z);
          },

          shadowMap_texelSizeDepthBiasAndNormalShadingSmooth: () => {
            const size = sh._textureSize;
            const tex = new Cartesian2(1 / size.x, 1 / size.y);
            return Cartesian4.fromElements(tex.x, tex.y, this._depthBias, bias.normalShadingSmooth);
          },

          shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness: () =>
            Cartesian4.fromElements(
              bias.normalOffsetScale,
              sh._distance,
              shadow.maximumDistance,
              sh._darkness
            ),

          exclude_terrain: () => s.terrainProvider instanceof EllipsoidTerrainProvider,
        },
      })
    );

    // Enable PP only when shadow texture exists
    this.preUpdateFn = () => {
      const tex = (this.shadow as any)?._shadowMapTexture;
      this.post!.enabled = !!tex;
    };

    s.preUpdate.addEventListener(this.preUpdateFn);
  }

  /** ------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------- */
  update(frameState: any) {
    if (this.destroyed || !this.scene) return; // guard

    this._createShadow(true);
    if (this.shadow) {
      frameState.shadowMaps.push(this.shadow);
    }
  }


  // In destroy()
  destroy() {
    if (this.destroyed) return;

    const s = this.scene;

    // Remove preUpdate listener and post-process
    if (s && this.preUpdateFn) {
      s.preUpdate.removeEventListener(this.preUpdateFn);
    }
    if (s && this.post) {
      s.postProcessStages.remove(this.post);
    }

    // IMPORTANT: remove the primitive from the scene so update() is no longer called
    if (s) {
      try {
        s.primitives.remove(this as any);
      } catch {}
    }

    this.shadow = null;
    this.post = null;
    this.preUpdateFn = null;
    this.scene = null;

    this.destroyed = true;
  }

  isDestroyed() {
    return this.destroyed;
  }

  /** ------------------------------------------------------------
   * Getters/setters
   * ------------------------------------------------------------- */
  get cameraPosition() { return this._cameraPosition; }
  set cameraPosition(v) {
    this._cameraPosition =
      v instanceof ConstantPositionProperty ? v : new ConstantPositionProperty(v);
  }

  get viewPosition() { return this._viewPosition; }
  set viewPosition(v) {
    this._viewPosition =
      v instanceof ConstantPositionProperty ? v : new ConstantPositionProperty(v);
  }

  get size() { return this._size; }
  set size(v) { this._size = v; }

  get depthBias() { return this._depthBias; }
  set depthBias(v) { this._depthBias = v; }

  get frustum() { return this._frustum; }
  set frustum(v) { this._frustum = v; }

  get distance() { return this._distance; }
  set distance(v) { this._distance = v; }

  get viewAreaColor() { return this._viewAreaColor; }
  set viewAreaColor(v) { this._viewAreaColor = v; }

  get shadowAreaColor() { return this._shadowAreaColor; }
  set shadowAreaColor(v) { this._shadowAreaColor = v; }

  get alpha() { return this._alpha; }
  set alpha(v) { this._alpha = v; }
}

export default SensorShadow;
