import { analyzeDangerousIntersections } from "./analysis";
import {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  deserializeAnalysisOptions
} from "./analysisWorkerProtocol";

const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<AnalysisWorkerRequest>) => void) => void;
  postMessage: (response: AnalysisWorkerResponse) => void;
};

workerScope.addEventListener("message", (event) => {
  const { id, accidents, options } = event.data;
  try {
    const result = analyzeDangerousIntersections(accidents, deserializeAnalysisOptions(options));
    workerScope.postMessage({ id, result });
  } catch (error) {
    workerScope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
