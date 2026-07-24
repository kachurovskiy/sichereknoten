import { AccidentRecord, AnalysisOptions, AnalysisResult } from "./types";
import { roadUserFocusKey } from "./roadUsers";

export interface ParsedDataCache {
  accidents: AccidentRecord[];
}

export type CacheProgress = (message: string, progress: number) => void;

export interface ParsedDataCacheWriteOptions {
  chunkSize?: number;
  delayBetweenChunksMs?: number;
}

interface CacheMeta {
  key: "active";
  version: string;
  schemaVersion?: number;
  accidentChunks: number;
  accidentCount: number;
  createdAt: number;
}

interface AnalysisCacheRecord {
  id: string;
  dataVersion: string;
  appVersion: string;
  optionsKey: string;
  result: AnalysisResult;
  createdAt: number;
}

const DB_NAME = "sichere-knoten-cache";
const DB_VERSION = 3;
const META_STORE = "meta";
const CHUNK_STORE = "chunks";
const ANALYSIS_STORE = "analysis";
const META_KEY = "active";
const DEFAULT_ACCIDENT_CHUNK_SIZE = 25000;
const PARSED_DATA_SCHEMA_VERSION = 9;

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>;
};

export async function readParsedDataCache(version: string, onProgress: CacheProgress): Promise<ParsedDataCache | null> {
  if (!("indexedDB" in window)) {
    return null;
  }

  try {
    const db = await openCacheDb();
    const meta = await getValue<CacheMeta>(db, META_STORE, META_KEY);
    if (!meta || meta.version !== version || meta.schemaVersion !== PARSED_DATA_SCHEMA_VERSION) {
      db.close();
      return null;
    }

    const accidents: AccidentRecord[] = [];
    for (let index = 0; index < meta.accidentChunks; index += 1) {
      const chunk = await getValue<AccidentRecord[]>(db, CHUNK_STORE, chunkKey(version, "accidents", index));
      if (!chunk) {
        db.close();
        return null;
      }
      appendItems(accidents, chunk);
      onProgress(`Loading cached accidents ${index + 1}/${meta.accidentChunks}.`, Math.min(45, 8 + index));
      await yieldToBrowser();
    }

    db.close();
    return accidents.length === meta.accidentCount ? { accidents } : null;
  } catch {
    return null;
  }
}

export async function writeParsedDataCache(
  version: string,
  accidents: AccidentRecord[],
  onProgress: CacheProgress,
  options: ParsedDataCacheWriteOptions = {}
): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  const chunkSize = normalizedChunkSize(options.chunkSize);
  const delayBetweenChunksMs = normalizedDelay(options.delayBetweenChunksMs);
  const db = await openCacheDb();
  try {
    await clearStore(db, META_STORE);
    await clearStore(db, CHUNK_STORE);
    await clearStore(db, ANALYSIS_STORE);

    const accidentChunks = Math.ceil(accidents.length / chunkSize);

    for (let index = 0; index < accidentChunks; index += 1) {
      const chunk = accidents.slice(index * chunkSize, (index + 1) * chunkSize);
      await putValue(db, CHUNK_STORE, { id: chunkKey(version, "accidents", index), value: chunk });
      onProgress(`Caching parsed accidents ${index + 1}/${accidentChunks}.`, Math.min(72, 62 + Math.floor((index / accidentChunks) * 10)));
      await yieldToBrowser(delayBetweenChunksMs);
    }

    const meta: CacheMeta = {
      key: META_KEY,
      version,
      schemaVersion: PARSED_DATA_SCHEMA_VERSION,
      accidentChunks,
      accidentCount: accidents.length,
      createdAt: Date.now()
    };
    await putValue(db, META_STORE, meta);
  } finally {
    db.close();
  }
}

export async function readAnalysisCache(
  dataVersion: string,
  appVersion: string,
  options: AnalysisOptions
): Promise<AnalysisResult | null> {
  if (!("indexedDB" in window)) {
    return null;
  }

  const optionsKey = analysisOptionsKey(options);
  try {
    const db = await openCacheDb();
    const record = await getValue<AnalysisCacheRecord>(db, ANALYSIS_STORE, analysisCacheKey(dataVersion, appVersion, optionsKey));
    db.close();

    if (!record || record.dataVersion !== dataVersion || record.appVersion !== appVersion || record.optionsKey !== optionsKey) {
      return null;
    }
    return record.result;
  } catch {
    return null;
  }
}

