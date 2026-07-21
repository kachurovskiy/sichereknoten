export type ScoreMode = "absolute" | "exposure";

export interface ParseProgress {
  label: string;
  loaded?: number;
  total?: number;
  records?: number;
  message?: string;
}

export interface AccidentRecord {
  id: string;
  source: string;
  sourceType: "csv" | "dbf";
  stateCode: string;
  stateName: string;
  year: number;
  month: number | null;
  hour: number | null;
  weekday: number | null;
  category: number | null;
  accidentType: number | null;
  severityWeight: number;
  lon: number;
  lat: number;
  involvesBike: boolean;
  involvesPedestrian: boolean;
  involvesMotorcycle: boolean;
  involvesCar: boolean;
  involvesTruck: boolean;
}

export interface TrafficPoint {
  id: string;
  road: string;
  stationNo: string;
  stateCode: string;
  stateName: string;
  from: string;
  to: string;
  dtv: number | null;
  dtvHeavy: number | null;
  x: number;
  y: number;
  lon: number;
  lat: number;
}

export interface AnalysisOptions {
  clusterRadiusMeters: number;
  matchRadiusMeters: number;
  minAccidents: number;
  years: Set<number>;
  stateCode: string | "all";
  scoreMode: ScoreMode;
}

export interface TrafficMatch {
  point: TrafficPoint;
  distanceMeters: number;
}

export type RateTrendDirection = "falling" | "stable" | "rising" | "unknown";

export interface RateTrend {
  direction: RateTrendDirection;
  slopePerYear: number | null;
  relativeSlopePerYear: number | null;
  startRate: number | null;
  endRate: number | null;
  years: number;
}

export interface ClusterYearStat {
  year: number;
  accidentCount: number;
  severityPoints: number;
  trafficDtv: number | null;
  estimatedVehicles: number | null;
  accidentsPerMillionVehicles: number | null;
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
  exposureScore: number | null;
  dangerScore: number;
  years: number[];
  yearlyStats: ClusterYearStat[];
  accidentsPerVehicleTrend: RateTrend;
  trafficMatch: TrafficMatch | null;
  accidentKeys?: string[];
}

export interface StateSummary {
  stateCode: string;
  stateName: string;
  accidentCount: number;
  clusterCount: number;
  severityPoints: number;
  matchedClusterCount: number;
  topCluster: IntersectionCluster | null;
}

export interface AnalysisResult {
  clusters: IntersectionCluster[];
  stateSummaries: StateSummary[];
  filteredAccidentCount: number;
  scoreMode: ScoreMode;
  years: number[];
}
