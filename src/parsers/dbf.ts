import { AccidentRecord, ParseProgress } from "../types";
import { accidentFromRecord, normalizeFieldName } from "./common";

type ProgressCallback = (progress: ParseProgress) => void;

interface DbfField {
  name: string;
  type: string;
  length: number;
  offset: number;
}

const WANTED_FIELDS = new Set([
  "ID",
  "OID_",
  "UIDENTSTLA",
  "UIDENTSTLAE",
  "ULAND",
  "UREGBEZ",
  "UKREIS",
  "UGEMEINDE",
  "UJAHR",
  "UMONAT",
  "USTUNDE",
  "UWOCHENTAG",
  "UKATEGORIE",
  "UART",
  "UTYP1",
  "ULICHTVERH",
  "USTRZUSTAND",
  "IstStrassenzustand",
  "istStrasse",
  "IstStrasse",
  "IstRad",
  "IstPKW",
  "IstFuss",
  "IstKrad",
  "IstGkfz",
  "IstSonstige",
  "LINREFX",
  "LINREFY",
  "XGCSWGS84",
  "YGCSWGS84",
  "PLST"
]);

const WANTED_FIELD_KEYS = new Set(Array.from(WANTED_FIELDS, normalizeFieldName));

export async function parseAccidentDbfFiles(files: File[], onProgress: ProgressCallback): Promise<AccidentRecord[]> {
  const dbfFiles = files.filter((file) => file.name.toLowerCase().endsWith(".dbf"));
  const accidents: AccidentRecord[] = [];

  for (const file of dbfFiles) {
    const parsed = await parseDbfAccidents(file, onProgress);
    accidents.push(...parsed);
  }

  return accidents;
}

async function parseDbfAccidents(file: File, onProgress: ProgressCallback): Promise<AccidentRecord[]> {
  const decoder = new TextDecoder("windows-1252");
  const headerProbe = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const view = new DataView(headerProbe.buffer);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const headerBytes =
    headerLength <= headerProbe.byteLength ? headerProbe : new Uint8Array(await file.slice(0, headerLength).arrayBuffer());
  const fields = readDbfFields(headerBytes);
  const selectedFields = fields.filter((field) => WANTED_FIELD_KEYS.has(normalizeFieldName(field.name)));

  if (
    !selectedFields.some((field) => normalizeFieldName(field.name) === normalizeFieldName("XGCSWGS84")) ||
    !selectedFields.some((field) => normalizeFieldName(field.name) === normalizeFieldName("YGCSWGS84"))
  ) {
    throw new Error(`${file.name} does not include XGCSWGS84/YGCSWGS84 fields.`);
  }

  const accidents: AccidentRecord[] = [];
  const recordsPerChunk = Math.max(1, Math.floor(4 * 1024 * 1024 / recordLength));

  for (let startRecord = 0; startRecord < recordCount; startRecord += recordsPerChunk) {
    const count = Math.min(recordsPerChunk, recordCount - startRecord);
    const startByte = headerLength + startRecord * recordLength;
    const endByte = startByte + count * recordLength;
    const chunk = new Uint8Array(await file.slice(startByte, endByte).arrayBuffer());

    for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
      const base = rowIndex * recordLength;
      if (chunk[base] === 0x2a) {
        continue;
      }

      const row: Record<string, string> = {};
      for (const field of selectedFields) {
        const valueBytes = chunk.subarray(base + field.offset, base + field.offset + field.length);
        row[field.name] = decoder.decode(valueBytes).trim();
      }

      const accident = accidentFromRecord(row, file.name, "dbf", startRecord + rowIndex);
      if (accident) {
        accidents.push(accident);
      }
    }

    onProgress({
      label: file.name,
      loaded: startRecord + count,
      total: recordCount,
      records: accidents.length,
      message: `${accidents.length.toLocaleString()} usable accidents from ${file.name}`
    });
    await yieldToBrowser();
  }

  return accidents;
}

function readDbfFields(header: Uint8Array): DbfField[] {
  const decoder = new TextDecoder("ascii");
  const fields: DbfField[] = [];
  let offset = 1;

  for (let position = 32; position < header.length; position += 32) {
    if (header[position] === 0x0d) {
      break;
    }
    const rawName = decoder.decode(header.subarray(position, position + 11));
    const name = rawName.replace(/\0.*$/, "").trim();
    const type = String.fromCharCode(header[position + 11]);
    const length = header[position + 16];
    fields.push({ name, type, length, offset });
    offset += length;
  }

  return fields;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
