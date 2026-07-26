export interface GeoPoint {
  lat: number;
  lon: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function lonLatToMeterPoint(point: GeoPoint): { x: number; y: number } {
  const latRad = point.lat * DEG_TO_RAD;
  return {
    x: point.lon * 111320 * Math.cos(latRad),
    y: point.lat * 110540
  };
}

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const hav =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
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
          for (const item of bucket) {
            items.push(item);
          }
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

function radians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}
