import { gunzipSync } from "fflate";
import { readAnalysisCache, resetAppStorage, writeAnalysisCache } from "./cache";
import { roadUserFocusKey } from "./roadUsers";
import { STATE_NAMES } from "./states";
import { AccidentRecord, AnalysisOptions, AnalysisResult, RoadUserKey, SeverityPercentOptions } from "./types";

export type DataRepositoryTelemetryMetadata = Record<string, string | number | boolean | null>;

export interface DataRepositoryTelemetry {
  measure<T>(
    name: string,
    detail: string | null,
    work: () => Promise<T>,
    metadata?: (result: T) => DataRepositoryTelemetryMetadata
  ): Promise<T>;
  record(name: string, detail: string | null, metadata: DataRepositoryTelemetryMetadata): void;
}

export interface EmbeddedDataFile {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedTime?: string;
}

interface EmbeddedAccidentChunk {
  id: string;
  encoding: "gzip-base64-json-compact-v1";
  recordCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface EmbeddedAccidentShardFile {
  stateCode: string;
  fileName: string;
  recordCount: number;
}

interface EmbeddedAccidentShard {
  id: string;
  stateCode: string;
  encoding: "gzip-base64-json-compact-v1" | "gzip-base64-json-compact-v2";
  recordCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface SerializedAnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: number[];
  roadUserFocus: RoadUserKey[];
  stateCode: string | "all";
  severityPercent: SeverityPercentOptions;
}

interface EmbeddedDefaultAnalysisMetadata {
  dataVersion: string;
  analysisCacheVersion: string;
  options: SerializedAnalysisOptions;
}

interface EmbeddedDefaultAnalysis {
  id: string;
  encoding: "gzip-base64-json-v1";
  metadata: EmbeddedDefaultAnalysisMetadata;
  clusterCount: number;
  filteredAccidentCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface EmbeddedDataBundle {
  version?: string;
  files: EmbeddedDataFile[];
  accidentShardFiles?: EmbeddedAccidentShardFile[];
  accidentShards?: EmbeddedAccidentShard[];
  accidentChunkFiles?: string[];
  accidentChunks?: EmbeddedAccidentChunk[];
  defaultAnalysisFile?: string;
  defaultAnalysisMetadata?: EmbeddedDefaultAnalysisMetadata;
  defaultAnalysis?: EmbeddedDefaultAnalysis | null;
}

type CompactAccidentRecord = [
  string,
  string | null,
  string,
  string[],
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  number,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  number | null | undefined
];

declare global {
  var __SICHERE_KNOTEN_DATA__: EmbeddedDataBundle | undefined;
}

export interface AnalysisCacheContext {
  dataVersion: string;
  appVersion: string;
}

export interface AccidentLoadProgress {
  current: number;
  total: number;
}

export class DataRepository {
  private accidents: AccidentRecord[] = [];
  private accidentDataLoadPromise: Promise<AccidentRecord[]> | null = null;
  private accidentStateRecords = new Map<string, AccidentRecord[]>();
  private accidentStateLoadPromises = new Map<string, Promise<AccidentRecord[]>>();
  private readonly offlineBundleScriptPromises = new Map<string, Promise<string>>();

  resetRuntimeState(): void {
    this.accidents = [];
    this.accidentDataLoadPromise = null;
    this.accidentStateRecords = new Map();
    this.accidentStateLoadPromises = new Map();
  }

  allAccidentsSnapshot(): AccidentRecord[] | null {
    return this.accidents.length > 0 ? this.accidents : null;
  }

  cachedAccidentsForStateOrAll(stateCode: string): AccidentRecord[] | null {
    if (this.accidents.length > 0) {
      return this.accidents;
    }
    return this.accidentStateRecords.get(stateCode) ?? null;
  }

  hasAnyAccidents(): boolean {
    return this.accidents.length > 0 || this.accidentStateRecords.size > 0;
  }

  hasStateShard(stateCode: string): boolean {
    const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
    return Boolean(
      bundle?.accidentShardFiles?.some((entry) => entry.stateCode === stateCode) ||
        bundle?.accidentChunkFiles?.length ||
        bundle?.accidentChunks?.length
    );
  }

