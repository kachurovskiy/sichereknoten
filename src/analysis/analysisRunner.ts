import { analyzeDangerousIntersections, combineAnalysisResults } from "./analysis";
import {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  SerializableAnalysisOptions,
  serializeAnalysisOptions
} from "./analysisWorkerProtocol";
import { accidentMatchesRoadUserFocus } from "../domain/roadUsers";
import { AccidentRecord, AnalysisOptions, AnalysisResult } from "../domain/types";

declare const __SICHERE_KNOTEN_ANALYSIS_WORKER_URL__: string | undefined;

export interface AnalysisExecutionPlan {
  background: boolean;
  fallback: boolean;
  parallel: boolean;
  workerCount: number;
  partitionCount: number;
}

interface AnalysisPartition {
  accidents: AccidentRecord[];
  options: SerializableAnalysisOptions;
}

const MIN_PARALLEL_ACCIDENTS = 5_000;

export async function analyzeDangerousIntersectionsInBackground(
  accidents: AccidentRecord[],
  options: AnalysisOptions,
  onPlan?: (plan: AnalysisExecutionPlan) => void
): Promise<AnalysisResult> {
  if (!canUseWorkers()) {
    onPlan?.(mainThreadPlan(false));
    return analyzeDangerousIntersections(accidents, options);
  }

  const partitions = analysisPartitions(accidents, options);
  const workerCount = Math.min(partitions.length, availableWorkerCount());
  onPlan?.({
    background: true,
    fallback: false,
    parallel: partitions.length > 1,
    workerCount,
    partitionCount: partitions.length
  });

  try {
    const results = await runWorkerPartitions(partitions, workerCount);
    return results.length === 1 ? results[0] : combineAnalysisResults(results);
  } catch {
    onPlan?.(mainThreadPlan(true));
    return analyzeDangerousIntersections(accidents, options);
  }
}

function analysisPartitions(accidents: AccidentRecord[], options: AnalysisOptions): AnalysisPartition[] {
  if (options.stateCode !== "all") {
    return [
      {
        accidents: filterAccidents(accidents, options),
        options: serializeAnalysisOptions(options)
      }
    ];
  }

  const selectedYears = analysisYears(accidents, options);
  if (accidents.length < MIN_PARALLEL_ACCIDENTS) {
    return [
      {
        accidents,
        options: serializeAnalysisOptions({ ...options, years: selectedYears })
      }
    ];
  }

  const accidentsByState = new Map<string, AccidentRecord[]>();
  for (const accident of accidents) {
    if (selectedYears.size > 0 && !selectedYears.has(accident.year)) {
      continue;
    }
    if (!accidentMatchesRoadUserFocus(accident, options.roadUserFocus)) {
      continue;
    }
    const stateAccidents = accidentsByState.get(accident.stateCode);
    if (stateAccidents) {
      stateAccidents.push(accident);
    } else {
      accidentsByState.set(accident.stateCode, [accident]);
    }
  }

  const partitions = Array.from(accidentsByState.values())
    .sort((a, b) => b.length - a.length)
    .map((stateAccidents) => ({
      accidents: stateAccidents,
      options: serializeAnalysisOptions({ ...options, years: selectedYears })
    }));

  return partitions.length > 0
    ? partitions
    : [
        {
          accidents: [],
          options: serializeAnalysisOptions({ ...options, years: selectedYears })
        }
      ];
}

function filterAccidents(accidents: AccidentRecord[], options: AnalysisOptions): AccidentRecord[] {
  return accidents.filter((accident) => {
    if (options.years.size > 0 && !options.years.has(accident.year)) {
      return false;
    }
    if (options.stateCode !== "all" && accident.stateCode !== options.stateCode) {
      return false;
    }
    return accidentMatchesRoadUserFocus(accident, options.roadUserFocus);
  });
}

function analysisYears(accidents: AccidentRecord[], options: AnalysisOptions): Set<number> {
  if (options.years.size > 0) {
    return new Set(options.years);
  }
  return new Set(accidents.map((accident) => accident.year));
}

function runWorkerPartitions(partitions: AnalysisPartition[], workerCount: number): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = new Array(partitions.length);
  const workers: Worker[] = [];
  let nextPartition = 0;
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
      const partitionIndex = nextPartition;
      nextPartition += 1;
      if (partitionIndex >= partitions.length) {
        worker.terminate();
        return;
      }

      worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
        const response = event.data;
        if ("error" in response) {
          fail(new Error(response.error));
          return;
        }
        results[partitionIndex] = response.result;
        completed += 1;
        if (completed === partitions.length) {
          settled = true;
          workers.forEach((entry) => entry.terminate());
          resolve(results);
          return;
        }
        runNext(worker);
      };
      worker.onerror = (event) => {
        fail(event.error ?? new Error(event.message));
      };

      const request: AnalysisWorkerRequest = {
        id: partitionIndex,
        accidents: partitions[partitionIndex].accidents,
        options: partitions[partitionIndex].options
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        fail(error);
      }
    };

    for (let index = 0; index < workerCount; index += 1) {
      try {
        const worker = createAnalysisWorker();
        workers.push(worker);
        runNext(worker);
      } catch (error) {
        fail(error);
        break;
      }
    }
  });
}

function createAnalysisWorker(): Worker {
  const bundledWorkerUrl =
    typeof __SICHERE_KNOTEN_ANALYSIS_WORKER_URL__ === "string" ? __SICHERE_KNOTEN_ANALYSIS_WORKER_URL__ : null;
  return bundledWorkerUrl
    ? new Worker(bundledWorkerUrl)
    : new Worker("/src/analysis/analysisWorker.ts", { type: "module" });
}

function canUseWorkers(): boolean {
  return typeof Worker !== "undefined";
}

function availableWorkerCount(): number {
  const hardwareConcurrency = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Math.max(1, Math.floor(hardwareConcurrency || 1));
}

function mainThreadPlan(fallback: boolean): AnalysisExecutionPlan {
  return {
    background: false,
    fallback,
    parallel: false,
    workerCount: 0,
    partitionCount: 1
  };
}
