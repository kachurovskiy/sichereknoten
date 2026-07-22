import { AccidentRecord, AnalysisOptions, AnalysisResult, SeverityPercentOptions } from "./types";

export interface SerializableAnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: number[];
  stateCode: string | "all";
  severityPercent: SeverityPercentOptions;
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
    severityPercent: { ...options.severityPercent }
  };
}

export function deserializeAnalysisOptions(options: SerializableAnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    severityPercent: { ...options.severityPercent }
  };
}
