import "./styles.css";
import { serializeAnalysisOptions } from "./analysisOptions";
import { analyzeDangerousIntersectionsInBackground, type AnalysisExecutionPlan } from "./analysisRunner";
import { DataRepository, type AnalysisCacheContext, type DataRepositoryTelemetry } from "./dataRepository";
import { normalizeTrendYears } from "./defaults";
import {
  cleanAreaNameForDisplay,
  clusterLocationText,
  clusterStreetNamesForDisplay,
  compareClusterCoreMetric
} from "./clusterDisplay";
import { accidentKey, accidentRecordRows, accidentSeverityLabel, accidentTimeLabel } from "./accidentRecordDisplay";
import {
  accidentMatchesAnalysisOptions,
  analysisOptionsIndexKey,
  clusteredAccidentMembership,
  ClusterAccidentRecordMatcher,
  type ClusterAccidentRecordsSnapshot,
  type CrossingAccident
} from "./clusterAccidentRecords";
import {
  configureNumberLocale,
  formatCompactPopulation,
  formatDistance,
  formatInteger,
  formatSeverityPercent,
  severityPercentValue
} from "./formatting";
import { createFactsheetPdf, factsheetFileName, type CreateFactsheetPdfOptions } from "./factsheet";
import { distanceMeters } from "./geo";
import { escapeHtml } from "./html";
import { applyStaticTranslations, configureI18n, detectLocale, tr, trf, type AppLocale } from "./i18n";
import { DEFAULT_LOADING_FACT_META, LOADING_FACTS } from "./loadingFacts";
import { clampNumber, round } from "./math";
import { MapCanvas, type MapIncidentViewportRequest } from "./mapCanvas";
import { RequestGate, type RequestToken } from "./requestGate";
import { ROAD_USER_DEFINITIONS, roadUserFocusKey } from "./roadUsers";
import { STATE_NAMES } from "./states";
import {
  createInitializationTelemetry,
  createInteractionTelemetry,
  createPostRenderCacheTelemetry,
  errorMessage,
  finishInteractionStep,
  logInitializationTelemetry,
  logInteractionTelemetry,
  measureInitializationStep,
  measureInteractionStep,
  recordInitializationStep,
  startInteractionStep,
  type InitializationTelemetry,
  type InitializationTelemetryStatus,
  type InteractionTelemetry,
  type TelemetryMetadata
} from "./telemetry";
import {
  AccidentRecord,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  SeverityPercentOptions,
  IntersectionCluster,
  RoadUserKey
} from "./types";
import { TRANSLATIONS } from "./translations";
import {
  googleStreetViewEmbedUrl,
  mapUrlsForCluster,
  pressSearchUrlForAccident,
  pressSearchUrlForCluster,
  responsibleAuthoritySearchUrlForCluster
} from "./urlBuilders";
import { ExploreView } from "./views/exploreView";
import {
  roadUserSummaryItems,
  SelectedIntersectionPanelView,
  type SelectedIntersectionPanelViewModel
} from "./views/selectedIntersectionPanelView";
import { SelectedPreviewMapView, type SelectedPreviewMapIncidentPoint } from "./views/selectedPreviewMapView";
import { SimilarView, type RoadClassSignature } from "./views/similarView";
import { StateRegionView, type RegionSummary, type RegionSummaryAccumulator } from "./views/stateRegionView";
import { TableView } from "./views/tableView";

const STATE_BROWSE_MIN_SEVERITY_PERCENT = 0.1;
const STATE_BROWSE_MAX_INTERSECTIONS = 100;
const INTERSECTION_URL_COORDINATE_DECIMALS = 5;
const INTERSECTION_URL_MATCH_MAX_DISTANCE_METERS = 75;
const INTERSECTION_URL_ZOOM_MIN = 0;
const INTERSECTION_URL_ZOOM_MAX = 19;
const VIEW_URL_PARAM = "view";

declare const __SICHERE_KNOTEN_APP_VERSION__: string | undefined;
declare const __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__: string | undefined;

type SeverityFilterKey = "fatal" | "serious" | "other";
type ViewKey = "explore" | "map" | "details" | "state" | "region" | "similar" | "table" | "settings";
type SelectionReason = "auto" | "program" | "user";
type LoadingStatusKind = "normal" | "problem" | "idle";

interface LatLon {
  lat: number;
  lon: number;
}

interface IntersectionUrlSelection extends LatLon {
  zoomLevel: number | null;
}

interface SiteVersionManifest {
  appVersion?: string;
  analysisCacheVersion?: string;
}

const MOBILE_LAYOUT_QUERY = "(max-width: 640px)";
const APP_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev-cluster-streets";
const ANALYSIS_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ === "string" ? __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ : APP_CACHE_VERSION;
const STREET_VIEW_OPEN_STORAGE_KEY = "sichere-knoten:street-view-open";
const LOADING_FACT_STORAGE_KEY = "sichere-knoten:loading-fact-index";
const ACTIVE_LOCALE: AppLocale = detectLocale();
configureI18n(ACTIVE_LOCALE, TRANSLATIONS);
configureNumberLocale(ACTIVE_LOCALE);
interface BrowseIndex {
  clusters: IntersectionCluster[];
  regionSummaries: RegionSummary[];
  regionsByState: Map<string, RegionSummary[]>;
  topClustersByState: IntersectionCluster[];
  browseClustersByState: Map<string, IntersectionCluster[]>;
  browseClustersByRegion: Map<string, IntersectionCluster[]>;
}

interface SeverityRank {
  rank: number;
  percentile: number;
}

interface SeverityRankContext {
  state: SeverityRank;
  germany: SeverityRank | null;
}

interface SeverityRankCache {
  clusters: IntersectionCluster[];
  clusterIndexes: Map<string, number>;
  hasMultipleStates: boolean;
  stateRanks: Map<string, SeverityRank>;
  germanyRanks: Map<string, SeverityRank>;
}

interface PendingAnalysisCacheWrite {
  cacheContext: AnalysisCacheContext;
  options: AnalysisOptions;
  result: AnalysisResult;
}

interface PostRenderCacheWrites {
  analysis: PendingAnalysisCacheWrite | null;
}

interface UnclusteredIncidentMapCache {
  key: string;
  loadedStateCodes: Set<string>;
  loadingStateCodes: Set<string>;
  records: AccidentRecord[];
  clusteredAccidentKeys: Set<string>;
  clusteredAccidentIndexes: Set<number>;
}

interface SelectedIntersectionViewModel {
  cluster: IntersectionCluster;
  roadClassSignature: RoadClassSignature | null;
  panel: SelectedIntersectionPanelViewModel;
  incidentPoints: SelectedPreviewMapIncidentPoint[];
}

interface CommittedAnalysisState {
  result: AnalysisResult;
  options: AnalysisOptions;
  dataVersion: string | null;
}

let accidents: AccidentRecord[] = [];
let result: AnalysisResult | null = null;
let committedAnalysis: CommittedAnalysisState | null = null;
let selectedCluster: IntersectionCluster | null = null;
let selectedRoadClassSignature: RoadClassSignature | null = null;
let analysisSettingsDirty = false;
let activeDataVersion: string | null = null;
let userLocation: { lat: number; lon: number; accuracyMeters: number | null } | null = null;
let severityRankCache: SeverityRankCache | null = null;
let browseIndexCache: BrowseIndex | null = null;
let unclusteredIncidentMapCache: UnclusteredIncidentMapCache | null = null;
let renderedMapClusters: IntersectionCluster[] | null | undefined;
let postRenderCacheWriteQueue: Promise<void> = Promise.resolve();
let isStreetViewOpen = readStoredStreetViewOpen();
let activeView: ViewKey = "map";
let loadingStatusKind: LoadingStatusKind = "normal";
let activeInteractionTelemetry: InteractionTelemetry | null = null;
let isSplashDisplayed = false;
let loadingFactFallbackIndex = 0;
let pendingUrlIntersectionSelection: IntersectionUrlSelection | null = readIntersectionSelectionFromUrl();

const elements = {
  app: byId<HTMLDivElement>("app"),
  splash: byId<HTMLDivElement>("appSplash"),
  splashLoadingFactMeta: byId<HTMLParagraphElement>("splashLoadingFactMeta"),
  splashLoadingFact: byId<HTMLParagraphElement>("splashLoadingFact"),
  resetAppBtn: byId<HTMLButtonElement>("resetAppBtn"),
  analyzeBtn: byId<HTMLButtonElement>("analyzeBtn"),
  clusterRadius: byId<HTMLInputElement>("clusterRadius"),
  clusterRadiusOut: byId<HTMLInputElement>("clusterRadiusOut"),
  minAccidents: byId<HTMLInputElement>("minAccidents"),
  fatalWeight: byId<HTMLInputElement>("fatalWeight"),
  seriousWeight: byId<HTMLInputElement>("seriousWeight"),
  severityFullSample: byId<HTMLInputElement>("severityFullSample"),
  severityTrendYears: byId<HTMLInputElement>("severityTrendYears"),
  severityTrendDeadZone: byId<HTMLInputElement>("severityTrendDeadZone"),
  severityTrendFullSignal: byId<HTMLInputElement>("severityTrendFullSignal"),
  severityMaxTrendAdjustment: byId<HTMLInputElement>("severityMaxTrendAdjustment"),
  severityMaxPercent: byId<HTMLInputElement>("severityMaxPercent"),
  stateFilter: byId<HTMLSelectElement>("stateFilter"),
  roadUserFocus: byId<HTMLDivElement>("roadUserFocus"),
  yearFilter: byId<HTMLDivElement>("yearFilter"),
  mapColumn: byId<HTMLDivElement>("mapColumn"),
  mapCanvas: byId<HTMLCanvasElement>("mapCanvas"),
  mapEmpty: byId<HTMLDivElement>("mapEmpty"),
  mapLoadingTitle: byId<HTMLHeadingElement>("mapLoadingTitle"),
  mapLoadingStatus: byId<HTMLParagraphElement>("mapLoadingStatus"),
  mapLoadingBar: byId<HTMLDivElement>("mapLoadingBar"),
  selectedAside: byId<HTMLElement>("selectedAside"),
  selectedPermalinkBtn: byId<HTMLButtonElement>("selectedPermalinkBtn"),
  selectedPreviewMap: byId<HTMLDivElement>("selectedPreviewMap"),
  selectedPreviewCanvas: byId<HTMLCanvasElement>("selectedPreviewCanvas"),
  selectionDetails: byId<HTMLDivElement>("selectionDetails"),
  findNearbyBtn: byId<HTMLButtonElement>("findNearbyBtn"),
  nearbyList: byId<HTMLDivElement>("nearbyList"),
  browseState: byId<HTMLSelectElement>("browseState"),
  browseRegionField: byId<HTMLLabelElement>("browseRegionField"),
  browseRegion: byId<HTMLSelectElement>("browseRegion"),
  stateHotspotList: byId<HTMLDivElement>("stateHotspotList"),
  stateRankChart: byId<HTMLDivElement>("stateRankChart"),
  statePopulationRates: byId<HTMLDivElement>("statePopulationRates"),
  statePopulationScatter: byId<HTMLDivElement>("statePopulationScatter"),
  stateSeverityCorrelationScatter: byId<HTMLDivElement>("stateSeverityCorrelationScatter"),
  regionRankChart: byId<HTMLDivElement>("regionRankChart"),
  regionPopulationRates: byId<HTMLDivElement>("regionPopulationRates"),
  regionPopulationScatter: byId<HTMLDivElement>("regionPopulationScatter"),
  regionSeverityCorrelationScatter: byId<HTMLDivElement>("regionSeverityCorrelationScatter"),
  similarIntersections: byId<HTMLDivElement>("similarIntersections"),
  intersectionFeatureSummary: byId<HTMLDivElement>("intersectionFeatureSummary"),
  clusterTableBody: byId<HTMLTableSectionElement>("clusterTableBody"),
  exploreTab: byId<HTMLButtonElement>("exploreTab"),
  mapTab: byId<HTMLButtonElement>("mapTab"),
  detailsTab: byId<HTMLButtonElement>("detailsTab"),
  moreTab: byId<HTMLButtonElement>("moreTab"),
  stateTab: byId<HTMLButtonElement>("stateTab"),
  regionTab: byId<HTMLButtonElement>("regionTab"),
  similarTab: byId<HTMLButtonElement>("similarTab"),
  tableTab: byId<HTMLButtonElement>("tableTab"),
  settingsTab: byId<HTMLButtonElement>("settingsTab"),
  mobileMoreMenu: byId<HTMLDivElement>("mobileMoreMenu"),
  mobileStateTab: byId<HTMLButtonElement>("mobileStateTab"),
  mobileRegionTab: byId<HTMLButtonElement>("mobileRegionTab"),
  mobileTableTab: byId<HTMLButtonElement>("mobileTableTab"),
  mobileSettingsTab: byId<HTMLButtonElement>("mobileSettingsTab"),
  mapView: byId<HTMLElement>("mapView"),
  stateView: byId<HTMLElement>("stateView"),
  regionView: byId<HTMLElement>("regionView"),
  similarView: byId<HTMLElement>("similarView"),
  tableView: byId<HTMLElement>("tableView"),
  settingsView: byId<HTMLElement>("settingsView"),
  showFatalPoints: byId<HTMLInputElement>("showFatalPoints"),
  showSeriousPoints: byId<HTMLInputElement>("showSeriousPoints"),
  showOtherPoints: byId<HTMLInputElement>("showOtherPoints"),
  locateMeBtn: byId<HTMLButtonElement>("locateMeBtn"),
  mapIncidentLegend: byId<HTMLDivElement>("mapIncidentLegend"),
  mapIntersectionLegend: byId<HTMLDivElement>("mapIntersectionLegend"),
  incidentDialog: byId<HTMLDialogElement>("incidentDialog"),
  incidentDialogBody: byId<HTMLDivElement>("incidentDialogBody"),
  streetViewPanel: byId<HTMLElement>("streetViewPanel"),
  streetViewToggle: byId<HTMLButtonElement>("streetViewToggle"),
  streetViewToggleText: byId<HTMLSpanElement>("streetViewToggleText"),
  streetViewBody: byId<HTMLDivElement>("streetViewBody"),
  streetViewFrame: byId<HTMLIFrameElement>("streetViewFrame"),
  streetViewEmpty: byId<HTMLParagraphElement>("streetViewEmpty"),
  exportBtn: byId<HTMLButtonElement>("exportBtn")
};

