import { accidentKey, accidentSeverity, type AccidentSeverity } from "../domain/accidentRecordDisplay";
import { distanceMeters, GeoGridIndex } from "../map/geo";
import { accidentMatchesRoadUserFocus, roadUserFocusKey } from "../domain/roadUsers";
import type { TelemetryMetadata } from "../shared/telemetry";
import type { AccidentRecord, AnalysisOptions, IntersectionCluster } from "../domain/types";

export interface CrossingAccident {
  accident: AccidentRecord;
  distanceMeters: number;
}

export interface ClusterAccidentRecordsSnapshot {
  records: CrossingAccident[];
  loading: boolean;
}

export type MeasureClusterAccidentStep = <T>(
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => TelemetryMetadata
) => T;

interface AccidentIndexCache {
  key: string;
  source: AccidentRecord[];
  index: GeoGridIndex<AccidentRecord>;
}

interface AccidentKeyLookupCache {
  source: AccidentRecord[];
  map: Map<string, AccidentRecord>;
}

interface AccidentRecordIndexLookupCache {
  source: AccidentRecord[];
  map: Map<number, AccidentRecord>;
}

export class ClusterAccidentRecordMatcher {
  private crossingAccidentIndexCache: AccidentIndexCache | null = null;
  private accidentKeyLookupCache: AccidentKeyLookupCache | null = null;
  private accidentRecordIndexLookupCache: AccidentRecordIndexLookupCache | null = null;

  constructor(private readonly measureStep?: MeasureClusterAccidentStep) {}

  clearCaches(): void {
    this.crossingAccidentIndexCache = null;
    this.accidentKeyLookupCache = null;
    this.accidentRecordIndexLookupCache = null;
  }

  snapshot(
    cluster: IntersectionCluster,
    sourceRecords: AccidentRecord[] | null,
    hasStateShard: boolean,
    options: AnalysisOptions
  ): ClusterAccidentRecordsSnapshot {
    if (sourceRecords) {
      return {
        records: this.records(cluster, sourceRecords, options),
        loading: false
      };
    }

    return {
      records: [],
      loading: hasStateShard
    };
  }

  records(cluster: IntersectionCluster, sourceRecords: AccidentRecord[], options: AnalysisOptions): CrossingAccident[] {
    if (sourceRecords.length === 0) {
      return [];
    }

    const exactRecords = this.exactClusterAccidentRecords(cluster, sourceRecords);
    if (exactRecords.length > 0) {
      return exactRecords.sort(compareCrossingAccidents);
    }

    const searchRadiusMeters = clusterAccidentSearchRadius(options);
    const index = this.accidentIndexForCrossings(options, searchRadiusMeters, sourceRecords);
    const candidates = index
      .nearby(cluster)
      .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }))
      .filter((entry) => entry.distanceMeters <= searchRadiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    return pickClusterAccidents(candidates, cluster).sort(compareCrossingAccidents);
  }

  private exactClusterAccidentRecords(cluster: IntersectionCluster, sourceRecords: AccidentRecord[]): CrossingAccident[] {
    const indexedRecords = this.exactClusterAccidentRecordsByIndex(cluster, sourceRecords);
    if (indexedRecords.length > 0) {
      return indexedRecords;
    }

    if (!cluster.accidentKeys?.length) {
      return [];
    }

    const lookup = this.accidentKeyLookup(sourceRecords);
    return cluster.accidentKeys
      .map((key) => lookup.get(key))
      .filter((accident): accident is AccidentRecord => Boolean(accident))
      .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }));
  }

  private exactClusterAccidentRecordsByIndex(cluster: IntersectionCluster, sourceRecords: AccidentRecord[]): CrossingAccident[] {
    const indexes = cluster.accidentIndexes;
    if (!indexes?.length) {
      return [];
    }

    const lookup = this.accidentRecordIndexLookup(sourceRecords);
    return this.measure(
      "read indexed accident records",
      cluster.id,
      () =>
        indexes
          .map((index) => lookup.get(index))
          .filter((accident): accident is AccidentRecord => Boolean(accident))
          .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) })),
      (records) => ({
        recordCount: records.length,
        indexCount: indexes.length
      })
    );
  }

  private accidentRecordIndexLookup(sourceRecords: AccidentRecord[]): Map<number, AccidentRecord> {
    if (this.accidentRecordIndexLookupCache?.source === sourceRecords) {
      return this.accidentRecordIndexLookupCache.map;
    }

    const map = new Map<number, AccidentRecord>();
    for (let index = 0; index < sourceRecords.length; index += 1) {
      const accident = sourceRecords[index];
      map.set(accident.recordIndex ?? index, accident);
    }
    this.accidentRecordIndexLookupCache = { source: sourceRecords, map };
    return map;
  }

  private accidentKeyLookup(sourceRecords: AccidentRecord[]): Map<string, AccidentRecord> {
    if (this.accidentKeyLookupCache?.source === sourceRecords) {
      return this.accidentKeyLookupCache.map;
    }

    return this.measure(
      "build accident key lookup",
      "all accident records",
      () => this.buildAccidentKeyLookup(sourceRecords),
      (map) => ({
        accidentCount: sourceRecords.length,
        recordCount: map.size
      })
    );
  }

  private buildAccidentKeyLookup(sourceRecords: AccidentRecord[]): Map<string, AccidentRecord> {
    const map = new Map<string, AccidentRecord>();
    for (const accident of sourceRecords) {
      map.set(accidentKey(accident), accident);
    }
    this.accidentKeyLookupCache = { source: sourceRecords, map };
    return map;
  }

  private accidentIndexForCrossings(
    options: AnalysisOptions,
    searchRadiusMeters: number,
    sourceRecords: AccidentRecord[]
  ): GeoGridIndex<AccidentRecord> {
    const key = analysisOptionsIndexKey(options, searchRadiusMeters);
    if (this.crossingAccidentIndexCache?.key === key && this.crossingAccidentIndexCache.source === sourceRecords) {
      return this.crossingAccidentIndexCache.index;
    }

    const index = new GeoGridIndex<AccidentRecord>(searchRadiusMeters);
    for (const accident of sourceRecords) {
      if (accidentMatchesAnalysisOptions(accident, options)) {
        index.insert(accident);
      }
    }
    this.crossingAccidentIndexCache = { key, source: sourceRecords, index };
    return index;
  }

  private measure<T>(
    name: string,
    detail: string | null,
    work: () => T,
    metadata?: (result: T) => TelemetryMetadata
  ): T {
    return this.measureStep ? this.measureStep(name, detail, work, metadata) : work();
  }
}

