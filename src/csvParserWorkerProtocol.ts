import { AccidentRecord, ParseProgress } from "./types";

export interface CsvParserWorkerRequest {
  id: number;
  file: File;
}

export type CsvParserWorkerResponse =
  | {
      id: number;
      type: "progress";
      progress: ParseProgress;
    }
  | {
      id: number;
      type: "result";
      accidents: AccidentRecord[];
    }
  | {
      id: number;
      type: "error";
      error: string;
    };
