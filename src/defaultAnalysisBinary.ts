import {
  BinaryReader,
  BinaryWriter,
  nullableBooleanId,
  readNullableBoolean,
  readNullableScaledSigned,
  readNullableStringId,
  readNullableUint,
  readStringId,
  stateCodeFromNumber,
  stateCodeNumber,
  writeNullableScaledSigned,
  writeNullableStringId,
  writeNullableUint,
  writeStringId
} from "./binaryCodec";
import { stateNameFor } from "./states";
import type {
  AccidentTrendDirection,
  AnalysisResult,
  ClusterYearStat,
  IntersectionCluster,
  PopulationAccidentSummary,
  StateSummary
} from "./types";

const DEFAULT_ANALYSIS_BINARY_MAGIC = "SKABIN01";
const DEFAULT_ANALYSIS_COORDINATE_SCALE = 10_000_000;
const DEFAULT_ANALYSIS_SEVERITY_SCALE = 10_000;
const DEFAULT_ANALYSIS_TREND_SCALE = 10_000;
const DEFAULT_ANALYSIS_TREND_DIRECTIONS: AccidentTrendDirection[] = ["unknown", "falling", "stable", "rising"];
const DEFAULT_ANALYSIS_TREND_DIRECTION_IDS = new Map<AccidentTrendDirection, number>([
  ["unknown", 0],
  ["falling", 1],
  ["stable", 2],
  ["rising", 3]
]);

export function encodeDefaultAnalysisBinary(result: AnalysisResult): Uint8Array {
  const strings = defaultAnalysisStringDictionary(result);
  const stringIds = new Map(strings.map((value, index) => [value, index]));
  const writer = new BinaryWriter("default analysis binary");
  writer.writeAscii(DEFAULT_ANALYSIS_BINARY_MAGIC);
  writer.writeVarUint(result.filteredAccidentCount);
  writeVarUintArray(writer, result.years);
  writeStringDictionary(writer, strings);
  writer.writeVarUint(result.clusters.length);
  for (const cluster of result.clusters) {
    writeAnalysisCluster(writer, stringIds, cluster);
  }
  writer.writeVarUint(result.stateSummaries.length);
  for (const summary of result.stateSummaries) {
    writeStateSummary(writer, summary);
  }
  writePopulationSummaries(writer, stringIds, result.stateAccidentSummaries);
  writePopulationSummaries(writer, stringIds, result.regionAccidentSummaries);
  return writer.finish();
}

export function decodeDefaultAnalysisBinary(bytes: Uint8Array): AnalysisResult {
  const reader = new BinaryReader(bytes, "default analysis binary");
  reader.expectAscii(DEFAULT_ANALYSIS_BINARY_MAGIC);
  const filteredAccidentCount = reader.readVarUint();
  const years = readVarUintArray(reader);
  const strings = readStringDictionary(reader);
  const clusterCount = reader.readVarUint();
  const clusters: IntersectionCluster[] = new Array(clusterCount);
  const clusterById = new Map<string, IntersectionCluster>();

  for (let index = 0; index < clusterCount; index += 1) {
    const cluster = readAnalysisCluster(reader, strings);
    clusters[index] = cluster;
    clusterById.set(cluster.id, cluster);
  }

  const stateSummaries = readStateSummaries(reader, clusterById);
  const stateAccidentSummaries = readPopulationSummaries(reader, strings);
  const regionAccidentSummaries = readPopulationSummaries(reader, strings);
  reader.expectDone();

  return {
    clusters,
    stateSummaries,
    stateAccidentSummaries,
    regionAccidentSummaries,
    filteredAccidentCount,
    years
  };
}

function defaultAnalysisStringDictionary(result: AnalysisResult): string[] {
  const strings: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value !== "string" || seen.has(value)) {
      return;
    }
    seen.add(value);
    strings.push(value);
  };

  for (const cluster of result.clusters) {
    add(cluster.administrativeRegionCode);
    add(cluster.administrativeRegionName);
    add(cluster.districtCode);
    add(cluster.districtName);
    add(cluster.municipalityCode);
    add(cluster.municipalityName);
    for (const streetName of cluster.streetNames ?? []) {
      add(streetName);
    }
  }
  for (const summary of [...result.stateAccidentSummaries, ...result.regionAccidentSummaries]) {
    add(summary.key);
    add(summary.name);
  }

  return strings;
}