  async ensureManifest(telemetry: DataRepositoryTelemetry | null): Promise<EmbeddedDataBundle> {
    const existingBundle = globalThis.__SICHERE_KNOTEN_DATA__;
    if (existingBundle?.version) {
      return existingBundle;
    }

    await this.measure(
      telemetry,
      "load data manifest",
      "data-manifest.js",
      () => this.loadOfflineBundleScript("data-manifest.js"),
      (url) => ({
        url,
        automatic: true
      })
    );

    const loadedBundle = globalThis.__SICHERE_KNOTEN_DATA__;
    if (!loadedBundle?.version) {
      throw new Error("Bundled data manifest is missing. Run npm run build so docs/assets contains the generated offline bundle.");
    }
    return loadedBundle;
  }

  dataVersion(): string {
    const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
    if (bundle?.version) {
      return bundle.version;
    }
    if (bundle?.files.length) {
      return `legacy:${bundle.files.map((file) => `${file.path}:${file.size}:${file.modifiedTime ?? ""}`).join("|")}`;
    }
    return "missing-normalized-data";
  }

  bundledYears(): number[] {
    const years = new Set<number>();
    for (const file of globalThis.__SICHERE_KNOTEN_DATA__?.files ?? []) {
      const label = `${file.path} ${file.name}`;
      for (const match of label.matchAll(/(20\d{2})/g)) {
        years.add(Number(match[1]));
      }
    }
    return Array.from(years).sort((a, b) => a - b);
  }

  latestBundledFileDate(): Date | null {
    const timestamps = (globalThis.__SICHERE_KNOTEN_DATA__?.files ?? [])
      .map((file) => (file.modifiedTime ? new Date(file.modifiedTime) : null))
      .filter((date): date is Date => date instanceof Date && Number.isFinite(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());
    return timestamps[0] ?? null;
  }

  async readDefaultAnalysis(
    dataVersion: string,
    analysisCacheVersion: string,
    options: AnalysisOptions,
    detail: string,
    telemetry: DataRepositoryTelemetry | null
  ): Promise<AnalysisResult | null> {
    const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
    const fileName = bundle?.defaultAnalysisFile;
    const metadata = bundle?.defaultAnalysisMetadata;
    if (typeof fileName !== "string" || !metadata) {
      telemetry?.record("skip bundled default analysis", detail, {
        reason: "bundled default analysis is missing"
      });
      return null;
    }
    if (!this.defaultAnalysisMetadataMatches(metadata, dataVersion, analysisCacheVersion, options)) {
      telemetry?.record("skip bundled default analysis", detail, {
        reason: "settings or version mismatch"
      });
      return null;
    }

    try {
      const bundledAnalysis = await this.ensureBundledDefaultAnalysis(fileName, telemetry);
      if (!this.defaultAnalysisMetadataMatches(bundledAnalysis.metadata, dataVersion, analysisCacheVersion, options)) {
        telemetry?.record("skip bundled default analysis", detail, {
          reason: "loaded bundle metadata mismatch"
        });
        return null;
      }

      return await this.measure(
        telemetry,
        "read bundled default analysis",
        bundledAnalysis.id,
        async () => {
          const compressed = this.decodeBase64Chunks(bundledAnalysis.chunks);
          const bytes = gunzipSync(compressed);
          const text = new TextDecoder().decode(bytes);
          const parsed = JSON.parse(text) as AnalysisResult;
          await yieldToBrowser();
          return parsed;
        },
        (analysisResult) => ({
          cacheHit: true,
          clusterCount: analysisResult.clusters.length,
          filteredAccidentCount: analysisResult.filteredAccidentCount,
          bytes: bundledAnalysis.size,
          compressedBytes: bundledAnalysis.compressedSize
        })
      );
    } catch (error) {
      console.warn("[Safe Intersections] Could not load bundled default analysis; falling back to runtime analysis.", error);
      telemetry?.record("skip bundled default analysis", detail, {
        reason: errorMessage(error)
      });
      return null;
    }
  }

  async readCachedAnalysis(cacheContext: AnalysisCacheContext, options: AnalysisOptions): Promise<AnalysisResult | null> {
    return readAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options);
  }

  async writeCachedAnalysis(cacheContext: AnalysisCacheContext, options: AnalysisOptions, result: AnalysisResult): Promise<void> {
    await writeAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options, result);
  }

  async resetStorage(): Promise<void> {
    await resetAppStorage();
  }

  async loadAllAccidents(
    telemetry: DataRepositoryTelemetry | null,
    onProgress: ((progress: AccidentLoadProgress) => void) | null = null
  ): Promise<AccidentRecord[]> {
    if (this.accidents.length > 0) {
      return this.accidents;
    }
    if (!this.accidentDataLoadPromise) {
      this.accidentDataLoadPromise = this.readBundledAccidents(telemetry, onProgress)
        .then((records) => {
          this.accidents = this.normalizeAccidentRecordIndexes(records);
          return this.accidents;
        })
        .catch((error) => {
          this.accidentDataLoadPromise = null;
          throw error;
        });
    }
    return this.accidentDataLoadPromise;
  }

