import { cloneAnalysisOptions } from "../analysis/analysisOptions";
import type { AccidentRecord, AnalysisOptions, AnalysisResult, IntersectionCluster } from "../domain/types";

export interface CommittedAnalysisState {
  result: AnalysisResult;
  options: AnalysisOptions;
  dataVersion: string | null;
}

export interface UserLocation {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
}

export class AppState {
  private accidentsValue: AccidentRecord[] = [];
  private resultValue: AnalysisResult | null = null;
  private committedAnalysisValue: CommittedAnalysisState | null = null;
  private userLocationValue: UserLocation | null = null;
  private renderedMapClustersValue: IntersectionCluster[] | null | undefined;

  get accidents(): AccidentRecord[] {
    return this.accidentsValue;
  }

  get result(): AnalysisResult | null {
    return this.resultValue;
  }

  get committedAnalysis(): CommittedAnalysisState | null {
    return this.committedAnalysisValue;
  }

  get userLocation(): UserLocation | null {
    return this.userLocationValue;
  }

  get renderedMapClusters(): IntersectionCluster[] | null | undefined {
    return this.renderedMapClustersValue;
  }

  get hasAccidents(): boolean {
    return this.accidentsValue.length > 0;
  }

  resetRuntimeAnalysis(): void {
    this.accidentsValue = [];
    this.clearCommittedAnalysis();
  }

  clearCommittedAnalysis(): void {
    this.resultValue = null;
    this.committedAnalysisValue = null;
    this.invalidateRenderedMapClusters();
  }

  commitAnalysis(options: AnalysisOptions, result: AnalysisResult, dataVersion: string | null): void {
    this.resultValue = result;
    this.committedAnalysisValue = {
      result,
      options: cloneAnalysisOptions(options),
      dataVersion
    };
    this.invalidateRenderedMapClusters();
  }

  setAccidents(records: AccidentRecord[]): boolean {
    if (this.accidentsValue === records) {
      return false;
    }
    this.accidentsValue = records;
    return true;
  }

  allAccidentsSnapshot(): AccidentRecord[] | null {
    return this.hasAccidents ? this.accidentsValue : null;
  }

  setUserLocation(location: UserLocation): void {
    this.userLocationValue = { ...location };
  }

  availableStateCodes(fallbackStateCodes: Iterable<string>): Set<string> {
    if (this.hasAccidents) {
      return new Set(this.accidentsValue.map((accident) => accident.stateCode));
    }
    return new Set(fallbackStateCodes);
  }

  availableYears(manifestYears: number[]): number[] {
    if (this.hasAccidents) {
      return Array.from(new Set(this.accidentsValue.map((accident) => accident.year).filter(Boolean))).sort((a, b) => a - b);
    }
    if (manifestYears.length > 0) {
      return manifestYears;
    }
    return this.resultValue?.years ?? [];
  }

  invalidateRenderedMapClusters(): void {
    this.renderedMapClustersValue = undefined;
  }

  markRenderedMapClusters(clusters: IntersectionCluster[] | null): void {
    this.renderedMapClustersValue = clusters;
  }
}
