import { AccidentRecord, AnalysisOptions, AnalysisResult, FatalPercentOptions } from "./types";

export interface SerializableAnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: number[];
  stateCode: string | "all";
  fatalPercent: FatalPercentOptions;
}

export interface AnalysisWorkerRequest {
  id: number;
  accidents: AccidentRecord[];
  options: SerializableAnalysisOptions;
}

export type AnalysisWorkerResponse =
  | {
      id: number;
      result: AnalysisResult;
    }
  | {
      id: number;
      error: string;
    };

export function serializeAnalysisOptions(options: AnalysisOptions): SerializableAnalysisOptions {
  return {
    ...options,
    years: Array.from(options.years).sort((a, b) => a - b),
    fatalPercent: { ...options.fatalPercent }
  };
}

export function deserializeAnalysisOptions(options: SerializableAnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    fatalPercent: { ...options.fatalPercent }
  };
}
