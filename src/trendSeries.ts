import type { ClusterYearStat } from "./types";

export type TrendSeverityKey = "fatal" | "serious" | "light";

export interface TrendSeverityCounts {
  fatalCount: number;
  seriousCount: number;
  lightCount: number;
}

export const TREND_SEVERITY_STACK_ORDER: TrendSeverityKey[] = ["light", "serious", "fatal"];

export function clusterYearSeverityCounts(point: ClusterYearStat): TrendSeverityCounts {
  const hasBreakdown =
    typeof point.fatalCount === "number" || typeof point.seriousCount === "number" || typeof point.lightCount === "number";
  if (!hasBreakdown) {
    return {
      fatalCount: 0,
      seriousCount: 0,
      lightCount: nonNegativeCount(point.accidentCount)
    };
  }

  return {
    fatalCount: nonNegativeCount(point.fatalCount),
    seriousCount: nonNegativeCount(point.seriousCount),
    lightCount: nonNegativeCount(point.lightCount)
  };
}

export function trendSeverityCount(counts: TrendSeverityCounts, key: TrendSeverityKey): number {
  switch (key) {
    case "fatal":
      return counts.fatalCount;
    case "serious":
      return counts.seriousCount;
    case "light":
      return counts.lightCount;
  }
}

function nonNegativeCount(value: number | undefined): number {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value ?? 0 : 0));
}
