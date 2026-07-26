import { clusterLocation, clusterLocationText, compareClusterCoreMetric, renderOsmBooleanBadge } from "../clusterDisplay";
import { formatInteger, formatRate, formatSeverityPercent, type SeverityPercentSource } from "../formatting";
import { escapeHtml } from "../html";
import { tr, trf } from "../i18n";
import { clampNumber, round } from "../math";
import type { AnalysisResult, IntersectionCluster } from "../types";

type ClusterSortKey =
  | "state"
  | "location"
  | "accidents"
  | "fatal"
  | "serious"
  | "roundabout"
  | "trafficSignal"
  | "severityPercent";
type SortDirection = "asc" | "desc";

interface ClusterTableSort {
  key: ClusterSortKey;
  direction: SortDirection;
}

export interface IntersectionFeatureSummaryRow extends SeverityPercentSource {
  id: string;
  label: string;
  clusterCount: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  weightedSeverityPercent: number;
  sortOrder: number;
}

interface IntersectionFeatureRow extends IntersectionFeatureSummaryRow {}

interface IntersectionFeatureAccumulator {
  id: string;
  label: string;
  clusterCount: number;
  accidentCount: number;
  fatalCount: number;
  seriousCount: number;
  weightedSeverityPercent: number;
  sortOrder: number;
}

export interface TableViewDependencies {
  body: HTMLTableSectionElement;
  featureSummary: HTMLElement;
  getResult: () => AnalysisResult | null;
  getStateFilterValue: () => string;
  selectCluster: (cluster: IntersectionCluster) => void;
}

const TABLE_ROWS_PER_STATE = 10;
const INTERSECTION_FEATURE_MIN_POPULATION = 1;
const INTERSECTION_FEATURE_POPULATION_BUCKETS = [
  { id: "under10k", maxExclusive: 10_000, labelKey: "intersectionFeature.populationUnder10k" },
  { id: "10k50k", maxExclusive: 50_000, labelKey: "intersectionFeature.population10k50k" },
  { id: "50k100k", maxExclusive: 100_000, labelKey: "intersectionFeature.population50k100k" },
  { id: "100k500k", maxExclusive: 500_000, labelKey: "intersectionFeature.population100k500k" },
  { id: "500kPlus", maxExclusive: Number.POSITIVE_INFINITY, labelKey: "intersectionFeature.population500kPlus" }
] as const;

export class TableView {
  private sort: ClusterTableSort = { key: "severityPercent", direction: "desc" };
  private renderedResult: AnalysisResult | null | undefined;

  constructor(private readonly deps: TableViewDependencies) {}

  bindSortEvents(root: ParentNode = document): void {
    for (const button of this.clusterSortButtons(root)) {
      button.addEventListener("click", () => {
        const key = button.dataset.clusterSort as ClusterSortKey | undefined;
        if (!key) {
          return;
        }
        this.sort =
          this.sort.key === key
            ? { key, direction: this.sort.direction === "asc" ? "desc" : "asc" }
            : { key, direction: this.defaultClusterSortDirection(key) };
        this.invalidate();
        this.render();
      });
    }
  }

  invalidate(): void {
    this.renderedResult = undefined;
  }

