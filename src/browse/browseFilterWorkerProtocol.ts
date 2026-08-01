import type { BrowseClusterFilters } from "./browseIndex";
import type { IntersectionCluster } from "../domain/types";

export interface BrowseFilterWorkerPrepareRequest {
  id: number;
  type: "prepare";
  clusters: IntersectionCluster[];
}

export interface BrowseFilterWorkerSearchRequest {
  id: number;
  type: "search";
  clusters?: IntersectionCluster[];
  stateCode: string;
  regionKey: string;
  filters: BrowseClusterFilters;
  limit: number;
  batchSize: number;
  totalCount: number;
}

export type BrowseFilterWorkerRequest = BrowseFilterWorkerPrepareRequest | BrowseFilterWorkerSearchRequest;

export type BrowseFilterWorkerResponse =
  | {
      id: number;
      type: "prepared";
    }
  | {
      id: number;
      type: "results";
      clusterIndexes: number[];
      scannedCount: number;
      totalCount: number;
      done: boolean;
    }
  | {
      id: number;
      type: "error";
      error: string;
    };
