import { accidentKey } from "../domain/accidentRecordDisplay";
import {
  accidentMatchesAnalysisOptions,
  analysisOptionsIndexKey,
  clusteredAccidentMembership
} from "../analysis/clusterAccidentRecords";
import type { MapIncidentViewportRequest, MapCanvas } from "./mapCanvas";
import { STATE_NAMES } from "../domain/states";
import type { AccidentRecord, AnalysisOptions, AnalysisResult } from "../domain/types";

interface UnclusteredIncidentLayerAnalysisState {
  result: AnalysisResult;
  options: AnalysisOptions;
  dataVersion: string | null;
}

interface UnclusteredIncidentMapCache {
  key: string;
  loadedStateCodes: Set<string>;
  loadingStateCodes: Set<string>;
  records: AccidentRecord[];
  clusteredAccidentKeys: Set<string>;
  clusteredAccidentIndexes: Set<number>;
}

export interface UnclusteredIncidentLayerDependencies {
  map: MapCanvas;
  getAnalysisState: () => UnclusteredIncidentLayerAnalysisState | null;
  hasStateShard: (stateCode: string) => boolean;
  loadAccidentsForState: (stateCode: string) => Promise<AccidentRecord[]>;
}

export class UnclusteredIncidentLayer {
  private cache: UnclusteredIncidentMapCache | null = null;

  constructor(private readonly deps: UnclusteredIncidentLayerDependencies) {}

  reset(): void {
    this.cache = null;
    this.deps.map.setUnclusteredIncidentPoints([]);
  }

  handleViewportRequest(request: MapIncidentViewportRequest): void {
    const stateCodes = this.stateCodesForIncidentMapRequest(request);
    if (stateCodes.length === 0) {
      return;
    }
    this.ensureStatesLoaded(stateCodes);
  }

  private stateCodesForIncidentMapRequest(request: MapIncidentViewportRequest): string[] {
    const options = this.deps.getAnalysisState()?.options;
    if (!options) {
      return [];
    }
    if (options.stateCode !== "all") {
      return [options.stateCode];
    }
    const seen = new Set<string>();
    const stateCodes: string[] = [];
    for (const stateCode of request.stateCodes) {
      if (!STATE_NAMES[stateCode] || seen.has(stateCode)) {
        continue;
      }
      seen.add(stateCode);
      stateCodes.push(stateCode);
    }
    return stateCodes;
  }

  private ensureStatesLoaded(stateCodes: string[]): void {
    const cache = this.cacheForCurrentResult();
    if (!cache) {
      return;
    }

    for (const stateCode of stateCodes) {
      if (cache.loadedStateCodes.has(stateCode) || cache.loadingStateCodes.has(stateCode) || !this.deps.hasStateShard(stateCode)) {
        continue;
      }
      cache.loadingStateCodes.add(stateCode);
      void this.loadState(stateCode, cache.key);
    }
  }

  private cacheForCurrentResult(): UnclusteredIncidentMapCache | null {
    const state = this.deps.getAnalysisState();
    const key = state ? this.cacheKey(state) : null;
    if (!key || !state) {
      return null;
    }
    if (this.cache?.key === key) {
      return this.cache;
    }

    const membership = clusteredAccidentMembership(state.result.clusters);
    this.cache = {
      key,
      loadedStateCodes: new Set(),
      loadingStateCodes: new Set(),
      records: [],
      clusteredAccidentKeys: membership.keys,
      clusteredAccidentIndexes: membership.indexes
    };
    this.deps.map.setUnclusteredIncidentPoints([]);
    return this.cache;
  }

  private cacheKey(state: UnclusteredIncidentLayerAnalysisState): string {
    return [
      state.dataVersion ?? "unknown-data",
      analysisOptionsIndexKey(state.options, 0),
      state.result.filteredAccidentCount,
      state.result.clusters.length
    ].join("|");
  }

  private async loadState(stateCode: string, cacheKey: string): Promise<void> {
    try {
      const stateRecords = await this.deps.loadAccidentsForState(stateCode);
      const cache = this.cache;
      const state = this.deps.getAnalysisState();
      if (!cache || cache.key !== cacheKey || !state) {
        return;
      }

      const records = this.recordsForMap(stateRecords, state.options, cache);
      for (const record of records) {
        cache.records.push(record);
      }
      cache.loadedStateCodes.add(stateCode);
      this.deps.map.setUnclusteredIncidentPoints(cache.records);
    } catch (error) {
      console.warn("[Safe Intersections] Could not load unclustered map incidents.", { stateCode, error });
    } finally {
      const cache = this.cache;
      if (cache?.key === cacheKey) {
        cache.loadingStateCodes.delete(stateCode);
      }
    }
  }

  private recordsForMap(
    sourceRecords: AccidentRecord[],
    options: AnalysisOptions,
    cache: UnclusteredIncidentMapCache
  ): AccidentRecord[] {
    return sourceRecords.filter(
      (accident) => accidentMatchesAnalysisOptions(accident, options) && !this.isClusteredAccidentInCurrentResult(accident, cache)
    );
  }

  private isClusteredAccidentInCurrentResult(accident: AccidentRecord, cache: UnclusteredIncidentMapCache): boolean {
    if (typeof accident.recordIndex === "number" && cache.clusteredAccidentIndexes.has(accident.recordIndex)) {
      return true;
    }
    return cache.clusteredAccidentKeys.has(accidentKey(accident));
  }
}
