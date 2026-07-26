import { renderIntersectionFeatureSection, type IntersectionFeatureSummaryRow } from "./intersectionFeatureSummaryView";
import {
  clusterAreaText,
  clusterLocationText,
  clusterStreetNamesForDisplay,
  compareClusterCoreMetric,
  displayStreetNames,
  formatClusterStreetNames,
  formatStreetNameForDisplay
} from "../clusterDisplay";
import { formatInteger, formatSeverityPercent } from "../formatting";
import { escapeHtml } from "../html";
import { tr, trf } from "../i18n";
import type { AnalysisResult, IntersectionCluster } from "../types";

export interface RoadClassSignature {
  key: string;
  label: string;
}

interface RoadClassToken {
  key: string;
  label: string;
}

type SimilarIntersectionFeatureGroupKey = (typeof SIMILAR_INTERSECTION_FEATURE_GROUPS)[number]["id"];

interface SimilarIntersectionGroupRow extends IntersectionFeatureSummaryRow {
  id: SimilarIntersectionFeatureGroupKey;
  weightedSeverityPercent: number;
  clusters: IntersectionCluster[];
}

interface SimilarIntersectionGroupAccumulator extends SimilarIntersectionGroupRow {
  weightedSeverityPercent: number;
}

interface SimilarIntersectionComparison {
  selected: IntersectionCluster;
  signature: RoadClassSignature;
  selectedFeatureGroup: SimilarIntersectionFeatureGroupKey | null;
  groups: SimilarIntersectionGroupRow[];
  matchedClusterCount: number;
  omittedCount: number;
}

export interface SimilarViewDependencies {
  container: HTMLElement;
  getResult: () => AnalysisResult | null;
  getSelectedCluster: () => IntersectionCluster | null;
  getSelectedRoadClassSignature: () => RoadClassSignature | null;
  getActiveView: () => string;
  selectCluster: (cluster: IntersectionCluster) => void;
}

const SIMILAR_INTERSECTION_PREVIEW_LIMIT = 8;
const SIMILAR_INTERSECTION_FEATURE_GROUPS = [
  { id: "plain", labelKey: "similar.group.plain", sortOrder: 0 },
  { id: "roundabout", labelKey: "similar.group.roundabout", sortOrder: 1 },
  { id: "trafficSignal", labelKey: "similar.group.trafficSignal", sortOrder: 2 }
] as const;
const STREET_NAME_SEPARATOR = " \u00d7 ";

export class SimilarView {
  constructor(private readonly deps: SimilarViewDependencies) {}

  bindEvents(): void {
    this.deps.container.addEventListener("click", (event) => this.handleClick(event));
  }

  renderIfVisible(): void {
    if (this.deps.getActiveView() !== "similar") {
      return;
    }
    this.render();
  }

