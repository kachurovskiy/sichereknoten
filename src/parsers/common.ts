import { AccidentRecord } from "../types";
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

export function parseBooleanFlag(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "ja" || raw === "yes";
}

export function severityWeight(category: number | null): number {
  if (category === 1) {
    return 12;
  }
  if (category === 2) {
    return 5;
  }
  if (category === 3) {
    return 2;
  }
  return 1;
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
  const category = parseInteger(readField(fields, "UKATEGORIE"));
  const id = String(readField(fields, "UIDENTSTLAE", "UIDENTSTLA") ?? `${source}:${index}`);

  return {
    id,
    source,
    sourceType,
    stateCode,
    stateName: stateNameFor(stateCode),
    year: parseInteger(readField(fields, "UJAHR")) ?? 0,
    month: parseInteger(readField(fields, "UMONAT")),
    hour: parseInteger(readField(fields, "USTUNDE")),
    weekday: parseInteger(readField(fields, "UWOCHENTAG")),
    category,
    accidentType: parseInteger(readField(fields, "UART")),
    severityWeight: severityWeight(category),
    lon,
    lat,
    involvesBike: parseBooleanFlag(readField(fields, "IstRad")),
    involvesPedestrian: parseBooleanFlag(readField(fields, "IstFuss")),
    involvesMotorcycle: parseBooleanFlag(readField(fields, "IstKrad")),
    involvesCar: parseBooleanFlag(readField(fields, "IstPKW")),
    involvesTruck: parseBooleanFlag(readField(fields, "IstGkfz"))
  };
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
