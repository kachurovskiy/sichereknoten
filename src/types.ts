export interface ParseProgress {
  label: string;
  loaded?: number;
  total?: number;
  records?: number;
  message?: string;
}

export interface AccidentRecord {
  id: string;
  serialNumber: string | null;
  source: string;
  sourceType: "csv" | "dbf";
  stateCode: string;
  stateName: string;
  administrativeRegionCode: string | null;
  districtCode: string | null;
  municipalityCode: string | null;
  year: number;
  month: number | null;
  hour: number | null;
  weekday: number | null;
  category: number | null;
  accidentKind: number | null;
  accidentType: number | null;
  lightCondition: number | null;
  roadSurface: number | null;
  plausibilityLevel: number | null;
  severityWeight: number;
  linRefX: number | null;
  linRefY: number | null;
  lon: number;
  lat: number;
  involvesBike: boolean | null;
  involvesPedestrian: boolean | null;
  involvesMotorcycle: boolean | null;
  involvesCar: boolean | null;
  involvesTruck: boolean | null;
  involvesOther: boolean | null;
}

export interface AnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: Set<number>;
  stateCode: string | "all";
}

export type AccidentTrendDirection = "falling" | "stable" | "rising" | "unknown";

export interface AccidentTrend {
  direction: AccidentTrendDirection;
  slopePerYear: number | null;
  relativeSlopePerYear: number | null;
  startAccidents: number | null;
  endAccidents: number | null;
  years: number;
}

export interface ClusterYearStat {
  year: number;
  accidentCount: number;
  severityPoints: number;
}

export interface IntersectionCluster {
  id: string;
  rank: number;
  lon: number;
  lat: number;
  stateCode: string;
  stateName: string;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
  vulnerableCount: number;
  severityPoints: number;
  absoluteScore: number;
  dangerScore: number;
  years: number[];
  yearlyStats: ClusterYearStat[];
  accidentTrend: AccidentTrend;
  accidentKeys?: string[];
}

export interface StateSummary {
  stateCode: string;
  stateName: string;
  accidentCount: number;
  clusterCount: number;
  severityPoints: number;
  topCluster: IntersectionCluster | null;
}

export interface AnalysisResult {
  clusters: IntersectionCluster[];
  stateSummaries: StateSummary[];
  filteredAccidentCount: number;
  years: number[];
}
