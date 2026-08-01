import { cleanAreaNameForDisplay } from "../domain/clusterDisplay";
import {
  formatCompactPopulation,
  formatCorrelation,
  formatInteger,
  formatRate,
  formatSeverityPercent,
  type SeverityPercentSource
} from "../shared/formatting";
import { escapeHtml } from "../shared/html";
import { tr, trf } from "../shared/i18n";
import { clampNumber, linePath, round, uniqueNumbers } from "../shared/math";
import { STATE_NAMES } from "../domain/states";
import type { RegionSummary } from "../browse/browseIndex";
import type { AnalysisResult, IntersectionCluster, PopulationAccidentSummary } from "../domain/types";

const POPULATION_RATE_DENOMINATOR = 100_000;
const STATE_RANK_CHART_MAX_RANK = 1000;
const STATE_RANK_CHART_SAMPLE_RANKS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const STATE_RANK_CHART_COLORS = [
  "#166b6d",
  "#b9392b",
  "#425b70",
  "#8b3f7a",
  "#7c4d12",
  "#0b5d87",
  "#6b7f2a",
  "#a84f1d",
  "#5b5f97",
  "#2f7d55",
  "#9b2f4a",
  "#6a6f73",
  "#bf8f2f",
  "#1f6f8b",
  "#8a5a44",
  "#4f7c85"
];

interface StateRegionViewElements {
  stateRankChart: HTMLElement;
  statePopulationRates: HTMLElement;
  statePopulationScatter: HTMLElement;
  stateSeverityCorrelationScatter: HTMLElement;
  regionRankChart: HTMLElement;
  regionPopulationRates: HTMLElement;
  regionPopulationScatter: HTMLElement;
  regionSeverityCorrelationScatter: HTMLElement;
}

interface StateRegionViewDependencies extends StateRegionViewElements {
  getResult: () => AnalysisResult | null;
  getRegionSummaries: () => RegionSummary[];
}

interface StateRegionViewRenderContext {
  elements: StateRegionViewElements;
  result: AnalysisResult | null;
  getRegionSummaries: () => RegionSummary[];
}

export class StateRegionView {
  private result: AnalysisResult | null = null;
  private renderedStateResult: AnalysisResult | null | undefined;
  private renderedRegionResult: AnalysisResult | null | undefined;

  constructor(private readonly deps: StateRegionViewDependencies) {}

  renderAll(): void {
    this.syncResult();
    this.renderStateAnalysisView();
    this.renderRegionAnalysisView();
  }

  renderState(): void {
    this.syncResult();
    this.renderStateAnalysisView();
  }

  renderRegion(): void {
    this.syncResult();
    this.renderRegionAnalysisView();
  }

  invalidate(): void {
    this.renderedStateResult = undefined;
    this.renderedRegionResult = undefined;
  }

  private syncResult(): void {
    this.result = this.deps.getResult();
  }

  private renderStateAnalysisView(): void {
    const context = this.renderContext();
    if (this.renderedStateResult === context.result) {
      return;
    }
    this.renderedStateResult = context.result;
    renderStateAnalysisView(context);
  }

  private renderRegionAnalysisView(): void {
    const context = this.renderContext();
    if (this.renderedRegionResult === context.result) {
      return;
    }
    this.renderedRegionResult = context.result;
    renderRegionAnalysisView(context);
  }

  private renderContext(): StateRegionViewRenderContext {
    return {
      elements: this.deps,
      result: this.result,
      getRegionSummaries: this.deps.getRegionSummaries
    };
  }
}

interface PopulationRateRow {
  name: string;
  secondaryLabel: string | null;
  population: number;
  totalRate: number;
  fatalRate: number;
  seriousRate: number;
  otherRate: number;
}

type PopulationScatterMetric = "total" | "fatal" | "serious";

interface PopulationScatterChartConfig {
  titleKey: string;
  xMetric: PopulationScatterMetric;
  yMetric: PopulationScatterMetric;
  xMax: number;
  yMax: number;
  pointClass: string;
}

interface SeverityCorrelationRow extends SeverityPercentSource {
  name: string;
  secondaryLabel: string | null;
  population: number;
  fatalRate: number;
  severeRate: number;
}

type SeverityCorrelationMetric = "fatal" | "severe";

interface SeverityCorrelationChartConfig {
  titleKey: string;
  yMetric: SeverityCorrelationMetric;
  xMax: number;
  yMax: number;
  pointClass: string;
}

interface ScatterRegression {
  slope: number;
  intercept: number;
  correlation: number | null;
  minX: number;
  maxX: number;
}

function renderStateAnalysisView(context: StateRegionViewRenderContext): void {
  renderStateRankChart(context);
  renderStatePopulationRates(context);
  renderStatePopulationScatter(context);
  renderStateSeverityCorrelationScatter(context);
}

function renderRegionAnalysisView(context: StateRegionViewRenderContext): void {
  renderRegionRankChart(context);
  renderRegionPopulationRates(context);
  renderRegionPopulationScatter(context);
  renderRegionSeverityCorrelationScatter(context);
}