  render(): void {
    const result = this.deps.getResult();
    if (this.renderedResult === result) {
      return;
    }
    this.renderedResult = result;
    this.updateSortHeaders();
    this.renderIntersectionFeatureSummary(result);
    this.deps.body.innerHTML = "";
    if (!result) {
      return;
    }

    for (const cluster of this.clustersForTable(result.clusters)) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.innerHTML = `
        <td>${escapeHtml(cluster.stateName)}</td>
        <td>${clusterLocation(cluster)}</td>
        <td>${formatInteger(cluster.accidentCount)}</td>
        <td>${formatInteger(cluster.fatalCount)}</td>
        <td>${formatInteger(cluster.seriousCount)}</td>
        <td>${renderOsmBooleanBadge(cluster.osmRoundabout)}</td>
        <td>${renderOsmBooleanBadge(cluster.osmTrafficSignal)}</td>
        <td>${formatSeverityPercent(cluster)}</td>
      `;
      row.addEventListener("click", () => {
        this.deps.selectCluster(cluster);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          this.deps.selectCluster(cluster);
        }
      });
      this.deps.body.append(row);
    }
  }

  private renderIntersectionFeatureSummary(result: AnalysisResult | null): void {
    const clusters = result?.clusters ?? [];
    if (!result || clusters.length === 0) {
      this.deps.featureSummary.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("intersectionFeature.empty"))}</p>`;
      return;
    }

    const rows = this.populationIntersectionFeatureRows(clusters);
    if (rows.length === 0) {
      this.deps.featureSummary.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("intersectionFeature.empty"))}</p>`;
      return;
    }

    this.deps.featureSummary.innerHTML = this.renderIntersectionFeatureSection(rows);
  }

  private populationIntersectionFeatureRows(clusters: IntersectionCluster[]): IntersectionFeatureRow[] {
    const accumulators = new Map<string, IntersectionFeatureAccumulator>();
    INTERSECTION_FEATURE_POPULATION_BUCKETS.forEach((bucket, index) => {
      accumulators.set(bucket.id, this.createIntersectionFeatureAccumulator(bucket.id, tr(bucket.labelKey), index));
    });

    for (const cluster of clusters) {
      const bucket = this.intersectionFeaturePopulationBucket(cluster);
      if (!bucket) {
        continue;
      }
      this.addClusterToIntersectionFeatureAccumulator(accumulators.get(bucket.id), cluster);
    }

    return this.finalizeIntersectionFeatureRows(Array.from(accumulators.values()));
  }

  private intersectionFeaturePopulationBucket(cluster: IntersectionCluster): (typeof INTERSECTION_FEATURE_POPULATION_BUCKETS)[number] | null {
    const population = cluster.municipalityPopulation ?? cluster.administrativeRegionPopulation;
    if (typeof population !== "number" || population < INTERSECTION_FEATURE_MIN_POPULATION) {
      return null;
    }
    return INTERSECTION_FEATURE_POPULATION_BUCKETS.find((bucket) => population < bucket.maxExclusive) ?? null;
  }

  private createIntersectionFeatureAccumulator(id: string, label: string, sortOrder: number): IntersectionFeatureAccumulator {
    return {
      id,
      label,
      clusterCount: 0,
      accidentCount: 0,
      fatalCount: 0,
      seriousCount: 0,
      weightedSeverityPercent: 0,
      sortOrder
    };
  }

  private addClusterToIntersectionFeatureAccumulator(
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
  }

  private finalizeIntersectionFeatureRows(accumulators: IntersectionFeatureAccumulator[]): IntersectionFeatureRow[] {
    return accumulators
      .filter((row) => row.clusterCount > 0)
      .map((row) => ({
        ...row,
        severityPercent: row.accidentCount > 0 ? row.weightedSeverityPercent / row.accidentCount : 0
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  renderIntersectionFeatureSection(rows: readonly IntersectionFeatureSummaryRow[]): string {
    const maxSeverityPercent = Math.max(0.1, ...rows.map((row) => this.intersectionFeatureSeverityPercent(row)));
    const maxTotalPerIntersection = Math.max(1, ...rows.map((row) => this.intersectionFeatureTotalPerIntersection(row)));
    const maxFatalPer100 = Math.max(1, ...rows.map((row) => this.intersectionFeatureFatalPer100(row)));
    const maxSeriousPer100 = Math.max(1, ...rows.map((row) => this.intersectionFeatureSeriousPer100(row)));
    return `
      <div class="intersection-feature-table" role="table">
        <div class="intersection-feature-row intersection-feature-row-header" role="row">
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.group"))}</div>
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.severity"))}</div>
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.fatalPer100"))}</div>
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.seriousPer100"))}</div>
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.totalPerIntersection"))}</div>
          <div role="columnheader">${escapeHtml(tr("intersectionFeature.total"))}</div>
        </div>
        ${rows
          .map((row) => this.renderIntersectionFeatureRow(row, maxSeverityPercent, maxTotalPerIntersection, maxFatalPer100, maxSeriousPer100))
          .join("")}
      </div>
    `;
  }

  private renderIntersectionFeatureRow(
    row: IntersectionFeatureRow,
    maxSeverityPercent: number,
    maxTotalPerIntersection: number,
    maxFatalPer100: number,
    maxSeriousPer100: number
  ): string {
    const severityPercent = this.intersectionFeatureSeverityPercent(row);
    const severityLabel = this.formatIntersectionFeatureSeverityPercent(row);
    const fatalPer100 = this.intersectionFeatureFatalPer100(row);
    const seriousPer100 = this.intersectionFeatureSeriousPer100(row);
    const totalPerIntersection = this.intersectionFeatureTotalPerIntersection(row);
    const title = `${row.label}: ${tr("intersectionFeature.severity")} ${severityLabel}, ${tr(
      "intersectionFeature.fatalPer100"
    )} ${formatRate(fatalPer100)}, ${tr("intersectionFeature.seriousPer100")} ${formatRate(
      seriousPer100
    )}, ${tr("intersectionFeature.totalPerIntersection")} ${formatRate(totalPerIntersection)}`;
    return `
      <div class="intersection-feature-row" role="row" title="${escapeHtml(title)}">
        <div class="intersection-feature-group" role="cell">
          <strong>${escapeHtml(row.label)}</strong>
          <span>${formatInteger(row.clusterCount)} ${escapeHtml(tr("intersectionFeature.intersections").toLowerCase())}</span>
        </div>
        <div role="cell">${this.renderIntersectionFeatureMetric(severityLabel, severityPercent, maxSeverityPercent, "severity")}</div>
        <div role="cell">${this.renderIntersectionFeatureMetric(formatRate(fatalPer100), fatalPer100, maxFatalPer100, "fatal")}</div>
        <div role="cell">${this.renderIntersectionFeatureMetric(formatRate(seriousPer100), seriousPer100, maxSeriousPer100, "serious")}</div>
        <div role="cell">${this.renderIntersectionFeatureMetric(formatRate(totalPerIntersection), totalPerIntersection, maxTotalPerIntersection, "total")}</div>
        <div class="intersection-feature-number intersection-feature-total" role="cell">${formatInteger(row.accidentCount)}</div>
      </div>
    `;
  }

  private renderIntersectionFeatureMetric(label: string, value: number, maxValue: number, kind: string): string {
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

  private intersectionFeatureSeverityPercent(row: IntersectionFeatureRow): number {
    return row.severityPercent * 100;
  }

  private formatIntersectionFeatureSeverityPercent(row: IntersectionFeatureRow): string {
    return `${formatRate(this.intersectionFeatureSeverityPercent(row))}%`;
  }

  private intersectionFeatureFatalPer100(row: IntersectionFeatureRow): number {
    return row.clusterCount > 0 ? (row.fatalCount / row.clusterCount) * 100 : 0;
  }

  private intersectionFeatureSeriousPer100(row: IntersectionFeatureRow): number {
    return row.clusterCount > 0 ? (row.seriousCount / row.clusterCount) * 100 : 0;
  }

  private intersectionFeatureTotalPerIntersection(row: IntersectionFeatureRow): number {
    return row.clusterCount > 0 ? row.accidentCount / row.clusterCount : 0;
  }

  private clustersForTable(clusters: IntersectionCluster[]): IntersectionCluster[] {
    if (this.deps.getStateFilterValue() !== "all") {
      return this.topSortedClusters(clusters, TABLE_ROWS_PER_STATE);
    }

    const selectedByState = new Map<string, IntersectionCluster[]>();
    for (const cluster of clusters) {
      const stateClusters = selectedByState.get(cluster.stateCode) ?? [];
      this.insertSortedCluster(stateClusters, cluster, TABLE_ROWS_PER_STATE, (a, b) => this.compareClustersForTable(a, b));
      selectedByState.set(cluster.stateCode, stateClusters);
    }
    return Array.from(selectedByState.values())
      .flat()
      .sort((a, b) => this.compareClustersForTable(a, b));
  }

  private topSortedClusters(clusters: IntersectionCluster[], limit: number): IntersectionCluster[] {
    const selected: IntersectionCluster[] = [];
    for (const cluster of clusters) {
      this.insertSortedCluster(selected, cluster, limit, (a, b) => this.compareClustersForTable(a, b));
    }
    return selected;
  }

  private insertSortedCluster(
    selected: IntersectionCluster[],
    cluster: IntersectionCluster,
    limit: number,
    comparator: (a: IntersectionCluster, b: IntersectionCluster) => number
  ): void {
    let index = 0;
    while (index < selected.length && comparator(selected[index], cluster) <= 0) {
      index += 1;
    }
    if (index >= limit) {
      return;
    }

    selected.splice(index, 0, cluster);
    if (selected.length > limit) {
      selected.length = limit;
    }
  }

  private compareClustersForTable(a: IntersectionCluster, b: IntersectionCluster): number {
    const primary = this.compareClusterSortValue(a, b, this.sort.key, this.sort.direction);
    return primary || compareClusterCoreMetric(a, b);
  }

  private compareClusterSortValue(
    a: IntersectionCluster,
    b: IntersectionCluster,
    key: ClusterSortKey,
    direction: SortDirection
  ): number {
    const aValue = this.clusterSortValue(a, key);
    const bValue = this.clusterSortValue(b, key);
    const aMissing = aValue === null || (typeof aValue === "number" && !Number.isFinite(aValue));
    const bMissing = bValue === null || (typeof bValue === "number" && !Number.isFinite(bValue));

    if (aMissing && bMissing) {
      return 0;
    }
    if (aMissing) {
      return 1;
    }
    if (bMissing) {
      return -1;
    }

    const comparison =
      typeof aValue === "string" && typeof bValue === "string"
        ? aValue.localeCompare(bValue, "de", { sensitivity: "base" })
        : Number(aValue) - Number(bValue);
    return direction === "asc" ? comparison : -comparison;
  }

  private clusterSortValue(cluster: IntersectionCluster, key: ClusterSortKey): number | string | null {
    switch (key) {
      case "state":
        return cluster.stateName;
      case "location":
        return clusterLocationText(cluster);
      case "accidents":
        return cluster.accidentCount;
      case "fatal":
        return cluster.fatalCount;
      case "serious":
        return cluster.seriousCount;
      case "roundabout":
        return this.osmBooleanSortValue(cluster.osmRoundabout);
      case "trafficSignal":
        return this.osmBooleanSortValue(cluster.osmTrafficSignal);
      case "severityPercent":
        return cluster.severityPercent;
    }
  }

  private osmBooleanSortValue(value: boolean | null | undefined): number | null {
    if (value === true) {
      return 1;
    }
    if (value === false) {
      return 0;
    }
    return null;
  }

  private defaultClusterSortDirection(key: ClusterSortKey): SortDirection {
    return key === "state" || key === "location" ? "asc" : "desc";
  }

  private updateSortHeaders(): void {
    for (const button of this.clusterSortButtons()) {
      const key = button.dataset.clusterSort as ClusterSortKey | undefined;
      const active = key === this.sort.key;
      const indicator = button.querySelector<HTMLElement>(".sort-indicator");
      const label = button.querySelector("span")?.textContent?.trim() ?? tr("table.location");
      const header = button.closest("th");
      button.classList.toggle("active", active);
      button.setAttribute(
        "aria-label",
        trf("table.sorted", {
          label,
          direction: active ? tr(this.sort.direction === "asc" ? "table.sort.asc" : "table.sort.desc") : tr("table.sort.none")
        })
      );
      if (indicator) {
        indicator.textContent = active ? (this.sort.direction === "asc" ? "^" : "v") : "";
      }
      if (header) {
        header.setAttribute("aria-sort", active ? (this.sort.direction === "asc" ? "ascending" : "descending") : "none");
      }
    }
  }

  private clusterSortButtons(root: ParentNode = document): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>("[data-cluster-sort]"));
  }
}
