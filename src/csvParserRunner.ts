import { parseAccidentCsvFiles } from "./parsers/csv";
import { CsvParserWorkerRequest, CsvParserWorkerResponse } from "./csvParserWorkerProtocol";
import { AccidentRecord, ParseProgress } from "./types";

declare const __SICHERE_KNOTEN_CSV_PARSER_WORKER_URL__: string | undefined;

export interface CsvParseExecutionPlan {
  background: boolean;
  fallback: boolean;
  parallel: boolean;
  workerCount: number;
  fileCount: number;
}

interface CsvParseFileEvent {
  index: number;
  file: File;
}

interface CsvParseFileResultEvent extends CsvParseFileEvent {
  accidents: AccidentRecord[];
}

interface CsvParseProgressEvent extends CsvParseFileEvent {
  progress: ParseProgress;
}

interface CsvParseCallbacks {
  onPlan?: (plan: CsvParseExecutionPlan) => void;
  onFileStart?: (event: CsvParseFileEvent) => void;
  onFileProgress?: (event: CsvParseProgressEvent) => void;
  onFileComplete?: (event: CsvParseFileResultEvent) => void;
  onFileError?: (event: CsvParseFileEvent, error: unknown) => void;
}

const MAX_CSV_PARSE_WORKERS = 5;

export async function parseAccidentCsvFilesInBackground(files: File[], callbacks: CsvParseCallbacks = {}): Promise<AccidentRecord[]> {
  const csvFiles = files.filter((file) => file.name.toLowerCase().endsWith(".csv"));
  if (csvFiles.length === 0) {
    callbacks.onPlan?.(mainThreadPlan(0, false));
    return [];
  }

  if (!canUseWorkers()) {
    callbacks.onPlan?.(mainThreadPlan(csvFiles.length, true));
    return parseFilesOnMainThread(csvFiles, callbacks);
  }

  const workerCount = Math.min(csvFiles.length, availableWorkerCount());
  callbacks.onPlan?.({
    background: true,
    fallback: false,
    parallel: workerCount > 1,
    workerCount,
    fileCount: csvFiles.length
  });

  const results = await runWorkerFiles(csvFiles, workerCount, callbacks);
  return results.flat();
}

async function parseFilesOnMainThread(files: File[], callbacks: CsvParseCallbacks): Promise<AccidentRecord[]> {
  const results: AccidentRecord[][] = [];
  for (const [index, file] of files.entries()) {
    callbacks.onFileStart?.({ index, file });
    try {
      const accidents = await parseAccidentCsvFiles([file], (progress) => {
        callbacks.onFileProgress?.({ index, file, progress });
      });
      results[index] = accidents;
      callbacks.onFileComplete?.({ index, file, accidents });
    } catch (error) {
      callbacks.onFileError?.({ index, file }, error);
      throw error;
    }
  }
  return results.flat();
}

function runWorkerFiles(files: File[], workerCount: number, callbacks: CsvParseCallbacks): Promise<AccidentRecord[][]> {
  const results: AccidentRecord[][] = new Array(files.length);
  const workers: Worker[] = [];
  let nextFile = 0;
  let completed = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      workers.forEach((worker) => worker.terminate());
      reject(error);
    };

    const runNext = (worker: Worker) => {
      if (settled) {
        return;
      }

      const fileIndex = nextFile;
      nextFile += 1;
      if (fileIndex >= files.length) {
        worker.terminate();
        return;
      }

      const file = files[fileIndex];
      callbacks.onFileStart?.({ index: fileIndex, file });
      worker.onmessage = (event: MessageEvent<CsvParserWorkerResponse>) => {
        const response = event.data;
        if (response.id !== fileIndex || settled) {
          return;
        }
        if (response.type === "progress") {
          callbacks.onFileProgress?.({ index: fileIndex, file, progress: response.progress });
          return;
        }
        if (response.type === "error") {
          callbacks.onFileError?.({ index: fileIndex, file }, new Error(response.error));
          fail(new Error(response.error));
          return;
        }

        results[fileIndex] = response.accidents;
        callbacks.onFileComplete?.({ index: fileIndex, file, accidents: response.accidents });
        completed += 1;
        if (completed === files.length) {
          settled = true;
          workers.forEach((entry) => entry.terminate());
          resolve(results);
          return;
        }
        runNext(worker);
      };
      worker.onerror = (event) => {
        callbacks.onFileError?.({ index: fileIndex, file }, event.error ?? new Error(event.message));
        fail(event.error ?? new Error(event.message));
      };

      const request: CsvParserWorkerRequest = {
        id: fileIndex,
        file
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        callbacks.onFileError?.({ index: fileIndex, file }, error);
        fail(error);
      }
    };

    for (let index = 0; index < workerCount; index += 1) {
      try {
        const worker = createCsvParserWorker();
        workers.push(worker);
        runNext(worker);
      } catch (error) {
        fail(error);
        break;
      }
    }
  });
}

function createCsvParserWorker(): Worker {
  const bundledWorkerUrl =
    typeof __SICHERE_KNOTEN_CSV_PARSER_WORKER_URL__ === "string" ? __SICHERE_KNOTEN_CSV_PARSER_WORKER_URL__ : null;
  return bundledWorkerUrl
    ? new Worker(bundledWorkerUrl)
    : new Worker("/src/csvParserWorker.ts", { type: "module" });
}

function canUseWorkers(): boolean {
  return typeof Worker !== "undefined";
}

function availableWorkerCount(): number {
  const hardwareConcurrency = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Math.min(MAX_CSV_PARSE_WORKERS, Math.max(1, Math.floor((hardwareConcurrency || 1) - 1)));
}

function mainThreadPlan(fileCount: number, fallback: boolean): CsvParseExecutionPlan {
  return {
    background: false,
    fallback,
    parallel: false,
    workerCount: 0,
    fileCount
  };
}
