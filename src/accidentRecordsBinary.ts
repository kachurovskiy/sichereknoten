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
import type { AccidentRecord } from "./types";

export const ACCIDENT_RECORDS_BINARY_MAGIC = "SKACC01";
export const ACCIDENT_LINREF_SCALE = 100;

const ACCIDENT_SOURCE_TYPES: readonly AccidentRecord["sourceType"][] = ["csv", "dbf"];
const ACCIDENT_SOURCE_TYPE_IDS = new Map<AccidentRecord["sourceType"], number>(
  ACCIDENT_SOURCE_TYPES.map((value, index) => [value, index])
);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type NullableIntegerField =
  | "month"
  | "day"
  | "hour"
  | "weekday"
  | "category"
  | "accidentKind"
  | "accidentType"
  | "lightCondition"
  | "roadSurface"
  | "plausibilityLevel";

type NullableBooleanField =
  | "involvesBike"
  | "involvesPedestrian"
  | "involvesMotorcycle"
  | "involvesCar"
  | "involvesTruck"
  | "involvesOther"
  | "osmRoundabout"
  | "osmTrafficSignal";

const ACCIDENT_NULLABLE_INTEGER_FIELDS: readonly NullableIntegerField[] = [
  "month",
  "day",
  "hour",
  "weekday",
  "category",
  "accidentKind",
  "accidentType",
  "lightCondition",
  "roadSurface",
  "plausibilityLevel"
];

const ACCIDENT_NULLABLE_BOOLEAN_FIELDS: readonly NullableBooleanField[] = [
  "involvesBike",
  "involvesPedestrian",
  "involvesMotorcycle",
  "involvesCar",
  "involvesTruck",
  "involvesOther",
  "osmRoundabout",
  "osmTrafficSignal"
];

export function encodeAccidentRecordsBinary(records: AccidentRecord[]): Uint8Array {
  const strings = accidentRecordStringDictionary(records);
  const stringIds = new Map(strings.map((value, index) => [value, index]));
  const writer = new BinaryWriter("accident records binary");
  writer.writeAscii(ACCIDENT_RECORDS_BINARY_MAGIC);
  writer.writeVarUint(records.length);
  writeStringDictionary(writer, strings);
  for (const record of records) {
    writeAccidentRecord(writer, stringIds, record);
  }
  return writer.finish();
}

export function decodeAccidentRecordsBinary(bytes: Uint8Array): AccidentRecord[] {
  const reader = new BinaryReader(bytes, "accident records binary");
  reader.expectAscii(ACCIDENT_RECORDS_BINARY_MAGIC);
  const recordCount = reader.readVarUint();
  const strings = readStringDictionary(reader);
  const records: AccidentRecord[] = new Array(recordCount);
  for (let index = 0; index < recordCount; index += 1) {
    records[index] = readAccidentRecord(reader, strings);
  }
  reader.expectDone();
  return records;
}

function accidentRecordStringDictionary(records: AccidentRecord[]): string[] {
  const strings: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value !== "string" || seen.has(value)) {
      return;
    }
    seen.add(value);
    strings.push(value);
  };

  for (const record of records) {
    add(record.source);
    add(record.administrativeRegionCode);
    add(record.administrativeRegionName);
    add(record.districtCode);
    add(record.districtName);
    add(record.municipalityCode);
    add(record.municipalityName);
    for (const streetName of record.streetNames) {
      add(streetName);
    }
  }

  return strings;
}

function writeAccidentRecord(writer: BinaryWriter, stringIds: Map<string, number>, record: AccidentRecord): void {
  writeInlineString(writer, record.id);
  writeNullableInlineString(writer, record.serialNumber);
  writeSourceType(writer, record.sourceType);
  writeStringId(writer, stringIds, record.source, "accident records");
  writeNullableUint(writer, record.recordIndex ?? null, "recordIndex");
  writer.writeVarUint(stateCodeNumber(record.stateCode, "accident records binary"));
  writeNullableStringId(writer, stringIds, record.administrativeRegionCode, "accident records");
  writeNullableStringId(writer, stringIds, record.districtCode, "accident records");
  writeNullableStringId(writer, stringIds, record.municipalityCode, "accident records");
  writeNullableStringId(writer, stringIds, record.administrativeRegionName, "accident records");
  writeNullableStringId(writer, stringIds, record.districtName, "accident records");
  writeNullableStringId(writer, stringIds, record.municipalityName, "accident records");
  writeRequiredUint(writer, record.year, "year");
  for (const field of ACCIDENT_NULLABLE_INTEGER_FIELDS) {
    writeNullableUint(writer, record[field], field);
  }
  writeNullableScaledSigned(writer, record.linRefX, ACCIDENT_LINREF_SCALE, "linRefX");
  writeNullableScaledSigned(writer, record.linRefY, ACCIDENT_LINREF_SCALE, "linRefY");
  writeFloat64(writer, record.lon, "lon");
  writeFloat64(writer, record.lat, "lat");
  writeStringArray(writer, stringIds, record.streetNames);
  for (const field of ACCIDENT_NULLABLE_BOOLEAN_FIELDS) {
    writer.writeByte(nullableBooleanId(record[field]));
  }
}

