import { AccidentRecord } from "../types";
import { administrativeRegionNameFor, districtNameFor, municipalityNameFor } from "../municipalities";
import { normalizeStateCode, stateNameFor } from "../states";

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-") {
    return null;
  }
  const normalized = raw.replace(/\s/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseInteger(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export function parseBooleanFlag(value: unknown): boolean | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "-") {
    return null;
  }
  if (raw === "1" || raw === "true" || raw === "ja" || raw === "yes") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "nein" || raw === "no") {
    return false;
  }
  return null;
}

export function accidentFromRecord(
  fields: Record<string, unknown>,
  source: string,
  sourceType: AccidentRecord["sourceType"],
  index: number
): AccidentRecord | null {
  const lon = parseNumber(readField(fields, "XGCSWGS84"));
  const lat = parseNumber(readField(fields, "YGCSWGS84"));
  if (lon === null || lat === null || lat < 45 || lat > 56 || lon < 5 || lon > 16) {
    return null;
  }

  const stateCode = normalizeStateCode(readField(fields, "ULAND"));
  const administrativeRegionCode = readOptionalString(readField(fields, "UREGBEZ"));
  const districtCode = readOptionalString(readField(fields, "UKREIS"));
  const municipalityCode = readOptionalString(readField(fields, "UGEMEINDE"));
  const category = parseInteger(readField(fields, "UKATEGORIE"));
  const id = readOptionalString(readField(fields, "UIDENTSTLAE", "UIDENTSTLA", "ID", "OID_")) ?? `${source}:${index}`;
  const serialNumber = readOptionalString(readField(fields, "ID", "OID_"));

  return {
    id,
    serialNumber,
    source,
    sourceType,
    stateCode,
    stateName: stateNameFor(stateCode),
    administrativeRegionCode,
    administrativeRegionName: administrativeRegionNameFor(stateCode, administrativeRegionCode),
    districtCode,
    districtName: districtNameFor(stateCode, administrativeRegionCode, districtCode),
    municipalityCode,
    municipalityName: municipalityNameFor(stateCode, administrativeRegionCode, districtCode, municipalityCode),
    year: parseInteger(readField(fields, "UJAHR")) ?? 0,
    month: parseInteger(readField(fields, "UMONAT")),
    hour: parseInteger(readField(fields, "USTUNDE")),
    weekday: parseInteger(readField(fields, "UWOCHENTAG")),
    category,
    accidentKind: parseInteger(readField(fields, "UART")),
    accidentType: parseInteger(readField(fields, "UTYP1")),
    lightCondition: parseInteger(readField(fields, "ULICHTVERH")),
    roadSurface: parseInteger(readField(fields, "USTRZUSTAND", "IstStrassenzustand", "istStrasse", "IstStrasse")),
    plausibilityLevel: parseInteger(readField(fields, "PLST")),
    linRefX: parseNumber(readField(fields, "LINREFX")),
    linRefY: parseNumber(readField(fields, "LINREFY")),
    lon,
    lat,
    involvesBike: parseBooleanFlag(readField(fields, "IstRad")),
    involvesPedestrian: parseBooleanFlag(readField(fields, "IstFuss")),
    involvesMotorcycle: parseBooleanFlag(readField(fields, "IstKrad")),
    involvesCar: parseBooleanFlag(readField(fields, "IstPKW")),
    involvesTruck: parseBooleanFlag(readField(fields, "IstGkfz")),
    involvesOther: parseBooleanFlag(readField(fields, "IstSonstige"))
  };
}

function readOptionalString(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return raw && raw !== "-" ? raw : null;
}

export function readField(fields: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in fields) {
      return fields[name];
    }
    const normalized = normalizeFieldName(name);
    const match = Object.keys(fields).find((field) => normalizeFieldName(field) === normalized);
    if (match) {
      return fields[match];
    }
  }
  return undefined;
}

export function normalizeFieldName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
