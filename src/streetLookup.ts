type StreetLookupIndexEntry = number | number[];

interface StreetLookupFile {
  name: string;
  indexes: StreetLookupIndexEntry[];
}

interface StreetLookupBundle {
  version: string;
  names: string[];
  files: StreetLookupFile[];
}

declare global {
  var __SICHERE_KNOTEN_STREETS__: StreetLookupBundle | undefined;
}

const streetLookupFiles = new Map<string, StreetLookupFile>();
let activeStreetLookupBundle: StreetLookupBundle | null = null;

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
