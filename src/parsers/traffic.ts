import { strFromU8, unzipSync } from "fflate";
import { normalizeStateCode, stateNameFor } from "../states";
import { TrafficPoint, ParseProgress } from "../types";
import { utm32ToWgs84 } from "../geo";
import { parseNumber, readField } from "./common";

type ProgressCallback = (progress: ParseProgress) => void;

export async function parseTrafficWorkbook(file: File, onProgress: ProgressCallback): Promise<TrafficPoint[]> {
  onProgress({ label: file.name, message: "Reading traffic workbook" });
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const sharedStrings = parseSharedStrings(readZipText(zip, "xl/sharedStrings.xml"));
  const selectedSheet = findSheet(zip, "Zeilenformat");
  const sheetXml = readZipText(zip, selectedSheet.path);
  const rows = rowsFromSheet(sheetXml, sharedStrings);
  const points: TrafficPoint[] = [];

  rows.forEach((row, index) => {
    const x = parseNumber(readField(row, "X_Koordinate"));
    const y = parseNumber(readField(row, "Y_Koordinate"));
    if (x === null || y === null) {
      return;
    }

    const converted = utm32ToWgs84(x, y);
    if (converted.lat < 45 || converted.lat > 56 || converted.lon < 5 || converted.lon > 16) {
      return;
    }

    const stateCode = normalizeStateCode(readField(row, "Land"));
    const road = String(readField(row, "Str") ?? "").trim();
    const stationNo = String(readField(row, "TKZST") ?? "").trim();

    points.push({
      id: `${road || "road"}:${stationNo || index}`,
      road,
      stationNo,
      stateCode,
      stateName: stateNameFor(stateCode),
      from: String(readField(row, "Anfang") ?? "").trim(),
      to: String(readField(row, "Ende") ?? "").trim(),
      dtv: parseNumber(readField(row, "DTV")),
      dtvHeavy: parseNumber(readField(row, "DTVSV")),
      x,
      y,
      lon: converted.lon,
      lat: converted.lat
    });
  });

  onProgress({
    label: file.name,
    records: points.length,
    message: `${points.length.toLocaleString()} traffic points from ${selectedSheet.name}`
  });

  return points;
}

function readZipText(zip: Record<string, Uint8Array>, path: string): string {
  const entry = zip[path];
  if (!entry) {
    throw new Error(`Workbook is missing ${path}.`);
  }
  return strFromU8(entry);
}

function findSheet(zip: Record<string, Uint8Array>, preferredName: string): { name: string; path: string } {
  const workbookXml = readZipText(zip, "xl/workbook.xml");
  const relsXml = readZipText(zip, "xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  const relRegex = /<Relationship\b([^>]*)\/?>/g;
  let relMatch: RegExpExecArray | null;

  while ((relMatch = relRegex.exec(relsXml))) {
    const id = attr(relMatch[1], "Id");
    const target = attr(relMatch[1], "Target");
    if (id && target) {
      rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }

  const sheets: Array<{ name: string; id: string }> = [];
  const sheetRegex = /<sheet\b([^>]*)\/?>/g;
  let sheetMatch: RegExpExecArray | null;
  while ((sheetMatch = sheetRegex.exec(workbookXml))) {
    const name = attr(sheetMatch[1], "name");
    const id = attr(sheetMatch[1], "r:id");
    if (name && id) {
      sheets.push({ name: decodeXml(name), id });
    }
  }

  const selected = sheets.find((sheet) => sheet.name === preferredName) ?? sheets[0];
  if (!selected) {
    throw new Error("Workbook does not contain worksheets.");
  }
  const path = rels.get(selected.id);
  if (!path) {
    throw new Error(`Workbook relationship for ${selected.name} was not found.`);
  }
  return { name: selected.name, path };
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  const itemRegex = /<si\b[\s\S]*?<\/si>/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(xml))) {
    const item = itemMatch[0];
    const parts: string[] = [];
    const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textRegex.exec(item))) {
      parts.push(decodeXml(textMatch[1]));
    }
    values.push(parts.join(""));
  }

  return values;
}

function rowsFromSheet(xml: string, sharedStrings: string[]): Array<Record<string, unknown>> {
  const header = new Map<string, string>();
  const rows: Array<Record<string, unknown>> = [];
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  let sequentialRowNumber = 0;

  while ((rowMatch = rowRegex.exec(xml))) {
    sequentialRowNumber += 1;
    const rowNumber = Number(attr(rowMatch[1], "r") ?? sequentialRowNumber);
    const cells = parseCells(rowMatch[2], sharedStrings);

    if (rowNumber === 1) {
      cells.forEach((value, column) => {
        if (value) {
          header.set(column, value);
        }
      });
      continue;
    }

    if (header.size === 0) {
      continue;
    }

    const row: Record<string, unknown> = {};
    cells.forEach((value, column) => {
      const fieldName = header.get(column);
      if (fieldName) {
        row[fieldName] = value;
      }
    });
    rows.push(row);
  }

  return rows;
}

function parseCells(rowXml: string, sharedStrings: string[]): Map<string, string> {
  const cells = new Map<string, string>();
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let cellMatch: RegExpExecArray | null;

  while ((cellMatch = cellRegex.exec(rowXml))) {
    const attributes = cellMatch[1];
    const body = cellMatch[2];
    const ref = attr(attributes, "r");
    if (!ref) {
      continue;
    }

    const column = ref.replace(/\d/g, "");
    const type = attr(attributes, "t");
    let value = "";
    if (type === "inlineStr") {
      value = textFromInlineString(body);
    } else {
      const valueMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
      value = valueMatch ? decodeXml(valueMatch[1]) : "";
      if (type === "s") {
        value = sharedStrings[Number(value)] ?? "";
      }
    }
    cells.set(column, value);
  }

  return cells;
}

function textFromInlineString(xml: string): string {
  const parts: string[] = [];
  const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml))) {
    parts.push(decodeXml(match[1]));
  }
  return parts.join("");
}

function attr(attributes: string, name: string): string | null {
  const escaped = name.replace(":", "\\:");
  const match = new RegExp(`\\b${escaped}="([^"]*)"`).exec(attributes);
  return match ? match[1] : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
