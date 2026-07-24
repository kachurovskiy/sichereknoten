import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

const root = process.cwd();
const workbookPath = path.join(root, "data/AuszugGV2QAktuell.xlsx");
const outputPath = path.join(root, "src/municipalities.ts");
const textDecoder = new TextDecoder();
const BERLIN_DISTRICT_NAMES = new Map([
  ["01", "Mitte"],
  ["02", "Friedrichshain-Kreuzberg"],
  ["03", "Pankow"],
  ["04", "Charlottenburg-Wilmersdorf"],
  ["05", "Spandau"],
  ["06", "Steglitz-Zehlendorf"],
  ["07", "Tempelhof-Schöneberg"],
  ["08", "Neukölln"],
  ["09", "Treptow-Köpenick"],
  ["10", "Marzahn-Hellersdorf"],
  ["11", "Lichtenberg"],
  ["12", "Reinickendorf"]
]);
const HAMBURG_ADMINISTRATIVE_REGION_NAMES = new Map([
  ["1", "Hamburg-Mitte"],
  ["2", "Altona"],
  ["3", "Eimsbüttel"],
  ["4", "Hamburg-Nord"],
  ["5", "Wandsbek"],
  ["6", "Bergedorf"],
  ["7", "Harburg"]
]);

const workbook = unzipSync(await readFile(workbookPath));
const sharedStrings = parseSharedStrings(readXml("xl/sharedStrings.xml"));
const rows = parseRows(readXml("xl/worksheets/sheet2.xml"), sharedStrings);
const administrativeRegions = new Map();
const districts = new Map();
const municipalities = new Map();
const statePopulations = new Map();
const administrativeRegionPopulations = new Map();
const municipalityPopulations = new Map();

for (const row of rows) {
  const rowType = cleanName(row.A);
  if (rowType === "20" && hasValue(row.C) && hasValue(row.D) && hasValue(row.H)) {
    administrativeRegions.set(administrativeRegionKey(row.C, row.D), cleanName(row.H));
  } else if (rowType === "40" && hasValue(row.C) && hasValue(row.D) && hasValue(row.E) && hasValue(row.H)) {
    districts.set(districtKey(row.C, row.D, row.E), cleanName(row.H));
  } else if (rowType === "60" && hasValue(row.C) && hasValue(row.D) && hasValue(row.E) && hasValue(row.G) && hasValue(row.H)) {
    const key = municipalityKey(row.C, row.D, row.E, row.G);
    const population = parsePopulation(row.J);
    municipalities.set(key, cleanName(row.H));
    if (population !== null) {
      municipalityPopulations.set(key, population);
      addPopulation(statePopulations, codePart(row.C, 2), population);
      addPopulation(administrativeRegionPopulations, administrativeRegionKey(row.C, row.D), population);
    }
  }
}

await writeFile(
  outputPath,
  renderSource(administrativeRegions, districts, municipalities, statePopulations, administrativeRegionPopulations, municipalityPopulations)
);
console.log(
  `Wrote ${administrativeRegions.size} administrative regions, ${districts.size} districts, ${municipalities.size} municipalities, and ${municipalityPopulations.size} population entries to ${path.relative(root, outputPath)}.`
);

function readXml(name) {
  const file = workbook[name];
  if (!file) {
    throw new Error(`Missing workbook entry: ${name}`);
  }
  return textDecoder.decode(file);
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((entry) => decodeXml(entry[1])).join("");
    strings.push(text);
  }
  return strings;
}

function parseRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    const cellsXml = rowMatch[1].replace(/<c\b[^>]*\/>/g, "");
    for (const cellMatch of cellsXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const ref = attribute(attrs, "r");
      const valueMatch = cellMatch[2].match(/<v>([\s\S]*?)<\/v>/);
      if (!ref || !valueMatch) {
        continue;
      }
      const column = ref.match(/^[A-Z]+/)?.[0];
      if (!column) {
        continue;
      }
      const rawValue = valueMatch[1];
      row[column] = attribute(attrs, "t") === "s" ? sharedStrings[Number(rawValue)] ?? "" : decodeXml(rawValue);
    }
    rows.push(row);
  }
  return rows;
}

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function administrativeRegionKey(stateCode, administrativeRegionCode) {
  return [
    codePart(stateCode, 2),
    codePart(administrativeRegionCode, 1)
  ].join("");
}

function districtKey(stateCode, administrativeRegionCode, districtCode) {
  return [
    codePart(stateCode, 2),
    codePart(administrativeRegionCode, 1),
    codePart(districtCode, 2)
  ].join("");
}

function municipalityKey(stateCode, administrativeRegionCode, districtCode, municipalityCode) {
  return [
    codePart(stateCode, 2),
    codePart(administrativeRegionCode, 1),
    codePart(districtCode, 2),
    codePart(municipalityCode, 3)
  ].join("");
}

function codePart(value, width) {
  return String(value ?? "")
    .trim()
    .replace(/\D/g, "")
    .padStart(width, "0")
    .slice(-width);
}

