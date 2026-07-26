import {
  deserializeAnalysisOptions as deserializeSharedAnalysisOptions,
  serializeAnalysisOptions as serializeSharedAnalysisOptions,
  type SerializedAnalysisOptions
} from "./analysisOptions";
import { AccidentRecord, AnalysisOptions, AnalysisResult } from "./types";

export type SerializableAnalysisOptions = SerializedAnalysisOptions;

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
  return serializeSharedAnalysisOptions(options);
}

export function deserializeAnalysisOptions(options: SerializableAnalysisOptions): AnalysisOptions {
  return deserializeSharedAnalysisOptions(options);
}