function readAccidentRecord(reader: BinaryReader, strings: string[]): AccidentRecord {
  const id = readInlineString(reader);
  const serialNumber = readNullableInlineString(reader);
  const sourceType = readSourceType(reader);
  const source = readStringId(reader, strings, "accident records");
  const recordIndex = readNullableUint(reader);
  const stateCode = stateCodeFromNumber(reader.readVarUint());
  const administrativeRegionCode = readNullableStringId(reader, strings, "accident records");
  const districtCode = readNullableStringId(reader, strings, "accident records");
  const municipalityCode = readNullableStringId(reader, strings, "accident records");
  const administrativeRegionName = readNullableStringId(reader, strings, "accident records");
  const districtName = readNullableStringId(reader, strings, "accident records");
  const municipalityName = readNullableStringId(reader, strings, "accident records");
  const year = reader.readVarUint();
  const month = readNullableUint(reader);
  const day = readNullableUint(reader);
  const hour = readNullableUint(reader);
  const weekday = readNullableUint(reader);
  const category = readNullableUint(reader);
  const accidentKind = readNullableUint(reader);
  const accidentType = readNullableUint(reader);
  const lightCondition = readNullableUint(reader);
  const roadSurface = readNullableUint(reader);
  const plausibilityLevel = readNullableUint(reader);
  const linRefX = readNullableScaledSigned(reader, ACCIDENT_LINREF_SCALE);
  const linRefY = readNullableScaledSigned(reader, ACCIDENT_LINREF_SCALE);
  const lon = reader.readFloat64();
  const lat = reader.readFloat64();
  const streetNames = readStringArray(reader, strings);
  const involvesBike = readNullableBoolean(reader);
  const involvesPedestrian = readNullableBoolean(reader);
  const involvesMotorcycle = readNullableBoolean(reader);
  const involvesCar = readNullableBoolean(reader);
  const involvesTruck = readNullableBoolean(reader);
  const involvesOther = readNullableBoolean(reader);
  const osmRoundabout = readNullableBoolean(reader);
  const osmTrafficSignal = readNullableBoolean(reader);
  const record: AccidentRecord = {
    id,
    serialNumber,
    source,
    sourceType,
    streetName: streetNames[0] ?? null,
    streetNames,
    osmRoundabout,
    osmTrafficSignal,
    stateCode,
    stateName: stateNameFor(stateCode),
    administrativeRegionCode,
    administrativeRegionName,
    districtCode,
    districtName,
    municipalityCode,
    municipalityName,
    year,
    month,
    day,
    hour,
    weekday,
    category,
    accidentKind,
    accidentType,
    lightCondition,
    roadSurface,
    plausibilityLevel,
    linRefX,
    linRefY,
    lon,
    lat,
    involvesBike,
    involvesPedestrian,
    involvesMotorcycle,
    involvesCar,
    involvesTruck,
    involvesOther
  };
  if (recordIndex !== null) {
    record.recordIndex = recordIndex;
  }
  return record;
}

function writeStringDictionary(writer: BinaryWriter, strings: string[]): void {
  writer.writeVarUint(strings.length);
  for (const value of strings) {
    writeInlineString(writer, value);
  }
}

function writeStringArray(writer: BinaryWriter, stringIds: Map<string, number>, values: string[]): void {
  writer.writeVarUint(values.length);
  for (const value of values) {
    writeStringId(writer, stringIds, value, "accident records");
  }
}

function writeInlineString(writer: BinaryWriter, value: string): void {
  writer.writeBytes(textEncoder.encode(value));
}

function writeNullableInlineString(writer: BinaryWriter, value: string | null): void {
  if (value === null) {
    writer.writeByte(0);
    return;
  }
  writer.writeByte(1);
  writeInlineString(writer, value);
}

function writeSourceType(writer: BinaryWriter, value: AccidentRecord["sourceType"]): void {
  const id = ACCIDENT_SOURCE_TYPE_IDS.get(value);
  if (id === undefined) {
    throw new Error(`Invalid accident record source type: ${value}`);
  }
  writer.writeByte(id);
}

function writeRequiredUint(writer: BinaryWriter, value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid accident record ${field}: ${value}`);
  }
  writer.writeVarUint(Math.round(value));
}

function writeFloat64(writer: BinaryWriter, value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid accident record ${field}: ${value}`);
  }
  writer.writeFloat64(value);
}

function readStringDictionary(reader: BinaryReader): string[] {
  const count = reader.readVarUint();
  const strings: string[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    strings[index] = readInlineString(reader);
  }
  return strings;
}

function readStringArray(reader: BinaryReader, strings: string[]): string[] {
  const count = reader.readVarUint();
  const values: string[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = readStringId(reader, strings, "accident records");
  }
  return values;
}

function readInlineString(reader: BinaryReader): string {
  return textDecoder.decode(reader.readBytes());
}

function readNullableInlineString(reader: BinaryReader): string | null {
  const marker = reader.readByte();
  if (marker === 0) {
    return null;
  }
  if (marker === 1) {
    return readInlineString(reader);
  }
  throw new Error(`Invalid accident records nullable string marker ${marker}.`);
}

function readSourceType(reader: BinaryReader): AccidentRecord["sourceType"] {
  const id = reader.readByte();
  const sourceType = ACCIDENT_SOURCE_TYPES[id];
  if (!sourceType) {
    throw new Error(`Invalid accident record source type id ${id}.`);
  }
  return sourceType;
}
