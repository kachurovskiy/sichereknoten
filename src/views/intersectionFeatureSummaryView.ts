import { formatInteger, formatRate, type SeverityPercentSource } from "../formatting";
import { escapeHtml } from "../html";
import { tr } from "../i18n";
import { clampNumber, round } from "../math";
import type { AnalysisResult, IntersectionCluster } from "../types";

export interface IntersectionFeatureSummaryRow extends SeverityPercentSource {
  id: string;
  label: string;
  clusterCount: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  weightedSeverityPercent: number;
  municipalityPopulation?: number;
  municipalityAccidentRate?: number | null;
  sortOrder: number;
}

interface IntersectionFeatureAccumulator {
  id: string;
  label: string;
  clusterCount: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  weightedSeverityPercent: number;
  municipalityPopulationByKey: Map<string, number>;
  sortOrder: number;
}

export interface IntersectionFeatureSummaryViewDependencies {
  container: HTMLElement;
  getResult: () => AnalysisResult | null;
}

const INTERSECTION_FEATURE_MIN_POPULATION = 1;
const INTERSECTION_FEATURE_POPULATION_RATE_DENOMINATOR = 100_000;
const INTERSECTION_FEATURE_POPULATION_BUCKETS = [
  { id: "under10k", maxExclusive: 10_000, labelKey: "intersectionFeature.populationUnder10k" },
  { id: "10k50k", maxExclusive: 50_000, labelKey: "intersectionFeature.population10k50k" },
  { id: "50k100k", maxExclusive: 100_000, labelKey: "intersectionFeature.population50k100k" },
  { id: "100k500k", maxExclusive: 500_000, labelKey: "intersectionFeature.population100k500k" },
  { id: "500kPlus", maxExclusive: Number.POSITIVE_INFINITY, labelKey: "intersectionFeature.population500kPlus" }
] as const;

export class IntersectionFeatureSummaryView {
  private renderedResult: AnalysisResult | null | undefined;

  constructor(private readonly deps: IntersectionFeatureSummaryViewDependencies) {}

  invalidate(): void {
    this.renderedResult = undefined;
  }

  render(): void {
    const result = this.deps.getResult();
    if (this.renderedResult === result) {
      return;
    }
    this.renderedResult = result;
    this.renderIntersectionFeatureSummary(result);
  }

  private renderIntersectionFeatureSummary(result: AnalysisResult | null): void {
    const clusters = result?.clusters ?? [];
    if (!result || clusters.length === 0) {
      this.deps.container.innerHTML = renderIntersectionFeatureEmptyState();
      return;
    }

    const rows = populationIntersectionFeatureRows(clusters);
    if (rows.length === 0) {
      this.deps.container.innerHTML = renderIntersectionFeatureEmptyState();
      return;
    }

    this.deps.container.innerHTML = renderIntersectionFeatureSection(rows, { showMunicipalityAccidentRate: true });
  }
}

export function populationIntersectionFeatureRows(clusters: IntersectionCluster[]): IntersectionFeatureSummaryRow[] {
  const accumulators = new Map<string, IntersectionFeatureAccumulator>();
  INTERSECTION_FEATURE_POPULATION_BUCKETS.forEach((bucket, index) => {
    accumulators.set(bucket.id, createIntersectionFeatureAccumulator(bucket.id, tr(bucket.labelKey), index));
  });

  for (const cluster of clusters) {
    const bucket = intersectionFeaturePopulationBucket(cluster);
    if (!bucket) {
      continue;
    }
    addClusterToIntersectionFeatureAccumulator(accumulators.get(bucket.id), cluster);
  }

  return finalizeIntersectionFeatureRows(Array.from(accumulators.values()));
}

interface IntersectionFeatureRenderOptions {
  showMunicipalityAccidentRate?: boolean;
}

