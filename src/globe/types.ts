export type CleanupFn = () => void;

export interface GLTFAsset {
  url: string;
  lat: number;
  lng: number;
  height: number;
  heightReference?: any;
  animation?: any;
}

export interface SkyBoxSettings {
  url: string;
  images: { pX: string; nX: string; pY: string; nY: string; pZ: string; nZ: string };
}

export interface ShadowSettings {
  darkness: number;
  fadingEnabled: boolean;
  maximumDistance: number;
  normalOffset: number;
  size: number;
  softShadows: boolean;
}

export interface GlobeSettings {
  enableAtmosphere?: boolean;
  enableFog?: boolean;
  shadows?: ShadowSettings;
  depthTestAgainstTerrain?: boolean;
  showGroundAtmosphere?: boolean;
  skyBox?: SkyBoxSettings | false;
}

export type GeoJsonFeatureCollection = { type: 'FeatureCollection'; features: any[] };
