import { formatInteger, formatRate, type SeverityPercentSource } from "../shared/formatting";
import { escapeHtml } from "../shared/html";
import { tr } from "../shared/i18n";
import { clampNumber, round } from "../shared/math";
import type { AnalysisResult, IntersectionCluster } from "../domain/types";

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

type IntersectionFeatureRateBasis = "intersection" | "population";
type IntersectionFeatureMetricKey = "fatal" | "serious" | "total";

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

    this.deps.container.innerHTML = renderIntersectionFeatureTables(rows);
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
  rateBasis?: IntersectionFeatureRateBasis;
}

function renderIntersectionFeatureTables(rows: readonly IntersectionFeatureSummaryRow[]): string {
  return `
    <section class="intersection-feature-table-section">
      <h3>${escapeHtml(tr("intersectionFeature.perIntersection"))}</h3>
      ${renderIntersectionFeatureSection(rows)}
    </section>
    <section class="intersection-feature-table-section">
      <h3>${escapeHtml(tr("intersectionFeature.perPopulation"))}</h3>
      ${renderIntersectionFeatureSection(rows, { rateBasis: "population" })}
    </section>
  `;
}

export function renderIntersectionFeatureSection(
  rows: readonly IntersectionFeatureSummaryRow[],
  options: IntersectionFeatureRenderOptions = {}
): string {
  const rateBasis = options.rateBasis ?? "intersection";
  const maxSeverityPercent = Math.max(0.1, ...rows.map((row) => intersectionFeatureSeverityPercent(row)));
  const maxFatal = maxIntersectionFeatureMetric(rows, rateBasis, "fatal");
  const maxSerious = maxIntersectionFeatureMetric(rows, rateBasis, "serious");
  const maxTotal = maxIntersectionFeatureMetric(rows, rateBasis, "total");
  return `
    <div class="intersection-feature-table" role="table">
      <div class="intersection-feature-row intersection-feature-row-header" role="row">
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.group"))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.severity"))}</div>
        <div role="columnheader">${escapeHtml(tr(intersectionFeatureMetricLabelKey(rateBasis, "fatal")))}</div>
        <div role="columnheader">${escapeHtml(tr(intersectionFeatureMetricLabelKey(rateBasis, "serious")))}</div>
        <div role="columnheader">${escapeHtml(tr(intersectionFeatureMetricLabelKey(rateBasis, "total")))}</div>
        <div role="columnheader">${escapeHtml(tr("intersectionFeature.total"))}</div>
      </div>
      ${rows
        .map((row) =>
          renderIntersectionFeatureRow(
            row,
            maxSeverityPercent,
            maxFatal,
            maxSerious,
            maxTotal,
            rateBasis
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
  maxFatal: number,
  maxSerious: number,
  maxTotal: number,
  rateBasis: IntersectionFeatureRateBasis
): string {
  const severityPercent = intersectionFeatureSeverityPercent(row);
  const severityLabel = formatIntersectionFeatureSeverityPercent(row);
  const fatalValue = intersectionFeatureMetricValue(row, rateBasis, "fatal");
  const seriousValue = intersectionFeatureMetricValue(row, rateBasis, "serious");
  const totalValue = intersectionFeatureMetricValue(row, rateBasis, "total");
  const title = `${row.label}: ${tr("intersectionFeature.severity")} ${severityLabel}, ${tr(
    intersectionFeatureMetricLabelKey(rateBasis, "fatal")
  )} ${formatIntersectionFeatureMetricValue(fatalValue)}, ${tr(
    intersectionFeatureMetricLabelKey(rateBasis, "serious")
  )} ${formatIntersectionFeatureMetricValue(seriousValue)}, ${tr(
    intersectionFeatureMetricLabelKey(rateBasis, "total")
  )} ${formatIntersectionFeatureMetricValue(totalValue)}`;
  return `
    <div class="intersection-feature-row" role="row" title="${escapeHtml(title)}">
      <div class="intersection-feature-group" role="cell">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${formatInteger(row.clusterCount)} ${escapeHtml(tr("intersectionFeature.intersections").toLowerCase())}</span>
      </div>
      <div role="cell">${renderIntersectionFeatureMetric(severityLabel, severityPercent, maxSeverityPercent, "severity")}</div>
      <div role="cell">${renderIntersectionFeatureNullableMetric(fatalValue, maxFatal, "fatal")}</div>
      <div role="cell">${renderIntersectionFeatureNullableMetric(seriousValue, maxSerious, "serious")}</div>
      <div role="cell">${renderIntersectionFeatureNullableMetric(totalValue, maxTotal, "total")}</div>
      <div class="intersection-feature-number intersection-feature-total" role="cell">${formatInteger(row.accidentCount)}</div>
    </div>
  `;
}

function renderIntersectionFeatureNullableMetric(value: number | null, maxValue: number, kind: string): string {
  return value === null
    ? `<span class="intersection-feature-number">-</span>`
    : renderIntersectionFeatureMetric(formatRate(value), value, maxValue, kind);
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

function intersectionFeatureMetricValue(
  row: IntersectionFeatureSummaryRow,
  rateBasis: IntersectionFeatureRateBasis,
  metric: IntersectionFeatureMetricKey
): number | null {
  if (rateBasis === "population") {
    const count = metric === "fatal" ? row.fatalCount : metric === "serious" ? row.seriousCount : row.accidentCount;
    return intersectionFeatureMunicipalityAccidentRate(row, count);
  }
  if (metric === "fatal") {
    return intersectionFeatureFatalPer100(row);
  }
  if (metric === "serious") {
    return intersectionFeatureSeriousPer100(row);
  }
  return intersectionFeatureTotalPerIntersection(row);
}

function intersectionFeatureMetricLabelKey(rateBasis: IntersectionFeatureRateBasis, metric: IntersectionFeatureMetricKey): string {
  if (rateBasis === "population") {
    if (metric === "fatal") {
      return "intersectionFeature.fatalPer100kPopulation";
    }
    if (metric === "serious") {
      return "intersectionFeature.seriousPer100kPopulation";
    }
    return "intersectionFeature.totalPer100kPopulation";
  }
  if (metric === "fatal") {
    return "intersectionFeature.fatalPer100";
  }
  if (metric === "serious") {
    return "intersectionFeature.seriousPer100";
  }
  return "intersectionFeature.totalPerIntersection";
}

function intersectionFeatureMunicipalityAccidentRate(row: IntersectionFeatureSummaryRow, count: number): number | null {
  const population = row.municipalityPopulation;
  return typeof population === "number" && population > 0
    ? (count / population) * INTERSECTION_FEATURE_POPULATION_RATE_DENOMINATOR
    : null;
}

function maxIntersectionFeatureMetric(
  rows: readonly IntersectionFeatureSummaryRow[],
  rateBasis: IntersectionFeatureRateBasis,
  metric: IntersectionFeatureMetricKey
): number {
  return Math.max(1, ...rows.map((row) => intersectionFeatureMetricValue(row, rateBasis, metric) ?? 0));
}

function formatIntersectionFeatureMetricValue(value: number | null): string {
  return value === null ? "-" : formatRate(value);
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