const dataRepository = new DataRepository();
const requestGate = new RequestGate();
const clusterAccidentRecordMatcher = new ClusterAccidentRecordMatcher(measureActiveInteractionStep);
const selectedIntersectionPanelView = new SelectedIntersectionPanelView({
  container: elements.selectionDetails,
  formatSeverityPercentWithContext
});
const selectedPreviewMapView = new SelectedPreviewMapView({
  container: elements.selectedPreviewMap,
  canvas: elements.selectedPreviewCanvas,
  getSelectedClusterId: () => selectedCluster?.id ?? null,
  clusterRadiusMeters: () => committedAnalysis?.options.clusterRadiusMeters ?? 50
});
const map = new MapCanvas(
  elements.mapCanvas,
  handleClusterSelection,
  openUnclusteredIncidentDialog,
  handleMapIncidentViewportRequest,
  setMapIncidentLegendVisible,
  handleMapZoomChange
);
const tableView = new TableView({
  body: elements.clusterTableBody,
  featureSummary: elements.intersectionFeatureSummary,
  getResult: () => result,
  getStateFilterValue: () => elements.stateFilter.value,
  selectCluster: (cluster) => selectClusterOnMap(cluster)
});
const similarView = new SimilarView({
  container: elements.similarIntersections,
  getResult: () => result,
  getSelectedCluster: () => selectedCluster,
  getSelectedRoadClassSignature: () => selectedRoadClassSignature,
  getActiveView: () => activeView,
  selectCluster: (cluster) => selectClusterOnMap(cluster),
  renderIntersectionFeatureSection: (rows) => tableView.renderIntersectionFeatureSection(rows)
});
const stateRegionView = new StateRegionView({
  stateRankChart: elements.stateRankChart,
  statePopulationRates: elements.statePopulationRates,
  statePopulationScatter: elements.statePopulationScatter,
  stateSeverityCorrelationScatter: elements.stateSeverityCorrelationScatter,
  regionRankChart: elements.regionRankChart,
  regionPopulationRates: elements.regionPopulationRates,
  regionPopulationScatter: elements.regionPopulationScatter,
  regionSeverityCorrelationScatter: elements.regionSeverityCorrelationScatter,
  getResult: () => result,
  getRegionSummaries: () => browseIndexForCurrentResult()?.regionSummaries ?? []
});
const exploreView = new ExploreView({
  nearbyList: elements.nearbyList,
  stateHotspotList: elements.stateHotspotList,
  maxIntersections: STATE_BROWSE_MAX_INTERSECTIONS,
  getResult: () => result,
  getUserLocation: () => userLocation,
  getSelectedCluster: () => selectedCluster,
  getBrowseStateValue: () => elements.browseState.value,
  getBrowseRegionValue: () => elements.browseRegion.value,
  browseIndexForCurrentResult,
  updateBrowseRegionOptions,
  selectCluster: (cluster, telemetrySource) => selectClusterOnMap(cluster, telemetrySource),
  setView: (view) => setView(view)
});
const mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);

startApp();

function startApp(): void {
  applyStaticTranslations();
  showNextLoadingFact();
  isSplashDisplayed = !elements.splash.hidden;
  resetAnalysisControlsToDefaults();
  wireEvents();
  setView(initialView());
  renderAll();
  void checkForFreshDeploymentHtml();
  void loadBundledData();
}

function wireEvents(): void {
  wireApplicationCommands();
  wireAnalysisControlEvents();
  wireMapControlEvents();
  wireNavigationEvents();
  tableView.bindSortEvents();
  similarView.bindEvents();
  wireRankChartEvents();
}

function wireApplicationCommands(): void {
  elements.resetAppBtn.addEventListener("click", () => void resetApp());
  elements.analyzeBtn.addEventListener("click", () => runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);
  elements.selectedPermalinkBtn.addEventListener("click", () => void copySelectedIntersectionPermalink());
  elements.selectionDetails.addEventListener("click", handleSelectionDetailsClick);
  elements.incidentDialog.addEventListener("click", handleIncidentDialogClick);
}

function wireAnalysisControlEvents(): void {
  wireLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut, markAnalysisSettingsDirty);

  wireClampedNumberInput(elements.minAccidents, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.severityFullSample, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.severityTrendYears, markAnalysisSettingsDirty);
  severityPercentDecimalInputs().forEach((input) => wireClampedDecimalInput(input, markAnalysisSettingsDirty));

  elements.stateFilter.addEventListener("input", markAnalysisSettingsDirty);
  elements.stateFilter.addEventListener("change", markAnalysisSettingsDirty);
  roadUserFocusInputs().forEach((input) => input.addEventListener("change", markAnalysisSettingsDirty));
}

function wireMapControlEvents(): void {
  [elements.showFatalPoints, elements.showSeriousPoints, elements.showOtherPoints].forEach((input) => {
    input.addEventListener("change", applySeverityFilter);
  });
  elements.locateMeBtn.addEventListener("click", () => locateUser({ selectNearest: false }));
  elements.findNearbyBtn.addEventListener("click", () => locateUser({ selectNearest: true }));
  elements.streetViewToggle.addEventListener("click", toggleStreetViewPanel);
  elements.browseState.addEventListener("change", () => {
    updateBrowseRegionOptions();
    exploreView.renderStateHotspotList();
  });
  elements.browseRegion.addEventListener("change", () => exploreView.renderStateHotspotList());
}

function wireNavigationEvents(): void {
  elements.exploreTab.addEventListener("click", () => setView("explore"));
  elements.mapTab.addEventListener("click", () => setView("map"));
  elements.detailsTab.addEventListener("click", () => setView("details"));
  elements.moreTab.addEventListener("click", toggleMobileMoreMenu);
  elements.stateTab.addEventListener("click", () => setView("state"));
  elements.regionTab.addEventListener("click", () => setView("region"));
  elements.similarTab.addEventListener("click", () => setView("similar"));
  elements.tableTab.addEventListener("click", () => setView("table"));
  elements.settingsTab.addEventListener("click", () => setView("settings"));
  elements.mobileStateTab.addEventListener("click", () => setView("state"));
  elements.mobileRegionTab.addEventListener("click", () => setView("region"));
  elements.mobileTableTab.addEventListener("click", () => setView("table"));
  elements.mobileSettingsTab.addEventListener("click", () => setView("settings"));
  document.addEventListener("click", closeMobileMoreMenuOnOutsideClick);
  document.addEventListener("keydown", closeMobileMoreMenuOnEscape);
  mobileLayout.addEventListener("change", () => {
    if (!mobileLayout.matches && isMobilePaneView(activeView)) {
      setView("map");
      return;
    }
    setMobileMoreMenuOpen(false);
    scheduleMapRefresh();
  });
}

function wireRankChartEvents(): void {
  [elements.stateRankChart, elements.regionRankChart].forEach((chart) => {
    chart.addEventListener("pointerover", handleRankChartPointerOver);
    chart.addEventListener("pointermove", handleRankChartPointerMove);
    chart.addEventListener("pointerout", handleRankChartPointerOut);
    chart.addEventListener("focusin", handleRankChartFocusIn);
    chart.addEventListener("focusout", handleRankChartFocusOut);
  });
}

function handleRankChartPointerOver(event: PointerEvent): void {
  const chart = rankChartContainer(event.currentTarget);
  const series = rankChartSeriesElement(event.target);
  if (!chart || !series) {
    return;
  }
  setRankChartHover(chart, series);
  positionRankChartTooltip(chart, event);
}

function handleRankChartPointerMove(event: PointerEvent): void {
  const chart = rankChartContainer(event.currentTarget);
  if (chart && rankChartSeriesElement(event.target)) {
    positionRankChartTooltip(chart, event);
  }
}

function handleRankChartPointerOut(event: PointerEvent): void {
  const chart = rankChartContainer(event.currentTarget);
  const series = rankChartSeriesElement(event.target);
  if (!chart || !series || (event.relatedTarget instanceof Node && series.contains(event.relatedTarget))) {
    return;
  }
  clearRankChartHover(chart);
}

function handleRankChartFocusIn(event: FocusEvent): void {
  const chart = rankChartContainer(event.currentTarget);
  const series = rankChartSeriesElement(event.target);
  if (!chart || !series) {
    return;
  }
  setRankChartHover(chart, series);
  positionRankChartTooltipNearElement(chart, series);
}

function handleRankChartFocusOut(event: FocusEvent): void {
  const chart = rankChartContainer(event.currentTarget);
  if (chart) {
    clearRankChartHover(chart);
  }
}

function rankChartContainer(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}

function rankChartSeriesElement(target: EventTarget | null): SVGGElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<SVGGElement>("[data-rank-chart-series]");
}

function setRankChartHover(chart: HTMLElement, activeSeries: SVGGElement): void {
  const svg = activeSeries.closest<SVGSVGElement>(".state-rank-chart-svg");
  if (!svg || !chart.contains(svg)) {
    return;
  }

  chart.querySelectorAll<SVGGElement>("[data-rank-chart-series]").forEach((series) => {
    series.classList.toggle("active", series === activeSeries);
    series.classList.toggle("muted", series !== activeSeries);
  });

  const tooltip = rankChartTooltip(chart);
  if (!tooltip) {
    return;
  }
  tooltip.textContent = activeSeries.dataset.seriesTooltip ?? activeSeries.dataset.seriesName ?? "";
  tooltip.hidden = false;
}

function clearRankChartHover(chart: HTMLElement): void {
  chart.querySelectorAll<SVGGElement>("[data-rank-chart-series]").forEach((series) => {
    series.classList.remove("active", "muted");
  });
  const tooltip = rankChartTooltip(chart);
  if (tooltip) {
    tooltip.hidden = true;
  }
}

function positionRankChartTooltip(chart: HTMLElement, event: PointerEvent): void {
  const tooltip = rankChartTooltip(chart);
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const bounds = chart.getBoundingClientRect();
  const x = event.clientX - bounds.left + 12;
  const y = event.clientY - bounds.top + 12;
  tooltip.style.left = `${round(x, 1)}px`;
  tooltip.style.top = `${round(y, 1)}px`;
}

function positionRankChartTooltipNearElement(chart: HTMLElement, series: SVGGElement): void {
  const tooltip = rankChartTooltip(chart);
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const chartBounds = chart.getBoundingClientRect();
  const seriesBounds = series.getBoundingClientRect();
  tooltip.style.left = `${round(seriesBounds.right - chartBounds.left + 10, 1)}px`;
  tooltip.style.top = `${round(seriesBounds.top - chartBounds.top, 1)}px`;
}

