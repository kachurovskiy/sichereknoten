import { lonLatToMeterPoint } from "./geo";
import {
  AccidentRecord,
  AccidentTrend,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  IntersectionCluster,
  StateSummary
} from "./types";

interface ClusterYearAccumulator {
  year: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
  vulnerableCount: number;
  severityPoints: number;
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
  severityPoints: number;
  accidentKeys: string[];
  yearSet: Set<number>;
  yearStats: Map<number, ClusterYearAccumulator>;
  stateCounts: Map<string, number>;
}

export function analyzeDangerousIntersections(accidents: AccidentRecord[], options: AnalysisOptions): AnalysisResult {
  const filtered = accidents.filter((accident) => {
    if (options.years.size > 0 && !options.years.has(accident.year)) {
      return false;
    }
    return options.stateCode === "all" || accident.stateCode === options.stateCode;
  });

  const analysisYears =
    options.years.size > 0
      ? Array.from(options.years).sort((a, b) => a - b)
      : Array.from(new Set(filtered.map((accident) => accident.year))).sort((a, b) => a - b);

  const clusters = buildClusters(filtered, options.clusterRadiusMeters)
    .filter((cluster) => cluster.accidentCount >= options.minAccidents)
    .map((cluster) => finalizeCluster(cluster, analysisYears))
    .sort((a, b) => b.dangerScore - a.dangerScore)
    .map((cluster, index) => ({ ...cluster, rank: index + 1 }));

  return {
    clusters,
    stateSummaries: summarizeStates(clusters),
    filteredAccidentCount: filtered.length,
    years: analysisYears
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
        severityPoints: 0,
        accidentKeys: [],
        yearSet: new Set(),
        yearStats: new Map(),
        stateCounts: new Map()
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
  cluster.severityPoints += accident.severityWeight;
  cluster.accidentKeys.push(accidentKey(accident));
  cluster.yearSet.add(accident.year);
  cluster.stateCounts.set(accident.stateCode, (cluster.stateCounts.get(accident.stateCode) ?? 0) + 1);
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
      vulnerableCount: 0,
      severityPoints: 0
    } satisfies ClusterYearAccumulator);

  stats.accidentCount += 1;
  stats.severityPoints += accident.severityWeight;
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

function finalizeCluster(cluster: ClusterAccumulator, analysisYears: number[]): IntersectionCluster {
  const vulnerableBoost = cluster.vulnerableCount * 0.25;
  const absoluteScore = cluster.severityPoints + cluster.accidentCount * 0.35 + vulnerableBoost;
  const stateCode = topMapEntry(cluster.stateCounts) ?? "00";
  const yearlyStats = Array.from(cluster.yearStats.values())
    .sort((a, b) => a.year - b.year)
    .map(toClusterYearStat);

  return {
    id: cluster.id,
    rank: 0,
    lon: cluster.lon,
    lat: cluster.lat,
    stateCode,
    stateName: stateNameFromCode(stateCode),
    accidentCount: cluster.accidentCount,
    fatalCount: cluster.fatalCount,
    seriousCount: cluster.seriousCount,
    lightCount: cluster.lightCount,
    vulnerableCount: cluster.vulnerableCount,
    severityPoints: round(cluster.severityPoints, 2),
    absoluteScore: round(absoluteScore, 2),
    dangerScore: round(absoluteScore, 2),
    years: Array.from(cluster.yearSet).sort((a, b) => a - b),
    yearlyStats,
    accidentTrend: calculateAccidentTrend(cluster.yearStats, analysisYears),
    accidentKeys: cluster.accidentKeys
  };
}

function accidentKey(accident: AccidentRecord): string {
  return `${accident.source}\0${accident.id}`;
}

function toClusterYearStat(stats: ClusterYearAccumulator): ClusterYearStat {
  return {
    year: stats.year,
    accidentCount: stats.accidentCount,
    severityPoints: round(stats.severityPoints, 2)
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

function summarizeStates(clusters: IntersectionCluster[]): StateSummary[] {
  const summaries = new Map<string, StateSummary>();

  for (const cluster of clusters) {
    const summary =
      summaries.get(cluster.stateCode) ??
      ({
        stateCode: cluster.stateCode,
        stateName: cluster.stateName,
        accidentCount: 0,
        clusterCount: 0,
        severityPoints: 0,
        topCluster: null
      } satisfies StateSummary);

    summary.accidentCount += cluster.accidentCount;
    summary.clusterCount += 1;
    summary.severityPoints += cluster.severityPoints;
    if (!summary.topCluster || cluster.dangerScore > summary.topCluster.dangerScore) {
      summary.topCluster = cluster;
    }
    summaries.set(cluster.stateCode, summary);
  }

  return Array.from(summaries.values())
    .map((summary) => ({ ...summary, severityPoints: round(summary.severityPoints, 2) }))
    .sort((a, b) => b.severityPoints - a.severityPoints);
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

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
