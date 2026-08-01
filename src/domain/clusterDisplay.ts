import { escapeHtml } from "../shared/html";
import { tr } from "../shared/i18n";
import type { AccidentRecord, IntersectionCluster } from "./types";

const STREET_NAME_SEPARATOR = " \u00d7 ";

interface AccidentHolder {
  accident: AccidentRecord;
}

export function formatOsmBoolean(value: boolean | null | undefined): string {
  if (value === true) {
    return tr("details.yes");
  }
  if (value === false) {
    return tr("details.no");
  }
  return tr("details.unknown");
}

export function renderOsmBooleanBadge(value: boolean | null | undefined): string {
  const label = formatOsmBoolean(value);
  const state = value === true ? "yes" : value === false ? "no" : "unknown";
  return `<span class="osm-feature-pill osm-feature-${state}">${escapeHtml(label)}</span>`;
}

export function clusterStreetNamesForDisplay(cluster: IntersectionCluster, records: AccidentHolder[] = []): string[] {
  const storedNames = uniqueStreetNames(Array.isArray(cluster.streetNames) ? cluster.streetNames : []);
  return storedNames.length > 0 ? storedNames : uniqueStreetNames(records.flatMap(({ accident }) => accidentStreetNamesForDisplay(accident)));
}

export function accidentStreetNamesForDisplay(accident: AccidentRecord): string[] {
  return uniqueStreetNames(Array.isArray(accident.streetNames) && accident.streetNames.length > 0 ? accident.streetNames : [accident.streetName]);
}

export function uniqueStreetNames(values: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLocaleLowerCase("de");
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export function clusterStreetLabel(streetNames: string[]): string {
  return displayStreetNames(streetNames).length === 1 ? tr("details.street") : tr("details.streets");
}

export function formatClusterStreetNames(streetNames: string[]): string {
  return displayStreetNames(streetNames).join(STREET_NAME_SEPARATOR);
}

export function displayStreetNames(streetNames: string[]): string[] {
  return uniqueStreetNames(streetNames.map(formatStreetNameForDisplay));
}

export function formatStreetNameForDisplay(streetName: string): string {
  return streetName.replace(/\b(A|B|L|K|S|St)\s+(\d+[a-z]?)\b/gi, (_match, prefix: string, routeNumber: string) => {
    const normalizedPrefix = prefix.length === 2 ? "St" : prefix.toUpperCase();
    return `${normalizedPrefix}${routeNumber}`;
  });
}

export function formatAccidentStreetNames(accident: AccidentRecord, streetOrder: string[] = []): string | null {
  const streetNames = orderStreetNamesForCrossing(accidentStreetNamesForDisplay(accident), streetOrder);
  return streetNames.length > 0 ? formatClusterStreetNames(streetNames) : null;
}

export function orderStreetNamesForCrossing(streetNames: string[], streetOrder: string[]): string[] {
  if (streetNames.length < 2 || streetOrder.length === 0) {
    return streetNames;
  }

  const rankByName = new Map(streetOrder.map((name, index) => [streetNameSortKey(name), index]));
  return streetNames.slice().sort((a, b) => {
    const aRank = rankByName.get(streetNameSortKey(a)) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankByName.get(streetNameSortKey(b)) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.localeCompare(b, "de", { sensitivity: "base" });
  });
}

export function clusterAreaText(cluster: IntersectionCluster): string {
  const seen = new Set<string>();
  return [cluster.stateName, cluster.administrativeRegionName, cluster.districtName, cluster.municipalityName]
    .map((part) => (part ? cleanAreaNameForDisplay(part) : ""))
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      const key = normalizedAreaNameKey(part);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(", ");
}

export function cleanAreaNameForDisplay(name: string): string {
  const withoutAdministrativePrefix = name
    .trim()
    .replace(/^fr\u00fcher:\s*/i, "")
    .replace(/^Reg\.-Bez\.\s*/i, "")
    .replace(/^Regierungsbezirk\s+/i, "");
  const parts = withoutAdministrativePrefix
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  while (parts.length > 1 && isOfficialAreaSuffix(parts[parts.length - 1])) {
    parts.pop();
  }

  return parts.join(", ") || withoutAdministrativePrefix || name;
}

export function normalizedAreaNameKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de");
}

export function isCityTitleSuffix(value: string): boolean {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de");
  return normalized === "stadt" || normalized.endsWith("stadt") || normalized.startsWith("stadt ");
}

export function clusterLocation(cluster: IntersectionCluster): string {
  return escapeHtml(clusterLocationText(cluster));
}

export function clusterLocationText(cluster: IntersectionCluster): string {
  return cluster.municipalityName ?? cluster.districtName ?? cluster.administrativeRegionName ?? `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
}

export function compareClusterCoreMetric(a: IntersectionCluster, b: IntersectionCluster): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount ||
    clusterLocationText(a).localeCompare(clusterLocationText(b), "de", { sensitivity: "base" })
  );
}

function isOfficialAreaSuffix(value: string): boolean {
  const normalized = normalizedAreaNameKey(value);
  return isCityTitleSuffix(value) || normalized === "stadtkreis" || normalized === "landkreis" || normalized === "kreisfreie stadt";
}

function streetNameSortKey(name: string): string {
  return name.toLocaleLowerCase("de");
}