export function renderIntersectionFeatureSection(
  rows: readonly IntersectionFeatureSummaryRow[],
  options: IntersectionFeatureRenderOptions = {}
): string {
  const showMunicipalityAccidentRate = options.showMunicipalityAccidentRate === true;
  const maxSeverityPercent = Math.max(0.1, ...rows.map((row) => intersectionFeatureSeverityPercent(row)));
  const maxTotalPerIntersection = Math.max(1, ...rows.map((row) => intersectionFeatureTotalPerIntersection(row)));
  const maxFatalPer100 = Math.max(1, ...rows.map((row) => intersectionFeatureFatalPer100(row)));
  const maxSeriousPer100 = Math.max(1, ...rows.map((row) => intersectionFeatureSeriousPer100(row)));
  const maxMunicipalityAccidentRate = Math.max(1, ...rows.map((row) => row.municipalityAccidentRate ?? 0));
  return `
    <div class="intersection-feature-table ${showMunicipalityAccidentRate ? "intersection-feature-table-municipality-rate" : ""}" role="table">
      <div class="intersection-feature-row intersection-feature-row-header" role="row">
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.group"))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.severity"))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.fatalPer100"))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.seriousPer100"))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.totalPerIntersection"))}</div>
        ${
          showMunicipalityAccidentRate
            ? `<div role="columnheader">${escapeHtml(tr("intersectionFeature.municipalityAccidentRate"))}</div>`
            : ""
        }
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.total"))}</div>
      </div>
      ${rows
        .map((row) =>
          renderIntersectionFeatureRow(
            row,
            maxSeverityPercent,
            maxTotalPerIntersection,
            maxFatalPer100,
            maxSeriousPer100,
            maxMunicipalityAccidentRate,
            showMunicipalityAccidentRate
          )
        )
        .join("")}
    </div>
  `;
}

function renderIntersectionFeatureEmptyState(): string {
  return `<p class="population-rate-empty">${escapeHtml(tr("intersectionFeature.empty"))}</p>`;
}

function intersectionFeaturePopulationBucket(cluster: IntersectionCluster): (typeof INTERSECTION_FEATURE_POPULATION_BUCKETS)[number] | null {
  const population = cluster.municipalityPopulation;
  if (typeof population !== "number" || population < INTERSECTION_FEATURE_MIN_POPULATION) {
    return null;
  }
  return INTERSECTION_FEATURE_POPULATION_BUCKETS.find((bucket) => population < bucket.maxExclusive) ?? null;
}

function createIntersectionFeatureAccumulator(id: string, label: string, sortOrder: number): IntersectionFeatureAccumulator {
  return {
    id,
    label,
    clusterCount: 0,
    accidentCount: 0,
    fatalCount: 0,
    seriousCount: 0,
    weightedSeverityPercent: 0,
    municipalityPopulationByKey: new Map(),
    sortOrder
  };
}

function addClusterToIntersectionFeatureAccumulator(
  accumulator: IntersectionFeatureAccumulator | undefined,
  cluster: IntersectionCluster
): void {
  if (!accumulator) {
    return;
  }
  accumulator.clusterCount += 1;
  accumulator.accidentCount += cluster.accidentCount;
  accumulator.fatalCount += cluster.fatalCount;
  accumulator.seriousCount += cluster.seriousCount;
  accumulator.weightedSeverityPercent += cluster.severityPercent * cluster.accidentCount;
  const municipalityPopulationKey = intersectionFeatureMunicipalityPopulationKey(cluster);
  if (municipalityPopulationKey && !accumulator.municipalityPopulationByKey.has(municipalityPopulationKey)) {
    accumulator.municipalityPopulationByKey.set(municipalityPopulationKey, cluster.municipalityPopulation as number);
  }
}

