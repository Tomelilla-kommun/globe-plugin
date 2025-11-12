import {
  ConstantPositionProperty,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  EllipsoidTerrainProvider,
  Color,
  defaultValue,
  PerspectiveFrustum,
  ShadowMap,
  PostProcessStage,
  Camera
} from 'cesium';
import { Math as CesiumMath } from "cesium";
import text from './SensorShadow.fragment.shader.ts'

const fsShader = (text).replace("export default `", "").replace("`;","");

const defaultValues = {
  cameraPosition: new ConstantPositionProperty(),
  viewPosition: new ConstantPositionProperty(),
  viewAreaColor: new Color(0, 1, 0),
  shadowAreaColor: new Color(1, 0, 0),
  alpha: 0.5,
  frustum: true,
  size: 4096,
  depthBias: 2e-12,
};

/**
 * SensorShadow Class.
 * This class handles the creation, update and management of sensor shadow entities.
 *
 * @property {Object} scene - A reference to the Cesium scene instance.
 * @property {ConstantPositionProperty|PositionProperty|Cartesian3} cameraPosition - The camera position.
 * @property {ConstantPositionProperty|PositionProperty|Cartesian3} viewPosition - The view position.
 * @property {Color} viewAreaColor - The color of the visible area of the sensor shadow.
 * @property {Color} shadowAreaColor - The color of the hidden area of the sensor shadow.
 * @property {number} alpha - The alpha value for the sensor shadow.
 * @property {boolean} frustum - Whether the frustum is enabled.
 * @property {number} size - The size of the sensor shadow.
 */
class SensorShadow {
    /**
     * Constructs a new SensorShadow instance.
     *
     * @param {Object} scene - A reference to the Cesium scene instance.
     * @param {Object} options - An optional configuration object.
     *
     * @example
     * let sensorShadow = new SensorShadow(scene, {
     *   cameraPosition: new Cartesian3(0, 0, 0),
     *   viewPosition: new Cartesian3(1, 1, 1),
     *   viewAreaColor: new Color(0, 1, 0),
     *   shadowAreaColor: new Color(1, 0, 0),
     *   alpha: 0.5,
     *   frustum: true,
     *   size: 512
     * });
     */
    constructor(scene, {
        cameraPosition,
        viewPosition,
        viewAreaColor,
        shadowAreaColor,
        alpha,
        frustum,
        size,
        depthBias
    } = {}) {
        this.scene = scene;
        this._isDestroyed = false;

        this.cameraPosition = typeof cameraPosition?.getValue === 'function'
            ? cameraPosition
            : new ConstantPositionProperty(cameraPosition);

        this.viewPosition = typeof viewPosition?.getValue === 'function'
            ? viewPosition
            : new ConstantPositionProperty(viewPosition);

        this.viewAreaColor = defaultValue(viewAreaColor, defaultValues.viewAreaColor);
        this.shadowAreaColor = defaultValue(shadowAreaColor, defaultValues.shadowAreaColor);
        this.alpha = defaultValue(alpha, defaultValues.alpha);
        this.size = defaultValue(size, defaultValues.size);
        this.frustum = defaultValue(frustum, defaultValues.frustum);
        this.depthBias = defaultValue(depthBias, defaultValues.depthBias);

        if (this.cameraPosition && this.viewPosition) {
            this._addToScene();
        }
    }

    /**
     * Get the actual position of the camera.
     * This method calculates the position vector based on the current time.
     *
     * @private
     * @returns {Cartesian3} The calculated camera position vector.
     */
    get _getVectors() {
        const time = this.scene?.clock?.currentTime;
        if (!time) return { positionVector: Cartesian3.ZERO, viewVector: Cartesian3.ZERO };

        let positionVector = this.cameraPosition.getValue(time);
        let viewVector = this.viewPosition.getValue(time);

        if (!positionVector || !viewVector) return { positionVector: Cartesian3.ZERO, viewVector: Cartesian3.ZERO };

        const distance = Cartesian3.distance(viewVector, positionVector);
        if (distance > 10000) {
            const t = 1 - 10000 / distance;
            positionVector = Cartesian3.lerp(positionVector, viewVector, t, new Cartesian3());
        }

        return { positionVector, viewVector };
    }