interface RankChartSeries {
  id: string;
  name: string;
  tooltip?: string;
  color: string;
  clusters: IntersectionCluster[];
}

interface RankChartPoint {
  rank: number;
  severityPercent: number;
}

function renderStateRankChart({ elements, result }: StateRegionViewRenderContext): void {
  renderRankChart(elements.stateRankChart, result, result ? stateRankChartSeries(result.clusters) : [], "stateChart.empty", "stateChart.aria");
}

function renderRegionRankChart(context: StateRegionViewRenderContext): void {
  const { elements, result } = context;
  renderRankChart(elements.regionRankChart, result, result ? regionRankChartSeries(regionSummaries(context)) : [], "regionChart.empty", "regionChart.aria");
}

function renderStatePopulationRates({ elements, result }: StateRegionViewRenderContext): void {
  renderPopulationRateComparison(elements.statePopulationRates, result?.stateAccidentSummaries ?? [], false, result !== null);
}

function renderRegionPopulationRates({ elements, result }: StateRegionViewRenderContext): void {
  renderPopulationRateComparison(elements.regionPopulationRates, result?.regionAccidentSummaries ?? [], true, result !== null);
}

function renderStatePopulationScatter({ elements, result }: StateRegionViewRenderContext): void {
  renderPopulationScatterComparison(elements.statePopulationScatter, result?.stateAccidentSummaries ?? [], false, result !== null);
}

function renderRegionPopulationScatter({ elements, result }: StateRegionViewRenderContext): void {
  renderPopulationScatterComparison(elements.regionPopulationScatter, result?.regionAccidentSummaries ?? [], true, result !== null);
}

function renderStateSeverityCorrelationScatter({ elements, result }: StateRegionViewRenderContext): void {
  const severityByState = new Map((result?.stateSummaries ?? []).map((summary) => [summary.stateCode, summary.severityPercent]));
  const rows = severityCorrelationRows(
    result?.stateAccidentSummaries ?? [],
    false,
    (summary) => severityByState.get(summary.stateCode) ?? null
  );
  renderSeverityCorrelationComparison(elements.stateSeverityCorrelationScatter, rows, result !== null);
}

function renderRegionSeverityCorrelationScatter(context: StateRegionViewRenderContext): void {
  const { elements, result } = context;
  const severityByRegion = new Map(regionSummaries(context).map((summary) => [summary.key, summary.severityPercent]));
  const rows = severityCorrelationRows(
    result?.regionAccidentSummaries ?? [],
    true,
    (summary) => severityByRegion.get(summary.key) ?? null
  );
  renderSeverityCorrelationComparison(elements.regionSeverityCorrelationScatter, rows, result !== null);
}

