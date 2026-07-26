import type { AppLocale } from "./i18n";

export interface SeverityPercentSource {
  severityPercent: number;
}

let numberLocale = "en-US";

export function configureNumberLocale(locale: AppLocale): void {
  numberLocale = locale === "de" ? "de-DE" : "en-US";
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 0 }).format(value);
}

export function formatCompactPopulation(value: number): string {
  return new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

export function formatRate(value: number): string {
  const maximumFractionDigits = value >= 100 ? 0 : 1;
  return new Intl.NumberFormat(numberLocale, { maximumFractionDigits }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 2 }).format(value);
}

export function formatCorrelation(value: number): string {
  return new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

export function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(numberLocale, { year: "numeric", month: "short", day: "2-digit" }).format(value);
}

export function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

export function formatSharePercent(value: number): string {
  return `${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 0 }).format(value * 100)}%`;
}

export function formatSeverityPercent(source: SeverityPercentSource): string {
  return `${severityPercentValue(source)}%`;
}

export function severityPercentValue(source: SeverityPercentSource): number {
  return Math.round(source.severityPercent * 100);
}

export function formatDistance(valueMeters: number): string {
  if (valueMeters >= 10_000) {
    return `${formatNumber(valueMeters / 1000)} km`;
  }
  if (valueMeters >= 1000) {
    return `${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 1 }).format(valueMeters / 1000)} km`;
  }
  return `${formatInteger(Math.round(valueMeters))} m`;
}
