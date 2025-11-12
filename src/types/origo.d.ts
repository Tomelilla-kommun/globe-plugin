declare module 'Origo' {
  import type Layer from 'ol/layer/Layer';
  import type ImageLayer from 'ol/layer/Image';
  import type VectorLayer from 'ol/layer/Vector';
  import type Feature from 'ol/Feature';
  import type Geometry from 'ol/geom/Geometry';
  import type Point from 'ol/geom/Point';
  import type GeoJSON from 'ol/format/GeoJSON';
  import type Source from 'ol/source/Source';
  import type View from 'ol/View';

  /** Origo UI submodule */
  interface OrigoUI {
    Component: (options: any) => any;
    Button: (options: any) => OrigoButton;
    Element: (options: any) => OrigoElement;
    dom: {
      html: (htmlString: string) => HTMLElement;
    };
  }

  /** Origo main interface */
  const Origo: {
    ui: OrigoUI;
    ol: {
      layer: {
        Layer: typeof Layer;
        Image: typeof ImageLayer;
        Vector: typeof VectorLayer;
      };
      Feature: typeof Feature;
      geom: {
        Point: typeof Point;
      };
      format: {
        GeoJSON: typeof GeoJSON;
      };
      source: {
        Source: typeof Source;
      };
      View: typeof View;
    };
  };

  export default Origo;

  /** Origo UI element/button definitions */
  export interface OrigoButton {
    getId(): string;
    render(): string;
    hide?(): void;
    unhide?(): void;
  }

  export interface OrigoElement {
    getId(): string;
    render(): string;
  }
}