  render(): void {
    const result = this.deps.getResult();
    const selected = this.deps.getSelectedCluster();
    if (!result || !selected) {
      this.deps.container.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("similar.empty"))}</p>`;
      return;
    }

    const signature = this.deps.getSelectedRoadClassSignature();
    if (!signature) {
      this.deps.container.innerHTML = `<p class="population-rate-empty">${escapeHtml(tr("similar.noClass"))}</p>`;
      return;
    }

    this.deps.container.innerHTML = this.renderSimilarIntersectionComparison(
      this.buildSimilarIntersectionComparison(selected, signature, result.clusters)
    );
  }

  roadClassSignatureForStreetNames(streetNames: string[]): RoadClassSignature | null {
    const tokens = displayStreetNames(streetNames).map((streetName) => this.roadClassTokenForStreetName(streetName));
    if (tokens.length === 0 || !tokens.some(this.isKnownRoadClassToken)) {
      return null;
    }

    const sortedTokens = tokens.slice().sort((a, b) => this.compareRoadClassTokens(a, b));
    return {
      key: sortedTokens.map((token) => token.key).join("|"),
      label: sortedTokens.map((token) => token.label).join(STREET_NAME_SEPARATOR)
    };
  }

  private handleClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) {
      return;
    }

    const button = event.target.closest<HTMLButtonElement>("[data-similar-cluster-id]");
    const clusterId = button?.dataset.similarClusterId;
    if (!clusterId) {
      return;
    }

    const cluster = this.deps.getResult()?.clusters.find((candidate) => candidate.id === clusterId) ?? null;
    if (!cluster) {
      return;
    }

    this.deps.selectCluster(cluster);
  }

  private buildSimilarIntersectionComparison(
    selected: IntersectionCluster,
    signature: RoadClassSignature,
    clusters: IntersectionCluster[]
  ): SimilarIntersectionComparison {
    const accumulators = new Map<SimilarIntersectionFeatureGroupKey, SimilarIntersectionGroupAccumulator>();
    SIMILAR_INTERSECTION_FEATURE_GROUPS.forEach((group) => {
      accumulators.set(group.id, this.createSimilarIntersectionGroupAccumulator(group.id, tr(group.labelKey), group.sortOrder));
    });

    let matchedClusterCount = 0;
    let omittedCount = 0;
    for (const cluster of clusters) {
      if (cluster.id === selected.id) {
        continue;
      }

      const clusterSignature = this.roadClassSignatureForCluster(cluster);
      if (clusterSignature?.key !== signature.key) {
        continue;
      }

      matchedClusterCount += 1;
      const group = this.similarIntersectionFeatureGroup(cluster);
      if (!group) {
        omittedCount += 1;
        continue;
      }
      this.addClusterToSimilarIntersectionGroup(accumulators.get(group), cluster);
    }

    return {
      selected,
      signature,
      selectedFeatureGroup: this.similarIntersectionFeatureGroup(selected),
      groups: this.finalizeSimilarIntersectionGroups(Array.from(accumulators.values())),
      matchedClusterCount,
      omittedCount
    };
  }

  private createSimilarIntersectionGroupAccumulator(
    id: SimilarIntersectionFeatureGroupKey,
    label: string,
    sortOrder: number
  ): SimilarIntersectionGroupAccumulator {
    return {
      id,
      label,
      clusterCount: 0,
      accidentCount: 0,
      fatalCount: 0,
      seriousCount: 0,
      weightedSeverityPercent: 0,
      severityPercent: 0,
      sortOrder,
      clusters: []
    };
  }

  private addClusterToSimilarIntersectionGroup(
    accumulator: SimilarIntersectionGroupAccumulator | undefined,
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
    accumulator.clusters.push(cluster);
  }

  private finalizeSimilarIntersectionGroups(accumulators: SimilarIntersectionGroupAccumulator[]): SimilarIntersectionGroupRow[] {
    return accumulators
      .map((group) => ({
        ...group,
        severityPercent: group.accidentCount > 0 ? group.weightedSeverityPercent / group.accidentCount : 0,
        clusters: group.clusters.sort(compareClusterCoreMetric)
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private renderSimilarIntersectionComparison(comparison: SimilarIntersectionComparison): string {
    const selectedFeatureLabel = this.similarIntersectionFeatureGroupLabel(comparison.selectedFeatureGroup);
    const overview = `
      <div class="similar-overview">
        <div class="similar-overview-item">
          <span>${escapeHtml(tr("similar.class"))}</span>
          <strong>${escapeHtml(comparison.signature.label)}</strong>
        </div>
        <div class="similar-overview-item">
          <span>${escapeHtml(tr("similar.selectedFeatures"))}</span>
          <strong>${escapeHtml(selectedFeatureLabel)}</strong>
        </div>
        <div class="similar-overview-item">
          <span>${escapeHtml(trf("similar.otherMatches", { count: formatInteger(comparison.matchedClusterCount) }))}</span>
        </div>
      </div>
    `;

    if (comparison.matchedClusterCount === 0) {
      return `${overview}<p class="population-rate-empty">${escapeHtml(
        trf("similar.noMatches", { class: comparison.signature.label })
      )}</p>`;
    }

    const omittedNote =
      comparison.omittedCount > 0
        ? `<p class="similar-note">${escapeHtml(trf("similar.omitted", { count: formatInteger(comparison.omittedCount) }))}</p>`
        : "";

    return `
      ${overview}
      ${renderIntersectionFeatureSection(comparison.groups)}
      ${omittedNote}
      ${this.renderSimilarClusterGroups(comparison.groups)}
    `;
  }

  private renderSimilarClusterGroups(groups: SimilarIntersectionGroupRow[]): string {
    return `
      <div class="similar-group-grid">
        ${groups.map((group) => this.renderSimilarClusterGroup(group)).join("")}
      </div>
    `;
  }

  private renderSimilarClusterGroup(group: SimilarIntersectionGroupRow): string {
    const shownClusters = group.clusters.slice(0, SIMILAR_INTERSECTION_PREVIEW_LIMIT);
    const limitNote =
      group.clusters.length > shownClusters.length
        ? `<p class="similar-list-note">${escapeHtml(
            trf("similar.listLimit", {
              shown: formatInteger(shownClusters.length),
              total: formatInteger(group.clusters.length)
            })
          )}</p>`
        : "";
    const body =
      shownClusters.length > 0
        ? `
          <div class="similar-cluster-table" role="table">
            <div class="similar-cluster-row similar-cluster-row-header" role="row">
              <div role="columnheader">${escapeHtml(tr("similar.intersection"))}</div>
              <div role="columnheader">${escapeHtml(tr("similar.area"))}</div>
              <div role="columnheader">${escapeHtml(tr("table.accidents"))}</div>
              <div role="columnheader">${escapeHtml(tr("severity.fatal"))}</div>
              <div role="columnheader">${escapeHtml(tr("severity.serious"))}</div>
              <div role="columnheader">${escapeHtml(tr("metric.severityPercent"))}</div>
            </div>
            ${shownClusters.map((cluster) => this.renderSimilarClusterRow(cluster)).join("")}
          </div>
          ${limitNote}
        `
        : `<p class="population-rate-empty">${escapeHtml(tr("similar.noGroupMatches"))}</p>`;

    return `
      <section class="similar-group-section">
        <div class="similar-group-heading">
          <h3>${escapeHtml(group.label)}</h3>
          <span>${formatInteger(group.clusterCount)} ${escapeHtml(tr("intersectionFeature.intersections").toLowerCase())}</span>
        </div>
        <h4>${escapeHtml(tr("similar.topIntersections"))}</h4>
        ${body}
      </section>
    `;
  }

  private renderSimilarClusterRow(cluster: IntersectionCluster): string {
    return `
      <button class="similar-cluster-row similar-cluster-button" type="button" data-similar-cluster-id="${escapeHtml(cluster.id)}" role="row">
        <span class="similar-cluster-primary" role="cell">${escapeHtml(this.similarClusterStreetText(cluster))}</span>
        <span role="cell">${escapeHtml(clusterAreaText(cluster))}</span>
        <span class="similar-cluster-number" role="cell">${formatInteger(cluster.accidentCount)}</span>
        <span class="similar-cluster-number" role="cell">${formatInteger(cluster.fatalCount)}</span>
        <span class="similar-cluster-number" role="cell">${formatInteger(cluster.seriousCount)}</span>
        <span class="similar-cluster-number" role="cell">${formatSeverityPercent(cluster)}</span>
      </button>
    `;
  }

  private similarClusterStreetText(cluster: IntersectionCluster): string {
    const streetNames = clusterStreetNamesForDisplay(cluster);
    return streetNames.length > 0 ? formatClusterStreetNames(streetNames) : clusterLocationText(cluster);
  }

  private roadClassSignatureForCluster(cluster: IntersectionCluster): RoadClassSignature | null {
    return this.roadClassSignatureForStreetNames(clusterStreetNamesForDisplay(cluster));
  }

  private isKnownRoadClassToken(token: RoadClassToken): boolean {
    return token.key !== "other";
  }

  private roadClassTokenForStreetName(streetName: string): RoadClassToken {
    const routeMatch = formatStreetNameForDisplay(streetName).match(/\b(St|A|B|L|K|S)\s*\d+[a-z]?\b/i);
    if (!routeMatch) {
      return { key: "other", label: tr("similar.classOther") };
    }

    const prefix = routeMatch[1].toLocaleLowerCase("en") === "st" ? "St" : routeMatch[1].toUpperCase();
    return { key: prefix.toLocaleLowerCase("en"), label: prefix };
  }

  private compareRoadClassTokens(a: RoadClassToken, b: RoadClassToken): number {
    return this.roadClassSortValue(a.key) - this.roadClassSortValue(b.key) || a.label.localeCompare(b.label, "de", { sensitivity: "base" });
  }

  private roadClassSortValue(key: string): number {
    const order = ["a", "b", "k", "l", "s", "st", "other"];
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  }

  private similarIntersectionFeatureGroup(cluster: IntersectionCluster): SimilarIntersectionFeatureGroupKey | null {
    if (cluster.osmRoundabout === false && cluster.osmTrafficSignal === false) {
      return "plain";
    }
    if (cluster.osmRoundabout === true && cluster.osmTrafficSignal === false) {
      return "roundabout";
    }
    if (cluster.osmRoundabout === false && cluster.osmTrafficSignal === true) {
      return "trafficSignal";
    }
    return null;
  }

  private similarIntersectionFeatureGroupLabel(group: SimilarIntersectionFeatureGroupKey | null): string {
    const definition = group ? SIMILAR_INTERSECTION_FEATURE_GROUPS.find((candidate) => candidate.id === group) : null;
    return definition ? tr(definition.labelKey) : tr("similar.group.excluded");
  }
}