  async loadAccidentsForAnalysis(
    options: AnalysisOptions,
    telemetry: DataRepositoryTelemetry | null,
    onProgress: ((progress: AccidentLoadProgress) => void) | null = null
  ): Promise<AccidentRecord[]> {
    if (options.stateCode !== "all") {
      return this.loadAccidentsForState(options.stateCode, telemetry);
    }
    return this.loadAllAccidents(telemetry, onProgress);
  }

  async loadAccidentsForState(stateCode: string, telemetry: DataRepositoryTelemetry | null = null): Promise<AccidentRecord[]> {
    if (this.accidents.length > 0) {
      const cachedRecords = this.accidentStateRecords.get(stateCode);
      if (cachedRecords) {
        return cachedRecords;
      }
      const records = this.accidents.filter((accident) => accident.stateCode === stateCode);
      this.accidentStateRecords.set(stateCode, records);
      return records;
    }

    const cachedRecords = this.accidentStateRecords.get(stateCode);
    if (cachedRecords) {
      return cachedRecords;
    }

    const existingPromise = this.accidentStateLoadPromises.get(stateCode);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = this.readBundledAccidentState(stateCode, telemetry)
      .then((records) => {
        this.accidentStateRecords.set(stateCode, records);
        return records;
      })
      .catch((error) => {
        this.accidentStateLoadPromises.delete(stateCode);
        throw error;
      });
    this.accidentStateLoadPromises.set(stateCode, promise);
    return promise;
  }

  private async readBundledAccidents(
    telemetry: DataRepositoryTelemetry | null,
    onProgress: ((progress: AccidentLoadProgress) => void) | null
  ): Promise<AccidentRecord[]> {
    const bundle = await this.ensureManifest(telemetry);
    const shardFiles = bundle.accidentShardFiles ?? [];
    if (shardFiles.length > 0) {
      const shardLoadPromises = shardFiles.map((entry) => this.ensureBundledAccidentShard(entry.fileName, telemetry));
      const loadedAccidents: AccidentRecord[] = [];
      for (let index = 0; index < shardFiles.length; index += 1) {
        const shard = await shardLoadPromises[index];
        const records = await this.readBundledAccidentRecords(shard, telemetry, shardFiles.length);
        this.accidentStateRecords.set(shard.stateCode, records);
        appendItems(loadedAccidents, records);
        onProgress?.({ current: index + 1, total: shardFiles.length });
      }

      return loadedAccidents;
    }

    const chunkFiles = bundle.accidentChunkFiles ?? [];
    const preloadedChunks = bundle.accidentChunks ?? [];
    const totalChunks = chunkFiles.length || preloadedChunks.length;
    if (totalChunks === 0) {
      throw new Error("Bundled normalized accident data is missing. Run npm run build so docs/assets contains accidents-*.js.");
    }

    const chunkLoadPromises = chunkFiles.length > 0 ? chunkFiles.map((fileName) => this.ensureBundledAccidentChunk(fileName, telemetry)) : [];
    const loadedAccidents: AccidentRecord[] = [];
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = chunkLoadPromises.length > 0 ? await chunkLoadPromises[index] : preloadedChunks[index];
      const records = await this.readBundledAccidentRecords(chunk, telemetry, totalChunks);
      appendItems(loadedAccidents, records);
      onProgress?.({ current: index + 1, total: totalChunks });
    }

    return loadedAccidents;
  }

  private async readBundledAccidentState(stateCode: string, telemetry: DataRepositoryTelemetry | null): Promise<AccidentRecord[]> {
    const bundle = await this.ensureManifest(telemetry);
    const shardInfo = bundle.accidentShardFiles?.find((entry) => entry.stateCode === stateCode);
    if (shardInfo) {
      const shard = await this.ensureBundledAccidentShard(shardInfo.fileName, telemetry);
      return this.readBundledAccidentRecords(shard, telemetry, 1);
    }

    const allRecords = await this.loadAllAccidents(telemetry);
    return allRecords.filter((accident) => accident.stateCode === stateCode);
  }

