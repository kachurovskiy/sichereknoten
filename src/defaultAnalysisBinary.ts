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
  const writer = new BinaryWriter();
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
  const reader = new BinaryReader(bytes);
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
  writer.writeVarUint(stateCodeNumber(cluster.stateCode));
  writeNullableStringId(writer, stringIds, cluster.administrativeRegionCode);
  writeNullableStringId(writer, stringIds, cluster.administrativeRegionName);
  writeNullableUint(writer, cluster.administrativeRegionPopulation);
  writeNullableStringId(writer, stringIds, cluster.districtCode);
  writeNullableStringId(writer, stringIds, cluster.districtName);
  writeNullableStringId(writer, stringIds, cluster.municipalityCode);
  writeNullableStringId(writer, stringIds, cluster.municipalityName);
  writeNullableUint(writer, cluster.municipalityPopulation);
  writer.writeVarUint(cluster.accidentCount);
  writer.writeVarUint(cluster.fatalCount);
  writer.writeVarUint(cluster.seriousCount);
  writer.writeVarUint(cluster.lightCount);
  writer.writeVarUint(cluster.vulnerableCount);
  writer.writeVarUint(streetNames.length);
  for (const streetName of streetNames) {
    writeStringId(writer, stringIds, streetName);
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
  writer.writeVarUint(stateCodeNumber(summary.stateCode));
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
    writeStringId(writer, stringIds, summary.key);
    writeStringId(writer, stringIds, summary.name);
    writer.writeVarUint(stateCodeNumber(summary.stateCode));
    writeNullableUint(writer, summary.population);
    writer.writeVarUint(summary.accidentCount);
    writer.writeVarUint(summary.fatalCount);
    writer.writeVarUint(summary.seriousCount);
    writer.writeVarUint(summary.lightCount);
  }
}

