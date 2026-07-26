import { cleanAreaNameForDisplay, compareClusterCoreMetric } from "./clusterDisplay";
import { formatCompactPopulation, type SeverityPercentSource } from "./formatting";
import type { IntersectionCluster } from "./types";

const STATE_BROWSE_MIN_SEVERITY_PERCENT = 0.1;
export const STATE_BROWSE_MAX_INTERSECTIONS = 100;

export interface BrowseIndex {
  clusters: IntersectionCluster[];
  regionSummaries: RegionSummary[];
  regionsByState: Map<string, RegionSummary[]>;
  topClustersByState: IntersectionCluster[];
  browseClustersByState: Map<string, IntersectionCluster[]>;
  browseClustersByRegion: Map<string, IntersectionCluster[]>;
}

export interface RegionSummary extends SeverityPercentSource {
  key: string;
  stateCode: string;
  stateName: string;
  regionName: string;
  population: number | null;
  accidentCount: number;
  clusterCount: number;
  fatalCount: number;
  seriousCount: number;
  topCluster: IntersectionCluster | null;
  clusters: IntersectionCluster[];
}

interface RegionSummaryAccumulator extends RegionSummary {
  weightedSeverityPercent: number;
}

export class BrowseIndexStore {
  private cache: BrowseIndex | null = null;

  clear(): void {
    this.cache = null;
  }

  forClusters(clusters: IntersectionCluster[] | null | undefined): BrowseIndex | null {
    if (!clusters) {
      return null;
    }
    if (this.cache?.clusters === clusters) {
      return this.cache;
    }
    this.cache = buildBrowseIndex(clusters);
    return this.cache;
  }
}

export function buildBrowseIndex(clusters: IntersectionCluster[]): BrowseIndex {
  const byRegion = new Map<string, RegionSummaryAccumulator>();
  const regionsByState = new Map<string, RegionSummary[]>();
  const browseClustersByState = new Map<string, IntersectionCluster[]>();
  const browseClustersByRegion = new Map<string, IntersectionCluster[]>();
  const topClusterByState = new Map<string, IntersectionCluster>();

  for (const cluster of clusters) {
    const regionName = clusterRegionName(cluster);
    const key = clusterRegionKey(cluster);
    const summary =
      byRegion.get(key) ??
      ({
        key,
        stateCode: cluster.stateCode,
        stateName: cluster.stateName,
        regionName,
        population: cluster.administrativeRegionPopulation,
        accidentCount: 0,
        clusterCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        severityPercent: 0,
        weightedSeverityPercent: 0,
        topCluster: null,
        clusters: []
      } satisfies RegionSummaryAccumulator);

    summary.accidentCount += cluster.accidentCount;
    summary.clusterCount += 1;
    summary.fatalCount += cluster.fatalCount;
    summary.seriousCount += cluster.seriousCount;
    summary.weightedSeverityPercent += cluster.severityPercent * cluster.accidentCount;
    summary.population ??= cluster.administrativeRegionPopulation;
    summary.clusters.push(cluster);
    if (!summary.topCluster || compareClusterCoreMetric(cluster, summary.topCluster) < 0) {
      summary.topCluster = cluster;
    }
    byRegion.set(key, summary);

    const stateTopCluster = topClusterByState.get(cluster.stateCode);
    if (!stateTopCluster || compareClusterCoreMetric(cluster, stateTopCluster) < 0) {
      topClusterByState.set(cluster.stateCode, cluster);
    }

    if (cluster.severityPercent >= STATE_BROWSE_MIN_SEVERITY_PERCENT) {
      insertSortedClusterMapItem(browseClustersByState, cluster.stateCode, cluster, STATE_BROWSE_MAX_INTERSECTIONS);
      insertSortedClusterMapItem(browseClustersByRegion, key, cluster, STATE_BROWSE_MAX_INTERSECTIONS);
    }
  }

  const regionSummaries = Array.from(byRegion.values())
    .map((summary): RegionSummary => ({
      key: summary.key,
      stateCode: summary.stateCode,
      stateName: summary.stateName,
      regionName: summary.regionName,
      population: summary.population,
      accidentCount: summary.accidentCount,
      clusterCount: summary.clusterCount,
      fatalCount: summary.fatalCount,
      seriousCount: summary.seriousCount,
      severityPercent: summary.accidentCount > 0 ? summary.weightedSeverityPercent / summary.accidentCount : 0,
      topCluster: summary.topCluster,
      clusters: summary.clusters
    }))
    .sort(compareRegionSummaries);

  for (const summary of regionSummaries) {
    appendMapListItem(regionsByState, summary.stateCode, summary);
  }
  for (const stateRegions of regionsByState.values()) {
    stateRegions.sort((a, b) => a.regionName.localeCompare(b.regionName, "de", { sensitivity: "base" }));
  }

  return {
    clusters,
    regionSummaries,
    regionsByState,
    topClustersByState: Array.from(topClusterByState.values()).sort(compareClusterCoreMetric),
    browseClustersByState,
    browseClustersByRegion
  };
}

export function regionOptionLabel(region: RegionSummary): string {
  return region.population === null ? region.regionName : `${region.regionName} (${formatCompactPopulation(region.population)})`;
}

function appendMapListItem<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const items = map.get(key);
  if (items) {
    items.push(item);
    return;
  }
  map.set(key, [item]);
}

function insertSortedClusterMapItem<K>(
  map: Map<K, IntersectionCluster[]>,
  key: K,
  cluster: IntersectionCluster,
  limit: number
): void {
  const items = map.get(key);
  if (items) {
    insertSortedCluster(items, cluster, limit, compareClusterCoreMetric);
    return;
  }
  map.set(key, [cluster]);
}

function compareRegionSummaries(a: RegionSummary, b: RegionSummary): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount ||
    a.stateName.localeCompare(b.stateName, "de", { sensitivity: "base" }) ||
    a.regionName.localeCompare(b.regionName, "de", { sensitivity: "base" })
  );
}

function clusterRegionName(cluster: IntersectionCluster): string {
  return cleanAreaNameForDisplay(cluster.administrativeRegionName ?? cluster.stateName);
}

function clusterRegionKey(cluster: IntersectionCluster): string {
  return `${cluster.stateCode}:${cluster.administrativeRegionCode ?? "state"}`;
}

function insertSortedCluster(
  selected: IntersectionCluster[],
  cluster: IntersectionCluster,
  limit: number,
  comparator: (a: IntersectionCluster, b: IntersectionCluster) => number
): void {
  let index = 0;
  while (index < selected.length && comparator(selected[index], cluster) <= 0) {
    index += 1;
  }
  if (index >= limit) {
    return;
  }

  selected.splice(index, 0, cluster);
  if (selected.length > limit) {
    selected.length = limit;
  }
}