export function accidentMatchesAnalysisOptions(accident: AccidentRecord, options: AnalysisOptions): boolean {
  if (options.years.size > 0 && !options.years.has(accident.year)) {
    return false;
  }
  if (options.stateCode !== "all" && accident.stateCode !== options.stateCode) {
    return false;
  }
  return accidentMatchesRoadUserFocus(accident, options.roadUserFocus);
}

export function analysisOptionsIndexKey(options: AnalysisOptions, searchRadiusMeters: number): string {
  return [
    options.stateCode,
    options.clusterRadiusMeters,
    searchRadiusMeters,
    [...options.years].sort((a, b) => a - b).join(","),
    roadUserFocusKey(options.roadUserFocus) || "all"
  ].join("|");
}

export function clusterAccidentSearchRadius(options: AnalysisOptions): number {
  return Math.max(150, options.clusterRadiusMeters * 3);
}

export function clusteredAccidentMembership(clusters: IntersectionCluster[]): { keys: Set<string>; indexes: Set<number> } {
  const keys = new Set<string>();
  const indexes = new Set<number>();
  for (const cluster of clusters) {
    for (const key of cluster.accidentKeys ?? []) {
      keys.add(key);
    }
    for (const index of cluster.accidentIndexes ?? []) {
      indexes.add(index);
    }
  }
  return { keys, indexes };
}

export function compareCrossingAccidents(a: CrossingAccident, b: CrossingAccident): number {
  return (
    b.accident.year - a.accident.year ||
    (b.accident.month ?? 0) - (a.accident.month ?? 0) ||
    (b.accident.day ?? 0) - (a.accident.day ?? 0) ||
    (b.accident.hour ?? -1) - (a.accident.hour ?? -1) ||
    severityOrder(a.accident) - severityOrder(b.accident) ||
    a.distanceMeters - b.distanceMeters
  );
}

export function pickClusterAccidents(candidates: CrossingAccident[], cluster: IntersectionCluster): CrossingAccident[] {
  const selected = new Set<AccidentRecord>();
  const selectedRecords: CrossingAccident[] = [];
  const remainingBySeverity = new Map<AccidentSeverity, number>([
    ["fatal", cluster.fatalCount],
    ["serious", cluster.seriousCount],
    ["other", Math.max(0, cluster.accidentCount - cluster.fatalCount - cluster.seriousCount)]
  ]);

  for (const candidate of candidates) {
    const severity = accidentSeverity(candidate.accident);
    const remaining = remainingBySeverity.get(severity) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    selected.add(candidate.accident);
    selectedRecords.push(candidate);
    remainingBySeverity.set(severity, remaining - 1);
    if (selectedRecords.length >= cluster.accidentCount) {
      return selectedRecords;
    }
  }

  for (const candidate of candidates) {
    if (selected.has(candidate.accident)) {
      continue;
    }
    selectedRecords.push(candidate);
    if (selectedRecords.length >= cluster.accidentCount) {
      break;
    }
  }

  return selectedRecords;
}

function severityOrder(accident: AccidentRecord): number {
  switch (accidentSeverity(accident)) {
    case "fatal":
      return 0;
    case "serious":
      return 1;
    case "other":
      return 2;
  }
}
