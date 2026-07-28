import "./styles.css";
import { AnalysisOptionsForm, analysisOptionsEqual } from "./analysisOptionsForm";
import { AnalysisCoordinator } from "./analysisCoordinator";
import { AppState } from "./appState";
import { AppRouter } from "./appRouter";
import { BrowseIndexStore, regionOptionLabel, STATE_BROWSE_MAX_INTERSECTIONS, type BrowseIndex } from "./browseIndex";
import { clustersCsv } from "./clusterCsvExport";
import { ClusterSelectionCoordinator, clusterSeverityKey } from "./clusterSelectionCoordinator";
import { DataRepository } from "./dataRepository";
import { compareClusterCoreMetric } from "./clusterDisplay";
import {
  configureNumberLocale,
  formatDistance,
  formatInteger,
  formatSeverityPercent
} from "./formatting";
import { distanceMeters } from "./geo";
import { applyStaticTranslations, configureI18n, detectLocale, tr, trf, type AppLocale } from "./i18n";
import {
  intersectionSelectionHref,
  INTERSECTION_URL_MATCH_MAX_DISTANCE_METERS,
  readIntersectionUrlSelection,
  type IntersectionUrlSelection,
  type LatLon
} from "./intersectionUrlState";
import { DEFAULT_LOADING_FACT_META, LOADING_FACTS } from "./loadingFacts";
import { LoadingStatusPresenter, type LoadingStatusKind } from "./loadingStatusPresenter";
import { round } from "./math";
import { MapCanvas } from "./mapCanvas";
import { RequestGate } from "./requestGate";
import { SelectedIntersectionController } from "./selectedIntersectionController";
import {
  SeverityRankIndexStore,
  type SeverityRank,
  type SeverityRankContext,
  type SeverityRankIndex,
  type SeverityRankIndexHooks
} from "./severityRankIndex";
import { STATE_NAMES } from "./states";
import type { TelemetryMetadata } from "./telemetry";
import { UnclusteredIncidentLayer } from "./unclusteredIncidentLayer";
import {
  AccidentRecord,
  AnalysisOptions,
  AnalysisResult,
  IntersectionCluster
} from "./types";
import { TRANSLATIONS } from "./translations";
import { ExploreView } from "./views/exploreView";
import { IntersectionFeatureSummaryView } from "./views/intersectionFeatureSummaryView";
import { SelectedIntersectionPanelView } from "./views/selectedIntersectionPanelView";
import { SelectedPreviewMapView } from "./views/selectedPreviewMapView";
import { SimilarView } from "./views/similarView";
import { StateRegionView } from "./views/stateRegionView";
import { TableView } from "./views/tableView";

declare const __SICHERE_KNOTEN_APP_VERSION__: string | undefined;
declare const __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__: string | undefined;

interface SiteVersionManifest {
  appVersion?: string;
  analysisCacheVersion?: string;
}

const APP_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev-cluster-streets";
const ANALYSIS_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ === "string" ? __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ : APP_CACHE_VERSION;
const LOADING_FACT_STORAGE_KEY = "sichere-knoten:loading-fact-index";
const ACTIVE_LOCALE: AppLocale = detectLocale();
configureI18n(ACTIVE_LOCALE, TRANSLATIONS);
configureNumberLocale(ACTIVE_LOCALE);

