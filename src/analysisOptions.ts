import type { AnalysisOptions, RoadUserKey, SeverityPercentOptions } from "./types";

export interface SerializedAnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: number[];
  roadUserFocus: RoadUserKey[];
  stateCode: string | "all";
  severityPercent: SeverityPercentOptions;
}

export interface AnalysisOptionsMetadata {
  dataVersion: string;
  analysisCacheVersion: string;
  options: SerializedAnalysisOptions;
}

export function serializeAnalysisOptions(options: AnalysisOptions): SerializedAnalysisOptions {
  return {
    clusterRadiusMeters: options.clusterRadiusMeters,
    minAccidents: options.minAccidents,
    years: Array.from(options.years).sort((a, b) => a - b),
    roadUserFocus: Array.from(options.roadUserFocus).sort(),
    stateCode: options.stateCode,
    severityPercent: { ...options.severityPercent }
  };
}

export const serializeAnalysisOptionsForBundle = serializeAnalysisOptions;

export function deserializeAnalysisOptions(options: SerializedAnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    roadUserFocus: new Set(options.roadUserFocus),
    severityPercent: { ...options.severityPercent }
  };
}

export function cloneAnalysisOptions(options: AnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    roadUserFocus: new Set(options.roadUserFocus),
    severityPercent: { ...options.severityPercent }
  };
}

export function analysisOptionsEqual(left: AnalysisOptions, right: AnalysisOptions): boolean {
  return serializedAnalysisOptionsEqual(serializeAnalysisOptions(left), serializeAnalysisOptions(right));
}

export function analysisOptionsMetadataMatches(
  metadata: AnalysisOptionsMetadata | null | undefined,
  dataVersion: string,
  analysisCacheVersion: string,
  options: AnalysisOptions
): boolean {
  return (
    !!metadata &&
    metadata.dataVersion === dataVersion &&
    metadata.analysisCacheVersion === analysisCacheVersion &&
    serializedAnalysisOptionsEqual(metadata.options, serializeAnalysisOptions(options))
  );
}

function serializedAnalysisOptionsEqual(left: SerializedAnalysisOptions, right: SerializedAnalysisOptions): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
