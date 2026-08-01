import { AccidentRecord, ParseProgress } from "../domain/types";
import { accidentFromRecord } from "./common";

type ProgressCallback = (progress: ParseProgress) => void;

export async function parseAccidentCsvFiles(files: File[], onProgress: ProgressCallback): Promise<AccidentRecord[]> {
  const csvFiles = files.filter((file) => file.name.toLowerCase().endsWith(".csv"));
  const accidents: AccidentRecord[] = [];

  for (const file of csvFiles) {
    let headers: string[] | null = null;
    let recordIndex = 0;
    let accepted = 0;

    for await (const line of readLines(file)) {
      if (!line.trim()) {
        continue;
      }
      if (!headers) {
        headers = parseDelimitedLine(line);
        continue;
      }

      recordIndex += 1;
      const values = parseDelimitedLine(line);
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? "";
      });
      const accident = accidentFromRecord(row, file.name, "csv", recordIndex);
      if (accident) {
        accidents.push(accident);
        accepted += 1;
      }

      if (recordIndex % 10000 === 0) {
        onProgress({
          label: file.name,
          records: accidents.length,
          message: `${accepted.toLocaleString()} usable accidents from ${file.name}`
        });
        await yieldToBrowser();
      }
    }

    onProgress({
      label: file.name,
      records: accidents.length,
      message: `${accepted.toLocaleString()} usable accidents from ${file.name}`
    });
  }

  return accidents;
}

async function* readLines(file: Blob): AsyncGenerator<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("windows-1252");
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      yield line;
    }
  }

  buffered += decoder.decode();
  if (buffered) {
    yield buffered;
  }
}

function parseDelimitedLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ";" && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