function finalizeIntersectionFeatureRows(accumulators: IntersectionFeatureAccumulator[]): IntersectionFeatureSummaryRow[] {
  return accumulators
    .filter((row) => row.clusterCount > 0)
    .map(({ municipalityPopulationByKey, ...row }) => {
      const municipalityPopulation = sumMunicipalityPopulation(municipalityPopulationByKey);
      return {
        ...row,
        severityPercent: row.accidentCount > 0 ? row.weightedSeverityPercent / row.accidentCount : 0,
        municipalityPopulation,
        municipalityAccidentRate:
          municipalityPopulation > 0 ? (row.accidentCount / municipalityPopulation) * INTERSECTION_FEATURE_POPULATION_RATE_DENOMINATOR : null
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function renderIntersectionFeatureRow(
  row: IntersectionFeatureSummaryRow,
  maxSeverityPercent: number,
  maxTotalPerIntersection: number,
  maxFatalPer100: number,
  maxSeriousPer100: number,
  maxMunicipalityAccidentRate: number,
  showMunicipalityAccidentRate: boolean
): string {
  const severityPercent = intersectionFeatureSeverityPercent(row);
  const severityLabel = formatIntersectionFeatureSeverityPercent(row);
  const fatalPer100 = intersectionFeatureFatalPer100(row);
  const seriousPer100 = intersectionFeatureSeriousPer100(row);
  const totalPerIntersection = intersectionFeatureTotalPerIntersection(row);
  const municipalityAccidentRate = row.municipalityAccidentRate ?? null;
  const municipalityAccidentRateTitle =
    showMunicipalityAccidentRate && municipalityAccidentRate !== null
      ? `, ${tr("intersectionFeature.municipalityAccidentRate")} ${formatRate(municipalityAccidentRate)}`
      : "";
  const title = `${row.label}: ${tr("intersectionFeature.severity")} ${severityLabel}, ${tr(
    "intersectionFeature.fatalPer100"
  )} ${formatRate(fatalPer100)}, ${tr("intersectionFeature.seriousPer100")} ${formatRate(
    seriousPer100
  )}, ${tr("intersectionFeature.totalPerIntersection")} ${formatRate(totalPerIntersection)}${municipalityAccidentRateTitle}`;
  return `
    <div class="intersection-feature-row" role="row" title="${escapeHtml(title)}">
      <div class="intersection-feature-group" role="cell">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${formatInteger(row.clusterCount)} ${escapeHtml(tr("intersectionFeature.intersections").toLowerCase())}</span>
      </div>
      <div role="cell">${renderIntersectionFeatureMetric(severityLabel, severityPercent, maxSeverityPercent, "severity")}</div>
      <div role="cell">${renderIntersectionFeatureMetric(formatRate(fatalPer100), fatalPer100, maxFatalPer100, "fatal")}</div>
      <div role="cell">${renderIntersectionFeatureMetric(formatRate(seriousPer100), seriousPer100, maxSeriousPer100, "serious")}</div>
      <div role="cell">${renderIntersectionFeatureMetric(formatRate(totalPerIntersection), totalPerIntersection, maxTotalPerIntersection, "total")}</div>
      ${
        showMunicipalityAccidentRate
          ? `<div role="cell">${renderIntersectionFeatureMunicipalityAccidentRate(row, maxMunicipalityAccidentRate)}</div>`
          : ""
      }
      <div class="intersection-feature-number intersection-feature-total" role="cell">${formatInteger(row.accidentCount)}</div>
    </div>
  `;
}

function renderIntersectionFeatureMunicipalityAccidentRate(row: IntersectionFeatureSummaryRow, maxMunicipalityAccidentRate: number): string {
  const rate = row.municipalityAccidentRate ?? null;
  return rate === null
    ? `<span class="intersection-feature-number">-</span>`
    : renderIntersectionFeatureMetric(formatRate(rate), rate, maxMunicipalityAccidentRate, "municipality-rate");
}

function renderIntersectionFeatureMetric(label: string, value: number, maxValue: number, kind: string): string {
  const width = maxValue <= 0 ? 0 : clampNumber((value / maxValue) * 100, 0, 100);
  return `
    <span class="intersection-feature-metric">
      <span class="intersection-feature-meter" aria-hidden="true">
        <span class="intersection-feature-meter-fill intersection-feature-meter-${kind}" style="width: ${round(width, 1)}%"></span>
      </span>
      <strong>${escapeHtml(label)}</strong>
    </span>
  `;
}

function intersectionFeatureSeverityPercent(row: IntersectionFeatureSummaryRow): number {
  return row.severityPercent * 100;
}

function formatIntersectionFeatureSeverityPercent(row: IntersectionFeatureSummaryRow): string {
  return `${formatRate(intersectionFeatureSeverityPercent(row))}%`;
}

function intersectionFeatureFatalPer100(row: IntersectionFeatureSummaryRow): number {
  return row.clusterCount > 0 ? (row.fatalCount / row.clusterCount) * 100 : 0;
}

function intersectionFeatureSeriousPer100(row: IntersectionFeatureSummaryRow): number {
  return row.clusterCount > 0 ? (row.seriousCount / row.clusterCount) * 100 : 0;
}

function intersectionFeatureTotalPerIntersection(row: IntersectionFeatureSummaryRow): number {
  return row.clusterCount > 0 ? row.accidentCount / row.clusterCount : 0;
}

function intersectionFeatureMunicipalityPopulationKey(cluster: IntersectionCluster): string | null {
  const population = cluster.municipalityPopulation;
  if (typeof population !== "number" || population <= 0) {
    return null;
  }
  if (cluster.districtCode && cluster.municipalityCode) {
    return [cluster.stateCode, cluster.administrativeRegionCode ?? "0", cluster.districtCode, cluster.municipalityCode].join(":");
  }
  return `${cluster.stateCode}:${cluster.municipalityName ?? cluster.id}`;
}

function sumMunicipalityPopulation(municipalityPopulationByKey: Map<string, number>): number {
  let total = 0;
  for (const population of municipalityPopulationByKey.values()) {
    total += population;
  }
  return total;
}
