import { compareClusterCoreMetric } from "../domain/clusterDisplay";
import type { IntersectionCluster } from "../domain/types";

export interface SeverityRank {
  rank: number;
  percentile: number;
}

export interface SeverityRankContext {
  state: SeverityRank;
  germany: SeverityRank | null;
}

export interface SeverityRankIndex {
  clusters: IntersectionCluster[];
  clusterIndexes: Map<string, number>;
  hasMultipleStates: boolean;
  stateRanks: Map<string, SeverityRank>;
  germanyRanks: Map<string, SeverityRank>;
}

export interface SeverityRankIndexHooks {
  prepareIndex?: (compute: () => SeverityRankIndex) => SeverityRankIndex;
  computeStateRank?: (compute: () => SeverityRank | null) => SeverityRank | null;
  computeGermanyRank?: (compute: () => SeverityRank | null) => SeverityRank | null;
}

export class SeverityRankIndexStore {
  private cache: SeverityRankIndex | null = null;

  clear(): void {
    this.cache = null;
  }

  forClusters(
    clusters: IntersectionCluster[] | null | undefined,
    hooks: SeverityRankIndexHooks = {}
  ): SeverityRankIndex | null {
    if (!clusters?.length) {
      return null;
    }
    if (this.cache?.clusters === clusters) {
      return this.cache;
    }

    const build = () => buildSeverityRankIndex(clusters);
    this.cache = hooks.prepareIndex ? hooks.prepareIndex(build) : build();
    return this.cache;
  }

  contextForCluster(
    clusters: IntersectionCluster[] | null | undefined,
    cluster: IntersectionCluster,
    hooks: SeverityRankIndexHooks = {}
  ): SeverityRankContext | null {
    const index = this.forClusters(clusters, hooks);
    return index ? severityRankContextForCluster(index, cluster, hooks) : null;
  }
}

export function buildSeverityRankIndex(clusters: IntersectionCluster[]): SeverityRankIndex {
  const clusterIndexes = new Map<string, number>();
  const firstStateCode = clusters[0]?.stateCode ?? null;
  let hasMultipleStates = false;

  clusters.forEach((cluster, index) => {
    const key = severityRankKey(cluster);
    if (!clusterIndexes.has(key)) {
      clusterIndexes.set(key, index);
    }
    if (firstStateCode !== null && cluster.stateCode !== firstStateCode) {
      hasMultipleStates = true;
    }
  });

  return {
    clusters,
    clusterIndexes,
    hasMultipleStates,
    stateRanks: new Map(),
    germanyRanks: new Map()
  };
}

export function severityRankContextForCluster(
  index: SeverityRankIndex,
  cluster: IntersectionCluster,
  hooks: SeverityRankIndexHooks = {}
): SeverityRankContext | null {
  const key = severityRankKey(cluster);
  const state = cachedSeverityRank(index.stateRanks, key, () => {
    const compute = () => severityRankInScope(cluster, index, (candidate) => candidate.stateCode === cluster.stateCode);
    return hooks.computeStateRank ? hooks.computeStateRank(compute) : compute();
  });
  if (state === null) {
    return null;
  }

  return {
    state,
    germany: index.hasMultipleStates
      ? cachedSeverityRank(index.germanyRanks, key, () => {
          const compute = () => severityRankInScope(cluster, index);
          return hooks.computeGermanyRank ? hooks.computeGermanyRank(compute) : compute();
        })
      : null
  };
}

function cachedSeverityRank(ranks: Map<string, SeverityRank>, key: string, compute: () => SeverityRank | null): SeverityRank | null {
  const cached = ranks.get(key);
  if (cached) {
    return cached;
  }

  const rank = compute();
  if (rank) {
    ranks.set(key, rank);
  }
  return rank;
}

function severityRankInScope(
  cluster: IntersectionCluster,
  index: SeverityRankIndex,
  inScope?: (candidate: IntersectionCluster) => boolean
): SeverityRank | null {
  const clusterIndex = index.clusterIndexes.get(severityRankKey(cluster));
  if (clusterIndex === undefined) {
    return null;
  }

  let scopeSize = 0;
  let rank = 1;
  let foundCluster = false;
  for (let candidateIndex = 0; candidateIndex < index.clusters.length; candidateIndex += 1) {
    const candidate = index.clusters[candidateIndex];
    if (inScope && !inScope(candidate)) {
      continue;
    }

    scopeSize += 1;
    if (candidate.id === cluster.id && candidate.stateCode === cluster.stateCode) {
      foundCluster = true;
    }

    const order = compareClusterCoreMetric(candidate, cluster);
    if (order < 0 || (order === 0 && candidateIndex < clusterIndex)) {
      rank += 1;
    }
  }

  if (!foundCluster || scopeSize === 0) {
    return null;
  }

  return {
    rank,
    percentile: Math.max(1, Math.ceil((rank / scopeSize) * 100))
  };
}

function severityRankKey(cluster: IntersectionCluster): string {
  return `${cluster.stateCode}\0${cluster.id}`;
}
