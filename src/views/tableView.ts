import { clusterLocation, clusterLocationText, compareClusterCoreMetric, renderOsmBooleanBadge } from "../domain/clusterDisplay";
import { formatInteger, formatSeverityPercent } from "../shared/formatting";
import { escapeHtml } from "../shared/html";
import { tr, trf } from "../shared/i18n";
import type { AnalysisResult, IntersectionCluster } from "../domain/types";

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

export interface TableViewDependencies {
  body: HTMLTableSectionElement;
  getResult: () => AnalysisResult | null;
  getStateFilterValue: () => string;
  selectCluster: (cluster: IntersectionCluster) => void;
}

const TABLE_ROWS_PER_STATE = 10;

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