export async function writeAnalysisCache(
  dataVersion: string,
  appVersion: string,
  options: AnalysisOptions,
  result: AnalysisResult
): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  const optionsKey = analysisOptionsKey(options);
  const record: AnalysisCacheRecord = {
    id: analysisCacheKey(dataVersion, appVersion, optionsKey),
    dataVersion,
    appVersion,
    optionsKey,
    result,
    createdAt: Date.now()
  };

  const db = await openCacheDb();
  try {
    await putValue(db, ANALYSIS_STORE, record);
  } finally {
    db.close();
  }
}

function normalizedChunkSize(value: number | undefined): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ACCIDENT_CHUNK_SIZE;
  return Math.max(1, Math.trunc(normalized));
}

function normalizedDelay(value: number | undefined): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.trunc(normalized));
}

export async function resetAppStorage(): Promise<void> {
  clearWebStorage("localStorage");
  clearWebStorage("sessionStorage");

  await Promise.allSettled([deleteCacheStorage(), deleteIndexedDbStorage()]);
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ANALYSIS_STORE)) {
        db.createObjectStore(ANALYSIS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB cache."));
  });
}

function getValue<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => {
      const result = request.result;
      if (storeName === CHUNK_STORE && result && typeof result === "object" && "value" in result) {
        resolve(result.value as T);
      } else {
        resolve((result as T | undefined) ?? null);
      }
    };
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${String(key)}.`));
  });
}

function putValue(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not write ${storeName}.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not write ${storeName}.`));
  });
}

function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not clear ${storeName}.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not clear ${storeName}.`));
  });
}

function clearWebStorage(storageKey: "localStorage" | "sessionStorage"): void {
  try {
    window[storageKey].clear();
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

async function deleteCacheStorage(): Promise<void> {
  if (!("caches" in window)) {
    return;
  }

  const cacheNames = await window.caches.keys();
  await Promise.all(cacheNames.map((name) => window.caches.delete(name)));
}

async function deleteIndexedDbStorage(): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  const databaseNames = new Set<string>([DB_NAME]);
  for (const name of await indexedDbDatabaseNames()) {
    databaseNames.add(name);
  }

  await Promise.all(Array.from(databaseNames).map(deleteIndexedDbDatabase));
}

async function indexedDbDatabaseNames(): Promise<string[]> {
  const dbFactory = indexedDB as IndexedDbFactoryWithDatabases;
  if (!dbFactory.databases) {
    return [];
  }

  try {
    const databases = await dbFactory.databases();
    return databases
      .map((database) => database.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

function deleteIndexedDbDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => window.setTimeout(resolve, 500);
  });
}

function chunkKey(version: string, type: "accidents", index: number): string {
  return `${version}:${type}:${index}`;
}

function analysisCacheKey(dataVersion: string, appVersion: string, optionsKey: string): string {
  return `${dataVersion}:${appVersion}:${optionsKey}`;
}

function analysisOptionsKey(options: AnalysisOptions): string {
  const years = Array.from(options.years).sort((a, b) => a - b).join(",");
  return [
    `cluster=${options.clusterRadiusMeters}`,
    `min=${options.minAccidents}`,
    `years=${years || "all"}`,
    `roadUsers=${roadUserFocusKey(options.roadUserFocus) || "all"}`,
    `state=${options.stateCode}`,
    `fatalWeight=${options.severityPercent.fatalWeight}`,
    `seriousWeight=${options.severityPercent.seriousWeight}`,
    `fullSample=${options.severityPercent.fullSampleAccidents}`,
    `trendYears=${options.severityPercent.trendYears}`,
    `trendDead=${options.severityPercent.trendDeadZone}`,
    `trendFull=${options.severityPercent.trendFullSignal}`,
    `trendMax=${options.severityPercent.maxTrendAdjustment}`,
    `severityCap=${options.severityPercent.maxSeverityPercent}`
  ].join("|");
}

function appendItems<T>(target: T[], items: T[]): void {
  for (const item of items) {
    target.push(item);
  }
}

function yieldToBrowser(delayMs = 0): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}
