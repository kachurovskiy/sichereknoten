import { clusterLocationText, compareClusterCoreMetric } from "../clusterDisplay";
import { formatDistance, formatInteger, formatSeverityPercent } from "../formatting";
import { distanceMeters } from "../geo";
import { escapeHtml } from "../html";
import { tr, trf } from "../i18n";
import {
  browseFiltersActive,
  clusterBrowseRegionKey,
  filterBrowseClusters,
  type BrowseClusterFilters,
  type BrowseIndex
} from "../browseIndex";
import type { BrowseFilterProgress } from "../browseFilterWorkerClient";
import type { AnalysisResult, IntersectionCluster } from "../types";

interface LatLon {
  lat: number;
  lon: number;
}

export interface ExploreViewDependencies {
  nearbyList: HTMLElement;
  stateHotspotList: HTMLElement;
  maxIntersections: number;
  getResult: () => AnalysisResult | null;
  getUserLocation: () => LatLon | null;
  getSelectedCluster: () => IntersectionCluster | null;
  getBrowseStateValue: () => string;
  getBrowseRegionValue: () => string;
  getBrowseFilters: () => BrowseClusterFilters;
  browseIndexForCurrentResult: () => BrowseIndex | null;
  updateBrowseRegionOptions: () => void;
  setBrowseSearchProgress: (progress: BrowseFilterProgress | null) => void;
  filterBrowseClustersInBackground: (
    request: {
      clusters: IntersectionCluster[];
      stateCode: string;
      regionKey: string;
      filters: BrowseClusterFilters;
      limit: number;
      totalCount: number;
    },
    onUpdate: (clusters: IntersectionCluster[], done: boolean, progress: BrowseFilterProgress) => void
  ) => Promise<IntersectionCluster[]>;
  selectCluster: (cluster: IntersectionCluster, telemetrySource?: string) => void;
  setView: (view: "map") => void;
}

export class ExploreView {
  private stateHotspotRenderToken = 0;

  constructor(private readonly deps: ExploreViewDependencies) {}

  render(): void {
    this.deps.updateBrowseRegionOptions();
    this.renderNearbyList();
    this.renderStateHotspotList();
  }

  renderStateHotspotList(): void {
    const renderToken = this.nextStateHotspotRenderToken();
    const result = this.deps.getResult();
    if (!result) {
      this.setStateHotspotBusy(false);
      this.deps.setBrowseSearchProgress(null);
      this.deps.stateHotspotList.innerHTML = "";
      this.deps.stateHotspotList.append(this.emptyHotspotMessage(tr("status.stateHotspotsPending")));
      return;
    }

    const browseIndex = this.deps.browseIndexForCurrentResult();
    if (!browseIndex) {
      this.setStateHotspotBusy(false);
      this.deps.setBrowseSearchProgress(null);
      this.deps.stateHotspotList.innerHTML = "";
      this.deps.stateHotspotList.append(this.emptyHotspotMessage(tr("status.noAnalysisMatches")));
      return;
    }

    const stateCode = this.deps.getBrowseStateValue();
    const regionKey = this.deps.getBrowseRegionValue();
    const filters = this.deps.getBrowseFilters();
    const hasActiveFilters = browseFiltersActive(filters);
    if (hasActiveFilters) {
      const totalCount = this.scopedBrowseClusterCount(browseIndex, result, stateCode, regionKey);
      this.setStateHotspotBusy(true);
      this.deps.setBrowseSearchProgress({ scannedCount: 0, totalCount });
      this.renderStateHotspotClusters([], stateCode, true, {
        showEmpty: false
      });
      void this.renderFilteredStateHotspotsInBackground(result.clusters, stateCode, regionKey, filters, totalCount, renderToken);
      return;
    }

    const sourceClusters =
      stateCode === "all"
        ? browseIndex.topClustersByState
        : regionKey === "all"
          ? browseIndex.browseClustersByState.get(stateCode) ?? []
          : browseIndex.browseClustersByRegion.get(regionKey) ?? [];
    const clusters = sourceClusters.slice(0, this.deps.maxIntersections);

    this.setStateHotspotBusy(false);
    this.deps.setBrowseSearchProgress(null);
    this.renderStateHotspotClusters(clusters, stateCode, hasActiveFilters);
  }