function renderPopulationScatterComparison(
  container: HTMLElement,
  summaries: PopulationAccidentSummary[],
  showStateLabel: boolean,
  hasResult: boolean
): void {
  const rows = populationRateRows(summaries, showStateLabel);
  if (!hasResult || rows.length === 0) {
    container.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("populationScatter.empty"))}</p>`;
    return;
  }

  const totalMax = niceRateChartMax(Math.max(...rows.map((row) => row.totalRate)));
  const fatalMax = niceRateChartMax(Math.max(...rows.map((row) => row.fatalRate)));
  const seriousMax = niceRateChartMax(Math.max(...rows.map((row) => row.seriousRate)));
  const charts: PopulationScatterChartConfig[] = [
    {
      titleKey: "populationScatter.fatalTitle",
      xMetric: "total",
      yMetric: "fatal",
      xMax: totalMax,
      yMax: fatalMax,
      pointClass: "fatal"
    },
    {
      titleKey: "populationScatter.seriousTitle",
      xMetric: "total",
      yMetric: "serious",
      xMax: totalMax,
      yMax: seriousMax,
      pointClass: "serious"
    },
    {
      titleKey: "populationScatter.fatalVsSeriousTitle",
      xMetric: "serious",
      yMetric: "fatal",
      xMax: seriousMax,
      yMax: fatalMax,
      pointClass: "comparison"
    }
  ];
  container.innerHTML = `
    <div class="population-scatter-size-legend">${escapeHtml(tr("populationScatter.sizeLegend"))}</div>
    <div class="population-scatter-plots">
      ${charts.map((chart) => renderPopulationScatterChart(rows, chart)).join("")}
    </div>
  `;
}

function renderPopulationScatterChart(rows: PopulationRateRow[], config: PopulationScatterChartConfig): string {
  const regression = populationScatterRegression(rows, config);
  const correlationLabel = scatterCorrelationLabel(regression?.correlation);
  return `
    <section class="population-scatter-chart">
      <h3><span>${escapeHtml(tr(config.titleKey))}</span>${correlationLabel}</h3>
      ${renderPopulationScatterSvg(rows, config, regression)}
    </section>
  `;
}

function renderPopulationScatterSvg(
  rows: PopulationRateRow[],
  config: PopulationScatterChartConfig,
  regression: ScatterRegression | null
): string {
  const width = 760;
  const height = 420;
  const chart = { left: 62, right: 22, top: 20, bottom: 350 };
  const chartWidth = width - chart.left - chart.right;
  const chartHeight = chart.bottom - chart.top;
  const xTicks = uniqueNumbers([0, config.xMax / 2, config.xMax]).sort((a, b) => a - b);
  const yTicks = uniqueNumbers([0, config.yMax / 2, config.yMax]).sort((a, b) => a - b);
  const populations = rows.map((row) => row.population);
  const minPopulation = Math.min(...populations);
  const maxPopulation = Math.max(...populations);
  const xForRate = (rate: number) => chart.left + (rate / config.xMax) * chartWidth;
  const yForRate = (rate: number) => chart.bottom - (rate / config.yMax) * chartHeight;
  const xAxisTicks = xTicks
    .map((rate) => {
      const x = xForRate(rate);
      return `
        <line class="population-scatter-grid-line" x1="${round(x, 1)}" y1="${chart.top}" x2="${round(x, 1)}" y2="${chart.bottom}"></line>
        <text class="population-scatter-tick" x="${round(x, 1)}" y="${chart.bottom + 19}" text-anchor="middle">${formatRate(rate)}</text>
      `;
    })
    .join("");
  const yAxisTicks = yTicks
    .map((rate) => {
      const y = yForRate(rate);
      return `
        <line class="population-scatter-grid-line" x1="${chart.left}" y1="${round(y, 1)}" x2="${width - chart.right}" y2="${round(y, 1)}"></line>
        <text class="population-scatter-tick" x="${chart.left - 10}" y="${round(y + 4, 1)}" text-anchor="end">${formatRate(rate)}</text>
      `;
    })
    .join("");
  const trend = renderScatterTrend(regression, config, xForRate, yForRate);
  const points = [...rows]
    .sort((a, b) => b.population - a.population)
    .map((row) => {
      const xRate = populationScatterMetricValue(row, config.xMetric);
      const yRate = populationScatterMetricValue(row, config.yMetric);
      const label = populationScatterPointLabel(row, config);
      return `
        <circle class="population-scatter-point population-scatter-point-${config.pointClass}" cx="${round(xForRate(xRate), 1)}" cy="${round(yForRate(yRate), 1)}" r="${round(populationScatterRadius(row.population, minPopulation, maxPopulation), 1)}" tabindex="0" aria-label="${escapeHtml(label)}">
          <title>${escapeHtml(label)}</title>
        </circle>
      `;
    })
    .join("");
  const ariaLabel = `${tr(config.titleKey)}: ${tr("populationScatter.sizeLegend")}`;

  return `
    <svg class="population-scatter-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
      ${xAxisTicks}
      ${yAxisTicks}
      <line class="population-scatter-axis" x1="${chart.left}" y1="${chart.top}" x2="${chart.left}" y2="${chart.bottom}"></line>
      <line class="population-scatter-axis" x1="${chart.left}" y1="${chart.bottom}" x2="${width - chart.right}" y2="${chart.bottom}"></line>
      ${trend}
      ${points}
      <text class="population-scatter-axis-label" x="${chart.left + chartWidth / 2}" y="${height - 10}" text-anchor="middle">${escapeHtml(populationScatterAxisLabel(config.xMetric))}</text>
      <text class="population-scatter-axis-label" x="16" y="${chart.top + chartHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${chart.top + chartHeight / 2})">${escapeHtml(populationScatterAxisLabel(config.yMetric))}</text>
    </svg>
  `;
}

function renderSeverityCorrelationComparison(container: HTMLElement, rows: SeverityCorrelationRow[], hasResult: boolean): void {
  if (!hasResult || rows.length === 0) {
    container.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("severityCorrelation.empty"))}</p>`;
    return;
  }

  const severityMax = niceSeverityPercentChartMax(Math.max(...rows.map((row) => row.severityPercent * 100)));
  const fatalMax = niceRateChartMax(Math.max(...rows.map((row) => row.fatalRate)));
  const severeMax = niceRateChartMax(Math.max(...rows.map((row) => row.severeRate)));
  const charts: SeverityCorrelationChartConfig[] = [
    {
      titleKey: "severityCorrelation.fatalTitle",
      yMetric: "fatal",
      xMax: severityMax,
      yMax: fatalMax,
      pointClass: "fatal"
    },
    {
      titleKey: "severityCorrelation.severeTitle",
      yMetric: "severe",
      xMax: severityMax,
      yMax: severeMax,
      pointClass: "severe"
    }
  ];
  container.innerHTML = `
    <div class="population-scatter-size-legend">${escapeHtml(tr("severityCorrelation.sizeLegend"))}</div>
    <div class="population-scatter-plots">
      ${charts.map((chart) => renderSeverityCorrelationChart(rows, chart)).join("")}
    </div>
  `;
}

