import { lonLatToMeterPoint } from "./geo";
import { administrativeRegionPopulationFor, municipalityPopulationFor, statePopulationFor } from "./municipalities";
import { accidentMatchesRoadUserFocus } from "./roadUsers";
import {
  AccidentRecord,
  AccidentTrend,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  SeverityPercentOptions,
  IntersectionCluster,
  PopulationAccidentSummary,
  StateSummary
} from "./types";

interface ClusterYearAccumulator {
  year: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
  vulnerableCount: number;
}

interface ClusterAccumulator {
  id: string;
  bucketKey: string;
  lon: number;
  lat: number;
  x: number;
  y: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
  vulnerableCount: number;
  osmMetadataKnownCount: number;
  osmRoundaboutCount: number;
  osmTrafficSignalCount: number;
  accidentIndexes: number[];
  accidentKeys: string[];
  streetNameCounts: Map<string, number>;
  yearSet: Set<number>;
  yearStats: Map<number, ClusterYearAccumulator>;
  stateCounts: Map<string, number>;
  administrativeRegionCodeCounts: Map<string, number>;
  administrativeRegionCounts: Map<string, number>;
  districtCodeCounts: Map<string, number>;
  districtCounts: Map<string, number>;
  municipalityCodeCounts: Map<string, number>;
  municipalityCounts: Map<string, number>;
}

interface StateSummaryAccumulator extends StateSummary {
  yearStats: Map<number, ClusterYearAccumulator>;
}

interface PopulationAccidentSummaryAccumulator extends PopulationAccidentSummary {}

export function analyzeDangerousIntersections(accidents: AccidentRecord[], options: AnalysisOptions): AnalysisResult {
  const filtered = accidents.filter((accident) => {
    if (options.years.size > 0 && !options.years.has(accident.year)) {
      return false;
    }
    if (options.stateCode !== "all" && accident.stateCode !== options.stateCode) {
      return false;
    }
    return accidentMatchesRoadUserFocus(accident, options.roadUserFocus);
  });

  const analysisYears =
    options.years.size > 0
      ? Array.from(options.years).sort((a, b) => a - b)
      : Array.from(new Set(filtered.map((accident) => accident.year))).sort((a, b) => a - b);

  const clusters = buildClusters(filtered, options.clusterRadiusMeters)
    .filter((cluster) => cluster.accidentCount >= options.minAccidents)
    .map((cluster) => finalizeCluster(cluster, analysisYears, options.severityPercent))
    .sort(compareSeverityMetric);

  return {
    clusters,
    stateSummaries: summarizeStates(clusters, analysisYears, options.severityPercent),
    stateAccidentSummaries: summarizeStateAccidents(filtered),
    regionAccidentSummaries: summarizeRegionAccidents(filtered),
    filteredAccidentCount: filtered.length,
    years: analysisYears
  };
}

export function combineAnalysisResults(results: AnalysisResult[]): AnalysisResult {
  const oldClusterIds = new Map<string, string>();
  const clusters = results
    .flatMap((entry) => entry.clusters)
    .sort(compareSeverityMetric)
    .map((cluster, index) => {
      const id = `c-${index + 1}`;
      oldClusterIds.set(partitionClusterKey(cluster), id);
      return {
        ...cluster,
        id
      };
    });
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const years = Array.from(new Set(results.flatMap((entry) => entry.years))).sort((a, b) => a - b);

  return {
    clusters,
    stateSummaries: results
      .flatMap((entry) => entry.stateSummaries)
      .map((summary) => {
        const topClusterId = summary.topCluster ? oldClusterIds.get(partitionClusterKey(summary.topCluster)) : null;
        return {
          ...summary,
          topCluster: topClusterId ? clusterById.get(topClusterId) ?? null : null
        };
      })
      .sort((a, b) => b.severityPercent - a.severityPercent || b.accidentCount - a.accidentCount),
    stateAccidentSummaries: combinePopulationAccidentSummaries(results.flatMap((entry) => entry.stateAccidentSummaries ?? [])),
    regionAccidentSummaries: combinePopulationAccidentSummaries(results.flatMap((entry) => entry.regionAccidentSummaries ?? [])),
    filteredAccidentCount: results.reduce((total, entry) => total + entry.filteredAccidentCount, 0),
    years
  };
}

