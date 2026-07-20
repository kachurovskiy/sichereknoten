export interface GeoPoint {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_METERS = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lonLatToMeterPoint(point: GeoPoint): { x: number; y: number } {
  const latRad = point.lat * DEG_TO_RAD;
  return {
    x: point.lon * 111320 * Math.cos(latRad),
    y: point.lat * 110540
  };
}

export function utm32ToWgs84(easting: number, northing: number): GeoPoint {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e = Math.sqrt(f * (2 - f));
  const e1sq = e * e / (1 - e * e);
  const x = easting - 500000;
  const y = northing;
  const lonOrigin = 9;
  const m = y / k0;
  const mu = m / (a * (1 - e ** 2 / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const j1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32;
  const j2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
  const j3 = 151 * e1 ** 3 / 96;
  const j4 = 1097 * e1 ** 4 / 512;
  const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu) + j3 * Math.sin(6 * mu) + j4 * Math.sin(8 * mu);
  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);
  const c1 = e1sq * cosFp ** 2;
  const t1 = tanFp ** 2;
  const n1 = a / Math.sqrt(1 - e ** 2 * sinFp ** 2);
  const r1 = a * (1 - e ** 2) / (1 - e ** 2 * sinFp ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat =
    fp -
    (n1 * tanFp / r1) *
      (d ** 2 / 2 -
        (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * e1sq) * d ** 4 / 24 +
        (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * e1sq - 3 * c1 ** 2) * d ** 6 / 720);
  const lon =
    (d -
      (1 + 2 * t1 + c1) * d ** 3 / 6 +
      (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * e1sq + 24 * t1 ** 2) * d ** 5 / 120) /
      cosFp;
  return { lat: lat * RAD_TO_DEG, lon: lonOrigin + lon * RAD_TO_DEG };
}

export class GeoGridIndex<T extends GeoPoint> {
  private readonly buckets = new Map<string, T[]>();

  constructor(private readonly cellSizeMeters: number) {}

  insert(item: T): void {
    const cell = this.cellFor(item);
    const key = this.key(cell.cx, cell.cy);
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      this.buckets.set(key, [item]);
    }
  }

  nearby(point: GeoPoint): T[] {
    const cell = this.cellFor(point);
    const items: T[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = this.buckets.get(this.key(cell.cx + dx, cell.cy + dy));
        if (bucket) {
          items.push(...bucket);
        }
      }
    }
    return items;
  }

  private cellFor(point: GeoPoint): { cx: number; cy: number } {
    const projected = lonLatToMeterPoint(point);
    return {
      cx: Math.floor(projected.x / this.cellSizeMeters),
      cy: Math.floor(projected.y / this.cellSizeMeters)
    };
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }
}
