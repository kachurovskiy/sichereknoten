type StreetLookupIndexEntry = number | number[];

interface StreetLookupFile {
  name: string;
  indexes: StreetLookupIndexEntry[];
  osmRoadControlMasks?: number[];
}

interface StreetLookupBundle {
  version: string;
  names: string[];
  files: StreetLookupFile[];
}

interface OsmRoadMetadata {
  roundabout: boolean | null;
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
  if (!file?.osmRoadControlMasks) {
    return unknownOsmRoadMetadata();
  }

  const mask = file.osmRoadControlMasks[rowIndex - 1] ?? 0;
  return {
    roundabout: Boolean(mask & OSM_ROUNDABOUT_MASK),
    trafficSignal: Boolean(mask & OSM_TRAFFIC_SIGNAL_MASK)
  };
}

function unknownOsmRoadMetadata(): OsmRoadMetadata {
  return {
    roundabout: null,
    trafficSignal: null
  };
}

function streetNameForIndex(bundle: StreetLookupBundle, streetIndex: number): string | null {
  return streetIndex > 0 ? bundle.names[streetIndex - 1] ?? null : null;
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
