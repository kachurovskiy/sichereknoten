import {
  accidentRecordRows,
  accidentSeverity,
  accidentSeverityLabel,
  accidentTimeLabel
} from "../accidentRecordDisplay";
import {
  clusterAreaText,
  clusterStreetLabel,
  formatClusterStreetNames,
  formatOsmBoolean,
  normalizedAreaNameKey
} from "../clusterDisplay";
import { formatInteger, formatSharePercent, formatSignedPercent } from "../formatting";
import { escapeHtml } from "../html";
import { tr, trf } from "../i18n";
import { linePath, round, uniqueNumbers } from "../math";
import { ROAD_USER_DEFINITIONS, type RoadUserDefinition } from "../roadUsers";
import type { AccidentRecord, AccidentTrendDirection, ClusterYearStat, IntersectionCluster, RoadUserKey } from "../types";

export interface SelectedIntersectionPanelUrls {
  openStreetMapUrl: string;
  googleMapsUrl: string;
  streetViewUrl: string;
  authoritySearchUrl: string;
}

export interface SelectedIntersectionPanelAccidentRecord {
  accident: AccidentRecord;
  distanceMeters: number;
}

export interface SelectedIntersectionPanelViewModel {
  cluster: IntersectionCluster;
  urls: SelectedIntersectionPanelUrls;
  streetNames: string[];
  canCompareSimilar: boolean;
  pressSearchUrl: string;
  trendSeries: ClusterYearStat[];
  accidentRecords: SelectedIntersectionPanelAccidentRecord[];
  accidentRecordsLoading: boolean;
}

export interface RoadUserSummaryItem {
  definition: RoadUserDefinition;
  label: string;
  count: number;
  share: number;
}

export interface SelectedIntersectionPanelViewDependencies {
  container: HTMLElement;
  formatSeverityPercentWithContext: (cluster: IntersectionCluster) => string;
  pressSearchUrlForAccident: (accident: AccidentRecord) => string;
}

interface TrendSeriesPoint extends ClusterYearStat {
  x: number;
  accidentY: number;
}

export class SelectedIntersectionPanelView {
  constructor(private readonly deps: SelectedIntersectionPanelViewDependencies) {}

  renderEmpty(): void {
    this.deps.container.textContent = tr("details.none");
  }

  render(viewModel: SelectedIntersectionPanelViewModel): void {
    this.deps.container.innerHTML = this.renderHtml(viewModel);
  }

  factsheetButtons(): HTMLButtonElement[] {
    return Array.from(this.deps.container.querySelectorAll<HTMLButtonElement>("[data-selected-action='factsheet']"));
  }

  renderIncidentDialogHtml(accident: AccidentRecord): string {
    return this.renderAccidentRecordItem(accident, "1", null, [], {
      className: "incident-dialog-card",
      closeButton: true,
      tagName: "article"
    });
  }

  private renderHtml(viewModel: SelectedIntersectionPanelViewModel): string {
    const { cluster, urls, pressSearchUrl, streetNames } = viewModel;
    return `
      <dl>
        <div><dt>${escapeHtml(tr("details.region"))}</dt><dd>${escapeHtml(clusterAreaText(cluster))}</dd></div>
        ${this.renderClusterStreetDetailRow(streetNames)}
        ${this.renderClusterOsmFeatureDetailRows(cluster)}
        ${this.renderClusterPopulationDetailRow(cluster)}
        <div><dt>${escapeHtml(tr("details.coordinates"))}</dt><dd>${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}</dd></div>
        <div><dt>${escapeHtml(tr("details.years"))}</dt><dd>${escapeHtml(this.formatYearSelection(cluster.years))}</dd></div>
        <div><dt>${escapeHtml(tr("details.accidents"))}</dt><dd>${escapeHtml(this.selectedAccidentCountText(cluster))}</dd></div>
        <div><dt>${escapeHtml(tr("details.severityPercent"))}</dt><dd>${escapeHtml(this.deps.formatSeverityPercentWithContext(cluster))}</dd></div>
      </dl>
      ${this.renderMapServiceActions(urls.openStreetMapUrl, urls.googleMapsUrl, urls.streetViewUrl)}
      ${this.renderSelectedWorkflowActions(urls.authoritySearchUrl, pressSearchUrl, viewModel.canCompareSimilar)}
      ${this.renderTrendPanel(cluster, viewModel.trendSeries)}
      ${this.renderRoadUserPanel(viewModel.accidentRecords)}
      ${this.renderSidebarAccidentRecords(viewModel)}
    `;
  }

