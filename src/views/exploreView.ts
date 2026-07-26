import { clusterLocationText, compareClusterCoreMetric } from "../clusterDisplay";
import { formatDistance, formatInteger, formatSeverityPercent } from "../formatting";
import { distanceMeters } from "../geo";
import { escapeHtml } from "../html";
import { tr, trf } from "../i18n";
import type { AnalysisResult, IntersectionCluster } from "../types";

interface LatLon {
  lat: number;
  lon: number;
}

interface BrowseIndex {
  topClustersByState: IntersectionCluster[];
  browseClustersByState: Map<string, IntersectionCluster[]>;
  browseClustersByRegion: Map<string, IntersectionCluster[]>;
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
  browseIndexForCurrentResult: () => BrowseIndex | null;
  updateBrowseRegionOptions: () => void;
  selectCluster: (cluster: IntersectionCluster, telemetrySource?: string) => void;
  setView: (view: "map") => void;
}

export class ExploreView {
  constructor(private readonly deps: ExploreViewDependencies) {}

  render(): void {
    this.deps.updateBrowseRegionOptions();
    this.renderNearbyList();
    this.renderStateHotspotList();
  }

  renderStateHotspotList(): void {
    this.deps.stateHotspotList.innerHTML = "";
    if (!this.deps.getResult()) {
      this.deps.stateHotspotList.append(this.emptyHotspotMessage(tr("status.stateHotspotsPending")));
      return;
    }

    const browseIndex = this.deps.browseIndexForCurrentResult();
    if (!browseIndex) {
      this.deps.stateHotspotList.append(this.emptyHotspotMessage(tr("status.noAnalysisMatches")));
      return;
    }

    const stateCode = this.deps.getBrowseStateValue();
    const regionKey = this.deps.getBrowseRegionValue();
    const sourceClusters =
      stateCode === "all"
        ? browseIndex.topClustersByState
        : regionKey === "all"
          ? browseIndex.browseClustersByState.get(stateCode) ?? []
          : browseIndex.browseClustersByRegion.get(regionKey) ?? [];
    const clusters = sourceClusters.slice(0, this.deps.maxIntersections);

    if (clusters.length === 0) {
      this.deps.stateHotspotList.append(this.emptyHotspotMessage(tr("status.noAnalysisMatches")));
      return;
    }

    clusters.forEach((cluster) => {
      this.deps.stateHotspotList.append(
        this.hotspotButton(cluster, stateCode === "all" ? cluster.stateName : clusterLocationText(cluster), {
          metricPlacement: "header",
          telemetrySource: "state hotspot"
        })
      );
    });
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