function cleanName(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function hasValue(value) {
  return cleanName(value) !== "";
}

function parsePopulation(value) {
  const normalized = cleanName(value).replace(/\D/g, "");
  if (!normalized) {
    return null;
  }
  const population = Number(normalized);
  return Number.isFinite(population) ? population : null;
}

function addPopulation(map, key, population) {
  map.set(key, (map.get(key) ?? 0) + population);
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function renderSource(
  administrativeRegions,
  districts,
  municipalities,
  statePopulations,
  administrativeRegionPopulations,
  municipalityPopulations
) {
  return `// Generated by scripts/generate-municipalities.mjs from data/AuszugGV2QAktuell.xlsx.
// Do not edit manually.

const ADMINISTRATIVE_REGION_NAMES: Record<string, string> = {
${renderEntries(administrativeRegions)}
};

const HAMBURG_ADMINISTRATIVE_REGION_NAMES: Record<string, string> = {
${renderEntries(HAMBURG_ADMINISTRATIVE_REGION_NAMES)}
};

const DISTRICT_NAMES: Record<string, string> = {
${renderEntries(districts)}
};

const BERLIN_DISTRICT_NAMES: Record<string, string> = {
${renderEntries(BERLIN_DISTRICT_NAMES)}
};

const MUNICIPALITY_NAMES: Record<string, string> = {
${renderEntries(municipalities)}
};

const STATE_POPULATIONS: Record<string, number> = {
${renderEntries(statePopulations)}
};

const ADMINISTRATIVE_REGION_POPULATIONS: Record<string, number> = {
${renderEntries(administrativeRegionPopulations)}
};

const MUNICIPALITY_POPULATIONS: Record<string, number> = {
${renderEntries(municipalityPopulations)}
};

export function administrativeRegionNameFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined
): string | null {
  const hamburgAdministrativeRegionName = hamburgAdministrativeRegionNameFor(stateCode, administrativeRegionCode);
  if (hamburgAdministrativeRegionName) {
    return hamburgAdministrativeRegionName;
  }
  const key = administrativeRegionLookupKey(stateCode, administrativeRegionCode);
  return key ? ADMINISTRATIVE_REGION_NAMES[key] ?? null : null;
}

export function districtNameFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined,
  districtCode: string | null | undefined
): string | null {
  const berlinDistrictName = berlinDistrictNameFor(stateCode, districtCode);
  if (berlinDistrictName) {
    return berlinDistrictName;
  }
  const key = districtLookupKey(stateCode, administrativeRegionCode, districtCode);
  return key ? DISTRICT_NAMES[key] ?? null : null;
}

export function municipalityNameFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined,
  districtCode: string | null | undefined,
  municipalityCode: string | null | undefined
): string | null {
  const key = municipalityLookupKey(stateCode, administrativeRegionCode, districtCode, municipalityCode);
  return key ? MUNICIPALITY_NAMES[key] ?? null : null;
}

export function statePopulationFor(stateCode: string | null | undefined): number | null {
  const state = normalizeCodePart(stateCode, 2);
  return state ? STATE_POPULATIONS[state] ?? null : null;
}

export function administrativeRegionPopulationFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined
): number | null {
  const key = administrativeRegionLookupKey(stateCode, administrativeRegionCode);
  return key ? ADMINISTRATIVE_REGION_POPULATIONS[key] ?? null : null;
}

export function municipalityPopulationFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined,
  districtCode: string | null | undefined,
  municipalityCode: string | null | undefined
): number | null {
  const key = municipalityLookupKey(stateCode, administrativeRegionCode, districtCode, municipalityCode);
  return key ? MUNICIPALITY_POPULATIONS[key] ?? null : null;
}

function administrativeRegionLookupKey(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined
): string | null {
  const state = normalizeCodePart(stateCode, 2);
  const administrativeRegion = normalizeCodePart(administrativeRegionCode, 1);
  return state && administrativeRegion ? \`\${state}\${administrativeRegion}\` : null;
}

function hamburgAdministrativeRegionNameFor(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined
): string | null {
  const state = normalizeCodePart(stateCode, 2);
  const administrativeRegion = normalizeCodePart(administrativeRegionCode, 1);
  return state === "02" && administrativeRegion ? HAMBURG_ADMINISTRATIVE_REGION_NAMES[administrativeRegion] ?? null : null;
}

function districtLookupKey(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined,
  districtCode: string | null | undefined
): string | null {
  const state = normalizeCodePart(stateCode, 2);
  const district = normalizeCodePart(districtCode, 2);
  return state && district ? \`\${state}\${normalizeCodePart(administrativeRegionCode, 1) ?? "0"}\${district}\` : null;
}

function berlinDistrictNameFor(
  stateCode: string | null | undefined,
  districtCode: string | null | undefined
): string | null {
  const state = normalizeCodePart(stateCode, 2);
  const district = normalizeCodePart(districtCode, 2);
  return state === "11" && district ? BERLIN_DISTRICT_NAMES[district] ?? null : null;
}

function municipalityLookupKey(
  stateCode: string | null | undefined,
  administrativeRegionCode: string | null | undefined,
  districtCode: string | null | undefined,
  municipalityCode: string | null | undefined
): string | null {
  const state = normalizeCodePart(stateCode, 2);
  const district = normalizeCodePart(districtCode, 2);
  const municipality = normalizeCodePart(municipalityCode, 3);
  return state && district && municipality
    ? \`\${state}\${normalizeCodePart(administrativeRegionCode, 1) ?? "0"}\${district}\${municipality}\`
    : null;
}

function normalizeCodePart(value: string | null | undefined, width: number): string | null {
  const digits = String(value ?? "").trim().replace(/\\D/g, "");
  return digits ? digits.padStart(width, "0").slice(-width) : null;
}
`;
}

function renderEntries(entries) {
  return [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
}