const appState = new AppState();
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
const severityRankIndexes = new SeverityRankIndexStore();
const browseIndexes = new BrowseIndexStore();
const analysisOptionsForm = new AnalysisOptionsForm(
  {
    analyzeButton: elements.analyzeBtn,
    clusterRadius: elements.clusterRadius,
    clusterRadiusOut: elements.clusterRadiusOut,
    minAccidents: elements.minAccidents,
    fatalWeight: elements.fatalWeight,
    seriousWeight: elements.seriousWeight,
    severityFullSample: elements.severityFullSample,
    severityTrendYears: elements.severityTrendYears,
    severityTrendDeadZone: elements.severityTrendDeadZone,
    severityTrendFullSignal: elements.severityTrendFullSignal,
    severityMaxTrendAdjustment: elements.severityMaxTrendAdjustment,
    severityMaxPercent: elements.severityMaxPercent,
    stateFilter: elements.stateFilter,
    roadUserFocus: elements.roadUserFocus,
    yearFilter: elements.yearFilter
  },
  {
    onDraftChange: markAnalysisSettingsDirty
  }
);
const loadingStatusPresenter = new LoadingStatusPresenter({
  elements: {
    splash: elements.splash,
    mapLoadingTitle: elements.mapLoadingTitle,
    mapLoadingStatus: elements.mapLoadingStatus,
    mapLoadingBar: elements.mapLoadingBar
  },
  hasNoClusters: () => Boolean(appState.result && appState.result.clusters.length === 0),
  onShowSplash: showNextLoadingFact,
  translate: tr
});
const analysisCoordinator = new AnalysisCoordinator({
  dataRepository,
  requestGate,
  appVersion: APP_CACHE_VERSION,
  analysisCacheVersion: ANALYSIS_CACHE_VERSION,
  readOptions: () => analysisOptionsForm.readOptions(),
  normalizeOptionsDraft: () => analysisOptionsForm.normalizeClusterRadius(),
  resetRuntimeState: resetRuntimeAnalysisState,
  onAccidentsLoaded: (records, context) => {
    if (context.scope === "analysis" && context.options?.stateCode !== "all") {
      return;
    }
    handleAccidentsLoaded(records);
  },
  commitAnalysisState: (options, analysisResult, dataVersion) => commitAnalysisState(options, analysisResult, dataVersion),
  populateFilters,
  renderAll,
  scheduleSelectionSupportPrewarm,
  scheduleAfterFirstRender,
  setBusy,
  setStatus
});
const selectedIntersectionPanelView = new SelectedIntersectionPanelView({
  container: elements.selectionDetails,
  formatSeverityPercentWithContext
});
let selectedIntersectionController: SelectedIntersectionController;
let appRouter: AppRouter;
let clusterSelectionCoordinator: ClusterSelectionCoordinator;
let similarView: SimilarView;
let exploreView: ExploreView;
let unclusteredIncidentLayer: UnclusteredIncidentLayer;
const intersectionFeatureSummaryView = new IntersectionFeatureSummaryView({
  container: elements.intersectionFeatureSummary,
  getResult: () => appState.result
});
const selectedPreviewMapView = new SelectedPreviewMapView({
  container: elements.selectedPreviewMap,
  canvas: elements.selectedPreviewCanvas,
  getSelectedClusterId: () => selectedIntersectionController.selectedClusterId,
  clusterRadiusMeters: () => appState.committedAnalysis?.options.clusterRadiusMeters ?? 50
});
const map = new MapCanvas(
  elements.mapCanvas,
  (cluster, reason) => selectedIntersectionController.handleMapSelection(cluster, reason),
  (accident) => selectedIntersectionController.openUnclusteredIncidentDialog(accident),
  (request) => unclusteredIncidentLayer.handleViewportRequest(request),
  setMapIncidentLegendVisible,
  handleMapZoomChange
);
unclusteredIncidentLayer = new UnclusteredIncidentLayer({
  map,
  getAnalysisState: () => appState.committedAnalysis,
  hasStateShard: (stateCode) => dataRepository.hasStateShard(stateCode),
  loadAccidentsForState: (stateCode) => loadAccidentsForState(stateCode)
});
selectedIntersectionController = new SelectedIntersectionController({
  elements: {
    mapColumn: elements.mapColumn,
    mapView: elements.mapView,
    selectedAside: elements.selectedAside,
    selectedPermalinkBtn: elements.selectedPermalinkBtn,
    selectionDetails: elements.selectionDetails,
    detailsTab: elements.detailsTab,
    similarTab: elements.similarTab,
    incidentDialog: elements.incidentDialog,
    incidentDialogBody: elements.incidentDialogBody,
    streetViewPanel: elements.streetViewPanel,
    streetViewToggle: elements.streetViewToggle,
    streetViewToggleText: elements.streetViewToggleText,
    streetViewBody: elements.streetViewBody,
    streetViewFrame: elements.streetViewFrame,
    streetViewEmpty: elements.streetViewEmpty
  },
  panelView: selectedIntersectionPanelView,
  previewMapView: selectedPreviewMapView,
  map,
  requestGate,
  getAnalysisResult: () => appState.result,
  getAnalysisOptions: () => appState.committedAnalysis?.options ?? analysisOptionsForm.readOptions(),
  getCachedAccidentsForState: (stateCode) =>
    dataRepository.cachedAccidentsForStateOrAll(stateCode) ?? appState.allAccidentsSnapshot(),
  hasAccidentStateShard: (stateCode) => dataRepository.hasStateShard(stateCode),
  loadAccidentsForState: (stateCode) => loadAccidentsForState(stateCode),
  latestBundledFileDate: () => dataRepository.latestBundledFileDate(),
  formatSeverityPercentWithContext,
  roadClassSignatureForStreetNames: (streetNames) => similarView.roadClassSignatureForStreetNames(streetNames),
  renderVisibleSimilarView: () => similarView.render(),
  renderBrowseLists: () => {
    exploreView.render();
    return {
      stateHotspotCount: elements.stateHotspotList.children.length,
      nearbyCount: elements.nearbyList.children.length
    };
  },
  getActiveView: () => appRouter.activeView,
  isMobileLayout: () => appRouter.isMobileLayout,
  setView: (view) => appRouter.setView(view),
  setStatus,
  updateIntersectionSelectionUrl,
  scheduleMapRefresh,
  measureStep: (name, detail, work, metadata) =>
    clusterSelectionCoordinator.measureActiveInteractionStep(name, detail, work, metadata)
});
appRouter = new AppRouter(
  {
    app: elements.app,
    exploreTab: elements.exploreTab,
    mapTab: elements.mapTab,
    detailsTab: elements.detailsTab,
    moreTab: elements.moreTab,
    stateTab: elements.stateTab,
    regionTab: elements.regionTab,
    similarTab: elements.similarTab,
    tableTab: elements.tableTab,
    settingsTab: elements.settingsTab,
    mobileMoreMenu: elements.mobileMoreMenu,
    mobileStateTab: elements.mobileStateTab,
    mobileRegionTab: elements.mobileRegionTab,
    mobileTableTab: elements.mobileTableTab,
    mobileSettingsTab: elements.mobileSettingsTab,
    mapView: elements.mapView,
    stateView: elements.stateView,
    regionView: elements.regionView,
    similarView: elements.similarView,
    tableView: elements.tableView,
    settingsView: elements.settingsView
  },
  {
    canOpenDetails: () => selectedIntersectionController.hasSelection,
    canOpenSimilar: () => selectedIntersectionController.canCompareSimilar,
    setStatus,
    onViewChanged: () => {
      selectedIntersectionController.updateContextTabs();
      renderActiveAnalysisView();
      selectedIntersectionController.updateStreetViewPanel();
    },
    scheduleMapRefresh
  }
);
clusterSelectionCoordinator = new ClusterSelectionCoordinator({
  getActiveView: () => appRouter.activeView,
  isMobileLayout: () => appRouter.isMobileLayout,
  setView: (view) => appRouter.setView(view),
  mapSelect: (cluster, focus, reason, zoomLevel) => map.select(cluster, focus, reason, zoomLevel),
  ensureSeverityVisible: ensureClusterSeverityVisible,
  scheduleFrame: (work) => {
    window.requestAnimationFrame(work);
  }
});
const tableView = new TableView({
  body: elements.clusterTableBody,
  getResult: () => appState.result,
  getStateFilterValue: () => elements.stateFilter.value,
  selectCluster: (cluster) => clusterSelectionCoordinator.selectCluster(cluster)
});
similarView = new SimilarView({
  container: elements.similarIntersections,
  getResult: () => appState.result,
  getSelectedCluster: () => selectedIntersectionController.selectedCluster,
  getSelectedRoadClassSignature: () => selectedIntersectionController.selectedRoadClassSignature,
  getActiveView: () => appRouter.activeView,
  selectCluster: (cluster) => clusterSelectionCoordinator.selectCluster(cluster)
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
  getResult: () => appState.result,
  getRegionSummaries: () => browseIndexForCurrentResult()?.regionSummaries ?? []
});
exploreView = new ExploreView({
  nearbyList: elements.nearbyList,
  stateHotspotList: elements.stateHotspotList,
  maxIntersections: STATE_BROWSE_MAX_INTERSECTIONS,
  getResult: () => appState.result,
  getUserLocation: () => appState.userLocation,
  getSelectedCluster: () => selectedIntersectionController.selectedCluster,
  getBrowseStateValue: () => elements.browseState.value,
  getBrowseRegionValue: () => elements.browseRegion.value,
  browseIndexForCurrentResult,
  updateBrowseRegionOptions,
  selectCluster: (cluster, telemetrySource) => clusterSelectionCoordinator.selectCluster(cluster, telemetrySource),
  setView: (view) => appRouter.setView(view)
});