function writeStringDictionary(writer: BinaryWriter, strings: string[]): void {
  const encoder = new TextEncoder();
  writer.writeVarUint(strings.length);
  for (const value of strings) {
    writer.writeBytes(encoder.encode(value));
  }
}

function writeAnalysisCluster(writer: BinaryWriter, stringIds: Map<string, number>, cluster: IntersectionCluster): void {
  const streetNames = cluster.streetNames ?? [];
  writer.writeVarUint(clusterIdNumber(cluster.id));
  writer.writeSignedVarInt(Math.round(cluster.lon * DEFAULT_ANALYSIS_COORDINATE_SCALE));
  writer.writeSignedVarInt(Math.round(cluster.lat * DEFAULT_ANALYSIS_COORDINATE_SCALE));
  writer.writeVarUint(stateCodeNumber(cluster.stateCode, "default analysis binary"));
  writeNullableStringId(writer, stringIds, cluster.administrativeRegionCode, "default analysis");
  writeNullableStringId(writer, stringIds, cluster.administrativeRegionName, "default analysis");
  writeNullableUint(writer, cluster.administrativeRegionPopulation, "default analysis administrativeRegionPopulation");
  writeNullableStringId(writer, stringIds, cluster.districtCode, "default analysis");
  writeNullableStringId(writer, stringIds, cluster.districtName, "default analysis");
  writeNullableStringId(writer, stringIds, cluster.municipalityCode, "default analysis");
  writeNullableStringId(writer, stringIds, cluster.municipalityName, "default analysis");
  writeNullableUint(writer, cluster.municipalityPopulation, "default analysis municipalityPopulation");
  writer.writeVarUint(cluster.accidentCount);
  writer.writeVarUint(cluster.fatalCount);
  writer.writeVarUint(cluster.seriousCount);
  writer.writeVarUint(cluster.lightCount);
  writer.writeVarUint(cluster.vulnerableCount);
  writer.writeVarUint(streetNames.length);
  for (const streetName of streetNames) {
    writeStringId(writer, stringIds, streetName, "default analysis");
  }
  writer.writeByte(nullableBooleanId(cluster.osmRoundabout));
  writer.writeByte(nullableBooleanId(cluster.osmTrafficSignal));
  writer.writeVarUint(cluster.osmRoundaboutCount);
  writer.writeVarUint(cluster.osmTrafficSignalCount);
  writer.writeVarUint(Math.round(cluster.severityPercent * DEFAULT_ANALYSIS_SEVERITY_SCALE));
  writeVarUintArray(writer, cluster.years);
  writer.writeVarUint(cluster.yearlyStats.length);
  for (const stats of cluster.yearlyStats) {
    writer.writeVarUint(stats.year);
    writer.writeVarUint(stats.accidentCount);
  }
  writeAccidentTrend(writer, cluster.accidentTrend);
  writeIndexArray(writer, cluster.accidentIndexes ?? []);
}

function writeStateSummary(writer: BinaryWriter, summary: StateSummary): void {
  writer.writeVarUint(stateCodeNumber(summary.stateCode, "default analysis binary"));
  writer.writeVarUint(summary.accidentCount);
  writer.writeVarUint(summary.clusterCount);
  writer.writeVarUint(summary.fatalCount);
  writer.writeVarUint(summary.seriousCount);
  writer.writeVarUint(Math.round(summary.severityPercent * DEFAULT_ANALYSIS_SEVERITY_SCALE));
  writeNullableClusterId(writer, summary.topCluster);
}