function rankChartTooltip(chart: HTMLElement): HTMLElement | null {
  return chart.querySelector<HTMLElement>(".state-rank-chart-tooltip");
}

function handleSelectionDetailsClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }

  const factsheetButton = event.target.closest<HTMLButtonElement>("[data-selected-action='factsheet']");
  if (factsheetButton) {
    void downloadSelectedFactsheet();
    return;
  }

  const similarButton = event.target.closest<HTMLButtonElement>("[data-selected-action='similar']");
  if (similarButton) {
    setView("similar");
  }
}

function wireLinkedNumberRange(range: HTMLInputElement, numberInput: HTMLInputElement, onDraftChange: () => void): void {
  range.addEventListener("input", () => {
    numberInput.value = range.value;
    onDraftChange();
  });

  numberInput.addEventListener("input", () => {
    const value = Number(numberInput.value);
    if (Number.isFinite(value)) {
      range.value = String(clampNumber(value, inputMin(range), inputMax(range)));
    }
    onDraftChange();
  });

  numberInput.addEventListener("change", () => {
    normalizeLinkedNumberRange(range, numberInput);
    onDraftChange();
  });
}

function wireClampedNumberInput(input: HTMLInputElement, onDraftChange: () => void): void {
  input.addEventListener("input", onDraftChange);
  input.addEventListener("change", () => {
    normalizeNumberInput(input);
    onDraftChange();
  });
}

function wireClampedDecimalInput(input: HTMLInputElement, onDraftChange: () => void): void {
  input.addEventListener("input", onDraftChange);
  input.addEventListener("change", () => {
    normalizeDecimalInput(input);
    onDraftChange();
  });
}

function resetAnalysisControlsToDefaults(): void {
  resetInputToDefault(elements.clusterRadius);
  resetInputToDefault(elements.clusterRadiusOut);
  resetInputToDefault(elements.minAccidents);
  severityPercentInputs().forEach(resetInputToDefault);
  roadUserFocusInputs().forEach((input) => {
    input.checked = input.defaultChecked;
  });
  normalizeLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut);
  normalizeNumberInput(elements.minAccidents);
  normalizeSeverityPercentInputs();
}

function resetInputToDefault(input: HTMLInputElement): void {
  if (input.defaultValue !== "") {
    input.value = input.defaultValue;
  }
}

function normalizeLinkedNumberRange(range: HTMLInputElement, numberInput: HTMLInputElement): void {
  const fallback = Number(range.value);
  const value = Number.isFinite(Number(numberInput.value)) ? Number(numberInput.value) : fallback;
  const normalized = clampNumber(value, inputMin(numberInput), inputMax(numberInput));
  numberInput.value = String(normalized);
  range.value = String(normalized);
}

function normalizeNumberInput(input: HTMLInputElement): number {
  const fallback = Number.isFinite(Number(input.defaultValue)) ? Number(input.defaultValue) : inputMin(input);
  const value = Number.isFinite(Number(input.value)) ? Number(input.value) : fallback;
  const normalized = Math.trunc(clampNumber(value, inputMin(input), inputMax(input)));
  input.value = String(normalized);
  return normalized;
}

function normalizeDecimalInput(input: HTMLInputElement): number {
  const fallback = Number.isFinite(Number(input.defaultValue)) ? Number(input.defaultValue) : inputMin(input);
  const value = Number.isFinite(Number(input.value)) ? Number(input.value) : fallback;
  const normalized = clampNumber(value, inputMin(input), inputMax(input));
  input.value = formatInputNumber(normalized);
  return normalized;
}

function normalizeSeverityPercentInputs(): void {
  normalizeNumberInput(elements.severityFullSample);
  normalizeNumberInput(elements.severityTrendYears);
  severityPercentDecimalInputs().forEach(normalizeDecimalInput);
}

function severityPercentInputs(): HTMLInputElement[] {
  return [
    elements.fatalWeight,
    elements.seriousWeight,
    elements.severityFullSample,
    elements.severityTrendYears,
    elements.severityTrendDeadZone,
    elements.severityTrendFullSignal,
    elements.severityMaxTrendAdjustment,
    elements.severityMaxPercent
  ];
}

function severityPercentDecimalInputs(): HTMLInputElement[] {
  return [
    elements.fatalWeight,
    elements.seriousWeight,
    elements.severityTrendDeadZone,
    elements.severityTrendFullSignal,
    elements.severityMaxTrendAdjustment,
    elements.severityMaxPercent
  ];
}

function formatInputNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value, 4));
}

function markAnalysisSettingsDirty(): void {
  if (!dataRepository.hasAnyAccidents() && !committedAnalysis) {
    return;
  }
  analysisSettingsDirty = !committedAnalysis || !analysisOptionsEqual(readDraftAnalysisOptions(), committedAnalysis.options);
  updateAnalyzeButton();
  if (analysisSettingsDirty && committedAnalysis) {
    setStatus(tr("status.settingsChanged"), 100);
  }
}

async function checkForFreshDeploymentHtml(): Promise<void> {
  if (!isBuiltAppVersion(APP_CACHE_VERSION)) {
    return;
  }

  try {
    const url = new URL("./assets/site-version.json", document.baseURI);
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url.href, { cache: "no-store" });
    if (!response.ok) {
      return;
    }

    const manifest = (await response.json()) as SiteVersionManifest;
    const latestAppVersion = typeof manifest.appVersion === "string" ? manifest.appVersion : null;
    if (!latestAppVersion || latestAppVersion === APP_CACHE_VERSION) {
      return;
    }

    reloadFreshDeploymentHtml(latestAppVersion);
  } catch (error) {
    console.info("[Safe Intersections] Could not check deployment version.", error);
  }
}

function isBuiltAppVersion(version: string): boolean {
  return /^[a-f0-9]{16}$/i.test(version);
}

function reloadFreshDeploymentHtml(latestAppVersion: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("v") === latestAppVersion) {
    return;
  }

  url.searchParams.set("v", latestAppVersion);
  window.location.replace(url.href);
}

function repositoryTelemetry(telemetry: InitializationTelemetry | null): DataRepositoryTelemetry | null {
  if (!telemetry) {
    return null;
  }

  return {
    measure: (name, detail, work, metadata) => measureInitializationStep(telemetry, name, detail, work, metadata),
    record: (name, detail, metadata) => recordInitializationStep(telemetry, name, detail, metadata)
  };
}

function clearCommittedAnalysisState(): void {
  result = null;
  committedAnalysis = null;
  selectedCluster = null;
  selectedRoadClassSignature = null;
  clearAnalysisDerivedState();
  analysisSettingsDirty = false;
  updateAnalyzeButton();
}

function commitAnalysisState(options: AnalysisOptions, analysisResult: AnalysisResult): void {
  result = analysisResult;
  committedAnalysis = {
    result: analysisResult,
    options: cloneAnalysisOptions(options),
    dataVersion: activeDataVersion
  };
  selectedCluster = null;
  selectedRoadClassSignature = null;
  clearAnalysisDerivedState();
  analysisSettingsDirty = false;
  updateAnalyzeButton();
}

function clearAnalysisDerivedState(): void {
  clusterAccidentRecordMatcher.clearCaches();
  severityRankCache = null;
  browseIndexCache = null;
  invalidateRenderedAnalysisViews();
  unclusteredIncidentMapCache = null;
  map.setUnclusteredIncidentPoints([]);
}

function invalidateRenderedAnalysisViews(): void {
  renderedMapClusters = undefined;
  stateRegionView.invalidate();
  tableView.invalidate();
}

async function loadBundledData(): Promise<void> {
  const telemetry = createInitializationTelemetry(APP_CACHE_VERSION);
  setBusy(true);
  let analysisStarted = false;
  try {
    accidents = [];
    clearCommittedAnalysisState();
    dataRepository.resetRuntimeState();
    activeDataVersion = null;
    populateFilters();
    renderAll();
    setStatus(tr("status.loadingDataManifest"), 2);
    await dataRepository.ensureManifest(repositoryTelemetry(telemetry));
    const dataVersion = dataRepository.dataVersion();
    telemetry.dataVersion = dataVersion;
    activeDataVersion = dataVersion;
    populateFilters();
    recordInitializationStep(telemetry, "skip parsed data cache", dataVersion, {
      reason: "normalized bundle is faster than IndexedDB object cache"
    });

    const options = readDraftAnalysisOptions();
    const cacheContext = { dataVersion, appVersion: ANALYSIS_CACHE_VERSION };
    const bundledDefaultAnalysis = await dataRepository.readDefaultAnalysis(
      dataVersion,
      ANALYSIS_CACHE_VERSION,
      options,
      analysisTelemetryDetail(options),
      repositoryTelemetry(telemetry)
    );
    if (bundledDefaultAnalysis) {
      commitAnalysisState(options, bundledDefaultAnalysis);
      await measureInitializationStep(
        telemetry,
        "render analysis results",
        analysisTelemetryDetail(options),
        async () => {
          renderAll();
        },
        () => ({ clusterCount: result?.clusters.length ?? 0 })
      );
      scheduleSelectionSupportPrewarm();
      setStatus(trf("status.intersectionClustersLoadedFromBundle", { count: formatInteger(bundledDefaultAnalysis.clusters.length) }), 100);
      setBusy(false);
      logInitializationTelemetry(telemetry, "done");
      return;
    }

    setStatus(tr("status.checkingAnalysisCache"), 20);
    const cachedAnalysis = await measureInitializationStep(
      telemetry,
      "read analysis cache",
      analysisTelemetryDetail(options),
      () => dataRepository.readCachedAnalysis(cacheContext, options),
      (cachedResult) => ({
        cacheHit: Boolean(cachedResult),
        clusterCount: cachedResult?.clusters.length ?? 0
      })
    );
    if (cachedAnalysis) {
      commitAnalysisState(options, cachedAnalysis);
      await measureInitializationStep(
        telemetry,
        "render analysis results",
        analysisTelemetryDetail(options),
        async () => {
          renderAll();
        },
        () => ({ clusterCount: result?.clusters.length ?? 0 })
      );
      scheduleSelectionSupportPrewarm();
      setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(cachedAnalysis.clusters.length) }), 100);
      setBusy(false);
      logInitializationTelemetry(telemetry, "done");
      return;
    }

    setStatus(tr("status.cacheMissParsingBundled"), 10);
    await loadAccidentData(telemetry);
    setStatus(trf("status.accidentRecordsLoaded", { count: formatInteger(accidents.length) }), 60);

    analysisStarted = true;
    const requestToken = requestGate.start("analysis", "startup fallback");
    void runAnalysisWithCache(options, cacheContext, telemetry, "analysis cache already missed before accident records loaded", null, requestToken);
  } catch (error) {
    setStatus(errorMessage(error), 0, "problem");
    logInitializationTelemetry(telemetry, "error");
  } finally {
    if (!analysisStarted) {
      setBusy(false);
    }
  }
}

function runAnalysis(initializationTelemetry: InitializationTelemetry | null = null): void {
  normalizeLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut);
  const options = readDraftAnalysisOptions();
  const cacheContext = activeDataVersion ? { dataVersion: activeDataVersion, appVersion: ANALYSIS_CACHE_VERSION } : null;
  const requestToken = requestGate.start("analysis", analysisTelemetryDetail(options));
  setBusy(true);
  void runAnalysisWhenAccidentsReady(requestToken, options, cacheContext, initializationTelemetry);
}

async function runAnalysisWhenAccidentsReady(
  requestToken: RequestToken,
  options: AnalysisOptions,
  cacheContext: AnalysisCacheContext | null,
  initializationTelemetry: InitializationTelemetry | null
): Promise<void> {
  try {
    await runAnalysisWithCache(options, cacheContext, initializationTelemetry, null, null, requestToken);
  } catch (error) {
    if (requestGate.isCurrent(requestToken)) {
      setStatus(errorMessage(error), 0, "problem");
      setBusy(false);
      logInitializationTelemetry(initializationTelemetry, "error");
    }
  }
}