startApp();

function startApp(): void {
  applyStaticTranslations();
  showNextLoadingFact();
  analysisOptionsForm.resetToDefaults();
  wireEvents();
  appRouter.setView(appRouter.initialView());
  renderAll();
  void checkForFreshDeploymentHtml();
  void analysisCoordinator.loadBundledData();
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
  elements.analyzeBtn.addEventListener("click", () => analysisCoordinator.runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);
  selectedIntersectionController.bindEvents();
}

function wireAnalysisControlEvents(): void {
  analysisOptionsForm.bindEvents();
}

function wireMapControlEvents(): void {
  [elements.showFatalPoints, elements.showSeriousPoints, elements.showOtherPoints].forEach((input) => {
    input.addEventListener("change", applySeverityFilter);
  });
  elements.locateMeBtn.addEventListener("click", () => locateUser({ selectNearest: false }));
  elements.findNearbyBtn.addEventListener("click", () => locateUser({ selectNearest: true }));
  elements.browseState.addEventListener("change", () => {
    updateBrowseRegionOptions();
    exploreView.renderStateHotspotList();
  });
  elements.browseRegion.addEventListener("change", () => exploreView.renderStateHotspotList());
}

function wireNavigationEvents(): void {
  appRouter.bindEvents();
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

function markAnalysisSettingsDirty(): void {
  const committedAnalysis = appState.committedAnalysis;
  if (!dataRepository.hasAnyAccidents() && !committedAnalysis) {
    return;
  }
  const isDirty = !committedAnalysis || !analysisOptionsEqual(analysisOptionsForm.readOptions(), committedAnalysis.options);
  analysisOptionsForm.setDirty(isDirty);
  if (isDirty && committedAnalysis) {
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

function resetRuntimeAnalysisState(): void {
  appState.resetRuntimeAnalysis();
  selectedIntersectionController.resetSelectionState();
  clearAnalysisDerivedState();
  analysisOptionsForm.setDirty(false);
}

function commitAnalysisState(options: AnalysisOptions, analysisResult: AnalysisResult, dataVersion: string | null): void {
  appState.commitAnalysis(options, analysisResult, dataVersion);
  selectedIntersectionController.resetSelectionState();
  clearAnalysisDerivedState();
  analysisOptionsForm.setDirty(false);
}

function handleAccidentsLoaded(records: AccidentRecord[]): void {
  if (!appState.setAccidents(records)) {
    return;
  }
  selectedIntersectionController.clearAccidentRecordCaches();
  populateFilters();
}

function clearAnalysisDerivedState(): void {
  selectedIntersectionController.clearAccidentRecordCaches();
  severityRankIndexes.clear();
  browseIndexes.clear();
  invalidateRenderedAnalysisViews();
  unclusteredIncidentLayer.reset();
}

function invalidateRenderedAnalysisViews(): void {
  appState.invalidateRenderedMapClusters();
  stateRegionView.invalidate();
  intersectionFeatureSummaryView.invalidate();
  tableView.invalidate();
}

function populateFilters(): void {
  const selectedBrowseState = elements.browseState.value;
  const selectedBrowseRegion = elements.browseRegion.value;
  const availableStateCodes = stateCodesForFilters();

  analysisOptionsForm.populateFilters(availableStateCodes, yearsForFilters());

  elements.browseState.replaceChildren(new Option(tr("option.allStates"), "all"));
  const stateOptions = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1], "de", { sensitivity: "base" }));
  for (const [code, name] of stateOptions) {
    if (availableStateCodes.has(code)) {
      elements.browseState.append(new Option(name, code));
    }
  }
  elements.browseState.value = [...elements.browseState.options].some((option) => option.value === selectedBrowseState)
    ? selectedBrowseState
    : "all";
  updateBrowseRegionOptions(selectedBrowseRegion);
}

