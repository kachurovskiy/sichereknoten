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
import { currentLocale, tr, trf } from "../i18n";
import type { AnalysisResult, IntersectionCluster } from "../types";

export interface RoadClassSignature {
  key: string;
  label: string;
}

interface RoadClassToken {
  key: string;
  label: string;
}

interface RoadClassOption extends RoadClassSignature {
  clusterCount: number;
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
  signature: RoadClassSignature;
  groups: SimilarIntersectionGroupRow[];
  matchedClusterCount: number;
  omittedCount: number;
}

interface SimilarIntersectionBucket {
  signature: RoadClassSignature;
  clusterCount: number;
  clusters: IntersectionCluster[];
  comparison: SimilarIntersectionComparison | null;
}

interface SimilarIntersectionIndex {
  result: AnalysisResult;
  locale: string;
  roadClassOptions: RoadClassOption[];
  bucketsByRoadClassKey: Map<string, SimilarIntersectionBucket>;
}

interface SimilarRenderedState {
  result: AnalysisResult | null;
  stateKey: string;
  locale: string;
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
const SIMILAR_INTERSECTION_MIN_COMPARISON_CLUSTER_COUNT = 10;
const SIMILAR_INTERSECTION_FEATURE_GROUPS = [
  { id: "plain", labelKey: "similar.group.plain", sortOrder: 0 },
  { id: "roundabout", labelKey: "similar.group.roundabout", sortOrder: 1 },
  { id: "trafficSignal", labelKey: "similar.group.trafficSignal", sortOrder: 2 }
] as const;
const STREET_NAME_SEPARATOR = " \u00d7 ";

export class SimilarView {
  private selectedRoadClassKey: string | null = null;
  private autoSelectedClusterId: string | null = null;
  private cachedIndex: SimilarIntersectionIndex | null = null;
  private renderedState: SimilarRenderedState | null = null;

  constructor(private readonly deps: SimilarViewDependencies) {}

  bindEvents(): void {
    this.deps.container.addEventListener("click", (event) => this.handleClick(event));
    this.deps.container.addEventListener("change", (event) => this.handleChange(event));
  }

  renderIfVisible(): void {
    if (this.deps.getActiveView() !== "similar") {
      return;
    }
    this.render();
  }