function writePopulationSummaries(writer: BinaryWriter, stringIds: Map<string, number>, summaries: PopulationAccidentSummary[]): void {
  writer.writeVarUint(summaries.length);
  for (const summary of summaries) {
    writeStringId(writer, stringIds, summary.key, "default analysis");
    writeStringId(writer, stringIds, summary.name, "default analysis");
    writer.writeVarUint(stateCodeNumber(summary.stateCode, "default analysis binary"));
    writeNullableUint(writer, summary.population, "default analysis population");
    writer.writeVarUint(summary.accidentCount);
    writer.writeVarUint(summary.fatalCount);
    writer.writeVarUint(summary.seriousCount);
    writer.writeVarUint(summary.lightCount);
  }
}

function writeAccidentTrend(writer: BinaryWriter, trend: IntersectionCluster["accidentTrend"]): void {
  writer.writeByte(DEFAULT_ANALYSIS_TREND_DIRECTION_IDS.get(trend.direction) ?? 0);
  writeNullableScaledSigned(writer, trend.slopePerYear, DEFAULT_ANALYSIS_TREND_SCALE, "default analysis trend slopePerYear");
  writeNullableScaledSigned(
    writer,
    trend.relativeSlopePerYear,
    DEFAULT_ANALYSIS_TREND_SCALE,
    "default analysis trend relativeSlopePerYear"
  );
  writeNullableUint(writer, trend.startAccidents, "default analysis trend startAccidents");
  writeNullableUint(writer, trend.endAccidents, "default analysis trend endAccidents");
  writer.writeVarUint(trend.years);
}

function writeIndexArray(writer: BinaryWriter, indexes: number[]): void {
  writer.writeVarUint(indexes.length);
  let previous = 0;
  for (let index = 0; index < indexes.length; index += 1) {
    const value = indexes[index];
    writer.writeSignedVarInt(index === 0 ? value : value - previous);
    previous = value;
  }
}

function writeVarUintArray(writer: BinaryWriter, values: number[]): void {
  writer.writeVarUint(values.length);
  for (const value of values) {
    writer.writeVarUint(value);
  }
}

function writeNullableClusterId(writer: BinaryWriter, cluster: IntersectionCluster | null): void {
  writer.writeVarUint(cluster ? clusterIdNumber(cluster.id) + 1 : 0);
}

function readAnalysisCluster(reader: BinaryReader, strings: string[]): IntersectionCluster {
  const id = `c-${reader.readVarUint()}`;
  const lon = reader.readSignedVarInt() / DEFAULT_ANALYSIS_COORDINATE_SCALE;
  const lat = reader.readSignedVarInt() / DEFAULT_ANALYSIS_COORDINATE_SCALE;
  const stateCode = stateCodeFromNumber(reader.readVarUint());
  const cluster: IntersectionCluster = {
    id,
    lon,
    lat,
    stateCode,
    stateName: stateNameFor(stateCode),
    administrativeRegionCode: readNullableStringId(reader, strings, "default analysis"),
    administrativeRegionName: readNullableStringId(reader, strings, "default analysis"),
    administrativeRegionPopulation: readNullableUint(reader),
    districtCode: readNullableStringId(reader, strings, "default analysis"),
    districtName: readNullableStringId(reader, strings, "default analysis"),
    municipalityCode: readNullableStringId(reader, strings, "default analysis"),
    municipalityName: readNullableStringId(reader, strings, "default analysis"),
    municipalityPopulation: readNullableUint(reader),
    accidentCount: reader.readVarUint(),
    fatalCount: reader.readVarUint(),
    seriousCount: reader.readVarUint(),
    lightCount: reader.readVarUint(),
    vulnerableCount: reader.readVarUint(),
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0,
    years: [],
    yearlyStats: [],
    accidentTrend: {
      direction: "unknown",
      slopePerYear: null,
      relativeSlopePerYear: null,
      startAccidents: null,
      endAccidents: null,
      years: 0
    }
  };

  cluster.streetNames = readStringArray(reader, strings);
  cluster.osmRoundabout = readNullableBoolean(reader);
  cluster.osmTrafficSignal = readNullableBoolean(reader);
  cluster.osmRoundaboutCount = reader.readVarUint();
  cluster.osmTrafficSignalCount = reader.readVarUint();
  cluster.severityPercent = reader.readVarUint() / DEFAULT_ANALYSIS_SEVERITY_SCALE;
  cluster.years = readVarUintArray(reader);
  cluster.yearlyStats = readClusterYearStats(reader);
  cluster.accidentTrend = readAccidentTrend(reader);
  const accidentIndexes = readIndexArray(reader);
  if (accidentIndexes.length > 0) {
    cluster.accidentIndexes = accidentIndexes;
  }

  return cluster;
}

