import pako from 'pako';

const roundCoord = (coord: number, decimals = 6) => {
  const factor = 10 ** decimals;
  return Math.round(coord * factor) / factor;
};

const roundPolygonCoordinates = (coordinates: any, decimals = 6) => {
  if (!Array.isArray(coordinates)) return coordinates;
  // Polygon coordinates: [ [ [lng, lat], ... ] , ... ]
  return coordinates.map((ring: any) => {
    if (!Array.isArray(ring)) return ring;
    return ring.map((pos: any) => {
      if (!Array.isArray(pos)) return pos;
      return pos.map((value: any, index: number) => {
        if (index < 2 && typeof value === 'number') return roundCoord(value, decimals);
        return value;
      });
    });
  });
};

export const roundGeoJsonForShare = (geojson: any, decimals = 6) => {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  return {
    ...geojson,
    features: features.map((f: any) => {
      if (f?.geometry?.type !== 'Polygon') return f;
      return {
        ...f,
        geometry: {
          ...f.geometry,
          coordinates: roundPolygonCoordinates(f.geometry.coordinates, decimals),
        },
      };
    }),
  };
};

const encodeBytesToBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decodeBase64UrlToBytes = (base64Url: string): Uint8Array => {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const encodeCompressedJsonToBase64Url = (value: unknown) => {
  const jsonStr = JSON.stringify(value);
  const compressed = pako.deflate(jsonStr, { level: 9 });
  return encodeBytesToBase64Url(compressed);
};

export const decodeCompressedBase64UrlToJson = (payload: string) => {
  const bytes = decodeBase64UrlToBytes(payload);
  const jsonStr = pako.inflate(bytes, { to: 'string' });
  return JSON.parse(jsonStr);
};