  private async renderFilteredStateHotspotsInBackground(
    clusters: IntersectionCluster[],
    stateCode: string,
    regionKey: string,
    filters: BrowseClusterFilters,
    totalCount: number,
    renderToken: number
  ): Promise<void> {
    let renderedFinalResult = false;
    try {
      const filteredClusters = await this.deps.filterBrowseClustersInBackground({
        clusters,
        stateCode,
        regionKey,
        filters,
        limit: this.deps.maxIntersections,
        totalCount
      }, (partialClusters, done, progress) => {
        if (!this.isCurrentStateHotspotRender(renderToken)) {
          return;
        }
        renderedFinalResult = done;
        this.setStateHotspotBusy(!done);
        this.deps.setBrowseSearchProgress(done ? null : progress);
        this.renderStateHotspotClusters(partialClusters, stateCode, true, {
          showEmpty: done
        });
      });
      if (!this.isCurrentStateHotspotRender(renderToken) || renderedFinalResult) {
        return;
      }
      this.setStateHotspotBusy(false);
      this.deps.setBrowseSearchProgress(null);
      this.renderStateHotspotClusters(filteredClusters, stateCode, true);
    } catch {
      if (!this.isCurrentStateHotspotRender(renderToken)) {
        return;
      }
      this.setStateHotspotBusy(false);
      this.deps.setBrowseSearchProgress(null);
      const fallbackClusters = filterBrowseClusters(this.scopedClusters(clusters, stateCode, regionKey), filters)
        .slice()
        .sort(compareClusterCoreMetric)
        .slice(0, this.deps.maxIntersections);
      this.renderStateHotspotClusters(fallbackClusters, stateCode, true);
    }
  }

  private renderStateHotspotClusters(
    clusters: IntersectionCluster[],
    stateCode: string,
    hasActiveFilters: boolean,
    options: { showEmpty?: boolean } = {}
  ): void {
    this.deps.stateHotspotList.innerHTML = "";
    if (clusters.length === 0) {
      if (options.showEmpty === false) {
        return;
      }
      this.deps.stateHotspotList.append(
        this.emptyHotspotMessage(tr(hasActiveFilters ? "status.noBrowseFilterMatches" : "status.noAnalysisMatches"))
      );
      return;
    }

    clusters.forEach((cluster) => {
      this.deps.stateHotspotList.append(
        this.hotspotButton(cluster, this.browseClusterLabel(cluster, stateCode, hasActiveFilters), {
          metricPlacement: "header",
          telemetrySource: "state hotspot"
        })
      );
    });
  }

  private nextStateHotspotRenderToken(): number {
    this.stateHotspotRenderToken += 1;
    return this.stateHotspotRenderToken;
  }

  private isCurrentStateHotspotRender(renderToken: number): boolean {
    return renderToken === this.stateHotspotRenderToken;
  }

  private setStateHotspotBusy(isBusy: boolean): void {
    this.deps.stateHotspotList.toggleAttribute("aria-busy", isBusy);
  }

  refreshHotspotSelectionState(): void {
    this.refreshHotspotListSelectionState(this.deps.nearbyList);
    this.refreshHotspotListSelectionState(this.deps.stateHotspotList);
  }

  private refreshHotspotListSelectionState(container: HTMLElement): void {
    const selectedClusterId = this.deps.getSelectedCluster()?.id ?? null;
    container.querySelectorAll<HTMLButtonElement>(".hotspot-button").forEach((button) => {
      button.classList.toggle("selected", selectedClusterId !== null && button.dataset.clusterId === selectedClusterId);
    });
  }

  private scopedBrowseClusterCount(browseIndex: BrowseIndex, result: AnalysisResult, stateCode: string, regionKey: string): number {
    if (stateCode === "all") {
      return result.clusters.length;
    }
    const regions = browseIndex.regionsByState.get(stateCode) ?? [];
    if (regionKey === "all") {
      return regions.reduce((total, region) => total + region.clusterCount, 0);
    }
    return regions.find((region) => region.key === regionKey)?.clusterCount ?? 0;
  }