function renderSeverityCorrelationChart(rows: SeverityCorrelationRow[], config: SeverityCorrelationChartConfig): string {
  const regression = severityCorrelationRegression(rows, config.yMetric);
  const correlationLabel = scatterCorrelationLabel(regression?.correlation);
  return `
    <section class="population-scatter-chart">
      <h3><span>${escapeHtml(tr(config.titleKey))}</span>${correlationLabel}</h3>
      ${renderSeverityCorrelationSvg(rows, config, regression)}
    </section>
  `;
}

function renderSeverityCorrelationSvg(
  rows: SeverityCorrelationRow[],
  config: SeverityCorrelationChartConfig,
  regression: ScatterRegression | null
): string {
  const width = 760;
  const height = 420;
  const chart = { left: 62, right: 22, top: 20, bottom: 350 };
  const chartWidth = width - chart.left - chart.right;
  const chartHeight = chart.bottom - chart.top;
  const xTicks = uniqueNumbers([0, config.xMax / 2, config.xMax]).sort((a, b) => a - b);
  const yTicks = uniqueNumbers([0, config.yMax / 2, config.yMax]).sort((a, b) => a - b);
  const populations = rows.map((row) => row.population);
  const minPopulation = Math.min(...populations);
  const maxPopulation = Math.max(...populations);
  const xForPercent = (percent: number) => chart.left + (percent / config.xMax) * chartWidth;
  const yForRate = (rate: number) => chart.bottom - (rate / config.yMax) * chartHeight;
  const xAxisTicks = xTicks
    .map((percent) => {
      const x = xForPercent(percent);
      return `
        <line class="population-scatter-grid-line" x1="${round(x, 1)}" y1="${chart.top}" x2="${round(x, 1)}" y2="${chart.bottom}"></line>
        <text class="population-scatter-tick" x="${round(x, 1)}" y="${chart.bottom + 19}" text-anchor="middle">${formatSeverityAxisPercent(percent)}</text>
      `;
    })
    .join("");
  const yAxisTicks = yTicks
    .map((rate) => {
      const y = yForRate(rate);
      return `
        <line class="population-scatter-grid-line" x1="${chart.left}" y1="${round(y, 1)}" x2="${width - chart.right}" y2="${round(y, 1)}"></line>
        <text class="population-scatter-tick" x="${chart.left - 10}" y="${round(y + 4, 1)}" text-anchor="end">${formatRate(rate)}</text>
      `;
    })
    .join("");
  const trend = renderScatterTrend(regression, config, xForPercent, yForRate);
  const points = [...rows]
    .sort((a, b) => b.population - a.population)
    .map((row) => {
      const xPercent = row.severityPercent * 100;
      const yRate = severityCorrelationMetricValue(row, config.yMetric);
      const label = severityCorrelationPointLabel(row, config);
      return `
        <circle class="population-scatter-point population-scatter-point-${config.pointClass}" cx="${round(xForPercent(xPercent), 1)}" cy="${round(yForRate(yRate), 1)}" r="${round(populationScatterRadius(row.population, minPopulation, maxPopulation), 1)}" tabindex="0" aria-label="${escapeHtml(label)}">
          <title>${escapeHtml(label)}</title>
        </circle>
      `;
    })
    .join("");
  const ariaLabel = `${tr(config.titleKey)}: ${tr("severityCorrelation.sizeLegend")}`;

  return `
    <svg class="population-scatter-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
      ${xAxisTicks}
      ${yAxisTicks}
      <line class="population-scatter-axis" x1="${chart.left}" y1="${chart.top}" x2="${chart.left}" y2="${chart.bottom}"></line>
      <line class="population-scatter-axis" x1="${chart.left}" y1="${chart.bottom}" x2="${width - chart.right}" y2="${chart.bottom}"></line>
      ${trend}
      ${points}
      <text class="population-scatter-axis-label" x="${chart.left + chartWidth / 2}" y="${height - 10}" text-anchor="middle">${escapeHtml(tr("severityCorrelation.xAxis"))}</text>
      <text class="population-scatter-axis-label" x="16" y="${chart.top + chartHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${chart.top + chartHeight / 2})">${escapeHtml(severityCorrelationYAxisLabel(config.yMetric))}</text>
    </svg>
  `;
}

function renderScatterTrend(
  regression: ScatterRegression | null,
  config: { xMax: number; yMax: number },
  xForValue: (value: number) => number,
  yForRate: (rate: number) => number
): string {
  if (!regression) {
    return "";
  }
  const x1Value = clampNumber(regression.minX, 0, config.xMax);
  const x2Value = clampNumber(regression.maxX, 0, config.xMax);
  const y1Rate = clampNumber(regression.intercept + regression.slope * x1Value, 0, config.yMax);
  const y2Rate = clampNumber(regression.intercept + regression.slope * x2Value, 0, config.yMax);
  return `
    <line class="population-scatter-trend" x1="${round(xForValue(x1Value), 1)}" y1="${round(yForRate(y1Rate), 1)}" x2="${round(xForValue(x2Value), 1)}" y2="${round(yForRate(y2Rate), 1)}">
      <title>${escapeHtml(tr("severityCorrelation.trend"))}</title>
    </line>
  `;
}

