export interface ParseProgress {
  label: string;
  loaded?: number;
  total?: number;
  records?: number;
  message?: string;
}

export interface AccidentRecord {
  id: string;
  recordIndex?: number;
  serialNumber: string | null;
  source: string;
  sourceType: "csv" | "dbf";
  streetName: string | null;
  streetNames: string[];
  osmRoundabout: boolean | null;
  osmTrafficSignal: boolean | null;
  stateCode: string;
  stateName: string;
  administrativeRegionCode: string | null;
  administrativeRegionName: string | null;
  districtCode: string | null;
  districtName: string | null;
  municipalityCode: string | null;
  municipalityName: string | null;
  year: number;
  month: number | null;
  day: number | null;
  hour: number | null;
  weekday: number | null;
  category: number | null;
  accidentKind: number | null;
  accidentType: number | null;
  lightCondition: number | null;
  roadSurface: number | null;
  plausibilityLevel: number | null;
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

export type RoadUserKey = "car" | "pedestrian" | "bicycle" | "motorcycle" | "truck" | "other";

export interface AnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: Set<number>;
  roadUserFocus: Set<RoadUserKey>;
  stateCode: string | "all";
  severityPercent: SeverityPercentOptions;
}

export interface SeverityPercentOptions {
  fatalWeight: number;
  seriousWeight: number;
  fullSampleAccidents: number;
  trendYears: number;
  trendDeadZone: number;
  trendFullSignal: number;
  maxTrendAdjustment: number;
  maxSeverityPercent: number;
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
}

export interface IntersectionCluster {
  id: string;
  lon: number;
  lat: number;
  stateCode: string;
  stateName: string;
  administrativeRegionCode: string | null;
  administrativeRegionName: string | null;
  administrativeRegionPopulation: number | null;
  districtCode: string | null;
  districtName: string | null;
  municipalityCode: string | null;
  municipalityName: string | null;
  municipalityPopulation: number | null;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
  vulnerableCount: number;
  streetNames: string[];
  osmRoundabout: boolean | null;
  osmTrafficSignal: boolean | null;
  osmRoundaboutCount: number;
  osmTrafficSignalCount: number;
  severityPercent: number;
  years: number[];
  yearlyStats: ClusterYearStat[];
  accidentTrend: AccidentTrend;
  accidentIndexes?: number[];
  accidentKeys?: string[];
}

export interface StateSummary {
  stateCode: string;
  stateName: string;
  accidentCount: number;
  clusterCount: number;
  fatalCount: number;
  seriousCount: number;
  severityPercent: number;
  topCluster: IntersectionCluster | null;
}

export interface PopulationAccidentSummary {
  key: string;
  name: string;
  stateCode: string;
  stateName: string;
  population: number | null;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
}

export interface AnalysisResult {
  clusters: IntersectionCluster[];
  stateSummaries: StateSummary[];
  stateAccidentSummaries: PopulationAccidentSummary[];
  regionAccidentSummaries: PopulationAccidentSummary[];
  filteredAccidentCount: number;
  years: number[];
}