  private async readBundledAccidentRecords(
    bundlePart: EmbeddedAccidentChunk | EmbeddedAccidentShard,
    telemetry: DataRepositoryTelemetry | null,
    totalParts: number
  ): Promise<AccidentRecord[]> {
    const isShard = "stateCode" in bundlePart;
    return this.measure(
      telemetry,
      isShard ? "read normalized accident state shard" : "read normalized accident chunk",
      bundlePart.id,
      async () => {
        const compressed = this.decodeBase64Chunks(bundlePart.chunks);
        const bytes = gunzipSync(compressed);
        const text = new TextDecoder().decode(bytes);
        const parsed = (JSON.parse(text) as CompactAccidentRecord[]).map(accidentFromCompactRecord);
        await yieldToBrowser();
        return parsed;
      },
      (parsed) => ({
        accidentCount: parsed.length,
        stateCode: isShard ? bundlePart.stateCode : null,
        bytes: bundlePart.size,
        compressedBytes: bundlePart.compressedSize,
        shardCount: isShard ? totalParts : null,
        chunkCount: isShard ? null : totalParts
      })
    );
  }

  private async ensureBundledDefaultAnalysis(
    fileName: string,
    telemetry: DataRepositoryTelemetry | null
  ): Promise<EmbeddedDefaultAnalysis> {
    const existingAnalysis = globalThis.__SICHERE_KNOTEN_DATA__?.defaultAnalysis;
    if (existingAnalysis) {
      return existingAnalysis;
    }

    await this.measure(
      telemetry,
      "load default analysis script",
      fileName,
      () => this.loadOfflineBundleScript(fileName),
      (url) => ({
        url,
        automatic: true
      })
    );

    const loadedAnalysis = globalThis.__SICHERE_KNOTEN_DATA__?.defaultAnalysis;
    if (!loadedAnalysis) {
      throw new Error(`Bundled default analysis ${fileName} did not register itself.`);
    }
    if (loadedAnalysis.encoding !== "gzip-base64-json-v1") {
      throw new Error(`Bundled default analysis ${fileName} uses unsupported encoding ${loadedAnalysis.encoding}.`);
    }
    return loadedAnalysis;
  }

  private async ensureBundledAccidentShard(fileName: string, telemetry: DataRepositoryTelemetry | null): Promise<EmbeddedAccidentShard> {
    const existingShard = this.findBundledAccidentShard(fileName);
    if (existingShard) {
      return existingShard;
    }

    await this.measure(
      telemetry,
      "load normalized accident state shard script",
      fileName,
      () => this.loadOfflineBundleScript(fileName),
      (url) => ({
        url,
        automatic: true
      })
    );

    const loadedShard = this.findBundledAccidentShard(fileName);
    if (!loadedShard) {
      throw new Error(`Bundled accident state shard ${fileName} did not register itself.`);
    }
    return loadedShard;
  }

  private async ensureBundledAccidentChunk(fileName: string, telemetry: DataRepositoryTelemetry | null): Promise<EmbeddedAccidentChunk> {
    const existingChunk = this.findBundledAccidentChunk(fileName);
    if (existingChunk) {
      return existingChunk;
    }

    await this.measure(
      telemetry,
      "load normalized accident chunk script",
      fileName,
      () => this.loadOfflineBundleScript(fileName),
      (url) => ({
        url,
        automatic: true
      })
    );

    const loadedChunk = this.findBundledAccidentChunk(fileName);
    if (!loadedChunk) {
      throw new Error(`Bundled accident chunk ${fileName} did not register itself.`);
    }
    return loadedChunk;
  }

  private findBundledAccidentShard(fileName: string): EmbeddedAccidentShard | null {
    const shardId = fileName.replace(/\.js$/i, "");
    return globalThis.__SICHERE_KNOTEN_DATA__?.accidentShards?.find((shard) => shard.id === shardId || `${shard.id}.js` === fileName) ?? null;
  }

  private findBundledAccidentChunk(fileName: string): EmbeddedAccidentChunk | null {
    const chunkId = fileName.replace(/\.js$/i, "");
    return globalThis.__SICHERE_KNOTEN_DATA__?.accidentChunks?.find((chunk) => chunk.id === chunkId || `${chunk.id}.js` === fileName) ?? null;
  }

  private defaultAnalysisMetadataMatches(
    metadata: EmbeddedDefaultAnalysisMetadata,
    dataVersion: string,
    analysisCacheVersion: string,
    options: AnalysisOptions
  ): boolean {
    return (
      metadata.dataVersion === dataVersion &&
      metadata.analysisCacheVersion === analysisCacheVersion &&
      JSON.stringify(metadata.options) === JSON.stringify(serializeAnalysisOptionsForBundle(options))
    );
  }