async function runAnalysisWithCache(
  options: AnalysisOptions,
  cacheContext: AnalysisCacheContext | null,
  initializationTelemetry: InitializationTelemetry | null = null,
  skipAnalysisCacheReason: string | null = null,
  analysisAccidents: AccidentRecord[] | null = null,
  requestToken: RequestToken | null = null
): Promise<void> {
  let telemetryStatus: InitializationTelemetryStatus = "done";
  try {
    if (cacheContext && skipAnalysisCacheReason) {
      recordInitializationStep(initializationTelemetry, "skip analysis cache", analysisTelemetryDetail(options), {
        reason: skipAnalysisCacheReason
      });
    } else if (cacheContext) {
      setStatus(tr("status.checkingAnalysisCache"), 75);
      const cached = await measureInitializationStep(
        initializationTelemetry,
        "read analysis cache",
        analysisTelemetryDetail(options),
        () => dataRepository.readCachedAnalysis(cacheContext, options),
        (cachedResult) => ({
          cacheHit: Boolean(cachedResult),
          clusterCount: cachedResult?.clusters.length ?? 0
        })
      );
      if (cached) {
        if (requestToken && !requestGate.isCurrent(requestToken)) {
          return;
        }
        commitAnalysisState(options, cached);
        await measureInitializationStep(
          initializationTelemetry,
          "render analysis results",
          analysisTelemetryDetail(options),
          async () => {
            renderAll();
          },
          () => ({ clusterCount: result?.clusters.length ?? 0 })
        );
        scheduleSelectionSupportPrewarm();
        setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(cached.clusters.length) }), 100);
        return;
      }
    }

    if (requestToken && !requestGate.isCurrent(requestToken)) {
      return;
    }
    setStatus(tr("status.analyzingIntersections"), 75);
    await yieldToBrowser();
    let analysisPlan: AnalysisExecutionPlan | null = null;
    const sourceAccidents = analysisAccidents ?? (await loadAccidentsForAnalysis(options, initializationTelemetry));
    if (requestToken && !requestGate.isCurrent(requestToken)) {
      return;
    }
    const analyzedResult = await measureInitializationStep(
      initializationTelemetry,
      "analyze intersections",
      analysisTelemetryDetail(options),
      () =>
        analyzeDangerousIntersectionsInBackground(sourceAccidents, options, (plan) => {
          analysisPlan = plan;
          if (!requestToken || requestGate.isCurrent(requestToken)) {
            updateAnalysisPlanStatus();
          }
        }),
      (analysisResult) => ({
        accidentCount: sourceAccidents.length,
        filteredAccidentCount: analysisResult.filteredAccidentCount,
        clusterCount: analysisResult.clusters.length,
        workerCount: analysisPlan?.workerCount ?? 0,
        partitionCount: analysisPlan?.partitionCount ?? 1,
        background: analysisPlan?.background ?? false,
        fallback: analysisPlan?.fallback ?? false,
        parallel: analysisPlan?.parallel ?? false
      })
    );
    if (requestToken && !requestGate.isCurrent(requestToken)) {
      return;
    }
    commitAnalysisState(options, analyzedResult);
    await measureInitializationStep(
      initializationTelemetry,
      "render analysis results",
      analysisTelemetryDetail(options),
      async () => {
        renderAll();
      },
      () => ({ clusterCount: result?.clusters.length ?? 0 })
    );
    scheduleSelectionSupportPrewarm();

    setStatus(trf("status.intersectionClustersAnalyzed", { count: formatInteger(analyzedResult.clusters.length) }), 100);
    enqueuePostRenderCacheWrites(initializationTelemetry, {
      analysis:
        cacheContext
          ? {
              cacheContext,
              options: cloneAnalysisOptions(options),
              result: analyzedResult
            }
          : null
    });
  } catch (error) {
    if (!requestToken || requestGate.isCurrent(requestToken)) {
      telemetryStatus = "error";
      setStatus(errorMessage(error), 0, "problem");
    }
  } finally {
    if (!requestToken || requestGate.isCurrent(requestToken)) {
      setBusy(false);
      logInitializationTelemetry(initializationTelemetry, telemetryStatus);
    }
  }
}

function updateAnalysisPlanStatus(): void {
  setStatus(tr("status.analyzingIntersections"), 75);
}

function readDraftAnalysisOptions(): AnalysisOptions {
  const years = new Set<number>();
  elements.yearFilter.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((input) => {
    if (input.checked) {
      years.add(Number(input.value));
    }
  });

  return {
    clusterRadiusMeters: Number(elements.clusterRadiusOut.value),
    minAccidents: normalizeNumberInput(elements.minAccidents),
    years,
    roadUserFocus: readRoadUserFocus(),
    stateCode: elements.stateFilter.value as AnalysisOptions["stateCode"],
    severityPercent: readSeverityPercentOptions()
  };
}

function readRoadUserFocus(): Set<RoadUserKey> {
  const focus = new Set<RoadUserKey>();
  roadUserFocusInputs().forEach((input) => {
    if (input.checked && isRoadUserKey(input.value)) {
      focus.add(input.value);
    }
  });
  return focus;
}

function roadUserFocusInputs(): HTMLInputElement[] {
  return Array.from(elements.roadUserFocus.querySelectorAll<HTMLInputElement>("input[data-road-user-focus]"));
}

function isRoadUserKey(value: string): value is RoadUserKey {
  return ROAD_USER_DEFINITIONS.some((definition) => definition.key === value);
}

function readSeverityPercentOptions(): SeverityPercentOptions {
  const trendDeadZonePercent = normalizeDecimalInput(elements.severityTrendDeadZone);
  const trendFullSignalPercent = Math.max(trendDeadZonePercent + 0.1, normalizeDecimalInput(elements.severityTrendFullSignal));
  elements.severityTrendFullSignal.value = formatInputNumber(trendFullSignalPercent);

  return {
    fatalWeight: normalizeDecimalInput(elements.fatalWeight),
    seriousWeight: normalizeDecimalInput(elements.seriousWeight),
    fullSampleAccidents: normalizeNumberInput(elements.severityFullSample),
    trendYears: normalizeNumberInput(elements.severityTrendYears),
    trendDeadZone: trendDeadZonePercent / 100,
    trendFullSignal: trendFullSignalPercent / 100,
    maxTrendAdjustment: normalizeDecimalInput(elements.severityMaxTrendAdjustment) / 100,
    maxSeverityPercent: normalizeDecimalInput(elements.severityMaxPercent) / 100
  };
}

function cloneAnalysisOptions(options: AnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    roadUserFocus: new Set(options.roadUserFocus),
    severityPercent: { ...options.severityPercent }
  };
}

function analysisOptionsEqual(left: AnalysisOptions, right: AnalysisOptions): boolean {
  return JSON.stringify(serializeAnalysisOptions(left)) === JSON.stringify(serializeAnalysisOptions(right));
}

function populateFilters(): void {
  const selectedState = elements.stateFilter.value;
  const selectedBrowseState = elements.browseState.value;
  const selectedBrowseRegion = elements.browseRegion.value;
  const previousYearInputs = Array.from(elements.yearFilter.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
  const selectedYears = new Set(previousYearInputs.filter((input) => input.checked).map((input) => Number(input.value)));
  const hadYearFilters = previousYearInputs.length > 0;
  elements.stateFilter.replaceChildren(new Option(tr("option.allStates"), "all"));
  elements.browseState.replaceChildren(new Option(tr("option.allStates"), "all"));
  const availableStateCodes = stateCodesForFilters();
  const stateOptions = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1], "de", { sensitivity: "base" }));
  for (const [code, name] of stateOptions) {
    if (availableStateCodes.has(code)) {
      elements.stateFilter.append(new Option(name, code));
      elements.browseState.append(new Option(name, code));
    }
  }
  elements.stateFilter.value = [...elements.stateFilter.options].some((option) => option.value === selectedState) ? selectedState : "all";
  elements.browseState.value = [...elements.browseState.options].some((option) => option.value === selectedBrowseState)
    ? selectedBrowseState
    : "all";
  updateBrowseRegionOptions(selectedBrowseRegion);

  const years = yearsForFilters();
  elements.yearFilter.innerHTML = "";
  for (const year of years) {
    const label = document.createElement("label");
    label.className = "year-pill";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(year);
    input.checked = hadYearFilters ? selectedYears.has(year) : true;
    input.addEventListener("change", markAnalysisSettingsDirty);
    label.append(input, document.createTextNode(String(year)));
    elements.yearFilter.append(label);
  }
  setAnalysisControlsDisabled(elements.analyzeBtn.disabled);
}

function updateBrowseRegionOptions(preferredRegion = elements.browseRegion.value): void {
  const stateCode = elements.browseState.value;
  const shouldShow = Boolean(result) && stateCode !== "all";
  elements.browseRegionField.hidden = !shouldShow;
  elements.browseRegion.disabled = !shouldShow;

  if (!shouldShow) {
    elements.browseRegion.replaceChildren(new Option(tr("option.allRegions"), "all"));
    elements.browseRegion.value = "all";
    return;
  }

  const regions = browseIndexForCurrentResult()?.regionsByState.get(stateCode) ?? [];
  elements.browseRegion.replaceChildren(new Option(tr("option.allRegions"), "all"));
  for (const region of regions) {
    elements.browseRegion.append(new Option(regionOptionLabel(region), region.key));
  }
  elements.browseRegion.value = [...elements.browseRegion.options].some((option) => option.value === preferredRegion)
    ? preferredRegion
    : "all";
}

function stateCodesForFilters(): Set<string> {
  if (accidents.length > 0) {
    return new Set(accidents.map((accident) => accident.stateCode));
  }
  return new Set(Object.keys(STATE_NAMES));
}

function yearsForFilters(): number[] {
  if (accidents.length > 0) {
    return Array.from(new Set(accidents.map((accident) => accident.year).filter(Boolean))).sort((a, b) => a - b);
  }
  const manifestYears = bundledDataYears();
  if (manifestYears.length > 0) {
    return manifestYears;
  }
  return result?.years ?? [];
}

function bundledDataYears(): number[] {
  return dataRepository.bundledYears();
}

function renderAll(): void {
  updateRangeOutputs();
  exploreView.render();
  renderActiveAnalysisView();
  applySeverityFilter();
  renderMapResults();
}

function renderMapResults(): void {
  if (result) {
    if (renderedMapClusters !== result.clusters) {
      map.setData(result.clusters);
      renderedMapClusters = result.clusters;
    }
    elements.mapEmpty.hidden = result.clusters.length > 0;
    updateMapLegendVisibility();
    applyPendingUrlIntersectionSelection();
  } else {
    if (renderedMapClusters !== null) {
      map.setData([]);
      renderedMapClusters = null;
    }
    elements.mapEmpty.hidden = false;
    elements.mapIncidentLegend.hidden = true;
    updateMapLegendVisibility();
    renderSelection(null);
  }
}

function handleClusterSelection(cluster: IntersectionCluster | null, reason: SelectionReason): void {
  const previousClusterId = selectedCluster?.id ?? null;
  measureActiveInteractionStep("store selected cluster", cluster?.id ?? null, () => {
    selectedCluster = cluster;
    selectedRoadClassSignature = null;
  });
  if (cluster) {
    updateIntersectionSelectionUrl(cluster);
  }
  if (previousClusterId !== (cluster?.id ?? null)) {
    requestGate.cancel("selectedAccidentRecords");
    requestGate.cancel("factsheet");
  }
  measureActiveInteractionStep(
    "render selected intersection panel",
    cluster?.id ?? null,
    () => renderSelection(cluster),
    () => ({
      selected: Boolean(cluster),
      accidentCount: cluster?.accidentCount ?? 0
    })
  );
  measureActiveInteractionStep(
    "rerender browse lists after selection",
    cluster?.id ?? null,
    () => exploreView.render(),
    () => ({
      stateHotspotCount: elements.stateHotspotList.children.length,
      nearbyCount: elements.nearbyList.children.length
    })
  );

  if (!cluster) {
    return;
  }

  if (reason === "user" && mobileLayout.matches) {
    measureActiveInteractionStep("mobile map focus", cluster.id, () => map.focus(cluster));
    measureActiveInteractionStep("mobile set view details", cluster.id, () => setView("details"), () => ({ activeView }));
  }
}

function applyPendingUrlIntersectionSelection(): void {
  if (!pendingUrlIntersectionSelection || !result) {
    return;
  }

  const selection = pendingUrlIntersectionSelection;
  pendingUrlIntersectionSelection = null;
  const nearest = nearestClusterTo(selection);
  if (!nearest || nearest.distanceMeters > INTERSECTION_URL_MATCH_MAX_DISTANCE_METERS) {
    return;
  }

  selectClusterOnMap(nearest.cluster, "intersection URL", selection.zoomLevel);
}