    destroy() {
        if (this._isDestroyed) return;

        // Remove pre-update listener
        if (this.preUpdateListener) {
            this.scene?.preUpdate.removeEventListener(this.preUpdateListener);
            this.preUpdateListener = null;
        }

        // Dispose of shadow map
        if (this.viewShadowMap) {
            // Just null it out and let GC handle the rest
            this.viewShadowMap._shadowMapTexture = undefined; // Optional: force release texture
            this.viewShadowMap = null;
        }

        // Remove post-process stage
        if (this.postProcess) {
            this.scene?.postProcessStages.remove(this.postProcess);
            this.postProcess = null;
        }

        // Remove from scene primitives if added
        if (this.scene?.primitives.contains(this)) {
            this.scene.primitives.remove(this);
        }

        // Nullify scene reference
        this.scene = null;

        // Set destroyed flag
        this._isDestroyed = true;

        // Remove all other properties
        for (let property in this) {
            if (Object.prototype.hasOwnProperty.call(this, property)) {
                delete this[property];
            }
        }
    }

    isDestroyed() {
        // Return the destroyed status
        return this._isDestroyed;
    }


    /**
     * Adds the SensorShadow to the scene.
     *
     * @private
     */
    _addToScene() {
        this._createShadowMap();
        this._addPostProcess();

        this.scene.primitives.add(this);

    }

    /**
     * Creates the shadow map.
     *
     * @private
     */
    _createShadowMap(updateOnly) {
        let { positionVector, viewVector } = this._getVectors;

        const distance = Number(
            Cartesian3.distance(viewVector, positionVector).toFixed(1)
        );

        if (distance > 10000) {
            const multiple = 1 - 10000 / distance;
            positionVector = Cartesian3.lerp(
                positionVector,
                viewVector,
                multiple,
                new Cartesian3()
            );
        }

        const scene = this.scene;

        const camera = new Camera(scene);

        camera.position = positionVector;

        camera.direction = Cartesian3.subtract(
            viewVector,
            positionVector,
            new Cartesian3(0, 0, 0)
        );

        camera.up = Cartesian3.normalize(positionVector, new Cartesian3(0, 0, 0));

        camera.frustum = new PerspectiveFrustum({
            fov: CesiumMath.toRadians(120),
            aspectRatio: scene.canvas.clientWidth / scene.canvas.clientHeight,
            near: 0.1,
            far: distance,
        });

        if (!updateOnly) {
            this.viewShadowMap = new ShadowMap({
                lightCamera: camera,
                enable: true,
                isPointLight: false,
                isSpotLight: true,
                cascadesEnabled: false,
                context: scene.context,
                size: this.size,
                pointLightRadius: distance,
                fromLightSource: false,
                maximumDistance: distance,
            });
        } else {
            this.viewShadowMap._lightCamera.position = positionVector;
        }

        this.viewShadowMap.normalOffset = true;
        this.viewShadowMap._terrainBias.depthBias = 0.0;
    }