function updateBrowseRegionOptions(preferredRegion = elements.browseRegion.value): void {
  const stateCode = elements.browseState.value;
  const shouldShow = Boolean(appState.result) && stateCode !== "all";
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
  return appState.availableStateCodes(Object.keys(STATE_NAMES));
}

function yearsForFilters(): number[] {
  return appState.availableYears(bundledDataYears());
}

function bundledDataYears(): number[] {
  return dataRepository.bundledYears();
}

function renderAll(): void {
  analysisOptionsForm.updateRangeOutputs();
  exploreView.render();
  renderActiveAnalysisView();
  applySeverityFilter();
  renderMapResults();
}

function renderMapResults(): void {
  const currentResult = appState.result;
  if (currentResult) {
    if (appState.renderedMapClusters !== currentResult.clusters) {
      map.setData(currentResult.clusters);
      appState.markRenderedMapClusters(currentResult.clusters);
    }
    elements.mapEmpty.hidden = currentResult.clusters.length > 0;
    updateMapLegendVisibility();
    applyPendingUrlIntersectionSelection();
  } else {
    if (appState.renderedMapClusters !== null) {
      map.setData([]);
      appState.markRenderedMapClusters(null);
    }
    elements.mapEmpty.hidden = false;
    elements.mapIncidentLegend.hidden = true;
    updateMapLegendVisibility();
    selectedIntersectionController.clearSelection();
  }
}

