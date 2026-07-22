import { AccidentRecord, AnalysisOptions, AnalysisResult } from "./types";

export interface ParsedDataCache {
  accidents: AccidentRecord[];
}

export type CacheProgress = (message: string, progress: number) => void;

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
const ACCIDENT_CHUNK_SIZE = 25000;
const PARSED_DATA_SCHEMA_VERSION = 6;

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
      accidents.push(...chunk);
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
  onProgress: CacheProgress
): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  const db = await openCacheDb();
  try {
    await clearStore(db, META_STORE);
    await clearStore(db, CHUNK_STORE);
    await clearStore(db, ANALYSIS_STORE);

    const accidentChunks = Math.ceil(accidents.length / ACCIDENT_CHUNK_SIZE);

    for (let index = 0; index < accidentChunks; index += 1) {
      const chunk = accidents.slice(index * ACCIDENT_CHUNK_SIZE, (index + 1) * ACCIDENT_CHUNK_SIZE);
      await putValue(db, CHUNK_STORE, { id: chunkKey(version, "accidents", index), value: chunk });
      onProgress(`Caching parsed accidents ${index + 1}/${accidentChunks}.`, Math.min(72, 62 + Math.floor((index / accidentChunks) * 10)));
      await yieldToBrowser();
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
    `state=${options.stateCode}`,
    `fatalWeight=${options.severityPercent.fatalWeight}`,
    `seriousWeight=${options.severityPercent.seriousWeight}`,
    `fullSample=${options.severityPercent.fullSampleAccidents}`,
    `trendDead=${options.severityPercent.trendDeadZone}`,
    `trendFull=${options.severityPercent.trendFullSignal}`,
    `trendMax=${options.severityPercent.maxTrendAdjustment}`,
    `severityCap=${options.severityPercent.maxSeverityPercent}`
  ].join("|");
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
