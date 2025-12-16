import Layer from 'ol/layer/Layer';
import Source from 'ol/source/Source';
import LayerProperty from 'ol/layer/Property';
import {
  Cesium3DTileStyle,
  ColorGeometryInstanceAttribute,
  Color,
  PerInstanceColorAppearance
} from 'cesium';

const superOptions = {
  render() { }
};
class ThreedTile extends Layer {
  constructor(options) {
    super(superOptions);
    Object.assign(this.values_, options);
    if (options.visible !== undefined) {
      this.set(LayerProperty.VISIBLE, options.visible);
    }
    this.CesiumTileset = undefined;
    this.Opacity = 1;
    this.setVisible = (visible) => {
      this.set(LayerProperty.VISIBLE, visible);
      console.log(this.treeScheduler)
      this.treeScheduler.setVisible(visible);

      if (this.CesiumTileset) {
        this.CesiumTileset.show = visible;
      }

      if (this.CesiumModels) {
        this.CesiumModels.forEach(m => {
          m.show = visible;
        });
      }

      if (this.CesiumExtrusions) {
        this.CesiumExtrusions.forEach(e => {
          e.show = visible;
        });
      }
    };

    this.setSource(new Source({ projection: 'EPSG:3857' || 'EPSG:4326' }));
    this.getMaxResolution = () => 10000000;
    this.getMinResolution = () => 0;
    this.setOpacity = (alpha) => {
      this.Opacity = alpha;
      const regex = /'(.*?)'/;
      if (this.CesiumTileset) {
        if (this.CesiumTileset.style.color.conditionsExpression) {
          const expr = this.CesiumTileset.style.color.conditionsExpression.conditions;
          const cond = expr.map((c) => {
            const col = regex.exec(c[1])[0];
            const string = `color(${col}, ${alpha})`;
            return [c[0], string];
          });
          this.CesiumTileset.style = new Cesium3DTileStyle({
            color: {
              conditions: cond
            }
          });
        } else {
          const expr = this.CesiumTileset.style.color;
          const col = regex.exec(expr.expression)[0];
          const string = `color(${col}, ${alpha})`;
          this.CesiumTileset.style = new Cesium3DTileStyle({
            color: string
          });
        }
      } else if (this.CesiumModels) {
        this.CesiumModels.forEach((model) => {
          model.color = Cesium.Color.WHITE.withAlpha(alpha);
        });
      } else if (this.CesiumExtrusions) {
        console.log(this)
        this.CesiumExtrusions.forEach((primitive) => {
            // get the id you set in the GeometryInstance
          const id = primitive.geometryInstances.id;
          const attributes = primitive.getGeometryInstanceAttributes(id);
          if (!attributes) return;

          let color;
          if (options.extrusion.color) {
            const colorName = options.extrusion.color.toUpperCase();
            color = Color[colorName] || Color.LIGHTGRAY;
          } else {
            color = Color.LIGHTGRAY;
          }

          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color.withAlpha(alpha));
        });
      }
    };
    this.getOpacity = () => this.Opacity;
  }
}
const threedtile = function threedtile(options) {
  // const threedtileOptions = Object.assign(layerOptions);
  return new ThreedTile(options);
};
export { threedtile, ThreedTile };