function buildClusters(accidents: AccidentRecord[], radiusMeters: number): ClusterAccumulator[] {
  const clusters: ClusterAccumulator[] = [];
  const buckets = new Map<string, ClusterAccumulator[]>();

  for (const accident of accidents) {
    const projected = lonLatToMeterPoint(accident);
    const cx = Math.floor(projected.x / radiusMeters);
    const cy = Math.floor(projected.y / radiusMeters);
    let nearest: ClusterAccumulator | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = buckets.get(key(cx + dx, cy + dy));
        if (!bucket) {
          continue;
        }
        for (const candidate of bucket) {
          const distance = Math.hypot(projected.x - candidate.x, projected.y - candidate.y);
          if (distance <= radiusMeters && distance < nearestDistance) {
            nearest = candidate;
            nearestDistance = distance;
          }
        }
      }
    }

    if (!nearest) {
      const bucketKey = key(cx, cy);
      nearest = {
        id: `c-${clusters.length + 1}`,
        bucketKey,
        lon: accident.lon,
        lat: accident.lat,
        x: projected.x,
        y: projected.y,
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0,
        vulnerableCount: 0,
        osmMetadataKnownCount: 0,
        osmRoundaboutCount: 0,
        osmTrafficSignalCount: 0,
        accidentIndexes: [],
        accidentKeys: [],
        streetNameCounts: new Map(),
        yearSet: new Set(),
        yearStats: new Map(),
        stateCounts: new Map(),
        administrativeRegionCodeCounts: new Map(),
        administrativeRegionCounts: new Map(),
        districtCodeCounts: new Map(),
        districtCounts: new Map(),
        municipalityCodeCounts: new Map(),
        municipalityCounts: new Map()
      };
      clusters.push(nearest);
      const bucket = buckets.get(bucketKey);
      if (bucket) {
        bucket.push(nearest);
      } else {
        buckets.set(bucketKey, [nearest]);
      }
    }

    addAccidentToCluster(nearest, accident, projected);
    updateClusterBucket(nearest, buckets, radiusMeters);
  }

  return clusters;
}

function addAccidentToCluster(cluster: ClusterAccumulator, accident: AccidentRecord, projected: { x: number; y: number }): void {
  const previousCount = cluster.accidentCount;
  cluster.accidentCount += 1;
  cluster.lon = (cluster.lon * previousCount + accident.lon) / cluster.accidentCount;
  cluster.lat = (cluster.lat * previousCount + accident.lat) / cluster.accidentCount;
  cluster.x = (cluster.x * previousCount + projected.x) / cluster.accidentCount;
  cluster.y = (cluster.y * previousCount + projected.y) / cluster.accidentCount;
  if (typeof accident.recordIndex === "number") {
    cluster.accidentIndexes.push(accident.recordIndex);
  }
  cluster.accidentKeys.push(accidentKey(accident));
  for (const streetName of accidentStreetNames(accident)) {
    cluster.streetNameCounts.set(streetName, (cluster.streetNameCounts.get(streetName) ?? 0) + 1);
  }
  cluster.yearSet.add(accident.year);
  cluster.stateCounts.set(accident.stateCode, (cluster.stateCounts.get(accident.stateCode) ?? 0) + 1);
  if (accident.administrativeRegionCode) {
    incrementMapEntry(cluster.administrativeRegionCodeCounts, accident.administrativeRegionCode);
  }
  if (accident.administrativeRegionName) {
    incrementMapEntry(cluster.administrativeRegionCounts, accident.administrativeRegionName);
  }
  if (accident.districtCode) {
    incrementMapEntry(cluster.districtCodeCounts, accident.districtCode);
  }
  if (accident.districtName) {
    incrementMapEntry(cluster.districtCounts, accident.districtName);
  }
  if (accident.municipalityCode) {
    incrementMapEntry(cluster.municipalityCodeCounts, accident.municipalityCode);
  }
  if (accident.municipalityName) {
    incrementMapEntry(cluster.municipalityCounts, accident.municipalityName);
  }
  addAccidentToYearStats(cluster, accident);

  if (accident.category === 1) {
    cluster.fatalCount += 1;
  } else if (accident.category === 2) {
    cluster.seriousCount += 1;
  } else if (accident.category === 3) {
    cluster.lightCount += 1;
  }

  if (accident.involvesBike || accident.involvesPedestrian || accident.involvesMotorcycle) {
    cluster.vulnerableCount += 1;
  }

  if (hasOsmRoadMetadata(accident)) {
    cluster.osmMetadataKnownCount += 1;
    if (accident.osmRoundabout) {
      cluster.osmRoundaboutCount += 1;
    }
    if (accident.osmTrafficSignal) {
      cluster.osmTrafficSignalCount += 1;
    }
  }
}