  private renderClusterPopulationDetailRow(cluster: IntersectionCluster): string {
    const rows: string[] = [];
    if (cluster.municipalityPopulation !== null && cluster.municipalityName) {
      rows.push(`${tr("details.municipality")}: ${formatInteger(cluster.municipalityPopulation)}`);
    }

    const regionName = cluster.administrativeRegionName ?? cluster.stateName;
    if (
      cluster.administrativeRegionPopulation !== null &&
      (!cluster.municipalityName ||
        cluster.municipalityPopulation !== cluster.administrativeRegionPopulation ||
        normalizedAreaNameKey(cluster.municipalityName) !== normalizedAreaNameKey(regionName))
    ) {
      rows.push(`${tr("details.region")}: ${formatInteger(cluster.administrativeRegionPopulation)}`);
    }

    if (rows.length === 0) {
      return "";
    }
    return `<div><dt>${escapeHtml(tr("details.population"))}</dt><dd>${rows.map(escapeHtml).join("<br>")}</dd></div>`;
  }

  private selectedAccidentCountText(cluster: IntersectionCluster): string {
    return `${formatInteger(cluster.accidentCount)} (${formatInteger(cluster.fatalCount)} ${tr("details.fatalCount")}, ${formatInteger(
      cluster.seriousCount
    )} ${tr("details.seriousCount")})`;
  }

  private renderClusterStreetDetailRow(streetNames: string[]): string {
    if (streetNames.length === 0) {
      return "";
    }
    return `<div><dt>${escapeHtml(clusterStreetLabel(streetNames))}</dt><dd>${escapeHtml(formatClusterStreetNames(streetNames))}</dd></div>`;
  }

  private renderClusterOsmFeatureDetailRows(cluster: IntersectionCluster): string {
    return [
      [tr("details.roundabout"), formatOsmBoolean(cluster.osmRoundabout)],
      [tr("details.trafficSignal"), formatOsmBoolean(cluster.osmTrafficSignal)]
    ]
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("");
  }

  private renderMapServiceActions(openStreetMapUrl: string, googleMapsUrl: string, streetViewUrl: string): string {
    return `
    <div class="selected-map-actions" aria-label="${escapeHtml(tr("aria.openMapServices"))}">
      ${this.mapServiceLink(openStreetMapUrl, tr("map.openOsm"), tr("map.labelOsm"))}
      ${this.mapServiceLink(googleMapsUrl, tr("map.openGoogleMaps"), tr("map.labelGoogleMaps"))}
      ${this.mapServiceLink(streetViewUrl, tr("map.openStreetView"), tr("map.labelStreetView"))}
    </div>
  `;
  }

  private mapServiceLink(url: string, accessibleLabel: string, visibleLabel: string): string {
    const label = escapeHtml(accessibleLabel);
    return `<a class="map-service-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${label}" title="${label}">${escapeHtml(visibleLabel)}</a>`;
  }

  private renderSelectedWorkflowActions(authoritySearchUrl: string, pressSearchUrl: string, canCompareSimilar: boolean): string {
    const similarButton = canCompareSimilar
      ? `
      <button class="map-service-link" type="button" data-selected-action="similar" aria-label="${escapeHtml(tr("action.findSimilar"))}" title="${escapeHtml(tr("action.findSimilar"))}">
        ${escapeHtml(tr("action.findSimilar"))}
      </button>`
      : "";
    return `
    <div class="selected-workflow-actions">
      ${similarButton}
      <button class="map-service-link factsheet-button" type="button" data-selected-action="factsheet" aria-label="${escapeHtml(tr("action.downloadFactsheet"))}" title="${escapeHtml(tr("action.downloadFactsheet"))}">
        ${escapeHtml(tr("action.labelFactsheet"))}
      </button>
      ${this.mapServiceLink(authoritySearchUrl, tr("map.searchResponsibleAuthority"), tr("map.labelResponsibleAuthority"))}
      ${this.mapServiceLink(pressSearchUrl, tr("press.searchIntersection"), tr("press.label"))}
    </div>
  `;
  }