function scatterCorrelationLabel(correlation: number | null | undefined): string {
  if (correlation === null || correlation === undefined) {
    return "";
  }
  return `<span class="population-scatter-correlation">${escapeHtml(trf("severityCorrelation.correlation", { value: formatCorrelation(correlation) }))}</span>`;
}

function populationScatterMetricValue(row: PopulationRateRow, metric: PopulationScatterMetric): number {
  if (metric === "fatal") {
    return row.fatalRate;
  }
  if (metric === "serious") {
    return row.seriousRate;
  }
  return row.totalRate;
}

function populationScatterAxisLabel(metric: PopulationScatterMetric): string {
  if (metric === "fatal") {
    return tr("populationRate.fatal");
  }
  if (metric === "serious") {
    return tr("populationRate.serious");
  }
  return tr("populationRate.total");
}

function populationScatterPointLabel(row: PopulationRateRow, config: PopulationScatterChartConfig): string {
  const areaLabel = row.secondaryLabel ? `${row.name}, ${row.secondaryLabel}` : row.name;
  const xRate = populationScatterMetricValue(row, config.xMetric);
  const yRate = populationScatterMetricValue(row, config.yMetric);
  return `${areaLabel}: ${formatRate(xRate)} ${populationScatterAxisLabel(config.xMetric)}, ${formatRate(yRate)} ${populationScatterAxisLabel(config.yMetric)}, ${tr("populationRate.population")}: ${formatInteger(row.population)}`;
}

function populationScatterRegression(rows: PopulationRateRow[], config: PopulationScatterChartConfig): ScatterRegression | null {
  if (rows.length < 2) {
    return null;
  }

  const points = rows.map((row) => ({
    x: populationScatterMetricValue(row, config.xMetric),
    y: populationScatterMetricValue(row, config.yMetric)
  }));
  return scatterRegression(points);
}

function populationScatterRadius(population: number, minPopulation: number, maxPopulation: number): number {
  if (maxPopulation <= minPopulation) {
    return 9;
  }
  const minSqrt = Math.sqrt(minPopulation);
  const maxSqrt = Math.sqrt(maxPopulation);
  const normalized = (Math.sqrt(population) - minSqrt) / (maxSqrt - minSqrt);
  return 5 + normalized * 12;
}

function severityCorrelationRows(
  summaries: PopulationAccidentSummary[],
  showStateLabel: boolean,
  severityForSummary: (summary: PopulationAccidentSummary) => number | null
): SeverityCorrelationRow[] {
  return summaries
    .map((summary): SeverityCorrelationRow | null => {
      const severityPercent = severityForSummary(summary);
      if (
        typeof summary.population !== "number" ||
        summary.population <= 0 ||
        summary.accidentCount <= 0 ||
        typeof severityPercent !== "number" ||
        !Number.isFinite(severityPercent)
      ) {
        return null;
      }
      const population = summary.population;
      const name = cleanAreaNameForDisplay(summary.name);
      const secondaryLabel = showStateLabel && name !== summary.stateName ? summary.stateName : null;
      return {
        name,
        secondaryLabel,
        population,
        severityPercent,
        fatalRate: accidentRate(summary.fatalCount, population),
        severeRate: accidentRate(summary.fatalCount + summary.seriousCount, population)
      };
    })
    .filter((row): row is SeverityCorrelationRow => row !== null)
    .sort(compareSeverityCorrelationRows);
}

function compareSeverityCorrelationRows(a: SeverityCorrelationRow, b: SeverityCorrelationRow): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.severeRate - a.severeRate ||
    b.fatalRate - a.fatalRate ||
    a.name.localeCompare(b.name, "de", { sensitivity: "base" })
  );
}

function severityCorrelationMetricValue(row: SeverityCorrelationRow, metric: SeverityCorrelationMetric): number {
  return metric === "fatal" ? row.fatalRate : row.severeRate;
}

function severityCorrelationYAxisLabel(metric: SeverityCorrelationMetric): string {
  return metric === "fatal" ? tr("severityCorrelation.fatalYAxis") : tr("severityCorrelation.severeYAxis");
}

function severityCorrelationPointLabel(row: SeverityCorrelationRow, config: SeverityCorrelationChartConfig): string {
  const areaLabel = row.secondaryLabel ? `${row.name}, ${row.secondaryLabel}` : row.name;
  return `${areaLabel}: ${tr("metric.severityPercent")}: ${formatSeverityPercent(row)}, ${severityCorrelationYAxisLabel(config.yMetric)}: ${formatRate(severityCorrelationMetricValue(row, config.yMetric))}, ${tr("populationRate.population")}: ${formatInteger(row.population)}`;
}

function severityCorrelationRegression(rows: SeverityCorrelationRow[], metric: SeverityCorrelationMetric): ScatterRegression | null {
  if (rows.length < 2) {
    return null;
  }

  const points = rows.map((row) => ({
    x: row.severityPercent * 100,
    y: severityCorrelationMetricValue(row, metric)
  }));
  return scatterRegression(points);
}