  private async loadOfflineBundleScript(fileName: string): Promise<string> {
    const urls = this.offlineBundleScriptUrls(fileName);
    let lastError: unknown = null;

    for (const url of urls) {
      try {
        await this.appendOfflineBundleScript(url);
        return url;
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError ? ` Last error: ${errorMessage(lastError)}` : "";
    throw new Error(`Could not load offline data asset ${fileName}.${detail}`);
  }

  private offlineBundleScriptUrls(fileName: string): string[] {
    const baseUrls = this.offlineBundleAssetBaseUrls();
    return baseUrls.map((baseUrl) => new URL(fileName, baseUrl).href);
  }

  private offlineBundleAssetBaseUrls(): string[] {
    const sourceModuleScript = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src$="/src/main.ts"], script[type="module"][src$="src/main.ts"]'
    );
    const preferred = sourceModuleScript ? "./docs/assets/" : "./assets/";
    const fallback = sourceModuleScript ? "./assets/" : "./docs/assets/";
    return uniqueStrings([new URL(preferred, document.baseURI).href, new URL(fallback, document.baseURI).href]);
  }

  private appendOfflineBundleScript(url: string): Promise<string> {
    const existingPromise = this.offlineBundleScriptPromises.get(url);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = new Promise<string>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = false;
      script.onload = () => resolve(url);
      script.onerror = () => {
        script.remove();
        this.offlineBundleScriptPromises.delete(url);
        reject(new Error(`Failed to load ${url}`));
      };
      document.head.append(script);
    });
    this.offlineBundleScriptPromises.set(url, promise);
    return promise;
  }

  private normalizeAccidentRecordIndexes(records: AccidentRecord[]): AccidentRecord[] {
    if (records.every((record) => typeof record.recordIndex === "number")) {
      return records.sort((a, b) => (a.recordIndex ?? 0) - (b.recordIndex ?? 0));
    }
    for (let index = 0; index < records.length; index += 1) {
      records[index].recordIndex = index;
    }
    return records;
  }

  private decodeBase64Chunks(chunks: string[]): Uint8Array {
    const decodedChunks = chunks.map((chunk) => {
      const binary = atob(chunk);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    });
    const length = decodedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;

    for (const chunk of decodedChunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return output;
  }

  private measure<T>(
    telemetry: DataRepositoryTelemetry | null,
    name: string,
    detail: string | null,
    work: () => Promise<T>,
    metadata?: (result: T) => DataRepositoryTelemetryMetadata
  ): Promise<T> {
    return telemetry ? telemetry.measure(name, detail, work, metadata) : work();
  }
}

function accidentFromCompactRecord(record: CompactAccidentRecord): AccidentRecord {
  const streetNames = record[3];
  const stateCode = record[4];
  const administrativeRegionCode = record[5];
  const districtCode = record[6];
  const municipalityCode = record[7];
  const recordIndex = typeof record[32] === "number" ? record[32] : undefined;
  return {
    id: record[0],
    recordIndex,
    serialNumber: record[1],
    source: record[2],
    sourceType: "csv",
    streetName: streetNames[0] ?? null,
    streetNames,
    stateCode,
    stateName: STATE_NAMES[stateCode] ?? `Bundesland ${stateCode || "unknown"}`,
    administrativeRegionCode,
    administrativeRegionName: record[8],
    districtCode,
    districtName: record[9],
    municipalityCode,
    municipalityName: record[10],
    year: record[11],
    month: record[12],
    day: record[13],
    hour: record[14],
    weekday: record[15],
    category: record[16],
    accidentKind: record[17],
    accidentType: record[18],
    lightCondition: record[19],
    roadSurface: record[20],
    plausibilityLevel: record[21],
    linRefX: record[22],
    linRefY: record[23],
    lon: record[24],
    lat: record[25],
    involvesBike: record[26],
    involvesPedestrian: record[27],
    involvesMotorcycle: record[28],
    involvesCar: record[29],
    involvesTruck: record[30],
    involvesOther: record[31]
  };
}

function serializeAnalysisOptionsForBundle(options: AnalysisOptions): SerializedAnalysisOptions {
  return {
    clusterRadiusMeters: options.clusterRadiusMeters,
    minAccidents: options.minAccidents,
    years: Array.from(options.years).sort((a, b) => a - b),
    roadUserFocus: Array.from(options.roadUserFocus).sort(),
    stateCode: options.stateCode,
    severityPercent: { ...options.severityPercent }
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function appendItems<T>(target: T[], items: T[]): void {
  for (const item of items) {
    target.push(item);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToBrowser(delayMs = 0): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}
