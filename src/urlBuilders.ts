import { displayStreetNames, isCityTitleSuffix } from "./clusterDisplay";
import type { AccidentRecord, IntersectionCluster } from "./types";

export interface ClusterMapUrls {
  openStreetMapUrl: string;
  googleMapsUrl: string;
  streetViewUrl: string;
}

interface PressSearchLocation {
  municipalityName: string | null;
  districtName: string | null;
  administrativeRegionName: string | null;
  stateName: string;
}

export function mapUrlsForCluster(cluster: IntersectionCluster): ClusterMapUrls {
  return {
    openStreetMapUrl: openStreetMapUrlForCluster(cluster),
    googleMapsUrl: googleMapsUrlForCluster(cluster),
    streetViewUrl: googleStreetViewUrl(cluster)
  };
}

export function openStreetMapUrlForCluster(cluster: IntersectionCluster): string {
  const { lat, lon } = clusterCoordinateStrings(cluster, 6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

export function googleMapsUrlForCluster(cluster: IntersectionCluster): string {
  const { lat, lon } = clusterCoordinateStrings(cluster, 6);
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

export function googleStreetViewEmbedUrl(cluster: IntersectionCluster): string {
  const { lat, lon } = clusterCoordinateStrings(cluster, 6);
  return `https://www.google.com/maps?layer=c&cbll=${lat},${lon}&cbp=11,0,0,0,0&output=svembed`;
}

export function googleStreetViewUrl(cluster: IntersectionCluster): string {
  const { lat, lon } = clusterCoordinateStrings(cluster, 6);
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
}

export function responsibleAuthoritySearchUrlForCluster(cluster: IntersectionCluster): string {
  const queryParts = [
    "zust\u00e4ndige Stra\u00dfenverkehrsbeh\u00f6rde",
    "Unfallkommission",
    "Verkehrssicherheit",
    "Unfallh\u00e4ufungsstelle",
    "Kreuzung",
    cluster.municipalityName,
    cluster.districtName,
    cluster.administrativeRegionName,
    cluster.stateName,
    `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`
  ].filter((part): part is string => Boolean(part));
  return googleSearchUrl(queryParts);
}

export function pressSearchUrlForCluster(cluster: IntersectionCluster, streetNames: string[]): string {
  const queryParts = ["Unfall", ...displayStreetNames(streetNames), pressSearchPlaceName(cluster)].filter((part): part is string =>
    Boolean(part)
  );
  return googleSearchUrl(queryParts);
}

export function pressSearchUrlForAccident(accident: AccidentRecord): string {
  const queryParts = [
    "Unfall",
    pressSeveritySearchTerm(accident),
    accidentSearchDateLabel(accident),
    pressSearchPlaceName(accident)
  ].filter((part): part is string => Boolean(part));
  return googleSearchUrl(queryParts);
}

export function googleSearchUrl(queryParts: string[]): string {
  return `https://www.google.com/search?q=${encodeURIComponent(queryParts.join(" "))}`;
}

function clusterCoordinateStrings(cluster: IntersectionCluster, decimals: number): { lat: string; lon: string } {
  return {
    lat: cluster.lat.toFixed(decimals),
    lon: cluster.lon.toFixed(decimals)
  };
}

function pressSearchPlaceName(location: PressSearchLocation): string {
  const placeName = location.municipalityName ?? location.districtName ?? location.administrativeRegionName ?? location.stateName;
  return cleanPressSearchPlaceName(placeName);
}

function cleanPressSearchPlaceName(placeName: string): string {
  const parts = placeName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 1 && isCityTitleSuffix(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(", ") || placeName;
}

function accidentSearchDateLabel(accident: AccidentRecord): string {
  if (accident.year && accident.month && accident.day) {
    return `${String(accident.day).padStart(2, "0")}.${String(accident.month).padStart(2, "0")}.${accident.year}`;
  }
  if (accident.year && accident.month) {
    return `${String(accident.month).padStart(2, "0")}.${accident.year}`;
  }
  return accident.year ? String(accident.year) : "";
}

function pressSeveritySearchTerm(accident: AccidentRecord): string {
  switch (accident.category) {
    case 1:
      return "toedlicher Unfall";
    case 2:
      return "schwer verletzt";
    case 3:
      return "leicht verletzt";
    default:
      return "Verkehrsunfall";
  }
}