function writeAccidentTrend(writer: BinaryWriter, trend: IntersectionCluster["accidentTrend"]): void {
  writer.writeByte(DEFAULT_ANALYSIS_TREND_DIRECTION_IDS.get(trend.direction) ?? 0);
  writeNullableScaledSigned(writer, trend.slopePerYear, DEFAULT_ANALYSIS_TREND_SCALE);
  writeNullableScaledSigned(writer, trend.relativeSlopePerYear, DEFAULT_ANALYSIS_TREND_SCALE);
  writeNullableUint(writer, trend.startAccidents);
  writeNullableUint(writer, trend.endAccidents);
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

function writeNullableUint(writer: BinaryWriter, value: number | null): void {
  writer.writeVarUint(typeof value === "number" ? Math.max(0, Math.round(value)) + 1 : 0);
}

function writeNullableScaledSigned(writer: BinaryWriter, value: number | null, scale: number): void {
  writer.writeVarUint(typeof value === "number" ? zigZagEncode(Math.round(value * scale)) + 1 : 0);
}

function writeStringId(writer: BinaryWriter, stringIds: Map<string, number>, value: string): void {
  const id = stringIds.get(value);
  if (id === undefined) {
    throw new Error(`String is missing from default analysis dictionary: ${value}`);
  }
  writer.writeVarUint(id);
}

function writeNullableStringId(writer: BinaryWriter, stringIds: Map<string, number>, value: string | null): void {
  if (value === null) {
    writer.writeVarUint(0);
    return;
  }
  const id = stringIds.get(value);
  if (id === undefined) {
    throw new Error(`String is missing from default analysis dictionary: ${value}`);
  }
  writer.writeVarUint(id + 1);
}

function nullableBooleanId(value: boolean | null): number {
  if (value === true) {
    return 2;
  }
  if (value === false) {
    return 1;
  }
  return 0;
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
    administrativeRegionCode: readNullableString(reader, strings),
    administrativeRegionName: readNullableString(reader, strings),
    administrativeRegionPopulation: readNullableUint(reader),
    districtCode: readNullableString(reader, strings),
    districtName: readNullableString(reader, strings),
    municipalityCode: readNullableString(reader, strings),
    municipalityName: readNullableString(reader, strings),
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
    const key = readString(reader, strings);
    const name = readString(reader, strings);
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
    values[index] = readString(reader, strings);
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

function readString(reader: BinaryReader, strings: string[]): string {
  const id = reader.readVarUint();
  const value = strings[id];
  if (value === undefined) {
    throw new Error(`Invalid default analysis string id ${id}.`);
  }
  return value;
}

function readNullableString(reader: BinaryReader, strings: string[]): string | null {
  const id = reader.readVarUint();
  if (id === 0) {
    return null;
  }
  const value = strings[id - 1];
  if (value === undefined) {
    throw new Error(`Invalid default analysis nullable string id ${id}.`);
  }
  return value;
}

function readNullableUint(reader: BinaryReader): number | null {
  const value = reader.readVarUint();
  return value === 0 ? null : value - 1;
}

function readNullableScaledSigned(reader: BinaryReader, scale: number): number | null {
  const value = reader.readVarUint();
  return value === 0 ? null : zigZagDecode(value - 1) / scale;
}

function readNullableBoolean(reader: BinaryReader): boolean | null {
  const value = reader.readByte();
  if (value === 0) {
    return null;
  }
  if (value === 1) {
    return false;
  }
  if (value === 2) {
    return true;
  }
  throw new Error(`Invalid default analysis nullable boolean id ${value}.`);
}

function stateCodeNumber(value: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid state code for default analysis binary: ${value}`);
  }
  return number;
}

function stateCodeFromNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function clusterIdNumber(value: string): number {
  const match = /^c-(\d+)$/.exec(String(value));
  if (!match) {
    throw new Error(`Invalid cluster id for default analysis binary: ${value}`);
  }
  return Number(match[1]);
}

function zigZagEncode(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function zigZagDecode(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

class BinaryWriter {
  private readonly chunks: Uint8Array[] = [];
  private buffer = new Uint8Array(1024 * 1024);
  private offset = 0;

  writeAscii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.writeByte(value.charCodeAt(index));
    }
  }

  writeByte(value: number): void {
    this.ensure(1);
    this.buffer[this.offset] = value & 0xff;
    this.offset += 1;
  }

  writeVarUint(value: number): void {
    let remaining = Math.trunc(value);
    if (!Number.isFinite(remaining) || remaining < 0) {
      throw new Error(`Invalid unsigned integer for default analysis binary: ${value}`);
    }
    while (remaining >= 0x80) {
      this.writeByte((remaining % 0x80) | 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    this.writeByte(remaining);
  }

  writeSignedVarInt(value: number): void {
    this.writeVarUint(zigZagEncode(Math.trunc(value)));
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeVarUint(bytes.byteLength);
    this.ensure(bytes.byteLength);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.byteLength;
  }

  finish(): Uint8Array {
    this.flush();
    const length = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  private ensure(length: number): void {
    if (this.offset + length <= this.buffer.byteLength) {
      return;
    }
    this.flush();
    if (length > this.buffer.byteLength) {
      this.buffer = new Uint8Array(length);
    }
  }

  private flush(): void {
    if (this.offset > 0) {
      this.chunks.push(this.buffer.slice(0, this.offset));
    }
    this.buffer = new Uint8Array(1024 * 1024);
    this.offset = 0;
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readByte(): number {
    if (this.offset >= this.bytes.byteLength) {
      throw new Error("Unexpected end of default analysis binary.");
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  readVarUint(): number {
    let value = 0;
    let multiplier = 1;

    for (;;) {
      const byte = this.readByte();
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) {
          throw new Error("Default analysis binary integer exceeds safe range.");
        }
        return value;
      }
      multiplier *= 0x80;
      if (multiplier > Number.MAX_SAFE_INTEGER / 0x80) {
        throw new Error("Default analysis binary varint is too large.");
      }
    }
  }

  readSignedVarInt(): number {
    return zigZagDecode(this.readVarUint());
  }

  readBytes(): Uint8Array {
    const length = this.readVarUint();
    this.ensure(length);
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  expectAscii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const byte = this.readByte();
      if (byte !== value.charCodeAt(index)) {
        throw new Error("Default analysis binary has an invalid header.");
      }
    }
  }

  expectDone(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error("Default analysis binary has trailing bytes.");
    }
  }

  private ensure(length: number): void {
    if (this.offset + length > this.bytes.byteLength) {
      throw new Error("Unexpected end of default analysis binary.");
    }
  }
}