  private scopedClusters(clusters: IntersectionCluster[], stateCode: string, regionKey: string): IntersectionCluster[] {
    if (stateCode === "all") {
      return clusters;
    }
    return clusters.filter((cluster) => {
      if (cluster.stateCode !== stateCode) {
        return false;
      }
      return regionKey === "all" || clusterBrowseRegionKey(cluster) === regionKey;
    });
  }

  private browseClusterLabel(cluster: IntersectionCluster, stateCode: string, hasActiveFilters: boolean): string {
    if (stateCode !== "all") {
      return clusterLocationText(cluster);
    }
    return hasActiveFilters ? `${cluster.stateName} - ${clusterLocationText(cluster)}` : cluster.stateName;
  }

  selectNearestCluster(): { cluster: IntersectionCluster; distanceMeters: number } | null {
    const nearest = this.nearbyClusters(1)[0];
    if (!nearest) {
      this.deps.setView("map");
      return null;
    }
    this.deps.selectCluster(nearest.cluster, "nearest hotspot");
    return nearest;
  }

  private renderNearbyList(): void {
    this.deps.nearbyList.innerHTML = "";
    this.deps.nearbyList.hidden = false;
    if (!this.deps.getResult() || !this.deps.getUserLocation()) {
      this.deps.nearbyList.hidden = true;
      return;
    }

    const nearby = this.nearbyClusters(6);
    if (nearby.length === 0) {
      this.deps.nearbyList.append(this.emptyHotspotMessage(tr("status.noSeverityNearby")));
      return;
    }

    nearby.forEach((entry) => {
      this.deps.nearbyList.append(
        this.hotspotButton(entry.cluster, trf("label.away", { distance: formatDistance(entry.distanceMeters) }), {
          metricPlacement: "header",
          telemetrySource: "nearby hotspot"
        })
      );
    });
  }

  private hotspotButton(
    cluster: IntersectionCluster,
    context: string,
    options: { metricPlacement?: "header" | "stats"; telemetrySource?: string } = {}
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hotspot-button";
    button.dataset.clusterId = cluster.id;
    button.classList.toggle("selected", this.deps.getSelectedCluster()?.id === cluster.id);
    const metricPlacement = options.metricPlacement ?? "stats";
    const metricStat = `<span class="hotspot-stat hotspot-stat-metric"><strong>${formatSeverityPercent(cluster)}</strong> ${escapeHtml(tr("metric.severity"))}</span>`;
    button.innerHTML = `
      <span class="hotspot-main">
        <span class="hotspot-heading">
          <span class="hotspot-title">${escapeHtml(context)}</span>
          ${metricPlacement === "header" ? metricStat : ""}
        </span>
        <span class="hotspot-stats">
          ${metricPlacement === "stats" ? metricStat : ""}
          <span class="hotspot-stat hotspot-stat-total"><strong>${formatInteger(cluster.accidentCount)}</strong> ${escapeHtml(this.accidentCountNoun(cluster.accidentCount))}</span>
          <span class="hotspot-stat"><strong>${formatInteger(cluster.fatalCount)}</strong> ${escapeHtml(tr("severity.fatal").toLowerCase())}</span>
          <span class="hotspot-stat"><strong>${formatInteger(cluster.seriousCount)}</strong> ${escapeHtml(tr("severity.serious").toLowerCase())}</span>
        </span>
      </span>
    `;
    button.addEventListener("click", () => {
      this.deps.selectCluster(cluster, options.telemetrySource ?? "hotspot");
    });
    return button;
  }

  private accidentCountNoun(count: number): string {
    return tr(count === 1 ? "noun.accident.one" : "noun.accident.other");
  }

  private emptyHotspotMessage(message: string): HTMLParagraphElement {
    const element = document.createElement("p");
    element.className = "hotspot-empty";
    element.textContent = message;
    return element;
  }

  private nearbyClusters(limit: number): Array<{ cluster: IntersectionCluster; distanceMeters: number }> {
    const location = this.deps.getUserLocation();
    if (!location) {
      return [];
    }

    return (this.deps.getResult()?.clusters ?? [])
      .map((cluster) => ({ cluster, distanceMeters: distanceMeters(location, cluster) }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters || compareClusterCoreMetric(a.cluster, b.cluster))
      .slice(0, limit);
  }
}