  render(): void {
    const result = this.deps.getResult();
    if (!result) {
      this.renderHtmlIfChanged(
        null,
        "no-result",
        () => `<p class="population-rate-empty">${escapeHtml(tr("similar.noData"))}</p>`
      );
      return;
    }

    const index = this.similarIntersectionIndexForResult(result);
    if (index.roadClassOptions.length === 0) {
      this.renderHtmlIfChanged(
        result,
        "no-road-classes",
        () =>
          `<p class="population-rate-empty">${escapeHtml(
            trf("similar.noRoadClasses", { count: formatInteger(SIMILAR_INTERSECTION_MIN_COMPARISON_CLUSTER_COUNT) })
          )}</p>`
      );
      return;
    }

    const selected = this.deps.getSelectedCluster();
    const signature = this.pickRoadClassSignatureForRender(selected, index.roadClassOptions);
    const bucket = index.bucketsByRoadClassKey.get(signature.key);
    if (!bucket) {
      return;
    }

    this.renderHtmlIfChanged(
      result,
      `road-class:${signature.key}`,
      () => this.renderSimilarIntersectionComparison(this.comparisonForBucket(bucket), index.roadClassOptions)
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

  private handleChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.similarRoadClass !== "true") {
      return;
    }
    this.selectedRoadClassKey = target.value || null;
    this.render();
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
    bucket: SimilarIntersectionBucket
  ): SimilarIntersectionComparison {
    const accumulators = new Map<SimilarIntersectionFeatureGroupKey, SimilarIntersectionGroupAccumulator>();
    SIMILAR_INTERSECTION_FEATURE_GROUPS.forEach((group) => {
      accumulators.set(group.id, this.createSimilarIntersectionGroupAccumulator(group.id, tr(group.labelKey), group.sortOrder));
    });

    let omittedCount = 0;
    for (const cluster of bucket.clusters) {
      const group = this.similarIntersectionFeatureGroup(cluster);
      if (!group) {
        omittedCount += 1;
        continue;
      }
      this.addClusterToSimilarIntersectionGroup(accumulators.get(group), cluster);
    }

    return {
      signature: bucket.signature,
      groups: this.finalizeSimilarIntersectionGroups(Array.from(accumulators.values())),
      matchedClusterCount: bucket.clusterCount,
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
      .filter((group) => group.clusterCount >= SIMILAR_INTERSECTION_MIN_COMPARISON_CLUSTER_COUNT)
      .map((group) => ({
        ...group,
        severityPercent: group.accidentCount > 0 ? group.weightedSeverityPercent / group.accidentCount : 0,
        clusters: group.clusters.sort(compareClusterCoreMetric)
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private renderSimilarIntersectionComparison(comparison: SimilarIntersectionComparison, roadClassOptions: RoadClassOption[]): string {
    const overview = `
      <div class="similar-overview">
        <div class="similar-overview-item similar-overview-control">
          <label class="similar-road-class-field" for="similarRoadClassSelect">
            <span>${escapeHtml(tr("similar.class"))}:</span>
            <select id="similarRoadClassSelect" data-similar-road-class="true">
              ${roadClassOptions.map((option) => this.renderRoadClassOption(option, comparison.signature)).join("")}
            </select>
          </label>
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
      ${comparison.groups.length > 0 ? renderIntersectionFeatureSection(comparison.groups) : this.renderMinimumGroupEmptyState()}
      ${omittedNote}
      ${comparison.groups.length > 0 ? this.renderSimilarClusterGroups(comparison.groups) : ""}
    `;
  }

  private renderMinimumGroupEmptyState(): string {
    return `<p class="population-rate-empty">${escapeHtml(
      trf("similar.noLargeGroups", { count: formatInteger(SIMILAR_INTERSECTION_MIN_COMPARISON_CLUSTER_COUNT) })
    )}</p>`;
  }

  private renderRoadClassOption(option: RoadClassOption, selected: RoadClassSignature): string {
    return `<option value="${escapeHtml(option.key)}" ${option.key === selected.key ? "selected" : ""}>${escapeHtml(
      `${option.label} (${formatInteger(option.clusterCount)})`
    )}</option>`;
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

  private similarIntersectionIndexForResult(result: AnalysisResult): SimilarIntersectionIndex {
    const locale = currentLocale();
    if (this.cachedIndex?.result === result && this.cachedIndex.locale === locale) {
      return this.cachedIndex;
    }

    const buckets = new Map<string, SimilarIntersectionBucket>();
    for (const cluster of result.clusters) {
      const signature = this.roadClassSignatureForCluster(cluster);
      if (!signature) {
        continue;
      }
      const current = buckets.get(signature.key);
      if (current) {
        current.clusterCount += 1;
        current.clusters.push(cluster);
      } else {
        buckets.set(signature.key, { signature, clusterCount: 1, clusters: [cluster], comparison: null });
      }
    }

    const eligibleBuckets = Array.from(buckets.values()).filter(
      (bucket) => bucket.clusterCount >= SIMILAR_INTERSECTION_MIN_COMPARISON_CLUSTER_COUNT
    );
    const bucketsByRoadClassKey = new Map<string, SimilarIntersectionBucket>(
      eligibleBuckets.map((bucket) => [bucket.signature.key, bucket])
    );
    const roadClassOptions = eligibleBuckets
      .map((bucket) => ({ ...bucket.signature, clusterCount: bucket.clusterCount }))
      .sort((a, b) => this.compareRoadClassSignatures(a, b));
    this.cachedIndex = { result, locale, roadClassOptions, bucketsByRoadClassKey };
    this.renderedState = null;
    return this.cachedIndex;
  }

  private comparisonForBucket(bucket: SimilarIntersectionBucket): SimilarIntersectionComparison {
    if (!bucket.comparison) {
      bucket.comparison = this.buildSimilarIntersectionComparison(bucket);
    }
    return bucket.comparison;
  }

  private renderHtmlIfChanged(result: AnalysisResult | null, stateKey: string, html: () => string): void {
    const locale = currentLocale();
    if (
      this.renderedState?.result === result &&
      this.renderedState.stateKey === stateKey &&
      this.renderedState.locale === locale
    ) {
      return;
    }
    this.deps.container.innerHTML = html();
    this.renderedState = { result, stateKey, locale };
  }

  private pickRoadClassSignatureForRender(
    selected: IntersectionCluster | null,
    roadClassOptions: RoadClassOption[]
  ): RoadClassSignature {
    const selectedClusterId = selected?.id ?? null;
    const selectedSignature = this.deps.getSelectedRoadClassSignature();
    if (selectedClusterId !== this.autoSelectedClusterId) {
      this.autoSelectedClusterId = selectedClusterId;
      if (selectedSignature && roadClassOptions.some((option) => option.key === selectedSignature.key)) {
        this.selectedRoadClassKey = selectedSignature.key;
      }
    }

    const manuallySelected = roadClassOptions.find((option) => option.key === this.selectedRoadClassKey);
    if (manuallySelected) {
      return manuallySelected;
    }

    const autoSelected = selectedSignature
      ? roadClassOptions.find((option) => option.key === selectedSignature.key) ?? null
      : null;
    const fallback = autoSelected ?? roadClassOptions[0];
    this.selectedRoadClassKey = fallback.key;
    return fallback;
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

  private compareRoadClassSignatures(a: RoadClassSignature, b: RoadClassSignature): number {
    const aTokens = a.key.split("|");
    const bTokens = b.key.split("|");
    const length = Math.max(aTokens.length, bTokens.length);
    for (let index = 0; index < length; index += 1) {
      const aToken = aTokens[index] ?? "";
      const bToken = bTokens[index] ?? "";
      const order = this.roadClassSortValue(aToken) - this.roadClassSortValue(bToken);
      if (order !== 0) {
        return order;
      }
      const keyOrder = aToken.localeCompare(bToken, "en", { sensitivity: "base" });
      if (keyOrder !== 0) {
        return keyOrder;
      }
    }
    return a.label.localeCompare(b.label, "de", { sensitivity: "base" });
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
}
