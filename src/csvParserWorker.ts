import { parseAccidentCsvFiles } from "./parsers/csv";
import { CsvParserWorkerRequest, CsvParserWorkerResponse } from "./csvParserWorkerProtocol";

const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<CsvParserWorkerRequest>) => void) => void;
  postMessage: (response: CsvParserWorkerResponse) => void;
};

workerScope.addEventListener("message", (event) => {
  void parseWorkerFile(event.data);
});

async function parseWorkerFile(request: CsvParserWorkerRequest): Promise<void> {
  try {
    const accidents = await parseAccidentCsvFiles([request.file], (progress) => {
      workerScope.postMessage({ id: request.id, type: "progress", progress });
    });
    workerScope.postMessage({ id: request.id, type: "result", accidents });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      type: "error",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