  private renderSidebarAccidentRecords(viewModel: SelectedIntersectionPanelViewModel): string {
    const { accidentRecords, accidentRecordsLoading, cluster, streetNames } = viewModel;
    const countText = trf("records.countOf", { shown: formatInteger(accidentRecords.length), total: formatInteger(cluster.accidentCount) });
    if (accidentRecords.length === 0) {
      const emptyMessage = accidentRecordsLoading ? tr("records.loading") : tr("records.empty");
      return `
      <section class="sidebar-accident-records">
        <div class="section-heading-row">
          <h3>${escapeHtml(tr("records.title"))}</h3>
          <span>${countText}</span>
        </div>
        <p class="hotspot-empty">${escapeHtml(emptyMessage)}</p>
      </section>
    `;
    }

    const items = accidentRecords
      .map(({ accident, distanceMeters }, index) => this.renderAccidentRecordItem(accident, String(index + 1), distanceMeters, streetNames))
      .join("");

    return `
    <section class="sidebar-accident-records">
      <div class="section-heading-row">
        <h3>${escapeHtml(tr("records.title"))}</h3>
        <span>${countText}</span>
      </div>
      <ol class="accident-record-list">${items}</ol>
    </section>
  `;
  }

  private renderAccidentRecordItem(
    accident: AccidentRecord,
    recordNumber: string,
    distanceMeters: number | null,
    streetOrder: string[] = [],
    options: { className?: string; closeButton?: boolean; tagName?: "article" | "li" } = {}
  ): string {
    const tagName = options.tagName ?? "li";
    const severity = accidentSeverity(accident);
    const actionLinks = this.renderAccidentActionLinks(accident);
    const closeButton = options.closeButton ? this.renderIncidentDialogCloseButton() : "";
    const className = ["accident-record-item", options.className].filter(Boolean).join(" ");
    const rows = accidentRecordRows(accident, distanceMeters, streetOrder)
      .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
      .join("");
    return `
    <${tagName} class="${className}">
      <div class="accident-record-topline">
        <span class="accident-record-number" aria-label="${escapeHtml(trf("records.incidentNumber", { number: recordNumber }))}">${recordNumber}</span>
        <span class="severity-pill severity-${severity}">${accidentSeverityLabel(accident)}</span>
        <strong>${escapeHtml(accidentTimeLabel(accident))}</strong>
        ${actionLinks}
        ${closeButton}
      </div>
      <dl class="accident-record-fields">${rows}</dl>
    </${tagName}>
  `;
  }

  private renderAccidentActionLinks(accident: AccidentRecord): string {
    return `
    <div class="accident-record-actions">
      <a href="${escapeHtml(this.deps.pressSearchUrlForAccident(accident))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tr("press.searchIncident"))}" title="${escapeHtml(tr("press.searchIncident"))}">
        ${escapeHtml(tr("press.label"))}
      </a>
    </div>
  `;
  }

  private renderIncidentDialogCloseButton(): string {
    const label = escapeHtml(tr("action.close"));
    return `
    <button class="incident-dialog-card-close" type="button" data-incident-dialog-close aria-label="${label}" title="${label}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18"></path>
      </svg>
    </button>
  `;
  }