function nearestClusterTo(point: LatLon): { cluster: IntersectionCluster; distanceMeters: number } | null {
  let nearest: { cluster: IntersectionCluster; distanceMeters: number } | null = null;
  for (const cluster of result?.clusters ?? []) {
    const clusterDistance = distanceMeters(point, cluster);
    if (
      !nearest ||
      clusterDistance < nearest.distanceMeters ||
      (clusterDistance === nearest.distanceMeters && compareClusterCoreMetric(cluster, nearest.cluster) < 0)
    ) {
      nearest = { cluster, distanceMeters: clusterDistance };
    }
  }
  return nearest;
}

function readIntersectionSelectionFromUrl(): IntersectionUrlSelection | null {
  const params = new URLSearchParams(window.location.search);
  const lat = parseUrlCoordinate(params.get("lat"));
  const lon = parseUrlCoordinate(params.get("lon"));
  const zoomLevel = parseUrlZoom(params.get("z"));
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon, zoomLevel };
}

function readViewFromUrl(): ViewKey | null {
  return parseUrlView(new URLSearchParams(window.location.search).get(VIEW_URL_PARAM));
}

function parseUrlView(value: string | null): ViewKey | null {
  const normalizedValue = value?.trim().toLocaleLowerCase("en");
  switch (normalizedValue) {
    case "browse":
    case "explore":
      return "explore";
    case "map":
      return "map";
    case "details":
      return "details";
    case "state":
      return "state";
    case "region":
      return "region";
    case "similar":
      return "similar";
    case "intersections":
    case "table":
      return "table";
    case "settings":
      return "settings";
    default:
      return null;
  }
}

function urlViewValue(view: ViewKey): string {
  return view === "table" ? "intersections" : view;
}

function updateViewUrl(view: ViewKey): void {
  const url = new URL(window.location.href);
  if (view === "map") {
    if (!url.searchParams.has(VIEW_URL_PARAM)) {
      return;
    }
    url.searchParams.delete(VIEW_URL_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
    return;
  }

  const urlValue = urlViewValue(view);
  if (url.searchParams.get(VIEW_URL_PARAM) === urlValue) {
    return;
  }
  url.searchParams.set(VIEW_URL_PARAM, urlValue);
  window.history.replaceState(window.history.state, "", url.toString());
}

function parseUrlCoordinate(value: string | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const coordinate = Number(trimmed);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function parseUrlZoom(value: string | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const zoom = Math.round(Number(trimmed));
  if (!Number.isFinite(zoom) || zoom < INTERSECTION_URL_ZOOM_MIN || zoom > INTERSECTION_URL_ZOOM_MAX) {
    return null;
  }
  return zoom;
}

function updateIntersectionSelectionUrl(cluster: IntersectionCluster): void {
  const url = new URL(window.location.href);
  const lat = cluster.lat.toFixed(INTERSECTION_URL_COORDINATE_DECIMALS);
  const lon = cluster.lon.toFixed(INTERSECTION_URL_COORDINATE_DECIMALS);
  const zoom = String(map.zoomLevel());
  if (url.searchParams.get("lat") === lat && url.searchParams.get("lon") === lon && url.searchParams.get("z") === zoom) {
    return;
  }

  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  url.searchParams.set("z", zoom);
  window.history.replaceState(window.history.state, "", url.toString());
}

function applySeverityFilter(): void {
  map.setSeverityFilters({
    fatal: elements.showFatalPoints.checked,
    serious: elements.showSeriousPoints.checked,
    other: elements.showOtherPoints.checked
  });
}

function setMapIncidentLegendVisible(isVisible: boolean): void {
  elements.mapIncidentLegend.hidden = !isVisible;
  updateMapLegendVisibility();
}

function updateMapLegendVisibility(): void {
  const hasIntersections = Boolean(result && result.clusters.length > 0);
  const hasIncidentLegend = !elements.mapIncidentLegend.hidden;
  elements.mapIntersectionLegend.hidden = hasIncidentLegend || !hasIntersections;
}

function handleMapZoomChange(): void {
  if (selectedCluster) {
    updateIntersectionSelectionUrl(selectedCluster);
  }
}

function handleMapIncidentViewportRequest(request: MapIncidentViewportRequest): void {
  const stateCodes = stateCodesForIncidentMapRequest(request);
  if (stateCodes.length === 0) {
    return;
  }
  ensureUnclusteredIncidentStatesLoaded(stateCodes);
}

function stateCodesForIncidentMapRequest(request: MapIncidentViewportRequest): string[] {
  const options = committedAnalysis?.options;
  if (!options) {
    return [];
  }
  if (options.stateCode !== "all") {
    return [options.stateCode];
  }
  const seen = new Set<string>();
  const stateCodes: string[] = [];
  for (const stateCode of request.stateCodes) {
    if (!STATE_NAMES[stateCode] || seen.has(stateCode)) {
      continue;
    }
    seen.add(stateCode);
    stateCodes.push(stateCode);
  }
  return stateCodes;
}

function ensureUnclusteredIncidentStatesLoaded(stateCodes: string[]): void {
  const cache = unclusteredIncidentMapCacheForCurrentResult();
  if (!cache) {
    return;
  }

  for (const stateCode of stateCodes) {
    if (cache.loadedStateCodes.has(stateCode) || cache.loadingStateCodes.has(stateCode) || !hasAccidentStateShard(stateCode)) {
      continue;
    }
    cache.loadingStateCodes.add(stateCode);
    void loadUnclusteredIncidentState(stateCode, cache.key);
  }
}

function unclusteredIncidentMapCacheForCurrentResult(): UnclusteredIncidentMapCache | null {
  const key = unclusteredIncidentMapCacheKey();
  if (!key || !result) {
    return null;
  }
  if (unclusteredIncidentMapCache?.key === key) {
    return unclusteredIncidentMapCache;
  }

  const membership = clusteredAccidentMembership(result.clusters);
  unclusteredIncidentMapCache = {
    key,
    loadedStateCodes: new Set(),
    loadingStateCodes: new Set(),
    records: [],
    clusteredAccidentKeys: membership.keys,
    clusteredAccidentIndexes: membership.indexes
  };
  map.setUnclusteredIncidentPoints([]);
  return unclusteredIncidentMapCache;
}

function unclusteredIncidentMapCacheKey(): string | null {
  if (!committedAnalysis || !result) {
    return null;
  }
  return [
    committedAnalysis.dataVersion ?? "unknown-data",
    analysisOptionsIndexKey(committedAnalysis.options, 0),
    result.filteredAccidentCount,
    result.clusters.length
  ].join("|");
}

async function loadUnclusteredIncidentState(stateCode: string, cacheKey: string): Promise<void> {
  try {
    const stateRecords = await loadAccidentsForState(stateCode);
    const cache = unclusteredIncidentMapCache;
    if (!cache || cache.key !== cacheKey || !committedAnalysis) {
      return;
    }

    const records = unclusteredIncidentRecordsForMap(stateRecords, committedAnalysis.options, cache);
    for (const record of records) {
      cache.records.push(record);
    }
    cache.loadedStateCodes.add(stateCode);
    map.setUnclusteredIncidentPoints(cache.records);
  } catch (error) {
    console.warn("[Safe Intersections] Could not load unclustered map incidents.", { stateCode, error });
  } finally {
    const cache = unclusteredIncidentMapCache;
    if (cache?.key === cacheKey) {
      cache.loadingStateCodes.delete(stateCode);
    }
  }
}

function unclusteredIncidentRecordsForMap(
  sourceRecords: AccidentRecord[],
  options: AnalysisOptions,
  cache: UnclusteredIncidentMapCache
): AccidentRecord[] {
  return sourceRecords.filter(
    (accident) => accidentMatchesAnalysisOptions(accident, options) && !isClusteredAccidentInCurrentResult(accident, cache)
  );
}

function isClusteredAccidentInCurrentResult(accident: AccidentRecord, cache: UnclusteredIncidentMapCache): boolean {
  if (typeof accident.recordIndex === "number" && cache.clusteredAccidentIndexes.has(accident.recordIndex)) {
    return true;
  }
  return cache.clusteredAccidentKeys.has(accidentKey(accident));
}

function locateUser(options: { selectNearest: boolean }): void {
  if (!navigator.geolocation) {
    setStatus(tr("status.geolocationUnavailable"), 100);
    return;
  }

  setLocateBusy(true);
  setStatus(tr("status.requestingLocation"), 100);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      userLocation = { lat: latitude, lon: longitude, accuracyMeters: accuracy };
      map.setUserLocation(userLocation, !options.selectNearest);
      elements.locateMeBtn.classList.add("located");
      setLocateBusy(false);
      exploreView.render();
      const selectedNearest = options.selectNearest ? exploreView.selectNearestCluster() : null;
      if (options.selectNearest) {
        setStatus(
          selectedNearest
            ? trf("status.nearestIntersection", {
                distance: formatDistance(selectedNearest.distanceMeters),
                accuracy: formatInteger(Math.round(accuracy))
              })
            : trf("status.centeredNoMatch", { accuracy: formatInteger(Math.round(accuracy)) }),
          100
        );
      } else {
        setStatus(trf("status.centeredLocation", { accuracy: formatInteger(Math.round(accuracy)) }), 100);
      }
    },
    (error) => {
      elements.locateMeBtn.classList.remove("located");
      setLocateBusy(false);
      setStatus(geolocationErrorMessage(error), 100);
    },
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
  );
}

function setLocateBusy(isBusy: boolean): void {
  elements.locateMeBtn.disabled = isBusy;
  elements.findNearbyBtn.disabled = isBusy;
  elements.locateMeBtn.classList.toggle("locating", isBusy);
  elements.locateMeBtn.setAttribute("aria-busy", String(isBusy));
  elements.findNearbyBtn.setAttribute("aria-busy", String(isBusy));
}

function geolocationErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return tr("status.locationDenied");
    case error.POSITION_UNAVAILABLE:
      return tr("status.locationUnavailable");
    case error.TIMEOUT:
      return tr("status.locationTimedOut");
    default:
      return tr("status.locationFailed");
  }
}

function renderTables(): void {
  stateRegionView.renderAll();
  tableView.render();
  similarView.renderIfVisible();
}

function renderActiveAnalysisView(): void {
  switch (activeView) {
    case "state":
      stateRegionView.renderState();
      return;
    case "region":
      stateRegionView.renderRegion();
      return;
    case "table":
      tableView.render();
      return;
    case "similar":
      similarView.renderIfVisible();
      return;
    default:
      return;
  }
}

function browseIndexForCurrentResult(): BrowseIndex | null {
  const clusters = result?.clusters;
  if (!clusters) {
    return null;
  }
  if (browseIndexCache?.clusters === clusters) {
    return browseIndexCache;
  }
  browseIndexCache = buildBrowseIndex(clusters);
  return browseIndexCache;
}

function buildBrowseIndex(clusters: IntersectionCluster[]): BrowseIndex {
  const byRegion = new Map<string, RegionSummaryAccumulator>();
  const regionsByState = new Map<string, RegionSummary[]>();
  const browseClustersByState = new Map<string, IntersectionCluster[]>();
  const browseClustersByRegion = new Map<string, IntersectionCluster[]>();
  const topClusterByState = new Map<string, IntersectionCluster>();

  for (const cluster of clusters) {
    const regionName = clusterRegionName(cluster);
    const key = clusterRegionKey(cluster);
    const summary =
      byRegion.get(key) ??
      ({
        key,
        stateCode: cluster.stateCode,
        stateName: cluster.stateName,
        regionName,
        population: cluster.administrativeRegionPopulation,
        accidentCount: 0,
        clusterCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        severityPercent: 0,
        weightedSeverityPercent: 0,
        topCluster: null,
        clusters: []
      } satisfies RegionSummaryAccumulator);

    summary.accidentCount += cluster.accidentCount;
    summary.clusterCount += 1;
    summary.fatalCount += cluster.fatalCount;
    summary.seriousCount += cluster.seriousCount;
    summary.weightedSeverityPercent += cluster.severityPercent * cluster.accidentCount;
    summary.population ??= cluster.administrativeRegionPopulation;
    summary.clusters.push(cluster);
    if (!summary.topCluster || compareClusterCoreMetric(cluster, summary.topCluster) < 0) {
      summary.topCluster = cluster;
    }
    byRegion.set(key, summary);

    const stateTopCluster = topClusterByState.get(cluster.stateCode);
    if (!stateTopCluster || compareClusterCoreMetric(cluster, stateTopCluster) < 0) {
      topClusterByState.set(cluster.stateCode, cluster);
    }

    if (cluster.severityPercent >= STATE_BROWSE_MIN_SEVERITY_PERCENT) {
      insertSortedClusterMapItem(browseClustersByState, cluster.stateCode, cluster, STATE_BROWSE_MAX_INTERSECTIONS);
      insertSortedClusterMapItem(browseClustersByRegion, key, cluster, STATE_BROWSE_MAX_INTERSECTIONS);
    }
  }

  const regionSummaries = Array.from(byRegion.values())
    .map((summary): RegionSummary => ({
      key: summary.key,
      stateCode: summary.stateCode,
      stateName: summary.stateName,
      regionName: summary.regionName,
      population: summary.population,
      accidentCount: summary.accidentCount,
      clusterCount: summary.clusterCount,
      fatalCount: summary.fatalCount,
      seriousCount: summary.seriousCount,
      severityPercent: summary.accidentCount > 0 ? summary.weightedSeverityPercent / summary.accidentCount : 0,
      topCluster: summary.topCluster,
      clusters: summary.clusters
    }))
    .sort(compareRegionSummaries);

  for (const summary of regionSummaries) {
    appendMapListItem(regionsByState, summary.stateCode, summary);
  }
  for (const stateRegions of regionsByState.values()) {
    stateRegions.sort((a, b) => a.regionName.localeCompare(b.regionName, "de", { sensitivity: "base" }));
  }

  return {
    clusters,
    regionSummaries,
    regionsByState,
    topClustersByState: Array.from(topClusterByState.values()).sort(compareClusterCoreMetric),
    browseClustersByState,
    browseClustersByRegion
  };
}