function applyPendingUrlIntersectionSelection(): void {
  if (!pendingUrlIntersectionSelection || !appState.result) {
    return;
  }

  const selection = pendingUrlIntersectionSelection;
  pendingUrlIntersectionSelection = null;
  const nearest = nearestClusterTo(selection);
  if (!nearest || nearest.distanceMeters > INTERSECTION_URL_MATCH_MAX_DISTANCE_METERS) {
    return;
  }

  clusterSelectionCoordinator.selectCluster(nearest.cluster, "intersection URL", selection.zoomLevel);
}

function nearestClusterTo(point: LatLon): { cluster: IntersectionCluster; distanceMeters: number } | null {
  let nearest: { cluster: IntersectionCluster; distanceMeters: number } | null = null;
  for (const cluster of appState.result?.clusters ?? []) {
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
  return readIntersectionUrlSelection(window.location.search);
}

function updateIntersectionSelectionUrl(cluster: IntersectionCluster): void {
  const nextHref = intersectionSelectionHref(window.location.href, cluster, map.zoomLevel());
  if (!nextHref) {
    return;
  }

  window.history.replaceState(window.history.state, "", nextHref);
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
  const hasIntersections = Boolean(appState.result && appState.result.clusters.length > 0);
  const hasIncidentLegend = !elements.mapIncidentLegend.hidden;
  elements.mapIntersectionLegend.hidden = hasIncidentLegend || !hasIntersections;
}

function handleMapZoomChange(): void {
  const selectedCluster = selectedIntersectionController.selectedCluster;
  if (selectedCluster) {
    updateIntersectionSelectionUrl(selectedCluster);
  }
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
      const location = { lat: latitude, lon: longitude, accuracyMeters: accuracy };
      appState.setUserLocation(location);
      map.setUserLocation(location, !options.selectNearest);
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

function renderActiveAnalysisView(): void {
  switch (appRouter.activeView) {
    case "state":
      stateRegionView.renderState();
      return;
    case "region":
      stateRegionView.renderRegion();
      return;
    case "table":
      intersectionFeatureSummaryView.render();
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
  return browseIndexes.forClusters(appState.result?.clusters);
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
  return severityRankIndexes.contextForCluster(appState.result?.clusters, cluster, severityRankIndexHooks(cluster));
}

function severityRankIndexHooks(cluster: IntersectionCluster | null): SeverityRankIndexHooks {
  return {
    prepareIndex: (compute) =>
      clusterSelectionCoordinator.measureActiveInteractionStep("prepare severity rank cache", null, compute, (index: SeverityRankIndex) => ({
        clusterCount: index.clusters.length,
        hasMultipleStates: index.hasMultipleStates
      })),
    computeStateRank: cluster
      ? (compute) => clusterSelectionCoordinator.measureActiveInteractionStep("compute state severity rank", cluster.id, compute, severityRankTelemetryMetadata)
      : undefined,
    computeGermanyRank: cluster
      ? (compute) => clusterSelectionCoordinator.measureActiveInteractionStep("compute germany severity rank", cluster.id, compute, severityRankTelemetryMetadata)
      : undefined
  };
}

function severityRankTelemetryMetadata(rank: SeverityRank | null): TelemetryMetadata {
  return {
    rank: rank?.rank ?? null,
    percentile: rank?.percentile ?? null
  };
}

function ensureClusterSeverityVisible(cluster: IntersectionCluster): void {
  const severity = clusterSeverityKey(cluster);
  const input =
    severity === "fatal" ? elements.showFatalPoints : severity === "serious" ? elements.showSeriousPoints : elements.showOtherPoints;
  if (input.checked) {
    return;
  }
  input.checked = true;
  applySeverityFilter();
}

function scheduleMapRefresh(): void {
  window.requestAnimationFrame(() => {
    if (!appRouter.shouldRefreshMap()) {
      return;
    }
    map.refresh();
  });
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
  const currentResult = appState.result;
  if (!currentResult || currentResult.clusters.length === 0) {
    setStatus(tr("status.noClustersToExport"), 0, "idle");
    return;
  }

  const blob = new Blob([clustersCsv(currentResult.clusters)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "high-severity-intersections.csv";
  link.click();
  URL.revokeObjectURL(url);
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
  analysisOptionsForm.setDisabled(isBusy);
  elements.resetAppBtn.disabled = isBusy;
  loadingStatusPresenter.setBusy(isBusy);
}

function setStatus(message: string, progress: number, kind: LoadingStatusKind = "normal"): void {
  loadingStatusPresenter.setStatus(message, progress, kind);
}

async function loadAccidentsForState(stateCode: string): Promise<AccidentRecord[]> {
  return dataRepository.loadAccidentsForState(stateCode, null);
}

function scheduleAfterFirstRender(work: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(work, 0);
  });
}

function scheduleSelectionSupportPrewarm(): void {
  const sourceResult = appState.result;
  if (!sourceResult?.clusters.length) {
    return;
  }

  scheduleAfterFirstRender(() => {
    scheduleIdleWork(() => {
      if (appState.result !== sourceResult) {
        return;
      }

      const started = performance.now();
      severityRankIndexes.forClusters(sourceResult.clusters, severityRankIndexHooks(null));
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

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
