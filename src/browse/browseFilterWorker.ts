import {
  browseAddressQueryActive,
  browseClusterAddressSearchText,
  browseClusterMatchesFilters,
  clusterBrowseRegionKey
} from "./browseIndex";
import type {
  BrowseFilterWorkerRequest,
  BrowseFilterWorkerResponse,
  BrowseFilterWorkerSearchRequest
} from "./browseFilterWorkerProtocol";
import type { IntersectionCluster } from "../domain/types";

const SEARCH_SCAN_CHUNK_SIZE = 500;

const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<BrowseFilterWorkerRequest>) => void) => void;
  postMessage: (response: BrowseFilterWorkerResponse) => void;
};

interface ActiveBrowseSearch {
  id: number;
  stateCode: string;
  regionKey: string;
  filters: BrowseFilterWorkerSearchRequest["filters"];
  limit: number;
  batchSize: number;
  totalCount: number;
  cursor: number;
  scannedCount: number;
  clusterIndexes: number[];
  lastPostedCount: number;
  lastPostedScannedCount: number;
}

let currentClusters: IntersectionCluster[] = [];
let currentAddressSearchTextByIndex: string[] = [];
let currentRegionKeyByIndex: string[] = [];
let activeSearch: ActiveBrowseSearch | null = null;

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    if (request.clusters) {
      activeSearch = null;
      currentClusters = request.clusters;
      currentAddressSearchTextByIndex = [];
      currentRegionKeyByIndex = [];
    }

    if (request.type === "prepare") {
      workerScope.postMessage({ id: request.id, type: "prepared" });
      return;
    }

    activeSearch = {
      id: request.id,
      stateCode: request.stateCode,
      regionKey: request.regionKey,
      filters: request.filters,
      limit: request.limit,
      batchSize: Math.max(1, request.batchSize),
      totalCount: request.totalCount,
      cursor: 0,
      scannedCount: 0,
      clusterIndexes: [],
      lastPostedCount: -1,
      lastPostedScannedCount: -1
    };
    postResults(activeSearch, false);
    processActiveSearch(activeSearch);
  } catch (error) {
    workerScope.postMessage({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

function processActiveSearch(search: ActiveBrowseSearch): void {
  if (activeSearch !== search) {
    return;
  }

  try {
    let scanned = 0;
    let done = false;

    while (search.cursor < currentClusters.length && scanned < SEARCH_SCAN_CHUNK_SIZE) {
      const clusterIndex = search.cursor;
      const cluster = currentClusters[clusterIndex];
      search.cursor += 1;
      scanned += 1;

      if (!clusterInScope(cluster, clusterIndex, search.stateCode, search.regionKey)) {
        continue;
      }

      search.scannedCount += 1;
      if (isBelowMinimumSeverity(cluster, search.filters)) {
        done = true;
        break;
      }
      if (clusterMatchesFilters(cluster, clusterIndex, search.filters)) {
        search.clusterIndexes.push(clusterIndex);
        if (search.clusterIndexes.length >= search.limit) {
          done = true;
          break;
        }
        if (shouldPostPartialResults(search)) {
          postResults(search, false);
        }
      }
    }

    if (done || search.cursor >= currentClusters.length) {
      postResults(search, true);
      if (activeSearch === search) {
        activeSearch = null;
      }
      return;
    }

    postResults(search, false);
    globalThis.setTimeout(() => processActiveSearch(search), 0);
  } catch (error) {
    if (activeSearch === search) {
      activeSearch = null;
    }
    workerScope.postMessage({ id: search.id, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

function shouldPostPartialResults(search: ActiveBrowseSearch): boolean {
  const count = search.clusterIndexes.length;
  return count !== search.lastPostedCount && (count === 1 || count % search.batchSize === 0);
}

function postResults(search: ActiveBrowseSearch, done: boolean): void {
  if (!done && search.clusterIndexes.length === search.lastPostedCount && search.scannedCount === search.lastPostedScannedCount) {
    return;
  }
  search.lastPostedCount = search.clusterIndexes.length;
  search.lastPostedScannedCount = search.scannedCount;
  workerScope.postMessage({
    id: search.id,
    type: "results",
    clusterIndexes: search.clusterIndexes,
    scannedCount: search.scannedCount,
    totalCount: search.totalCount,
    done
  });
}

function clusterInScope(cluster: IntersectionCluster, clusterIndex: number, stateCode: string, regionKey: string): boolean {
  if (stateCode === "all") {
    return true;
  }
  if (cluster.stateCode !== stateCode) {
    return false;
  }
  return regionKey === "all" || regionKeyForCluster(cluster, clusterIndex) === regionKey;
}

function regionKeyForCluster(cluster: IntersectionCluster, clusterIndex: number): string {
  const cachedRegionKey = currentRegionKeyByIndex[clusterIndex];
  if (cachedRegionKey !== undefined) {
    return cachedRegionKey;
  }
  const regionKey = clusterBrowseRegionKey(cluster);
  currentRegionKeyByIndex[clusterIndex] = regionKey;
  return regionKey;
}

function clusterMatchesFilters(
  cluster: IntersectionCluster,
  clusterIndex: number,
  filters: ActiveBrowseSearch["filters"]
): boolean {
  const addressSearchText = browseAddressQueryActive(filters) ? addressSearchTextForCluster(cluster, clusterIndex) : "";
  return browseClusterMatchesFilters(cluster, filters, addressSearchText);
}

function addressSearchTextForCluster(cluster: IntersectionCluster, clusterIndex: number): string {
  const cachedAddressSearchText = currentAddressSearchTextByIndex[clusterIndex];
  if (cachedAddressSearchText !== undefined) {
    return cachedAddressSearchText;
  }
  const addressSearchText = browseClusterAddressSearchText(cluster);
  currentAddressSearchTextByIndex[clusterIndex] = addressSearchText;
  return addressSearchText;
}

function isBelowMinimumSeverity(cluster: IntersectionCluster, filters: ActiveBrowseSearch["filters"]): boolean {
  return filters.minSeverityPercent !== null && cluster.severityPercent * 100 < filters.minSeverityPercent;
}