function appendMapListItem<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const items = map.get(key);
  if (items) {
    items.push(item);
    return;
  }
  map.set(key, [item]);
}

function insertSortedClusterMapItem<K>(
  map: Map<K, IntersectionCluster[]>,
  key: K,
  cluster: IntersectionCluster,
  limit: number
): void {
  const items = map.get(key);
  if (items) {
    insertSortedCluster(items, cluster, limit, compareClusterCoreMetric);
    return;
  }
  map.set(key, [cluster]);
}

function compareRegionSummaries(a: RegionSummary, b: RegionSummary): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount ||
    a.stateName.localeCompare(b.stateName, "de", { sensitivity: "base" }) ||
    a.regionName.localeCompare(b.regionName, "de", { sensitivity: "base" })
  );
}

function regionOptionLabel(region: RegionSummary): string {
  return region.population === null ? region.regionName : `${region.regionName} (${formatCompactPopulation(region.population)})`;
}

function clusterRegionName(cluster: IntersectionCluster): string {
  return cleanAreaNameForDisplay(cluster.administrativeRegionName ?? cluster.stateName);
}

function clusterRegionKey(cluster: IntersectionCluster): string {
  return `${cluster.stateCode}:${cluster.administrativeRegionCode ?? "state"}`;
}

function insertSortedCluster(
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

function formatSeverityPercentWithContext(cluster: IntersectionCluster): string {
  const value = formatSeverityPercent(cluster);
  const context = severityRankContext(cluster);
  if (!context) {
    return value;
  }

  if (context.germany === null) {
    return trf("metric.severityPercentContextState", {
      value,
      stateRank: formatInteger(context.state.rank),
      statePercent: formatInteger(context.state.percentile),
      state: cluster.stateName
    });
  }

  return trf("metric.severityPercentContextGermany", {
    value,
    stateRank: formatInteger(context.state.rank),
    statePercent: formatInteger(context.state.percentile),
    state: cluster.stateName,
    germanyRank: formatInteger(context.germany.rank),
    germanyPercent: formatInteger(context.germany.percentile)
  });
}

function severityRankContext(cluster: IntersectionCluster): SeverityRankContext | null {
  const cache = severityRankCacheForCurrentResult();
  if (!cache) {
    return null;
  }

  const key = severityRankKey(cluster);
  const state = cachedSeverityRank(cache.stateRanks, key, () =>
    measureActiveInteractionStep(
      "compute state severity rank",
      cluster.id,
      () => severityRankInScope(cluster, cache, (candidate) => candidate.stateCode === cluster.stateCode),
      (rank) => ({
        rank: rank?.rank ?? null,
        percentile: rank?.percentile ?? null
      })
    )
  );
  if (state === null) {
    return null;
  }

  return {
    state,
    germany: cache.hasMultipleStates
      ? cachedSeverityRank(cache.germanyRanks, key, () =>
          measureActiveInteractionStep(
            "compute germany severity rank",
            cluster.id,
            () => severityRankInScope(cluster, cache),
            (rank) => ({
              rank: rank?.rank ?? null,
              percentile: rank?.percentile ?? null
            })
          )
        )
      : null
  };
}

function severityRankCacheForCurrentResult(): SeverityRankCache | null {
  const clusters = result?.clusters;
  if (!clusters?.length) {
    return null;
  }
  if (severityRankCache?.clusters === clusters) {
    return severityRankCache;
  }

  severityRankCache = measureActiveInteractionStep(
    "prepare severity rank cache",
    null,
    () => buildSeverityRankCache(clusters),
    (cache) => ({
      clusterCount: cache.clusters.length,
      hasMultipleStates: cache.hasMultipleStates
    })
  );
  return severityRankCache;
}

function buildSeverityRankCache(clusters: IntersectionCluster[]): SeverityRankCache {
  const clusterIndexes = new Map<string, number>();
  const firstStateCode = clusters[0]?.stateCode ?? null;
  let hasMultipleStates = false;

  clusters.forEach((cluster, index) => {
    const key = severityRankKey(cluster);
    if (!clusterIndexes.has(key)) {
      clusterIndexes.set(key, index);
    }
    if (firstStateCode !== null && cluster.stateCode !== firstStateCode) {
      hasMultipleStates = true;
    }
  });

  return {
    clusters,
    clusterIndexes,
    hasMultipleStates,
    stateRanks: new Map(),
    germanyRanks: new Map()
  };
}

function cachedSeverityRank(ranks: Map<string, SeverityRank>, key: string, compute: () => SeverityRank | null): SeverityRank | null {
  const cached = ranks.get(key);
  if (cached) {
    return cached;
  }

  const rank = compute();
  if (rank) {
    ranks.set(key, rank);
  }
  return rank;
}

function severityRankInScope(
  cluster: IntersectionCluster,
  cache: SeverityRankCache,
  inScope?: (candidate: IntersectionCluster) => boolean
): SeverityRank | null {
  const clusterIndex = cache.clusterIndexes.get(severityRankKey(cluster));
  if (clusterIndex === undefined) {
    return null;
  }

  let scopeSize = 0;
  let rank = 1;
  let foundCluster = false;
  for (let index = 0; index < cache.clusters.length; index += 1) {
    const candidate = cache.clusters[index];
    if (inScope && !inScope(candidate)) {
      continue;
    }

    scopeSize += 1;
    if (candidate.id === cluster.id && candidate.stateCode === cluster.stateCode) {
      foundCluster = true;
    }

    const order = compareClusterCoreMetric(candidate, cluster);
    if (order < 0 || (order === 0 && index < clusterIndex)) {
      rank += 1;
    }
  }

  if (!foundCluster || scopeSize === 0) {
    return null;
  }

  return {
    rank,
    percentile: Math.max(1, Math.ceil((rank / scopeSize) * 100))
  };
}

function severityRankKey(cluster: IntersectionCluster): string {
  return `${cluster.stateCode}\0${cluster.id}`;
}

function selectClusterOnMap(cluster: IntersectionCluster, telemetrySource = "cluster selection", zoomLevel: number | null = null): void {
  const telemetry = createInteractionTelemetry("select cluster from list", telemetrySource, cluster.id, clusterLocationText(cluster));
  activeInteractionTelemetry = telemetry;
  const openDetailsOnMobile = mobileLayout.matches;
  measureInteractionStep(telemetry, "ensure severity visible", cluster.id, () => ensureClusterSeverityVisible(cluster), () => ({
    severity: clusterSeverity(cluster),
    fatalCount: cluster.fatalCount,
    seriousCount: cluster.seriousCount
  }));
  if (!openDetailsOnMobile) {
    measureInteractionStep(telemetry, "set view to map", activeView, () => setView("map"), () => ({ activeView }));
  }
  const frameStep = startInteractionStep(telemetry, "wait for selection animation frame", cluster.id);
  window.requestAnimationFrame(() => {
    finishInteractionStep(frameStep, {});
    try {
      withInteractionTelemetry(telemetry, () => {
        measureInteractionStep(telemetry, "map select, focus, draw, callback", cluster.id, () => map.select(cluster, true, "program", zoomLevel), () => ({
          clusterId: cluster.id,
          accidentCount: cluster.accidentCount
        }));
        if (openDetailsOnMobile) {
          measureInteractionStep(telemetry, "mobile set view details", cluster.id, () => setView("details"), () => ({ activeView }));
        }
      });
    } finally {
      scheduleInteractionTelemetryLog(telemetry);
    }
  });
}

function ensureClusterSeverityVisible(cluster: IntersectionCluster): void {
  const severity = clusterSeverity(cluster);
  const input =
    severity === "fatal" ? elements.showFatalPoints : severity === "serious" ? elements.showSeriousPoints : elements.showOtherPoints;
  if (input.checked) {
    return;
  }
  input.checked = true;
  applySeverityFilter();
}

function clusterSeverity(cluster: IntersectionCluster): SeverityFilterKey {
  if (cluster.fatalCount > 0) {
    return "fatal";
  }
  if (cluster.seriousCount > 0) {
    return "serious";
  }
  return "other";
}

function renderSelection(cluster: IntersectionCluster | null): void {
  if (!cluster) {
    renderEmptySelection();
    return;
  }

  const viewModel = buildSelectedIntersectionViewModel(cluster);
  applySelectedIntersectionViewModel(viewModel);
  if (viewModel.panel.accidentRecordsLoading) {
    queueSelectedAccidentRecordsLoad(cluster);
  }
}

function renderEmptySelection(): void {
  elements.selectedAside.hidden = true;
  elements.mapView.classList.remove("has-selection");
  selectedIntersectionPanelView.renderEmpty();
  selectedPreviewMapView.clear();
  map.setSelectedIncidentPoints([]);
  updateContextTabs();
  if (activeView === "details" || activeView === "similar") {
    setView("map");
  } else {
    updateStreetViewPanel();
  }
}

function buildSelectedIntersectionViewModel(cluster: IntersectionCluster): SelectedIntersectionViewModel {
  const urls = measureActiveInteractionStep(
    "build selected external URLs",
    cluster.id,
    () => ({
      ...mapUrlsForCluster(cluster),
      authoritySearchUrl: responsibleAuthoritySearchUrlForCluster(cluster)
    }),
    () => ({ urlCount: 4 })
  );
  const accidentRecordSnapshot = measureActiveInteractionStep(
    "find selected accident records",
    cluster.id,
    () => clusterAccidentRecordsSnapshot(cluster),
    (snapshot) => ({
      recordCount: snapshot.records.length,
      clusterAccidentCount: cluster.accidentCount
    })
  );
  const accidentRecords = accidentRecordSnapshot.records;
  const streetNames = measureActiveInteractionStep(
    "derive selected street names",
    cluster.id,
    () => clusterStreetNamesForDisplay(cluster, accidentRecords),
    (names) => ({ streetCount: names.length })
  );
  const roadClassSignature = measureActiveInteractionStep(
    "derive selected road class signature",
    cluster.id,
    () => similarView.roadClassSignatureForStreetNames(streetNames),
    (signature) => ({ comparable: signature !== null, roadClass: signature?.label ?? null })
  );
  const pressSearchUrl = measureActiveInteractionStep("build press search URL", cluster.id, () =>
    pressSearchUrlForCluster(cluster, streetNames)
  );
  const trendSeries = measureActiveInteractionStep(
    "derive selected trend series",
    cluster.id,
    () => clusterTrendSeries(cluster, result?.years.length ? result.years : cluster.years),
    (series) => ({ yearCount: series.length })
  );

  return {
    cluster,
    roadClassSignature,
    panel: {
      cluster,
      urls,
      streetNames,
      canCompareSimilar: roadClassSignature !== null,
      pressSearchUrl,
      trendSeries,
      accidentRecords,
      accidentRecordsLoading: accidentRecordSnapshot.loading
    },
    incidentPoints: accidentRecords.map(({ accident }, index) => ({
      lat: accident.lat,
      lon: accident.lon,
      label: String(index + 1)
    }))
  };
}

function applySelectedIntersectionViewModel(viewModel: SelectedIntersectionViewModel): void {
  const { cluster } = viewModel;
  selectedRoadClassSignature = viewModel.roadClassSignature;
  elements.selectedAside.hidden = false;
  elements.mapView.classList.add("has-selection");
  measureActiveInteractionStep(
    "update selected incident points",
    cluster.id,
    () => map.setSelectedIncidentPoints(viewModel.incidentPoints),
    () => ({ pointCount: viewModel.incidentPoints.length })
  );
  measureActiveInteractionStep(
    "render selected preview map",
    cluster.id,
    () => selectedPreviewMapView.render({ cluster, incidentPoints: viewModel.incidentPoints }),
    () => ({ pointCount: viewModel.incidentPoints.length })
  );

  measureActiveInteractionStep("render selected panel", cluster.id, () => selectedIntersectionPanelView.render(viewModel.panel));
  measureActiveInteractionStep("update details tabs", cluster.id, updateContextTabs);
  if (activeView === "similar") {
    if (!viewModel.roadClassSignature) {
      measureActiveInteractionStep("fallback from unavailable comparison", cluster.id, () => setView("map"));
    } else {
      measureActiveInteractionStep("render visible comparison", cluster.id, () => similarView.render());
    }
  }
  measureActiveInteractionStep("update street view panel", cluster.id, updateStreetViewPanel, () => ({
    streetViewOpen: isStreetViewOpen
  }));
}

function toggleStreetViewPanel(): void {
  isStreetViewOpen = !isStreetViewOpen;
  writeStoredStreetViewOpen(isStreetViewOpen);
  updateStreetViewPanel();
}

function updateStreetViewPanel(): void {
  const cluster = selectedCluster;
  const hasSelection = cluster !== null;
  const isExpanded = hasSelection && isStreetViewOpen;

  elements.streetViewPanel.hidden = !hasSelection;
  elements.mapColumn.classList.toggle("street-view-open", isExpanded);
  elements.streetViewToggle.setAttribute("aria-expanded", String(isExpanded));
  elements.streetViewToggleText.textContent = isExpanded ? tr("action.hide") : tr("action.show");
  elements.streetViewBody.hidden = !isExpanded;

  if (!hasSelection || !isExpanded) {
    clearStreetViewFrame();
    scheduleMapRefresh();
    return;
  }

  const streetViewUrl = googleStreetViewEmbedUrl(cluster);
  if (elements.streetViewFrame.dataset.src !== streetViewUrl) {
    elements.streetViewFrame.src = streetViewUrl;
    elements.streetViewFrame.dataset.src = streetViewUrl;
  }
  elements.streetViewFrame.title = trf("streetView.near", { lat: cluster.lat.toFixed(5), lon: cluster.lon.toFixed(5) });
  elements.streetViewFrame.hidden = false;
  elements.streetViewEmpty.hidden = true;
  scheduleMapRefresh();
}

function clearStreetViewFrame(): void {
  elements.streetViewFrame.hidden = true;
  elements.streetViewFrame.removeAttribute("src");
  delete elements.streetViewFrame.dataset.src;
}

function scheduleMapRefresh(): void {
  window.requestAnimationFrame(() => {
    if (mobileLayout.matches && activeView !== "map") {
      return;
    }
    map.refresh();
  });
}

function openUnclusteredIncidentDialog(accident: AccidentRecord): void {
  elements.incidentDialogBody.innerHTML = selectedIntersectionPanelView.renderIncidentDialogHtml(accident);
  if (typeof elements.incidentDialog.showModal === "function") {
    elements.incidentDialog.showModal();
  } else {
    elements.incidentDialog.setAttribute("open", "");
  }
}

function closeUnclusteredIncidentDialog(): void {
  if (elements.incidentDialog.open) {
    elements.incidentDialog.close();
  }
}

function handleIncidentDialogClick(event: MouseEvent): void {
  if (event.target === elements.incidentDialog) {
    closeUnclusteredIncidentDialog();
    return;
  }

  const target = event.target;
  if (target instanceof Element && target.closest("[data-incident-dialog-close]")) {
    closeUnclusteredIncidentDialog();
  }
}

function clusterAccidentRecordsSnapshot(cluster: IntersectionCluster): ClusterAccidentRecordsSnapshot {
  const sourceRecords = cachedAccidentRecordsForCluster(cluster);
  return clusterAccidentRecordMatcher.snapshot(
    cluster,
    sourceRecords,
    hasAccidentStateShard(cluster.stateCode),
    currentAccidentRecordMatchingOptions()
  );
}

function cachedAccidentRecordsForCluster(cluster: IntersectionCluster): AccidentRecord[] | null {
  return dataRepository.cachedAccidentsForStateOrAll(cluster.stateCode) ?? (accidents.length > 0 ? accidents : null);
}

function hasAccidentStateShard(stateCode: string): boolean {
  return dataRepository.hasStateShard(stateCode);
}

function queueSelectedAccidentRecordsLoad(cluster: IntersectionCluster): void {
  const requestToken = requestGate.start("selectedAccidentRecords", cluster.id);
  void loadAccidentsForState(cluster.stateCode)
    .then(() => {
      if (selectedCluster?.id !== cluster.id || !requestGate.isCurrent(requestToken)) {
        return;
      }
      renderSelection(cluster);
    })
    .catch((error) => {
      if (selectedCluster?.id === cluster.id && requestGate.isCurrent(requestToken)) {
        console.warn("[Safe Intersections] Could not load selected accident records.", error);
      }
    });
}

async function clusterAccidentRecordsReady(cluster: IntersectionCluster): Promise<CrossingAccident[]> {
  const sourceRecords = cachedAccidentRecordsForCluster(cluster) ?? (await loadAccidentsForState(cluster.stateCode));
  return clusterAccidentRecordMatcher.records(cluster, sourceRecords, currentAccidentRecordMatchingOptions());
}

function currentAccidentRecordMatchingOptions(): AnalysisOptions {
  return committedAnalysis?.options ?? readDraftAnalysisOptions();
}

function clusterTrendSeries(cluster: IntersectionCluster, years: number[]): ClusterYearStat[] {
  const byYear = new Map(cluster.yearlyStats.map((stats) => [stats.year, stats]));

  return years.map((year) => {
    const existing = byYear.get(year);
    if (existing) {
      return existing;
    }
    return {
      year,
      accidentCount: 0
    };
  });
}

function setView(view: ViewKey): void {
  if (view === "details" && !selectedCluster) {
    setStatus(tr("details.selectFirst"), 100);
    view = "map";
  }
  if (view === "similar" && !hasComparableSelectedIntersection()) {
    setStatus(selectedCluster ? tr("similar.selectComparable") : tr("details.selectFirst"), 100);
    view = "map";
  }

  activeView = view;
  elements.app.dataset.activeView = view;
  updateViewUrl(view);

  const tabs = [
    { key: "explore", tab: elements.exploreTab },
    { key: "map", tab: elements.mapTab },
    { key: "details", tab: elements.detailsTab },
    { key: "similar", tab: elements.similarTab },
    { key: "state", tab: elements.stateTab },
    { key: "state", tab: elements.mobileStateTab },
    { key: "region", tab: elements.regionTab },
    { key: "region", tab: elements.mobileRegionTab },
    { key: "table", tab: elements.tableTab },
    { key: "table", tab: elements.mobileTableTab },
    { key: "settings", tab: elements.settingsTab },
    { key: "settings", tab: elements.mobileSettingsTab }
  ] as const;

  for (const entry of tabs) {
    const active = entry.key === view;
    entry.tab.classList.toggle("active", active);
    if (entry.tab.getAttribute("role") === "tab") {
      entry.tab.setAttribute("aria-selected", String(active));
    } else {
      entry.tab.toggleAttribute("aria-current", active);
    }
  }
  elements.moreTab.classList.toggle("active", isSecondaryView(view));

  elements.mapView.classList.toggle("active", view === "map" || view === "details");
  elements.stateView.classList.toggle("active", view === "state");
  elements.regionView.classList.toggle("active", view === "region");
  elements.similarView.classList.toggle("active", view === "similar");
  elements.tableView.classList.toggle("active", view === "table");
  elements.settingsView.classList.toggle("active", view === "settings");

  updateContextTabs();
  renderActiveAnalysisView();
  updateStreetViewPanel();
  setMobileMoreMenuOpen(false);
  scheduleMapRefresh();
}

function updateContextTabs(): void {
  const hasSelection = selectedCluster !== null;
  const canCompareSimilar = hasComparableSelectedIntersection();
  elements.detailsTab.disabled = !hasSelection;
  elements.similarTab.hidden = !canCompareSimilar;
  elements.similarTab.disabled = !canCompareSimilar;
}

function hasComparableSelectedIntersection(): boolean {
  return selectedCluster !== null && selectedRoadClassSignature !== null;
}

function isMobilePaneView(view: ViewKey): boolean {
  return view === "explore" || view === "details";
}

function isSecondaryView(view: ViewKey): boolean {
  return view === "state" || view === "region" || view === "table" || view === "settings";
}

function toggleMobileMoreMenu(event: MouseEvent): void {
  event.stopPropagation();
  setMobileMoreMenuOpen(elements.mobileMoreMenu.hidden);
}

function setMobileMoreMenuOpen(isOpen: boolean): void {
  elements.mobileMoreMenu.hidden = !isOpen;
  elements.moreTab.setAttribute("aria-expanded", String(isOpen));
}

function closeMobileMoreMenuOnOutsideClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (elements.mobileMoreMenu.contains(target) || elements.moreTab.contains(target)) {
    return;
  }
  setMobileMoreMenuOpen(false);
}

function closeMobileMoreMenuOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    setMobileMoreMenuOpen(false);
  }
}

function initialView(): ViewKey {
  const urlView = readViewFromUrl();
  if (urlView) {
    return urlView;
  }
  return mobileLayout.matches ? "explore" : "map";
}

function updateRangeOutputs(): void {
  elements.clusterRadiusOut.value = elements.clusterRadius.value;
}

async function resetApp(): Promise<void> {
  setBusy(true);
  setStatus(tr("status.resettingApp"), 0);
  try {
    await dataRepository.resetStorage();
  } finally {
    window.location.reload();
  }
}

function exportClusters(): void {
  if (!result || result.clusters.length === 0) {
    setStatus(tr("status.noClustersToExport"), 0, "idle");
    return;
  }

  const header = [
    "state",
    "administrative_region",
    "administrative_region_population",
    "district",
    "municipality",
    "municipality_population",
    "lat",
    "lon",
    "accidents",
    "fatal",
    "serious",
    "osm_roundabout",
    "osm_traffic_signal",
    "severity_percent"
  ];
  const rows = result.clusters.map((cluster) =>
    [
      cluster.stateName,
      cluster.administrativeRegionName ?? "",
      cluster.administrativeRegionPopulation ?? "",
      cluster.districtName ?? "",
      cluster.municipalityName ?? "",
      cluster.municipalityPopulation ?? "",
      cluster.lat,
      cluster.lon,
      cluster.accidentCount,
      cluster.fatalCount,
      cluster.seriousCount,
      osmBooleanCsvValue(cluster.osmRoundabout),
      osmBooleanCsvValue(cluster.osmTrafficSignal),
      severityPercentValue(cluster)
    ]
      .map(csvCell)
      .join(",")
  );

  const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "high-severity-intersections.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function osmBooleanCsvValue(value: boolean | null | undefined): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

async function downloadSelectedFactsheet(): Promise<void> {
  const cluster = selectedCluster;
  if (!cluster) {
    setStatus(tr("details.selectFirst"), 100, "idle");
    return;
  }
  const requestToken = requestGate.start("factsheet", cluster.id);

  const factsheetButtons = selectedFactsheetButtons();
  factsheetButtons.forEach((button) => {
    button.disabled = true;
  });
  setStatus(tr("status.factsheetCreating"), 100);
  try {
    const records = await clusterAccidentRecordsReady(cluster);
    if (selectedCluster?.id !== cluster.id || !requestGate.isCurrent(requestToken)) {
      return;
    }
    const blob = await createFactsheetPdf(createSelectedFactsheetOptions(cluster, records));
    if (selectedCluster?.id !== cluster.id || !requestGate.isCurrent(requestToken)) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = factsheetFileName(cluster);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(tr("status.factsheetDownloaded"), 100);
  } catch (error) {
    if (requestGate.isCurrent(requestToken)) {
      setStatus(trf("status.factsheetFailed", { error: errorMessage(error) }), 100, "problem");
    }
  } finally {
    if (requestGate.isCurrent(requestToken)) {
      factsheetButtons.forEach((button) => {
        button.disabled = false;
      });
    }
  }
}

async function copySelectedIntersectionPermalink(): Promise<void> {
  const cluster = selectedCluster;
  if (!cluster) {
    setStatus(tr("details.selectFirst"), 100, "idle");
    return;
  }

  updateIntersectionSelectionUrl(cluster);
  const permalink = window.location.href;
  elements.selectedPermalinkBtn.disabled = true;
  try {
    await writeClipboardText(permalink);
    setStatus(tr("status.permalinkCopied"), 100, "idle");
  } catch (error) {
    setStatus(trf("status.permalinkCopyFailed", { error: errorMessage(error) }), 100, "problem");
  } finally {
    elements.selectedPermalinkBtn.disabled = false;
  }
}

async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.readOnly = true;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command failed");
    }
  } finally {
    textArea.remove();
  }
}

