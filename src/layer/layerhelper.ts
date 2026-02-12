import Layer from 'ol/layer/Layer';
import LayerProperty from 'ol/layer/Property';
import Source from 'ol/source/Source';
import type { Options as LayerOptions } from 'ol/layer/Layer';
import type { Options as SourceOptions } from 'ol/source/Source';
import {
  Cesium3DTileStyle,
  Color,
  ColorGeometryInstanceAttribute
} from 'cesium';

type ConditionTuple = [string, string];

interface TileColorExpression {
  conditionsExpression?: {
    conditions: ConditionTuple[];
  };
  expression?: string;
}

interface ExtrusionOptions {
  color?: string;
}

export interface ThreedTileOptions extends Record<string, unknown> {
  visible?: boolean;
  extrusion?: ExtrusionOptions;
}

interface TreeScheduler {
  setVisible: (visible: boolean) => void;
}

interface CesiumModelLike {
  show: boolean;
  color?: Color;
}

interface CesiumExtrusionLike {
  show: boolean;
  geometryInstances: {
    id: string | number;
  };
  getGeometryInstanceAttributes: (
    id: string | number
  ) => { color?: Uint8Array } | undefined;
}

interface CesiumTilesetLike {
  show: boolean;
  style?: Cesium3DTileStyle & {
    color?: TileColorExpression;
  };
}

const superOptions: LayerOptions<Source> = {
  render() {
    return document.createElement('div');
  }
};

const defaultSourceOptions: SourceOptions = {
  projection: 'EPSG:3857'
};

const COLOR_TOKEN_REGEX = /'(.*?)'/;

const getColorToken = (value: string): string | null =>
  value.match(COLOR_TOKEN_REGEX)?.[0] ?? null;

const toggleVisibility = (items?: Array<{ show: boolean }>) => {
  items?.forEach((item) => {
    item.show = !item.show;
  });
};

class ThreedTile extends Layer<Source> {
  public treeScheduler?: TreeScheduler;
  public CesiumTileset?: CesiumTilesetLike;
  public CesiumModels?: CesiumModelLike[];
  public CesiumExtrusions?: CesiumExtrusionLike[];
  public Opacity = 1;

  private readonly tileOptions: ThreedTileOptions;

  constructor(options: ThreedTileOptions = {}) {
    super(superOptions);
    this.tileOptions = options;
    const layerInternal = this as unknown as {
      values_: Record<string, unknown>;
    };
    Object.assign(layerInternal.values_, options);

    if (options.visible !== undefined) {
      this.set(LayerProperty.VISIBLE, options.visible);
    }

    this.setSource(new Source(defaultSourceOptions));
  }

  public override setVisible(visible: boolean): void {
    this.set(LayerProperty.VISIBLE, visible);
    this.treeScheduler?.setVisible(visible);

    if (this.CesiumTileset) {
      this.CesiumTileset.show = !this.CesiumTileset.show;
      return;
    }

    if (this.CesiumModels) {
      toggleVisibility(this.CesiumModels);
      return;
    }

    toggleVisibility(this.CesiumExtrusions);
  }

  public override getMaxResolution(): number {
    return 10_000_000;
  }

  public override getMinResolution(): number {
    return 0;
  }

  public override setOpacity(alpha: number): void {
    this.Opacity = alpha;

    if (this.CesiumTileset?.style?.color) {
      this.applyTilesetOpacity(alpha);
      return;
    }

    this.CesiumModels?.forEach((model) => {
      model.color = Color.WHITE.withAlpha(alpha);
    });

    if (this.CesiumExtrusions) {
      this.applyExtrusionOpacity(alpha);
    }
  }

  public override getOpacity(): number {
    return this.Opacity;
  }

  private applyTilesetOpacity(alpha: number): void {
    const colorStyle = this.CesiumTileset?.style?.color as TileColorExpression | undefined;
    if (!colorStyle) {
      return;
    }

    if (colorStyle.conditionsExpression?.conditions) {
      const conditions = colorStyle.conditionsExpression.conditions.map(
        ([condition, expression]): ConditionTuple => {
          const token = getColorToken(expression) ?? expression;
          return [condition, `color(${token}, ${alpha})`];
        }
      );

      this.CesiumTileset!.style = new Cesium3DTileStyle({
        color: { conditions }
      });

      return;
    }

    const token =
      typeof colorStyle.expression === 'string'
        ? getColorToken(colorStyle.expression)
        : null;

    if (token) {
      this.CesiumTileset!.style = new Cesium3DTileStyle({
        color: `color(${token}, ${alpha})`
      });
    }
  }

  private applyExtrusionOpacity(alpha: number): void {
    this.CesiumExtrusions?.forEach((primitive) => {
      const attributes = primitive.getGeometryInstanceAttributes(
        primitive.geometryInstances.id
      );
      if (!attributes) {
        return;
      }

      const colorName = this.tileOptions.extrusion?.color?.toUpperCase();
      const namedColors = Color as unknown as Record<string, Color>;
      const baseColor = namedColors[colorName ?? ''] ?? Color.LIGHTGRAY;

      attributes.color = ColorGeometryInstanceAttribute.toValue(
        baseColor.withAlpha(alpha)
      );
    });
  }
}

const threedtile = function threedtile(options: ThreedTileOptions = {}) {
  return new ThreedTile(options);
};

export { threedtile, ThreedTile };
