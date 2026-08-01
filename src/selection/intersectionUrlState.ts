export const INTERSECTION_URL_MATCH_MAX_DISTANCE_METERS = 75;

const INTERSECTION_URL_COORDINATE_DECIMALS = 5;
const INTERSECTION_URL_ZOOM_MIN = 0;
const INTERSECTION_URL_ZOOM_MAX = 19;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface IntersectionUrlSelection extends LatLon {
  zoomLevel: number | null;
}

export function readIntersectionUrlSelection(search: string): IntersectionUrlSelection | null {
  const params = new URLSearchParams(search);
  const lat = parseUrlCoordinate(params.get("lat"));
  const lon = parseUrlCoordinate(params.get("lon"));
  const zoomLevel = parseUrlZoom(params.get("z"));
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon, zoomLevel };
}

export function intersectionSelectionHref(currentHref: string, point: LatLon, zoomLevel: number): string | null {
  const url = new URL(currentHref);
  const lat = point.lat.toFixed(INTERSECTION_URL_COORDINATE_DECIMALS);
  const lon = point.lon.toFixed(INTERSECTION_URL_COORDINATE_DECIMALS);
  const zoom = String(zoomLevel);
  if (url.searchParams.get("lat") === lat && url.searchParams.get("lon") === lon && url.searchParams.get("z") === zoom) {
    return null;
  }

  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  url.searchParams.set("z", zoom);
  return url.toString();
}

function parseUrlCoordinate(value: string | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const coordinate = Number(trimmed);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function parseUrlZoom(value: string | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const zoom = Math.round(Number(trimmed));
  if (!Number.isFinite(zoom) || zoom < INTERSECTION_URL_ZOOM_MIN || zoom > INTERSECTION_URL_ZOOM_MAX) {
    return null;
  }
  return zoom;
}
