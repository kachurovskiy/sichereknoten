import { gunzipSync } from "fflate";
import { decodeAccidentRecordsBinary } from "./accidentRecordsBinary";
import { readAnalysisCache, resetAppStorage, writeAnalysisCache } from "./cache";
import { decodeDefaultAnalysisBinary } from "./defaultAnalysisBinary";
import { roadUserFocusKey } from "./roadUsers";
import {
  AccidentRecord,
  AnalysisOptions,
  AnalysisResult,
  RoadUserKey,
  SeverityPercentOptions
} from "./types";

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

interface EmbeddedAccidentShardFile {
  stateCode: string;
  fileName: string;
  recordCount: number;
}

interface LoadedAccidentShard {
  id: string;
  stateCode: string;
  recordCount: number;
  size: number;
  compressedSize: number;
  compressedBytes: Uint8Array;
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

interface LoadedDefaultAnalysis {
  id: string;
  metadata: EmbeddedDefaultAnalysisMetadata;
  size: number;
  compressedSize: number;
  compressedBytes: Uint8Array;
}

interface EmbeddedDataBundle {
  version?: string;
  files: EmbeddedDataFile[];
  accidentShardFiles?: EmbeddedAccidentShardFile[];
  defaultAnalysisFile?: string;
  defaultAnalysisMetadata?: EmbeddedDefaultAnalysisMetadata;
}

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
    return Boolean(bundle?.accidentShardFiles?.some((entry) => entry.stateCode === stateCode));
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
          const bytes = gunzipSync(bundledAnalysis.compressedBytes);
          bundledAnalysis.size = bytes.byteLength;
          const parsed = decodeDefaultAnalysisBinary(bytes);
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
    if (shardFiles.length === 0) {
      throw new Error("Bundled normalized accident data is missing. Run npm run build so docs/assets contains accidents-state-*.bin.gz.");
    }

    const shardLoadPromises = shardFiles.map((entry) => this.ensureBundledAccidentShard(entry, telemetry));
    const loadedAccidents: AccidentRecord[] = [];
    for (let index = 0; index < shardFiles.length; index += 1) {
      const shard = await shardLoadPromises[index];
      const records = await this.readBundledAccidentShardRecords(shard, telemetry, shardFiles.length);
      this.accidentStateRecords.set(shard.stateCode, records);
      appendItems(loadedAccidents, records);
      onProgress?.({ current: index + 1, total: shardFiles.length });
    }

    return loadedAccidents;
  }

  private async readBundledAccidentState(stateCode: string, telemetry: DataRepositoryTelemetry | null): Promise<AccidentRecord[]> {
    const bundle = await this.ensureManifest(telemetry);
    const shardInfo = bundle.accidentShardFiles?.find((entry) => entry.stateCode === stateCode);
    if (shardInfo) {
      const shard = await this.ensureBundledAccidentShard(shardInfo, telemetry);
      return this.readBundledAccidentShardRecords(shard, telemetry, 1);
    }

    const allRecords = await this.loadAllAccidents(telemetry);
    return allRecords.filter((accident) => accident.stateCode === stateCode);
  }

  private async readBundledAccidentShardRecords(
    shard: LoadedAccidentShard,
    telemetry: DataRepositoryTelemetry | null,
    totalShards: number
  ): Promise<AccidentRecord[]> {
    return this.measure(
      telemetry,
      "read normalized accident state shard",
      shard.id,
      async () => {
        const bytes = gunzipSync(shard.compressedBytes);
        shard.size = bytes.byteLength;
        const parsed = decodeAccidentRecordsBinary(bytes);
        if (shard.recordCount > 0 && parsed.length !== shard.recordCount) {
          throw new Error(`Bundled accident state shard ${shard.id} decoded ${parsed.length} records; expected ${shard.recordCount}.`);
        }
        await yieldToBrowser();
        return parsed;
      },
      (parsed) => ({
        accidentCount: parsed.length,
        stateCode: shard.stateCode,
        bytes: shard.size,
        compressedBytes: shard.compressedSize,
        shardCount: totalShards
      })
    );
  }

  private async ensureBundledDefaultAnalysis(
    fileName: string,
    telemetry: DataRepositoryTelemetry | null
  ): Promise<LoadedDefaultAnalysis> {
    if (!fileName.toLowerCase().endsWith(".bin.gz")) {
      throw new Error(`Bundled default analysis ${fileName} uses an unsupported file format.`);
    }
    const compressedBytes = await this.loadBundledDefaultAnalysisBytes(fileName, telemetry);
    return {
      id: "analysis-default",
      metadata: globalThis.__SICHERE_KNOTEN_DATA__!.defaultAnalysisMetadata!,
      size: 0,
      compressedSize: compressedBytes.byteLength,
      compressedBytes
    };
  }

  private async loadBundledDefaultAnalysisBytes(fileName: string, telemetry: DataRepositoryTelemetry | null): Promise<Uint8Array> {
    const loaded = await this.measure(
      telemetry,
      "load default analysis file",
      fileName,
      () => this.fetchOfflineBundleAsset(fileName),
      ({ bytes, url }) => ({
        url,
        compressedBytes: bytes.byteLength,
        automatic: true
      })
    );
    return loaded.bytes;
  }

  private async ensureBundledAccidentShard(
    entry: EmbeddedAccidentShardFile,
    telemetry: DataRepositoryTelemetry | null
  ): Promise<LoadedAccidentShard> {
    if (!entry.fileName.toLowerCase().endsWith(".bin.gz")) {
      throw new Error(`Bundled accident state shard ${entry.fileName} uses an unsupported file format.`);
    }
    const loaded = await this.measure(
      telemetry,
      "load normalized accident state shard file",
      entry.fileName,
      () => this.fetchOfflineBundleAsset(entry.fileName),
      ({ bytes, url }) => ({
        url,
        compressedBytes: bytes.byteLength,
        stateCode: entry.stateCode,
        recordCount: entry.recordCount,
        automatic: true
      })
    );
    return {
      id: entry.fileName.replace(/\.bin\.gz$/i, ""),
      stateCode: entry.stateCode,
      recordCount: entry.recordCount,
      size: 0,
      compressedSize: loaded.bytes.byteLength,
      compressedBytes: loaded.bytes
    };
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
    const urls = this.offlineBundleAssetUrls(fileName);
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

  private async fetchOfflineBundleAsset(fileName: string): Promise<{ bytes: Uint8Array; url: string }> {
    const urls = this.offlineBundleAssetUrls(fileName);
    let lastError: unknown = null;

    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }
        return { bytes: new Uint8Array(await response.arrayBuffer()), url };
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError ? ` Last error: ${errorMessage(lastError)}` : "";
    throw new Error(`Could not fetch offline data asset ${fileName}.${detail}`);
  }

  private offlineBundleAssetUrls(fileName: string): string[] {
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
