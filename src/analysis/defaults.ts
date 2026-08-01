export const DEFAULT_TREND_YEARS = 5;
export const MIN_TREND_YEARS = 2;

export function normalizeTrendYears(value: unknown, fallback = DEFAULT_TREND_YEARS): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  const trendYears = Number.isFinite(numericValue) ? numericValue : fallback;
  return Math.max(MIN_TREND_YEARS, Math.trunc(trendYears));
}