  private renderTrendPanel(cluster: IntersectionCluster, series: ClusterYearStat[]): string {
    const trend = cluster.accidentTrend;
    const trendLabel = this.trendDirectionLabel(trend.direction);
    const relativeSlope =
      trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}${tr("unit.perYear")}`;
    const latestAccidents = [...series].reverse().find((point) => point.accidentCount > 0)?.accidentCount ?? 0;

    return `
    <section class="trend-panel" aria-label="${escapeHtml(tr("trend.aria"))}">
      <div class="trend-summary">
        <span>${escapeHtml(tr("trend.title"))}</span>
        <strong class="trend-value ${this.trendClassName(trend.direction)}">${trendLabel}${relativeSlope}</strong>
        <small>${escapeHtml(trf("trend.latest", { count: formatInteger(latestAccidents) }))}</small>
      </div>
      ${this.renderTrendChart(series, trend.direction)}
      <div class="trend-legend">
        <span class="legend-accidents">${escapeHtml(tr("trend.legend.accidents"))}</span>
      </div>
      <p class="trend-note">${escapeHtml(tr("trend.note"))}</p>
    </section>
  `;
  }

  private renderTrendChart(series: ClusterYearStat[], direction: AccidentTrendDirection): string {
    if (series.length === 0) {
      return "";
    }

    const chart = { left: 38, top: 12, width: 218, height: 80, bottom: 92 };
    const maxAccidents = this.maxSeriesAccidents(series, 1);
    const yAxisTicks = uniqueNumbers([0, Math.ceil(maxAccidents / 2), maxAccidents]).sort((a, b) => b - a);

    const plotted = series.map((point, index): TrendSeriesPoint => {
      const x = series.length === 1 ? chart.left + chart.width / 2 : chart.left + (index / (series.length - 1)) * chart.width;
      const accidentY = chart.bottom - (point.accidentCount / maxAccidents) * chart.height;
      return { ...point, x, accidentY };
    });
    const yAxisGrid = yAxisTicks
      .filter((value) => value > 0)
      .map((value) => {
        const y = chart.bottom - (value / maxAccidents) * chart.height;
        return `<line class="chart-grid" x1="${chart.left}" y1="${round(y, 1)}" x2="${chart.left + chart.width}" y2="${round(y, 1)}"></line>`;
      })
      .join("");
    const yAxisLabels = yAxisTicks
      .map((value) => {
        const y = chart.bottom - (value / maxAccidents) * chart.height;
        return `<text class="chart-y-label" x="${chart.left - 7}" y="${round(y, 1)}" dy="0.35em">${escapeHtml(formatInteger(value))}</text>`;
      })
      .join("");
    const accidentPath = linePath(plotted.map((point) => ({ x: point.x, y: point.accidentY })));
    const yearLabels = plotted.map((point) => `<text class="chart-year" x="${round(point.x, 1)}" y="126">${point.year}</text>`).join("");
    const accidentDots = plotted
      .map(
        (point) =>
          `<circle class="chart-dot chart-dot-accident" cx="${round(point.x, 1)}" cy="${round(point.accidentY, 1)}" r="2.6"><title>${escapeHtml(
            trf("trend.dotTitle", { year: point.year, count: formatInteger(point.accidentCount) })
          )}</title></circle>`
      )
      .join("");

    return `
    <svg class="trend-chart" viewBox="0 0 280 136" role="img" aria-label="${escapeHtml(
      trf("trend.chartAria", { direction: this.trendDirectionLabel(direction).toLowerCase() })
    )}">
      ${yAxisGrid}
      <line class="chart-axis" x1="${chart.left}" y1="${chart.top}" x2="${chart.left}" y2="${chart.bottom}"></line>
      <line class="chart-axis" x1="${chart.left}" y1="${chart.bottom}" x2="${chart.left + chart.width}" y2="${chart.bottom}"></line>
      ${yAxisLabels}
      ${accidentPath ? `<path class="chart-line chart-line-accidents" d="${accidentPath}"></path>` : ""}
      ${accidentDots}
      ${yearLabels}
    </svg>
  `;
  }

  private maxSeriesAccidents(series: ClusterYearStat[], fallback: number): number {
    let maximum = fallback;
    for (const point of series) {
      maximum = Math.max(maximum, point.accidentCount);
    }
    return maximum;
  }

  private trendDirectionLabel(direction: AccidentTrendDirection): string {
    switch (direction) {
      case "falling":
        return tr("trend.falling");
      case "rising":
        return tr("trend.rising");
      case "stable":
        return tr("trend.stable");
      case "unknown":
        return tr("trend.unknown");
    }
  }

  private trendClassName(direction: AccidentTrendDirection): string {
    return `trend-${direction}`;
  }

  private formatYearSelection(years: number[]): string {
    if (years.length === 0) {
      return tr("trend.unknown").toLowerCase();
    }
    const isContinuous = years.every((year, index) => index === 0 || year === years[index - 1] + 1);
    if (isContinuous && years.length > 1) {
      return `${years[0]}-${years[years.length - 1]}`;
    }
    return years.map(String).join(", ");
  }

  private renderRoadUserPanel(records: SelectedIntersectionPanelAccidentRecord[]): string {
    const items = roadUserSummaryItems(records);
    if (items.length === 0) {
      return "";
    }

    const topItem = items[0];
    const segments = items
      .map((item) => {
        const percent = formatSharePercent(item.share);
        const label = trf("roadUsers.segmentLabel", {
          label: item.label,
          count: formatInteger(item.count),
          percent
        });
        return `
        <span
          class="road-user-segment road-user-${item.definition.key}"
          style="--road-user-count: ${item.count}"
          role="listitem"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"
        >${this.roadUserIcon(item.definition.key)}</span>
      `;
      })
      .join("");
    const legend = items
      .map(
        (item) => `
        <span class="road-user-legend-item road-user-${item.definition.key}">
          ${this.roadUserIcon(item.definition.key)}
          <span class="road-user-legend-label">${escapeHtml(item.label)}</span>
          <strong>${formatInteger(item.count)}</strong>
        </span>
      `
      )
      .join("");

    return `
    <section class="road-user-panel" aria-label="${escapeHtml(tr("roadUsers.summaryAria"))}">
      <div class="road-user-summary">
        <div class="road-user-heading">
          <span>${escapeHtml(tr("roadUsers.title"))}</span>
          <strong>${escapeHtml(topItem.label)} ${formatSharePercent(topItem.share)}</strong>
        </div>
        <div class="road-user-strip" role="list">${segments}</div>
        <div class="road-user-legend">${legend}</div>
      </div>
    </section>
  `;
  }

  private roadUserIcon(key: RoadUserKey): string {
    switch (key) {
      case "car":
        return this.svgRoadUserIcon(
          '<path d="M5 16h14l-1.4-5.2A2.4 2.4 0 0 0 15.3 9H8.7a2.4 2.4 0 0 0-2.3 1.8L5 16Z"></path><path d="M7 16v2m10-2v2"></path><circle cx="8" cy="16" r="1.2"></circle><circle cx="16" cy="16" r="1.2"></circle><path d="M7.2 12h9.6"></path>'
        );
      case "pedestrian":
        return this.svgRoadUserIcon(
          '<circle cx="12" cy="5" r="2"></circle><path d="M12 7v6m0 0-4 7m4-7 4 7m-5-9-4 2m5-2 4 2"></path>'
        );
      case "bicycle":
        return this.svgRoadUserIcon(
          '<circle cx="6" cy="17" r="3"></circle><circle cx="18" cy="17" r="3"></circle><path d="M8.5 17 11 11h3l2 6m-5-6-2-3m5 3 3-2m-6 2 5 6"></path>'
        );
      case "motorcycle":
        return this.svgRoadUserIcon(
          '<circle cx="6" cy="17" r="3"></circle><circle cx="18" cy="17" r="3"></circle><path d="M7 17h5l2.5-4H18l2 4m-8-4-2-3h3m2 0h3"></path>'
        );
      case "truck":
        return this.svgRoadUserIcon(
          '<path d="M3 8h11v8H3Z"></path><path d="M14 11h4l3 3v2h-7Z"></path><circle cx="7" cy="17" r="1.5"></circle><circle cx="17" cy="17" r="1.5"></circle>'
        );
      case "other":
        return this.svgRoadUserIcon(
          '<path d="M12 3 21 8v8l-9 5-9-5V8l9-5Z"></path><path d="M12 9v3"></path><path d="M12 16h.01"></path>'
        );
    }
  }

  private svgRoadUserIcon(paths: string): string {
    return `<svg class="road-user-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
  }
}

export function roadUserSummaryItems(records: SelectedIntersectionPanelAccidentRecord[]): RoadUserSummaryItem[] {
  const counts = new Map<RoadUserKey, number>(ROAD_USER_DEFINITIONS.map((definition) => [definition.key, 0]));
  for (const { accident } of records) {
    for (const definition of ROAD_USER_DEFINITIONS) {
      if (definition.read(accident) === true) {
        counts.set(definition.key, (counts.get(definition.key) ?? 0) + 1);
      }
    }
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return [];
  }

  return ROAD_USER_DEFINITIONS.map((definition) => {
    const count = counts.get(definition.key) ?? 0;
    return {
      definition,
      label: tr(definition.labelKey),
      count,
      share: count / total
    };
  })
    .filter((item) => item.count > 0)
    .sort(compareRoadUserSummaryItems);
}

function compareRoadUserSummaryItems(a: RoadUserSummaryItem, b: RoadUserSummaryItem): number {
  return b.count - a.count || roadUserOrder(a.definition.key) - roadUserOrder(b.definition.key);
}

function roadUserOrder(key: RoadUserKey): number {
  return ROAD_USER_DEFINITIONS.findIndex((definition) => definition.key === key);
}