function selectedFactsheetButtons(): HTMLButtonElement[] {
  return selectedIntersectionPanelView.factsheetButtons();
}

function createSelectedFactsheetOptions(cluster: IntersectionCluster, records: CrossingAccident[]): CreateFactsheetPdfOptions {
  const selectedYears = result?.years.length ? result.years : cluster.years;
  const streetOrder = clusterStreetNamesForDisplay(cluster, records);
  return {
    cluster,
    records,
    selectedYears,
    trendSeries: clusterTrendSeries(cluster, selectedYears),
    trendPeriodYears: committedAnalysis?.options.severityPercent.trendYears ?? cluster.accidentTrend.years,
    clusterRadiusMeters: committedAnalysis?.options.clusterRadiusMeters ?? Number(elements.clusterRadiusOut.value),
    latestBundledFileDate: dataRepository.latestBundledFileDate(),
    severityPercentText: formatSeverityPercentWithContext(cluster),
    mapUrls: mapUrlsForCluster(cluster),
    roadUserItems: roadUserSummaryItems(records).map((item) => ({
      key: item.definition.key,
      label: item.label,
      count: item.count,
      share: item.share
    })),
    accidentDetails: records.map(({ accident, distanceMeters }) => ({
      heading: `${accidentSeverityLabel(accident)} - ${accidentTimeLabel(accident)}`,
      rows: accidentRecordRows(accident, distanceMeters, streetOrder).map((row): [string, string] => [row.label, row.value]),
      pressUrl: pressSearchUrlForAccident(accident)
    }))
  };
}

function showNextLoadingFact(): void {
  const factIndex = nextLoadingFactIndex();
  const fact = LOADING_FACTS[factIndex] ?? LOADING_FACTS[0] ?? null;
  elements.splashLoadingFactMeta.textContent = fact?.meta?.[ACTIVE_LOCALE] ?? DEFAULT_LOADING_FACT_META[ACTIVE_LOCALE];
  elements.splashLoadingFact.textContent = fact?.text[ACTIVE_LOCALE] ?? "";
  writeNextLoadingFactIndex(factIndex + 1);
}

function nextLoadingFactIndex(): number {
  try {
    const rawValue = window.localStorage.getItem(LOADING_FACT_STORAGE_KEY);
    const storedIndex = rawValue === null ? 0 : Number(rawValue);
    return normalizeLoadingFactIndex(Number.isFinite(storedIndex) ? storedIndex : 0);
  } catch {
    return normalizeLoadingFactIndex(loadingFactFallbackIndex);
  }
}

function writeNextLoadingFactIndex(nextIndex: number): void {
  const normalizedIndex = normalizeLoadingFactIndex(nextIndex);
  loadingFactFallbackIndex = normalizedIndex;
  try {
    window.localStorage.setItem(LOADING_FACT_STORAGE_KEY, String(normalizedIndex));
  } catch {
    // The rotating fact is optional; blocked storage should not affect loading.
  }
}

function normalizeLoadingFactIndex(index: number): number {
  if (LOADING_FACTS.length === 0) {
    return 0;
  }
  return ((Math.trunc(index) % LOADING_FACTS.length) + LOADING_FACTS.length) % LOADING_FACTS.length;
}

function setBusy(isBusy: boolean): void {
  elements.analyzeBtn.disabled = isBusy;
  elements.resetAppBtn.disabled = isBusy;
  if (isBusy && !isSplashDisplayed) {
    showNextLoadingFact();
  }
  isSplashDisplayed = isBusy;
  elements.splash.hidden = !isBusy;
  elements.splash.setAttribute("aria-busy", String(isBusy));
  setAnalysisControlsDisabled(isBusy);
  updateAnalyzeButton();
}

function setAnalysisControlsDisabled(isDisabled: boolean): void {
  const controls: HTMLElement[] = [
    elements.clusterRadius,
    elements.clusterRadiusOut,
    elements.minAccidents,
    elements.stateFilter,
    ...severityPercentInputs()
  ];
  roadUserFocusInputs().forEach((input) => controls.push(input));
  elements.yearFilter.querySelectorAll<HTMLInputElement>("input").forEach((input) => controls.push(input));

  for (const control of controls) {
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
      control.disabled = isDisabled;
    }
  }
}

function updateAnalyzeButton(): void {
  elements.analyzeBtn.textContent = analysisSettingsDirty ? tr("action.analyzeChanges") : tr("action.analyze");
  elements.analyzeBtn.classList.toggle("dirty", analysisSettingsDirty);
}

function setStatus(message: string, progress: number, kind: LoadingStatusKind = "normal"): void {
  loadingStatusKind = kind;
  const normalizedProgress = Math.max(0, Math.min(100, progress));
  updateLoadingPanels(message, normalizedProgress);
}

function updateLoadingPanels(message: string, progress: number): void {
  const isProblem = loadingStatusKind === "problem";
  const isIdle = loadingStatusKind === "idle";
  const hasNoClusters = Boolean(result && result.clusters.length === 0 && progress >= 100);
  const title = loadingTitle(progress, isProblem, isIdle, hasNoClusters);

  elements.mapLoadingStatus.textContent = message;
  elements.mapLoadingBar.style.width = `${progress}%`;
  elements.mapLoadingTitle.textContent = title;
}

function loadingTitle(progress: number, isProblem: boolean, isIdle: boolean, hasNoClusters: boolean): string {
  if (isProblem) {
    return tr("loading.title.problem");
  }
  if (isIdle) {
    return tr("loading.title.idle");
  }
  if (hasNoClusters) {
    return tr("loading.title.noMatches");
  }
  if (progress >= 100) {
    return tr("loading.title.ready");
  }
  if (progress >= 75) {
    return tr("loading.title.analyze");
  }
  if (progress >= 10) {
    return tr("loading.title.result");
  }
  return tr("loading.title.bundle");
}

async function loadAccidentData(
  telemetry: InitializationTelemetry | null,
  options: { updateStatus?: boolean } = {}
): Promise<AccidentRecord[]> {
  const records = await dataRepository.loadAllAccidents(
    repositoryTelemetry(telemetry),
    options.updateStatus ?? true
      ? ({ current, total }) => {
          setStatus(trf("status.loadingBundledChunk", { current, total }), Math.min(60, 10 + Math.floor((current / total) * 50)));
        }
      : null
  );
  if (accidents !== records) {
    accidents = records;
    clusterAccidentRecordMatcher.clearCaches();
    populateFilters();
  }
  return accidents;
}

async function loadAccidentsForAnalysis(
  options: AnalysisOptions,
  telemetry: InitializationTelemetry | null
): Promise<AccidentRecord[]> {
  const records = await dataRepository.loadAccidentsForAnalysis(
    options,
    repositoryTelemetry(telemetry),
    ({ current, total }) => {
      setStatus(trf("status.loadingBundledChunk", { current, total }), Math.min(60, 10 + Math.floor((current / total) * 50)));
    }
  );
  if (options.stateCode === "all" && accidents !== records) {
    accidents = records;
    clusterAccidentRecordMatcher.clearCaches();
    populateFilters();
  }
  return records;
}

async function loadAccidentsForState(stateCode: string, telemetry: InitializationTelemetry | null = null): Promise<AccidentRecord[]> {
  return dataRepository.loadAccidentsForState(stateCode, repositoryTelemetry(telemetry));
}

function inputMin(input: HTMLInputElement): number {
  return input.min === "" ? Number.NEGATIVE_INFINITY : Number(input.min);
}

function inputMax(input: HTMLInputElement): number {
  return input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function enqueuePostRenderCacheWrites(
  initializationTelemetry: InitializationTelemetry | null,
  writes: PostRenderCacheWrites
): void {
  if (!writes.analysis) {
    return;
  }

  const telemetry = createPostRenderCacheTelemetry(initializationTelemetry);
  scheduleAfterFirstRender(() => {
    postRenderCacheWriteQueue = postRenderCacheWriteQueue
      .catch(() => undefined)
      .then(() => writePostRenderCaches(telemetry, writes));
    void postRenderCacheWriteQueue;
  });
}

async function writePostRenderCaches(telemetry: InitializationTelemetry | null, writes: PostRenderCacheWrites): Promise<void> {
  let status: Exclude<InitializationTelemetryStatus, "running"> = "done";

  if (writes.analysis) {
    try {
      await measureInitializationStep(
        telemetry,
        "write analysis cache",
        analysisTelemetryDetail(writes.analysis.options),
        () => dataRepository.writeCachedAnalysis(writes.analysis!.cacheContext, writes.analysis!.options, writes.analysis!.result),
        () => ({
          clusterCount: writes.analysis?.result.clusters.length ?? 0,
          afterFirstRender: true
        })
      );
    } catch (error) {
      status = "error";
      console.warn("[Safe Intersections] Could not write analysis cache after startup.", error);
    }
  }

  logInitializationTelemetry(telemetry, status, "post-render cache telemetry");
}

function scheduleAfterFirstRender(work: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(work, 0);
  });
}

function scheduleSelectionSupportPrewarm(): void {
  const sourceResult = result;
  if (!sourceResult?.clusters.length) {
    return;
  }

  scheduleAfterFirstRender(() => {
    scheduleIdleWork(() => {
      if (result !== sourceResult) {
        return;
      }

      const started = performance.now();
      severityRankCacheForCurrentResult();
      const durationMs = round(performance.now() - started, 2);
      if (durationMs >= 10) {
        console.info("[Safe Intersections] selection support prewarm", {
          durationMs,
          clusterCount: sourceResult.clusters.length
        });
      }
    });
  });
}

function scheduleIdleWork(work: () => void): void {
  const requestIdleCallback = window.requestIdleCallback;
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback.call(window, () => work(), { timeout: 2000 });
  } else {
    globalThis.setTimeout(work, 0);
  }
}

function measureActiveInteractionStep<T>(
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => TelemetryMetadata
): T {
  const telemetry = activeInteractionTelemetry;
  return telemetry ? measureInteractionStep(telemetry, name, detail, work, metadata) : work();
}

function withInteractionTelemetry<T>(telemetry: InteractionTelemetry, work: () => T): T {
  const previous = activeInteractionTelemetry;
  activeInteractionTelemetry = telemetry;
  try {
    return work();
  } finally {
    activeInteractionTelemetry = previous;
  }
}

function scheduleInteractionTelemetryLog(telemetry: InteractionTelemetry): void {
  const paintStep = startInteractionStep(telemetry, "wait for browser paint", telemetry.clusterId);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      finishInteractionStep(paintStep, { activeView });
      logInteractionTelemetry(telemetry, { activeView });
      if (activeInteractionTelemetry === telemetry) {
        activeInteractionTelemetry = null;
      }
    });
  });
}

function analysisTelemetryDetail(options: AnalysisOptions): string {
  const years = Array.from(options.years).sort((a, b) => a - b).join(",") || "all";
  const roadUsers = roadUserFocusKey(options.roadUserFocus) || "all";
  return `state=${options.stateCode}; years=${years}; roadUsers=${roadUsers}; radius=${options.clusterRadiusMeters}m; minAccidents=${options.minAccidents}`;
}

function readStoredStreetViewOpen(): boolean {
  try {
    return window.localStorage.getItem(STREET_VIEW_OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredStreetViewOpen(value: boolean): void {
  try {
    window.localStorage.setItem(STREET_VIEW_OPEN_STORAGE_KEY, String(value));
  } catch {
    // Storage can be blocked in private or embedded contexts; the toggle still works for this session.
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
