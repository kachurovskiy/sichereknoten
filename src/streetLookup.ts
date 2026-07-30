type StreetLookupIndexEntry = number | number[];

interface StreetLookupFile {
  name: string;
  indexes: StreetLookupIndexEntry[];
  osmRoadControlMasks?: number[];
  osmRoundaboutIndexes?: number[];
}

interface StreetLookupRoundabout {
  lon: number;
  lat: number;
  radiusMeters: number;
  matchRadiusMeters: number;
}

interface StreetLookupBundle {
  version: string;
  names: string[];
  roundabouts?: StreetLookupRoundabout[];
  files: StreetLookupFile[];
}

interface OsmRoadMetadata {
  roundabout: boolean | null;
  roundaboutId: number | null;
  roundaboutLon: number | null;
  roundaboutLat: number | null;
  roundaboutRadiusMeters: number | null;
  roundaboutMatchRadiusMeters: number | null;
  trafficSignal: boolean | null;
}

declare global {
  var __SICHERE_KNOTEN_STREETS__: StreetLookupBundle | undefined;
}

const streetLookupFiles = new Map<string, StreetLookupFile>();
let activeStreetLookupBundle: StreetLookupBundle | null = null;

const OSM_ROUNDABOUT_MASK = 1;
const OSM_TRAFFIC_SIGNAL_MASK = 2;

export function streetNamesForAccident(source: string, rowIndex: number): string[] {
  const bundle = globalThis.__SICHERE_KNOTEN_STREETS__;
  if (!bundle) {
    return [];
  }

  const file = streetLookupFile(bundle, source);
  const entry = file?.indexes[rowIndex - 1] ?? 0;
  return Array.isArray(entry)
    ? entry.map((streetIndex) => streetNameForIndex(bundle, streetIndex)).filter((name): name is string => name !== null)
    : [streetNameForIndex(bundle, entry)].filter((name): name is string => name !== null);
}

export function streetNameForAccident(source: string, rowIndex: number): string | null {
  return streetNamesForAccident(source, rowIndex)[0] ?? null;
}

export function osmRoadMetadataForAccident(source: string, rowIndex: number): OsmRoadMetadata {
  const bundle = globalThis.__SICHERE_KNOTEN_STREETS__;
  if (!bundle) {
    return unknownOsmRoadMetadata();
  }

  const file = streetLookupFile(bundle, source);
  if (!file) {
    return unknownOsmRoadMetadata();
  }

  const hasRoadControlMasks = Array.isArray(file.osmRoadControlMasks);
  const mask = hasRoadControlMasks ? file.osmRoadControlMasks?.[rowIndex - 1] ?? 0 : 0;
  const roundaboutIndex = file.osmRoundaboutIndexes?.[rowIndex - 1] ?? 0;
  const roundabout = roundaboutForIndex(bundle, roundaboutIndex);
  if (!hasRoadControlMasks && !roundabout) {
    return unknownOsmRoadMetadata();
  }

  return {
    roundabout: Boolean(roundabout) || Boolean(mask & OSM_ROUNDABOUT_MASK),
    roundaboutId: roundabout ? roundaboutIndex : null,
    roundaboutLon: roundabout?.lon ?? null,
    roundaboutLat: roundabout?.lat ?? null,
    roundaboutRadiusMeters: roundabout?.radiusMeters ?? null,
    roundaboutMatchRadiusMeters: roundabout?.matchRadiusMeters ?? null,
    trafficSignal: hasRoadControlMasks ? Boolean(mask & OSM_TRAFFIC_SIGNAL_MASK) : null
  };
}

function unknownOsmRoadMetadata(): OsmRoadMetadata {
  return {
    roundabout: null,
    roundaboutId: null,
    roundaboutLon: null,
    roundaboutLat: null,
    roundaboutRadiusMeters: null,
    roundaboutMatchRadiusMeters: null,
    trafficSignal: null
  };
}

function streetNameForIndex(bundle: StreetLookupBundle, streetIndex: number): string | null {
  return streetIndex > 0 ? bundle.names[streetIndex - 1] ?? null : null;
}

function roundaboutForIndex(bundle: StreetLookupBundle, roundaboutIndex: number): StreetLookupRoundabout | null {
  if (roundaboutIndex <= 0 || !Array.isArray(bundle.roundabouts)) {
    return null;
  }
  const roundabout = bundle.roundabouts[roundaboutIndex - 1];
  return isRoundaboutGeometry(roundabout) ? roundabout : null;
}

function isRoundaboutGeometry(value: StreetLookupRoundabout | undefined): value is StreetLookupRoundabout {
  return (
    typeof value?.lon === "number" &&
    Number.isFinite(value.lon) &&
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    typeof value.radiusMeters === "number" &&
    Number.isFinite(value.radiusMeters) &&
    value.radiusMeters >= 0 &&
    typeof value.matchRadiusMeters === "number" &&
    Number.isFinite(value.matchRadiusMeters) &&
    value.matchRadiusMeters >= value.radiusMeters
  );
}

function streetLookupFile(bundle: StreetLookupBundle, source: string): StreetLookupFile | null {
  if (activeStreetLookupBundle !== bundle) {
    streetLookupFiles.clear();
    activeStreetLookupBundle = bundle;
  }

  const normalizedSource = normalizeStreetLookupFileName(source);
  const cached = streetLookupFiles.get(normalizedSource);
  if (cached) {
    return cached;
  }

  const file = bundle.files.find((entry) => normalizeStreetLookupFileName(entry.name) === normalizedSource) ?? null;
  if (file) {
    streetLookupFiles.set(normalizedSource, file);
  }
  return file;
}

function normalizeStreetLookupFileName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? value.toLowerCase();
}