function hasOsmRoadMetadata(accident: AccidentRecord): boolean {
  return accident.osmRoundabout !== null || accident.osmTrafficSignal !== null;
}

function addAccidentToYearStats(cluster: ClusterAccumulator, accident: AccidentRecord): void {
  const stats =
    cluster.yearStats.get(accident.year) ??
    ({
      year: accident.year,
      accidentCount: 0,
      fatalCount: 0,
      seriousCount: 0,
      lightCount: 0,
      vulnerableCount: 0
    } satisfies ClusterYearAccumulator);

  stats.accidentCount += 1;
  if (accident.category === 1) {
    stats.fatalCount += 1;
  } else if (accident.category === 2) {
    stats.seriousCount += 1;
  } else if (accident.category === 3) {
    stats.lightCount += 1;
  }
  if (accident.involvesBike || accident.involvesPedestrian || accident.involvesMotorcycle) {
    stats.vulnerableCount += 1;
  }
  cluster.yearStats.set(accident.year, stats);
}

function incrementMapEntry(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function updateClusterBucket(
  cluster: ClusterAccumulator,
  buckets: Map<string, ClusterAccumulator[]>,
  radiusMeters: number
): void {
  const cx = Math.floor(cluster.x / radiusMeters);
  const cy = Math.floor(cluster.y / radiusMeters);
  const nextKey = key(cx, cy);
  if (nextKey === cluster.bucketKey) {
    return;
  }

  const previousBucket = buckets.get(cluster.bucketKey);
  if (previousBucket) {
    const index = previousBucket.indexOf(cluster);
    if (index >= 0) {
      previousBucket.splice(index, 1);
    }
    if (previousBucket.length === 0) {
      buckets.delete(cluster.bucketKey);
    }
  }

  const nextBucket = buckets.get(nextKey);
  if (nextBucket) {
    nextBucket.push(cluster);
  } else {
    buckets.set(nextKey, [cluster]);
  }
  cluster.bucketKey = nextKey;
}

function finalizeCluster(
  cluster: ClusterAccumulator,
  analysisYears: number[],
  severityPercentOptions: SeverityPercentOptions
): IntersectionCluster {
  const stateCode = topMapEntry(cluster.stateCounts) ?? "00";
  const administrativeRegionCode = topMapEntry(cluster.administrativeRegionCodeCounts);
  const districtCode = topMapEntry(cluster.districtCodeCounts);
  const municipalityCode = topMapEntry(cluster.municipalityCodeCounts);
  const yearlyStats = Array.from(cluster.yearStats.values())
    .sort((a, b) => a.year - b.year)
    .map(toClusterYearStat);
  const accidentTrend = calculateAccidentTrend(cluster.yearStats, trendAnalysisYears(analysisYears, severityPercentOptions));

  return {
    id: cluster.id,
    lon: cluster.lon,
    lat: cluster.lat,
    stateCode,
    stateName: stateNameFromCode(stateCode),
    administrativeRegionCode,
    administrativeRegionName: topMapEntry(cluster.administrativeRegionCounts),
    administrativeRegionPopulation:
      administrativeRegionPopulationFor(stateCode, administrativeRegionCode) ?? (administrativeRegionCode ? null : statePopulationFor(stateCode)),
    districtCode,
    districtName: topMapEntry(cluster.districtCounts),
    municipalityCode,
    municipalityName: topMapEntry(cluster.municipalityCounts),
    municipalityPopulation: municipalityPopulationFor(stateCode, administrativeRegionCode, districtCode, municipalityCode),
    accidentCount: cluster.accidentCount,
    fatalCount: cluster.fatalCount,
    seriousCount: cluster.seriousCount,
    lightCount: cluster.lightCount,
    vulnerableCount: cluster.vulnerableCount,
    streetNames: clusterStreetNames(cluster.streetNameCounts),
    osmRoundabout: cluster.osmMetadataKnownCount > 0 ? cluster.osmRoundaboutCount > 0 : null,
    osmTrafficSignal: cluster.osmMetadataKnownCount > 0 ? cluster.osmTrafficSignalCount > 0 : null,
    osmRoundaboutCount: cluster.osmRoundaboutCount,
    osmTrafficSignalCount: cluster.osmTrafficSignalCount,
    severityPercent: severityPercent(cluster, accidentTrend, severityPercentOptions),
    years: Array.from(cluster.yearSet).sort((a, b) => a - b),
    yearlyStats,
    accidentTrend,
    accidentIndexes: cluster.accidentIndexes.length === cluster.accidentCount ? cluster.accidentIndexes : undefined,
    accidentKeys: cluster.accidentKeys
  };
}

function accidentKey(accident: AccidentRecord): string {
  return `${accident.source}\0${accident.id}`;
}

function clusterStreetNames(streetNameCounts: Map<string, number>): string[] {
  return Array.from(streetNameCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de", { sensitivity: "base" }))
    .map(([name]) => name);
}

function accidentStreetNames(accident: AccidentRecord): string[] {
  const values = Array.isArray(accident.streetNames) && accident.streetNames.length > 0 ? accident.streetNames : [accident.streetName];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLocaleLowerCase("de");
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function toClusterYearStat(stats: ClusterYearAccumulator): ClusterYearStat {
  return {
    year: stats.year,
    accidentCount: stats.accidentCount
  };
}

function calculateAccidentTrend(yearlyStats: Map<number, ClusterYearAccumulator>, analysisYears: number[]): AccidentTrend {
  if (analysisYears.length < 2) {
    return unknownAccidentTrend(analysisYears.length);
  }

  const points = analysisYears.map((year) => {
    const accidentCount = yearlyStats.get(year)?.accidentCount ?? 0;
    return {
      year,
      accidentCount
    };
  });
  const meanAccidents = points.reduce((total, point) => total + point.accidentCount, 0) / points.length;
  const firstYear = points[0].year;
  const meanX = points.reduce((total, point) => total + (point.year - firstYear), 0) / points.length;
  const numerator = points.reduce(
    (total, point) => total + (point.year - firstYear - meanX) * (point.accidentCount - meanAccidents),
    0
  );
  const denominator = points.reduce((total, point) => total + (point.year - firstYear - meanX) ** 2, 0);

  if (denominator === 0) {
    return unknownAccidentTrend(analysisYears.length);
  }

  const slopePerYear = numerator / denominator;
  const relativeSlopePerYear = meanAccidents > 0 ? slopePerYear / meanAccidents : 0;
  const direction = Math.abs(relativeSlopePerYear) < 0.08 ? "stable" : relativeSlopePerYear > 0 ? "rising" : "falling";

  return {
    direction,
    slopePerYear: round(slopePerYear, 4),
    relativeSlopePerYear: round(relativeSlopePerYear, 4),
    startAccidents: points[0].accidentCount,
    endAccidents: points[points.length - 1].accidentCount,
    years: points.length
  };
}

function unknownAccidentTrend(years: number): AccidentTrend {
  return {
    direction: "unknown",
    slopePerYear: null,
    relativeSlopePerYear: null,
    startAccidents: null,
    endAccidents: null,
    years
  };
}

function summarizeStates(
  clusters: IntersectionCluster[],
  analysisYears: number[],
  severityPercentOptions: SeverityPercentOptions
): StateSummary[] {
  const summaries = new Map<string, StateSummaryAccumulator>();

  for (const cluster of clusters) {
    const summary =
      summaries.get(cluster.stateCode) ??
      ({
        stateCode: cluster.stateCode,
        stateName: cluster.stateName,
        accidentCount: 0,
        clusterCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        severityPercent: 0,
        topCluster: null,
        yearStats: new Map()
      } satisfies StateSummaryAccumulator);

    summary.accidentCount += cluster.accidentCount;
    summary.clusterCount += 1;
    summary.fatalCount += cluster.fatalCount;
    summary.seriousCount += cluster.seriousCount;
    mergeSummaryYearStats(summary.yearStats, cluster.yearlyStats);
    if (!summary.topCluster || compareSeverityMetric(cluster, summary.topCluster) < 0) {
      summary.topCluster = cluster;
    }
    summaries.set(cluster.stateCode, summary);
  }

  return Array.from(summaries.values())
    .map((summary) => {
      const accidentTrend = calculateAccidentTrend(summary.yearStats, trendAnalysisYears(analysisYears, severityPercentOptions));
      const { yearStats: _yearStats, ...stateSummary } = summary;
      return {
        ...stateSummary,
        severityPercent: severityPercent(summary, accidentTrend, severityPercentOptions)
      };
    })
    .sort((a, b) => b.severityPercent - a.severityPercent || b.accidentCount - a.accidentCount);
}

function trendAnalysisYears(analysisYears: number[], options: SeverityPercentOptions): number[] {
  const trendYears = Math.max(2, Math.trunc(Number.isFinite(options.trendYears) ? options.trendYears : 4));
  return analysisYears.slice(-trendYears);
}

function summarizeStateAccidents(accidents: AccidentRecord[]): PopulationAccidentSummary[] {
  const summaries = new Map<string, PopulationAccidentSummaryAccumulator>();
  for (const accident of accidents) {
    const summary =
      summaries.get(accident.stateCode) ??
      ({
        key: accident.stateCode,
        name: accident.stateName,
        stateCode: accident.stateCode,
        stateName: accident.stateName,
        population: statePopulationFor(accident.stateCode),
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0
      } satisfies PopulationAccidentSummaryAccumulator);
    addAccidentToPopulationSummary(summary, accident);
    summaries.set(accident.stateCode, summary);
  }
  return Array.from(summaries.values()).sort(comparePopulationAccidentSummaries);
}

function summarizeRegionAccidents(accidents: AccidentRecord[]): PopulationAccidentSummary[] {
  const summaries = new Map<string, PopulationAccidentSummaryAccumulator>();
  for (const accident of accidents) {
    const administrativeRegionPopulation = administrativeRegionPopulationFor(accident.stateCode, accident.administrativeRegionCode);
    const hasAdministrativeRegionPopulation = administrativeRegionPopulation !== null;
    const regionKey = hasAdministrativeRegionPopulation ? accidentRegionSummaryKey(accident) : `${accident.stateCode}:state`;
    const population = hasAdministrativeRegionPopulation ? administrativeRegionPopulation : statePopulationFor(accident.stateCode);
    const summary =
      summaries.get(regionKey) ??
      ({
        key: regionKey,
        name: hasAdministrativeRegionPopulation ? accident.administrativeRegionName ?? accident.stateName : accident.stateName,
        stateCode: accident.stateCode,
        stateName: accident.stateName,
        population,
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0
      } satisfies PopulationAccidentSummaryAccumulator);
    summary.population ??= population;
    addAccidentToPopulationSummary(summary, accident);
    summaries.set(regionKey, summary);
  }
  return Array.from(summaries.values()).sort(comparePopulationAccidentSummaries);
}

function combinePopulationAccidentSummaries(summaries: PopulationAccidentSummary[]): PopulationAccidentSummary[] {
  const combined = new Map<string, PopulationAccidentSummaryAccumulator>();
  for (const summary of summaries) {
    const current =
      combined.get(summary.key) ??
      ({
        key: summary.key,
        name: summary.name,
        stateCode: summary.stateCode,
        stateName: summary.stateName,
        population: summary.population,
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0
      } satisfies PopulationAccidentSummaryAccumulator);
    current.population ??= summary.population;
    current.accidentCount += summary.accidentCount;
    current.fatalCount += summary.fatalCount;
    current.seriousCount += summary.seriousCount;
    current.lightCount += summary.lightCount;
    combined.set(summary.key, current);
  }
  return Array.from(combined.values()).sort(comparePopulationAccidentSummaries);
}

function addAccidentToPopulationSummary(summary: PopulationAccidentSummaryAccumulator, accident: AccidentRecord): void {
  summary.accidentCount += 1;
  if (accident.category === 1) {
    summary.fatalCount += 1;
  } else if (accident.category === 2) {
    summary.seriousCount += 1;
  } else if (accident.category === 3) {
    summary.lightCount += 1;
  }
}

function accidentRegionSummaryKey(accident: AccidentRecord): string {
  return `${accident.stateCode}:${accident.administrativeRegionCode ?? "state"}`;
}

function comparePopulationAccidentSummaries(a: PopulationAccidentSummary, b: PopulationAccidentSummary): number {
  return (
    b.accidentCount - a.accidentCount ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    a.stateName.localeCompare(b.stateName, "de", { sensitivity: "base" }) ||
    a.name.localeCompare(b.name, "de", { sensitivity: "base" })
  );
}

function mergeSummaryYearStats(target: Map<number, ClusterYearAccumulator>, yearlyStats: ClusterYearStat[]): void {
  for (const stats of yearlyStats) {
    const current =
      target.get(stats.year) ??
      ({
        year: stats.year,
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0,
        vulnerableCount: 0
      } satisfies ClusterYearAccumulator);
    current.accidentCount += stats.accidentCount;
    target.set(stats.year, current);
  }
}

function compareSeverityMetric(a: IntersectionCluster, b: IntersectionCluster): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount
  );
}

function severityPercent(
  source: { accidentCount: number; fatalCount: number; seriousCount: number },
  trend: AccidentTrend,
  options: SeverityPercentOptions
): number {
  if (source.accidentCount <= 0) {
    return 0;
  }
  const rawSeverityShare =
    (source.fatalCount * options.fatalWeight + source.seriousCount * options.seriousWeight) / source.accidentCount;
  const adjusted = rawSeverityShare * smallSampleFactor(source.accidentCount, options) * trendFactor(trend, options);
  return round(clamp(adjusted, 0, Math.max(0, options.maxSeverityPercent)), 4);
}

function smallSampleFactor(accidentCount: number, options: SeverityPercentOptions): number {
  const fullSampleAccidents = Math.max(1, options.fullSampleAccidents);
  if (accidentCount >= fullSampleAccidents) {
    return 1;
  }
  return accidentCount / fullSampleAccidents;
}

function trendFactor(trend: AccidentTrend, options: SeverityPercentOptions): number {
  if (trend.relativeSlopePerYear === null) {
    return 1;
  }
  const magnitude = Math.abs(trend.relativeSlopePerYear);
  if (magnitude <= options.trendDeadZone) {
    return 1;
  }
  const signalWidth = Math.max(0.001, options.trendFullSignal - options.trendDeadZone);
  const signal = clamp(
    (magnitude - options.trendDeadZone) / signalWidth,
    0,
    1
  );
  const adjustment = signal * options.maxTrendAdjustment;
  return trend.relativeSlopePerYear > 0 ? 1 + adjustment : 1 - adjustment;
}

function topMapEntry(map: Map<string, number>): string | null {
  let topKey: string | null = null;
  let topValue = -1;
  for (const [keyName, value] of map.entries()) {
    if (value > topValue) {
      topKey = keyName;
      topValue = value;
    }
  }
  return topKey;
}

function stateNameFromCode(code: string): string {
  const names: Record<string, string> = {
    "01": "Schleswig-Holstein",
    "02": "Hamburg",
    "03": "Niedersachsen",
    "04": "Bremen",
    "05": "Nordrhein-Westfalen",
    "06": "Hessen",
    "07": "Rheinland-Pfalz",
    "08": "Baden-Wuerttemberg",
    "09": "Bayern",
    "10": "Saarland",
    "11": "Berlin",
    "12": "Brandenburg",
    "13": "Mecklenburg-Vorpommern",
    "14": "Sachsen",
    "15": "Sachsen-Anhalt",
    "16": "Thueringen"
  };
  return names[code] ?? `Bundesland ${code}`;
}

function key(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function partitionClusterKey(cluster: IntersectionCluster): string {
  return `${cluster.stateCode}\0${cluster.id}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