function scatterRegression(points: Array<{ x: number; y: number }>): ScatterRegression | null {
  if (points.length < 2) {
    return null;
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sumXX += dx * dx;
    sumXY += dx * dy;
    sumYY += dy * dy;
  }
  if (sumXX <= 0) {
    return null;
  }

  return {
    slope: sumXY / sumXX,
    intercept: meanY - (sumXY / sumXX) * meanX,
    correlation: sumYY > 0 ? sumXY / Math.sqrt(sumXX * sumYY) : null,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x))
  };
}

function niceSeverityPercentChartMax(maxPercent: number): number {
  return Math.min(100, Math.max(10, niceRateChartMax(maxPercent)));
}

function formatSeverityAxisPercent(value: number): string {
  return `${formatRate(value)}%`;
}

function renderPopulationRateComparison(
  container: HTMLElement,
  summaries: PopulationAccidentSummary[],
  showStateLabel: boolean,
  hasResult: boolean
): void {
  const rows = populationRateRows(summaries, showStateLabel);
  if (!hasResult || rows.length === 0) {
    container.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("populationRate.empty"))}</p>`;
    return;
  }

  const maxTotalRate = Math.max(1, ...rows.map((row) => row.totalRate));
  container.innerHTML = `
    ${renderPopulationRateLegend()}
    <div class="population-rate-table" role="table">
      <div class="population-rate-row population-rate-row-header" role="row">
        <div role="columnheader">${escapeHtml(tr("populationRate.area"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.outcomeMix"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.total"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.fatal"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.serious"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.other"))}</div>
        <div role="columnheader">${escapeHtml(tr("populationRate.population"))}</div>
      </div>
      ${rows.map((row) => renderPopulationRateRow(row, maxTotalRate)).join("")}
    </div>
  `;
}

function populationRateRows(summaries: PopulationAccidentSummary[], showStateLabel: boolean): PopulationRateRow[] {
  return summaries
    .filter((summary) => typeof summary.population === "number" && summary.population > 0 && summary.accidentCount > 0)
    .map((summary) => {
      const population = summary.population as number;
      const otherCount = Math.max(0, summary.accidentCount - summary.fatalCount - summary.seriousCount);
      const name = cleanAreaNameForDisplay(summary.name);
      const secondaryLabel = showStateLabel && name !== summary.stateName ? summary.stateName : null;
      return {
        name,
        secondaryLabel,
        population,
        totalRate: accidentRate(summary.accidentCount, population),
        fatalRate: accidentRate(summary.fatalCount, population),
        seriousRate: accidentRate(summary.seriousCount, population),
        otherRate: accidentRate(otherCount, population)
      };
    })
    .sort(comparePopulationRateRows);
}

function comparePopulationRateRows(a: PopulationRateRow, b: PopulationRateRow): number {
  return (
    b.totalRate - a.totalRate ||
    b.fatalRate - a.fatalRate ||
    b.seriousRate - a.seriousRate ||
    a.name.localeCompare(b.name, "de", { sensitivity: "base" })
  );
}

function renderPopulationRateLegend(): string {
  return `
    <div class="population-rate-legend" aria-hidden="true">
      <span class="population-rate-legend-item"><span class="population-rate-swatch population-rate-fatal"></span>${escapeHtml(tr("severity.fatal"))}</span>
      <span class="population-rate-legend-item"><span class="population-rate-swatch population-rate-serious"></span>${escapeHtml(tr("severity.serious"))}</span>
      <span class="population-rate-legend-item"><span class="population-rate-swatch population-rate-other"></span>${escapeHtml(tr("severity.other"))}</span>
    </div>
  `;
}

function renderPopulationRateRow(row: PopulationRateRow, maxTotalRate: number): string {
  const title = `${row.name}: ${formatRate(row.totalRate)} ${tr("populationRate.total")}, ${formatRate(row.fatalRate)} ${tr("populationRate.fatal")}, ${formatRate(row.seriousRate)} ${tr("populationRate.serious")}, ${formatRate(row.otherRate)} ${tr("populationRate.other")}`;
  return `
    <div class="population-rate-row" role="row">
      <div class="population-rate-area" role="cell">
        <strong>${escapeHtml(row.name)}</strong>
        ${row.secondaryLabel ? `<span>${escapeHtml(row.secondaryLabel)}</span>` : ""}
      </div>
      <div class="population-rate-bar-cell" role="cell">
        <div class="population-rate-bar-track" title="${escapeHtml(title)}">
          ${populationRateSegment("fatal", row.fatalRate, maxTotalRate)}
          ${populationRateSegment("serious", row.seriousRate, maxTotalRate)}
          ${populationRateSegment("other", row.otherRate, maxTotalRate)}
        </div>
      </div>
      <div class="population-rate-number population-rate-total" role="cell">${formatRate(row.totalRate)}</div>
      <div class="population-rate-number" role="cell">${formatRate(row.fatalRate)}</div>
      <div class="population-rate-number" role="cell">${formatRate(row.seriousRate)}</div>
      <div class="population-rate-number" role="cell">${formatRate(row.otherRate)}</div>
      <div class="population-rate-number" role="cell">${formatCompactPopulation(row.population)}</div>
    </div>
  `;
}

function populationRateSegment(kind: "fatal" | "serious" | "other", rate: number, maxTotalRate: number): string {
  if (rate <= 0) {
    return "";
  }
  const width = Math.max(0, Math.min(100, (rate / maxTotalRate) * 100));
  return `<span class="population-rate-segment population-rate-${kind}" style="width: ${round(width, 2)}%; min-width: 2px"></span>`;
}

function accidentRate(count: number, population: number): number {
  return (count / population) * POPULATION_RATE_DENOMINATOR;
}

function niceRateChartMax(maxRate: number): number {
  if (!Number.isFinite(maxRate) || maxRate <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(maxRate));
  const scaled = maxRate / magnitude;
  const niceScaled = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return niceScaled * magnitude;
}

function renderRankChart(
  container: HTMLElement,
  result: AnalysisResult | null,
  series: RankChartSeries[],
  emptyKey: string,
  ariaLabelKey: string
): void {
  if (!result || result.clusters.length === 0 || series.length === 0) {
    container.innerHTML = `<p class="state-rank-chart-empty">${escapeHtml(tr(emptyKey))}</p>`;
    return;
  }

  container.innerHTML = `
    ${renderRankChartSvg(series, ariaLabelKey)}
    <div class="state-rank-chart-tooltip" role="tooltip" hidden></div>
    ${renderRankChartLegend(series)}
  `;
}

function stateRankChartSeries(clusters: IntersectionCluster[]): RankChartSeries[] {
  const byState = new Map<string, RankChartSeries>();
  for (const cluster of clusters) {
    const stateSeries =
      byState.get(cluster.stateCode) ??
      ({
        id: cluster.stateCode,
        name: cluster.stateName ?? STATE_NAMES[cluster.stateCode] ?? cluster.stateCode,
        color: stateRankChartColor(cluster.stateCode),
        clusters: []
      } satisfies RankChartSeries);
    if (stateSeries.clusters.length < STATE_RANK_CHART_MAX_RANK) {
      stateSeries.clusters.push(cluster);
    }
    byState.set(cluster.stateCode, stateSeries);
  }

  return Array.from(byState.values()).sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
}

function regionRankChartSeries(regionSummaries: RegionSummary[]): RankChartSeries[] {
  return regionSummaries.map((summary, index) => ({
    id: summary.key,
    name: `${summary.regionName}, ${summary.stateName}`,
    tooltip: regionTooltipLabel(summary),
    color: rankChartColor(index),
    clusters: summary.clusters.slice(0, STATE_RANK_CHART_MAX_RANK)
  }));
}

function renderRankChartSvg(series: RankChartSeries[], ariaLabelKey: string): string {
  const width = 760;
  const height = 600;
  const chart = { left: 54, right: 20, top: 28, bottom: 520 };
  const chartWidth = width - chart.left - chart.right;
  const chartHeight = chart.bottom - chart.top;
  const chartSeries = series.map((item) => ({
    ...item,
    points: rankChartPoints(item.clusters)
  }));
  const maxSeverity = Math.max(1, ...chartSeries.flatMap((item) => item.points.map((point) => point.severityPercent)));
  const yMax = niceSeverityChartMax(maxSeverity);
  const xTicks = [1, 10, 100, 1000];
  const yTicks = uniqueNumbers([0, yMax / 2, yMax].map((value) => Math.round(value))).sort((a, b) => a - b);
  const xForRank = (rank: number) => chart.left + (Math.log10(Math.max(1, rank)) / Math.log10(STATE_RANK_CHART_MAX_RANK)) * chartWidth;
  const yForSeverity = (severityPercent: number) => chart.bottom - (severityPercent / yMax) * chartHeight;
  const xAxisTicks = xTicks
    .map((rank) => {
      const x = xForRank(rank);
      return `
        <line class="state-rank-chart-grid" x1="${round(x, 1)}" y1="${chart.top}" x2="${round(x, 1)}" y2="${chart.bottom}"></line>
        <text class="state-rank-chart-tick" x="${round(x, 1)}" y="${chart.bottom + 21}" text-anchor="middle">${rank}</text>
      `;
    })
    .join("");
  const yAxisTicks = yTicks
    .map((severity) => {
      const y = yForSeverity(severity);
      return `
        <line class="state-rank-chart-grid" x1="${chart.left}" y1="${round(y, 1)}" x2="${width - chart.right}" y2="${round(y, 1)}"></line>
        <text class="state-rank-chart-tick" x="${chart.left - 10}" y="${round(y + 4, 1)}" text-anchor="end">${formatInteger(severity)}</text>
      `;
    })
    .join("");
  const lines = chartSeries
    .map((item) => {
      const points = item.points.map((point) => ({
        x: xForRank(point.rank),
        y: yForSeverity(point.severityPercent)
      }));
      const path = linePath(points);
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1] ?? firstPoint;
      const dots =
        points.length === 1
          ? `<circle class="state-rank-chart-dot" cx="${round(firstPoint.x, 1)}" cy="${round(firstPoint.y, 1)}" r="3.5" style="--series-color: ${item.color}"></circle>`
          : `
            <circle class="state-rank-chart-dot" cx="${round(firstPoint.x, 1)}" cy="${round(firstPoint.y, 1)}" r="3" style="--series-color: ${item.color}"></circle>
            <circle class="state-rank-chart-dot" cx="${round(lastPoint.x, 1)}" cy="${round(lastPoint.y, 1)}" r="3" style="--series-color: ${item.color}"></circle>
          `;
      const tooltipAttribute = item.tooltip ? ` data-series-tooltip="${escapeHtml(item.tooltip)}"` : "";
      return `
        <g class="state-rank-chart-series" data-rank-chart-series="true" data-series-name="${escapeHtml(item.name)}"${tooltipAttribute} tabindex="0" aria-label="${escapeHtml(item.name)}" style="--series-color: ${item.color}">
          <title>${escapeHtml(item.name)}</title>
          ${path ? `<path class="state-rank-chart-hit-line" d="${path}"></path><path class="state-rank-chart-line" d="${path}"></path>` : ""}
          ${dots}
        </g>
      `;
    })
    .join("");

  return `
    <svg class="state-rank-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(tr(ariaLabelKey))}">
      ${xAxisTicks}
      ${yAxisTicks}
      <line class="state-rank-chart-axis" x1="${chart.left}" y1="${chart.top}" x2="${chart.left}" y2="${chart.bottom}"></line>
      <line class="state-rank-chart-axis" x1="${chart.left}" y1="${chart.bottom}" x2="${width - chart.right}" y2="${chart.bottom}"></line>
      ${lines}
      <text class="state-rank-chart-axis-label" x="${chart.left + chartWidth / 2}" y="${height - 9}" text-anchor="middle">${escapeHtml(tr("stateChart.xAxis"))}</text>
      <text class="state-rank-chart-axis-label" x="16" y="${chart.top + chartHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${chart.top + chartHeight / 2})">${escapeHtml(tr("stateChart.yAxis"))}</text>
    </svg>
  `;
}

function rankChartPoints(clusters: IntersectionCluster[]): RankChartPoint[] {
  let runningSeverity = 0;
  const sampledRanks = rankChartSampleRanks(clusters.length);
  const sampledRankSet = new Set(sampledRanks);
  const points: RankChartPoint[] = [];

  for (let index = 0; index < clusters.length && index < STATE_RANK_CHART_MAX_RANK; index += 1) {
    const rank = index + 1;
    runningSeverity += clusters[index].severityPercent * 100;
    if (sampledRankSet.has(rank)) {
      points.push({
        rank,
        severityPercent: runningSeverity / rank
      });
    }
  }

  return points;
}

function rankChartSampleRanks(clusterCount: number): number[] {
  const maxRank = Math.min(clusterCount, STATE_RANK_CHART_MAX_RANK);
  if (maxRank <= 0) {
    return [];
  }

  const ranks = STATE_RANK_CHART_SAMPLE_RANKS.filter((rank) => rank <= maxRank);
  if (ranks[ranks.length - 1] !== maxRank) {
    ranks.push(maxRank);
  }
  return ranks;
}

function renderRankChartLegend(series: RankChartSeries[]): string {
  const legend = series
    .map(
      (item) => `
        <span class="state-rank-chart-legend-item">
          <span class="state-rank-chart-swatch" style="--series-color: ${item.color}"></span>
          ${escapeHtml(item.name)}
        </span>
      `
    )
    .join("");

  return `
    <div class="state-rank-chart-legend">${legend}</div>
  `;
}

function niceSeverityChartMax(maxSeverity: number): number {
  if (maxSeverity <= 5) {
    return 5;
  }
  if (maxSeverity <= 20) {
    return Math.ceil(maxSeverity / 5) * 5;
  }
  return Math.min(100, Math.ceil(maxSeverity / 10) * 10);
}

function stateRankChartColor(stateCode: string): string {
  const stateCodes = Object.keys(STATE_NAMES).sort();
  const index = Math.max(0, stateCodes.indexOf(stateCode));
  return rankChartColor(index);
}

function rankChartColor(index: number): string {
  return STATE_RANK_CHART_COLORS[index % STATE_RANK_CHART_COLORS.length];
}

function regionSummaries(context: StateRegionViewRenderContext): RegionSummary[] {
  return context.getRegionSummaries();
}

function regionTooltipLabel(region: RegionSummary): string {
  const name = `${region.regionName}, ${region.stateName}`;
  return region.population === null ? name : `${name} - ${tr("metric.population")}: ${formatInteger(region.population)}`;
}
