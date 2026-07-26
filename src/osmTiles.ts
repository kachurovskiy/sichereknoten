import { clampNumber } from "./math";

export const OSM_TILE_SIZE = 256;

const OSM_TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const osmTileCache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadOsmTile(zoom: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const key = `${zoom}/${x}/${y}`;
  const cached = osmTileCache.get(key);
  if (cached) {
    return cached;
  }

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.referrerPolicy = "origin";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = OSM_TILE_URL_TEMPLATE.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
  });
  osmTileCache.set(key, promise);
  return promise;
}

export function osmWorldPixel(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const clampedLat = clampNumber(lat, -85.05112878, 85.05112878);
  const sinLat = Math.sin(radians(clampedLat));
  const scale = OSM_TILE_SIZE * 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

export function wrapOsmTileX(x: number, tileCount: number): number {
  return ((x % tileCount) + tileCount) % tileCount;
}

export function localMeterOffset(center: { lat: number; lon: number }, point: { lat: number; lon: number }): { x: number; y: number } {
  return {
    x: (point.lon - center.lon) * 111_320 * Math.cos(radians(center.lat)),
    y: (point.lat - center.lat) * 110_540
  };
}

export function maxAbsoluteOffset(fallback: number, offsets: Array<{ x: number; y: number }>): number {
  let maximum = fallback;
  for (const offset of offsets) {
    maximum = Math.max(maximum, Math.abs(offset.x), Math.abs(offset.y));
  }
  return maximum;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