function readStateSummaries(reader: BinaryReader, clusterById: Map<string, IntersectionCluster>): StateSummary[] {
  const count = reader.readVarUint();
  const summaries: StateSummary[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const stateCode = stateCodeFromNumber(reader.readVarUint());
    const accidentCount = reader.readVarUint();
    const clusterCount = reader.readVarUint();
    const fatalCount = reader.readVarUint();
    const seriousCount = reader.readVarUint();
    const severityPercent = reader.readVarUint() / DEFAULT_ANALYSIS_SEVERITY_SCALE;
    const topClusterIdNumber = readNullableUint(reader);
    const topCluster = topClusterIdNumber === null ? null : clusterById.get(`c-${topClusterIdNumber}`) ?? null;
    summaries[index] = {
      stateCode,
      stateName: stateNameFor(stateCode),
      accidentCount,
      clusterCount,
      fatalCount,
      seriousCount,
      severityPercent,
      topCluster
    };
  }
  return summaries;
}

function readPopulationSummaries(reader: BinaryReader, strings: string[]): PopulationAccidentSummary[] {
  const count = reader.readVarUint();
  const summaries: PopulationAccidentSummary[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const key = readStringId(reader, strings, "default analysis");
    const name = readStringId(reader, strings, "default analysis");
    const stateCode = stateCodeFromNumber(reader.readVarUint());
    summaries[index] = {
      key,
      name,
      stateCode,
      stateName: stateNameFor(stateCode),
      population: readNullableUint(reader),
      accidentCount: reader.readVarUint(),
      fatalCount: reader.readVarUint(),
      seriousCount: reader.readVarUint(),
      lightCount: reader.readVarUint()
    };
  }
  return summaries;
}

function readStringDictionary(reader: BinaryReader): string[] {
  const decoder = new TextDecoder();
  const count = reader.readVarUint();
  const strings: string[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    strings[index] = decoder.decode(reader.readBytes());
  }
  return strings;
}

function readStringArray(reader: BinaryReader, strings: string[]): string[] {
  const count = reader.readVarUint();
  const values: string[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = readStringId(reader, strings, "default analysis");
  }
  return values;
}

function readClusterYearStats(reader: BinaryReader): ClusterYearStat[] {
  const count = reader.readVarUint();
  const stats: ClusterYearStat[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    stats[index] = {
      year: reader.readVarUint(),
      accidentCount: reader.readVarUint()
    };
  }
  return stats;
}

function readAccidentTrend(reader: BinaryReader): IntersectionCluster["accidentTrend"] {
  const directionId = reader.readByte();
  return {
    direction: DEFAULT_ANALYSIS_TREND_DIRECTIONS[directionId] ?? "unknown",
    slopePerYear: readNullableScaledSigned(reader, DEFAULT_ANALYSIS_TREND_SCALE),
    relativeSlopePerYear: readNullableScaledSigned(reader, DEFAULT_ANALYSIS_TREND_SCALE),
    startAccidents: readNullableUint(reader),
    endAccidents: readNullableUint(reader),
    years: reader.readVarUint()
  };
}

function readIndexArray(reader: BinaryReader): number[] {
  const count = reader.readVarUint();
  const values: number[] = new Array(count);
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = reader.readSignedVarInt();
    const value = index === 0 ? delta : previous + delta;
    values[index] = value;
    previous = value;
  }
  return values;
}

function readVarUintArray(reader: BinaryReader): number[] {
  const count = reader.readVarUint();
  const values: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = reader.readVarUint();
  }
  return values;
}

function clusterIdNumber(value: string): number {
  const match = /^c-(\d+)$/.exec(String(value));
  if (!match) {
    throw new Error(`Invalid cluster id for default analysis binary: ${value}`);
  }
  return Number(match[1]);
}