    /**
     * Adds post processing to the SensorShadow.
     *
     * @private
     */
    _addPostProcess() {
        const SensorShadow = this;

        const viewShadowMap = this.viewShadowMap;
        const primitiveBias = viewShadowMap._isPointLight
            ? viewShadowMap._pointBias
            : viewShadowMap._primitiveBias;
        this.postProcess = this.scene.postProcessStages.add(
            new PostProcessStage({
                fragmentShader: fsShader,
                uniforms: {
                    view_distance: function () {
                        return SensorShadow.distance;
                    },
                    viewArea_color: function () {
                        return SensorShadow.viewAreaColor;
                    },
                    shadowArea_color: function () {
                        return SensorShadow.shadowAreaColor;
                    },
                    percentShade: function () {
                        return SensorShadow.alpha;
                    },
                    shadowMap: function () {
                        return viewShadowMap._shadowMapTexture;
                    },
                    _shadowMap_cascadeSplits: function () {
                        return viewShadowMap._cascadeSplits;
                    },
                    _shadowMap_cascadeMatrices: function () {
                        return viewShadowMap._cascadeMatrices;
                    },
                    _shadowMap_cascadeDistances: function () {
                        return viewShadowMap._cascadeDistances;
                    },
                    shadowMap_matrix: function () {
                        return viewShadowMap._shadowMapMatrix;
                    },
                    shadowMap_camera_positionEC: function () {
                        return viewShadowMap._lightPositionEC;
                    },
                    shadowMap_camera_directionEC: function () {
                        return viewShadowMap._lightDirectionEC;
                    },
                    cameraPosition_WC: function () {
                        return SensorShadow.scene.camera.positionWC;
                    },
                    viewPosition_WC: function () {
                        return SensorShadow.viewPosition.getValue(
                            SensorShadow.scene.clock.currentTime
                        );
                    },
                    shadowMap_camera_up: function () {
                        return viewShadowMap._lightCamera.up;
                    },
                    shadowMap_camera_dir: function () {
                        return viewShadowMap._lightCamera.direction;
                    },
                    shadowMap_camera_right: function () {
                        return viewShadowMap._lightCamera.right;
                    },
                    ellipsoidInverseRadii: function () {
                        let radii = SensorShadow.scene.globe.ellipsoid.radii;
                        return new Cartesian3(1 / radii.x, 1 / radii.y, 1 / radii.z);
                    },
                    shadowMap_texelSizeDepthBiasAndNormalShadingSmooth: function () {
                        var viewShed2D = new Cartesian2();
                        viewShed2D.x = 1 / viewShadowMap._textureSize.x;
                        viewShed2D.y = 1 / viewShadowMap._textureSize.y;

                        return Cartesian4.fromElements(
                            viewShed2D.x,
                            viewShed2D.y,
                            this.depthBias,
                            primitiveBias.normalShadingSmooth,
                            this.combinedUniforms1
                        );
                    },
                    shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness:
                        function () {
                            return Cartesian4.fromElements(
                                primitiveBias.normalOffsetScale,
                                viewShadowMap._distance,
                                viewShadowMap.maximumDistance,
                                viewShadowMap._darkness,
                                this.combinedUniforms2
                            );
                        },
                    exclude_terrain: function () {
                        return (
                            SensorShadow.scene.terrainProvider instanceof
                            EllipsoidTerrainProvider
                        );
                    },
                },
            })
        );

        // If a previous listener was added, remove it
        if (this.preUpdateListener) {
            this.scene.preUpdate.removeEventListener(this.preUpdateListener);
        }

        // Add a new listener
        this.preUpdateListener = () => {
            if (!this.viewShadowMap._shadowMapTexture) {
                this.postProcess.enabled = false;
            } else {
                this.postProcess.enabled = true;
            }
        };

        this.scene.preUpdate.addEventListener(this.preUpdateListener);
    }

    update(frameState) {
        this._createShadowMap(true);
        frameState.shadowMaps.push(this.viewShadowMap);
    }

    get size() {
        return this._size;
    }

    set size(v) {
        this._size = v;
    }

    get depthBias() {
        return this._depthBias;
    }

    set depthBias(v) {
        this._depthBias = v;
    }

    get cameraPosition() {
        return this._cameraPosition;
    }

    set cameraPosition(v) {
        this._cameraPosition = v;
    }

    get viewPosition() {
        return this._viewPosition;
    }

    set viewPosition(v) {
        this._viewPosition = v;
    }

    get frustum() {
        return this._frustum;
    }

    set frustum(v) {
        this._frustum = v;
    }

    get distance() {
        return this._distance;
    }

    set distance(v) {
        this._distance = v;
    }

    get viewAreaColor() {
        return this._viewAreaColor;
    }

    set viewAreaColor(v) {
        this._viewAreaColor = v;
    }

    get shadowAreaColor() {
        return this._shadowAreaColor;
    }

    set shadowAreaColor(v) {
        this._shadowAreaColor = v;
    }

    get alpha() {
        return this._alpha;
    }

    set alpha(v) {
        this._alpha = v;
    }
}

export default SensorShadow;