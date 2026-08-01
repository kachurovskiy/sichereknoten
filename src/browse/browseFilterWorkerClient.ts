import type { BrowseClusterFilters } from "./browseIndex";
import type { BrowseFilterWorkerRequest, BrowseFilterWorkerResponse } from "./browseFilterWorkerProtocol";
import type { IntersectionCluster } from "../domain/types";

const BROWSE_FILTER_RESULT_BATCH_SIZE = 20;

declare const __SICHERE_KNOTEN_BROWSE_FILTER_WORKER_URL__: string | undefined;

export interface BrowseFilterRequest {
  clusters: IntersectionCluster[];
  stateCode: string;
  regionKey: string;
  filters: BrowseClusterFilters;
  limit: number;
  totalCount: number;
}

export interface BrowseFilterProgress {
  scannedCount: number;
  totalCount: number;
}

export type BrowseFilterUpdateHandler = (clusters: IntersectionCluster[], done: boolean, progress: BrowseFilterProgress) => void;

export class BrowseFilterWorkerClient {
  private worker: Worker | null = null;
  private clustersSentToWorker: IntersectionCluster[] | null = null;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<
    number,
    {
      clusters: IntersectionCluster[];
      onUpdate: BrowseFilterUpdateHandler | null;
      resolve: (clusters: IntersectionCluster[]) => void;
      reject: (error: Error) => void;
    }
  >();

  prepare(clusters: IntersectionCluster[]): void {
    if (typeof Worker === "undefined" || this.clustersSentToWorker === clusters || this.pendingRequests.size > 0) {
      return;
    }

    this.rejectPendingRequests(new Error("Browse filter request superseded."));
    const worker = this.ensureWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const workerRequest: BrowseFilterWorkerRequest = {
      id,
      type: "prepare",
      clusters
    };

    try {
      worker.postMessage(workerRequest);
      this.clustersSentToWorker = clusters;
    } catch {
      this.resetWorker();
    }
  }

  filter(request: BrowseFilterRequest, onUpdate: BrowseFilterUpdateHandler | null = null): Promise<IntersectionCluster[]> {
    if (typeof Worker === "undefined") {
      return Promise.reject(new Error("Browse filter workers are not available."));
    }

    this.rejectPendingRequests(new Error("Browse filter request superseded."));
    const worker = this.ensureWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const shouldSendClusters = this.clustersSentToWorker !== request.clusters;
    const workerRequest: BrowseFilterWorkerRequest = {
      id,
      type: "search",
      clusters: shouldSendClusters ? request.clusters : undefined,
      stateCode: request.stateCode,
      regionKey: request.regionKey,
      filters: request.filters,
      limit: request.limit,
      batchSize: BROWSE_FILTER_RESULT_BATCH_SIZE,
      totalCount: request.totalCount
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { clusters: request.clusters, onUpdate, resolve, reject });
      try {
        worker.postMessage(workerRequest);
        if (shouldSendClusters) {
          this.clustersSentToWorker = request.clusters;
        }
      } catch (error) {
        this.pendingRequests.delete(id);
        this.resetWorker();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = createBrowseFilterWorker();
    worker.onmessage = (event: MessageEvent<BrowseFilterWorkerResponse>) => this.handleWorkerMessage(event.data);
    worker.onerror = (event) => {
      this.rejectPendingRequests(event.error ?? new Error(event.message));
      this.resetWorker();
    };
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(response: BrowseFilterWorkerResponse): void {
    const pendingRequest = this.pendingRequests.get(response.id);
    if (!pendingRequest) {
      if (response.type === "error") {
        this.resetWorker();
      }
      return;
    }

    if (response.type === "prepared") {
      return;
    }
    if (response.type === "error") {
      this.pendingRequests.delete(response.id);
      pendingRequest.reject(new Error(response.error));
      this.resetWorker();
      return;
    }

    const clusters = response.clusterIndexes
      .map((clusterIndex) => pendingRequest.clusters[clusterIndex])
      .filter((cluster): cluster is IntersectionCluster => Boolean(cluster));
    pendingRequest.onUpdate?.(clusters, response.done, {
      scannedCount: response.scannedCount,
      totalCount: response.totalCount
    });

    if (response.done) {
      this.pendingRequests.delete(response.id);
      pendingRequest.resolve(clusters);
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pendingRequest of this.pendingRequests.values()) {
      pendingRequest.reject(error);
    }
    this.pendingRequests.clear();
  }

  private resetWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.clustersSentToWorker = null;
  }
}

function createBrowseFilterWorker(): Worker {
  const bundledWorkerUrl =
    typeof __SICHERE_KNOTEN_BROWSE_FILTER_WORKER_URL__ === "string" ? __SICHERE_KNOTEN_BROWSE_FILTER_WORKER_URL__ : null;
  return bundledWorkerUrl
    ? new Worker(bundledWorkerUrl)
    : new Worker("/src/browse/browseFilterWorker.ts", { type: "module" });
}
