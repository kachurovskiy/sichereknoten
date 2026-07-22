import "./styles.css";
import { gunzipSync } from "fflate";
import { analyzeDangerousIntersectionsInBackground } from "./analysisRunner";
import { readAnalysisCache, readParsedDataCache, writeAnalysisCache, writeParsedDataCache } from "./cache";
import { GeoGridIndex } from "./geo";
import { MapCanvas } from "./mapCanvas";
import { parseAccidentCsvFiles } from "./parsers/csv";
import { STATE_NAMES } from "./states";
import {
  AccidentRecord,
  AccidentTrendDirection,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  FatalPercentOptions,
  IntersectionCluster
} from "./types";

const BUNDLED_CSV_FILES = [
  "data/csv/Unfallorte_2021_LinRef.csv",
  "data/csv/Unfallorte2022_LinRef.csv",
  "data/csv/Unfallorte2023_LinRef.csv",
  "data/csv/Unfallorte2024_LinRef.csv",
  "data/csv/Unfallorte_2025_LR_BasisDLM.csv"
];

interface EmbeddedDataFile {
  path: string;
  name: string;
  type: string;
  encoding: "gzip-base64";
  size: number;
  compressedSize: number;
  chunks: string[];
}

declare global {
  var __SICHERE_KNOTEN_DATA__: { version?: string; files: EmbeddedDataFile[] } | undefined;
}

declare const __SICHERE_KNOTEN_APP_VERSION__: string | undefined;

type ClusterSortKey = "state" | "location" | "accidents" | "fatal" | "serious" | "fatalPercent";
type SortDirection = "asc" | "desc";
type LoadingStepKey = "cache" | "parse" | "analyze";
type SeverityFilterKey = "fatal" | "serious" | "other";
type ViewKey = "map" | "state" | "table" | "settings";
type SelectionReason = "auto" | "program" | "user";
type HotspotMetricPlacement = "header" | "stats";
const LOADING_STEP_ORDER: LoadingStepKey[] = ["cache", "parse", "analyze"];
const APP_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev-parallel-analysis";
const STREET_VIEW_OPEN_STORAGE_KEY = "sichere-knoten:street-view-open";
const ACCIDENT_CATEGORY_LABELS: Record<number, string> = {
  1: "Accident with persons killed",
  2: "Accident with seriously injured",
  3: "Accident with slightly injured"
};
const ACCIDENT_KIND_LABELS: Record<number, string> = {
  0: "Accident of another kind",
  1: "Collision with another vehicle which starts, stops, or is stationary",
  2: "Collision with another vehicle moving ahead or waiting",
  3: "Collision with another vehicle moving laterally in the same direction",
  4: "Collision with another oncoming vehicle",
  5: "Collision with another vehicle which turns into or crosses a road",
  6: "Collision between vehicle and pedestrian",
  7: "Collision with an obstacle in the carriageway",
  8: "Leaving the carriageway to the right",
  9: "Leaving the carriageway to the left"
};
const ACCIDENT_TYPE_LABELS: Record<number, string> = {
  1: "Driving accident",
  2: "Accident caused by turning off the road",
  3: "Accident caused by turning into a road or by crossing it",
  4: "Accident caused by crossing the road",
  5: "Accident involving stationary traffic",
  6: "Accident between vehicles moving along in carriageway",
  7: "Other accident"
};
const LIGHT_CONDITION_LABELS: Record<number, string> = {
  0: "Daylight",
  1: "Twilight",
  2: "Darkness"
};
const ROAD_SURFACE_LABELS: Record<number, string> = {
  0: "Dry",
  1: "Wet, damp, or slippery",
  2: "Slippery, winter conditions"
};
const PLAUSIBILITY_LEVEL_LABELS: Record<number, string> = {
  1: "Successful location check, regular proceedings",
  2: "Successful location check, advanced bicycle proceedings"
};

interface ClusterTableSort {
  key: ClusterSortKey;
  direction: SortDirection;
}

interface FatalPercentSource {
  fatalPercent: number;
}

interface TrendSeriesPoint extends ClusterYearStat {
  x: number;
  accidentY: number;
}

interface AnalysisCacheContext {
  dataVersion: string;
  appVersion: string;
}

interface AccidentIndexCache {
  key: string;
  index: GeoGridIndex<AccidentRecord>;
}

interface AccidentKeyLookupCache {
  source: AccidentRecord[];
  map: Map<string, AccidentRecord>;
}

interface CrossingAccident {
  accident: AccidentRecord;
  distanceMeters: number;
}

let accidents: AccidentRecord[] = [];
let result: AnalysisResult | null = null;
let selectedCluster: IntersectionCluster | null = null;
let clusterTableSort: ClusterTableSort = { key: "fatalPercent", direction: "desc" };
let analysisSettingsDirty = false;
let activeDataVersion: string | null = null;
let userLocation: { lat: number; lon: number; accuracyMeters: number | null } | null = null;
let activeAnalysisOptions: AnalysisOptions | null = null;
let crossingAccidentIndexCache: AccidentIndexCache | null = null;
let accidentKeyLookupCache: AccidentKeyLookupCache | null = null;
let isStreetViewOpen = readStoredStreetViewOpen();

const elements = {
  splash: byId<HTMLDivElement>("appSplash"),
  splashLoadingTitle: byId<HTMLHeadingElement>("splashLoadingTitle"),
  splashLoadingStatus: byId<HTMLParagraphElement>("splashLoadingStatus"),
  splashLoadingBar: byId<HTMLDivElement>("splashLoadingBar"),
  loadBundledBtn: byId<HTMLButtonElement>("loadBundledBtn"),
  clearBtn: byId<HTMLButtonElement>("clearBtn"),
  analyzeBtn: byId<HTMLButtonElement>("analyzeBtn"),
  clusterRadius: byId<HTMLInputElement>("clusterRadius"),
  clusterRadiusOut: byId<HTMLInputElement>("clusterRadiusOut"),
  minAccidents: byId<HTMLInputElement>("minAccidents"),
  topCount: byId<HTMLInputElement>("topCount"),
  fatalWeight: byId<HTMLInputElement>("fatalWeight"),
  seriousWeight: byId<HTMLInputElement>("seriousWeight"),
  fatalFullSample: byId<HTMLInputElement>("fatalFullSample"),
  fatalTrendDeadZone: byId<HTMLInputElement>("fatalTrendDeadZone"),
  fatalTrendFullSignal: byId<HTMLInputElement>("fatalTrendFullSignal"),
  fatalMaxTrendAdjustment: byId<HTMLInputElement>("fatalMaxTrendAdjustment"),
  fatalMaxPercent: byId<HTMLInputElement>("fatalMaxPercent"),
  stateFilter: byId<HTMLSelectElement>("stateFilter"),
  yearFilter: byId<HTMLDivElement>("yearFilter"),
  mapColumn: byId<HTMLDivElement>("mapColumn"),
  mapCanvas: byId<HTMLCanvasElement>("mapCanvas"),
  mapEmpty: byId<HTMLDivElement>("mapEmpty"),
  mapLoadingTitle: byId<HTMLHeadingElement>("mapLoadingTitle"),
  mapLoadingStatus: byId<HTMLParagraphElement>("mapLoadingStatus"),
  mapLoadingBar: byId<HTMLDivElement>("mapLoadingBar"),
  loadingSteps: Array.from(document.querySelectorAll<HTMLElement>("[data-loading-step]")),
  selectedAside: byId<HTMLElement>("selectedAside"),
  selectedMapActions: byId<HTMLDivElement>("selectedMapActions"),
  selectionDetails: byId<HTMLDivElement>("selectionDetails"),
  findNearbyBtn: byId<HTMLButtonElement>("findNearbyBtn"),
  nearbyList: byId<HTMLDivElement>("nearbyList"),
  browseState: byId<HTMLSelectElement>("browseState"),
  stateHotspotList: byId<HTMLDivElement>("stateHotspotList"),
  stateTableBody: byId<HTMLTableSectionElement>("stateTableBody"),
  clusterTableBody: byId<HTMLTableSectionElement>("clusterTableBody"),
  mapTab: byId<HTMLButtonElement>("mapTab"),
  stateTab: byId<HTMLButtonElement>("stateTab"),
  tableTab: byId<HTMLButtonElement>("tableTab"),
  settingsTab: byId<HTMLButtonElement>("settingsTab"),
  mapView: byId<HTMLElement>("mapView"),
  stateView: byId<HTMLElement>("stateView"),
  tableView: byId<HTMLElement>("tableView"),
  settingsView: byId<HTMLElement>("settingsView"),
  showFatalPoints: byId<HTMLInputElement>("showFatalPoints"),
  showSeriousPoints: byId<HTMLInputElement>("showSeriousPoints"),
  showOtherPoints: byId<HTMLInputElement>("showOtherPoints"),
  locateMeBtn: byId<HTMLButtonElement>("locateMeBtn"),
  streetViewPanel: byId<HTMLElement>("streetViewPanel"),
  streetViewToggle: byId<HTMLButtonElement>("streetViewToggle"),
  streetViewToggleText: byId<HTMLSpanElement>("streetViewToggleText"),
  streetViewBody: byId<HTMLDivElement>("streetViewBody"),
  streetViewFrame: byId<HTMLIFrameElement>("streetViewFrame"),
  streetViewEmpty: byId<HTMLParagraphElement>("streetViewEmpty"),
  exportBtn: byId<HTMLButtonElement>("exportBtn")
};

const map = new MapCanvas(elements.mapCanvas, handleClusterSelection);

resetAnalysisControlsToDefaults();
wireEvents();
updateStreetViewPanel();
renderAll();
void loadBundledData();

function wireEvents(): void {
  elements.loadBundledBtn.addEventListener("click", () => void loadBundledData());
  elements.clearBtn.addEventListener("click", clearData);
  elements.analyzeBtn.addEventListener("click", () => runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);

  wireLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut, markAnalysisSettingsDirty);

  wireClampedNumberInput(elements.minAccidents, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.fatalFullSample, markAnalysisSettingsDirty);
  fatalPercentDecimalInputs().forEach((input) => wireClampedDecimalInput(input, markAnalysisSettingsDirty));

  elements.stateFilter.addEventListener("input", markAnalysisSettingsDirty);
  elements.stateFilter.addEventListener("change", markAnalysisSettingsDirty);

  elements.topCount.addEventListener("input", () => {
    if (result) {
      renderTables();
    }
  });
  elements.topCount.addEventListener("change", () => {
    normalizeNumberInput(elements.topCount);
    if (result) {
      renderTables();
    }
  });

  [elements.showFatalPoints, elements.showSeriousPoints, elements.showOtherPoints].forEach((input) => {
    input.addEventListener("change", applySeverityFilter);
  });
  elements.locateMeBtn.addEventListener("click", () => locateUser({ selectNearest: false }));
  elements.findNearbyBtn.addEventListener("click", () => locateUser({ selectNearest: true }));
  elements.streetViewToggle.addEventListener("click", toggleStreetViewPanel);
  elements.browseState.addEventListener("change", renderExplore);

  elements.mapTab.addEventListener("click", () => setView("map"));
  elements.stateTab.addEventListener("click", () => setView("state"));
  elements.tableTab.addEventListener("click", () => setView("table"));
  elements.settingsTab.addEventListener("click", () => setView("settings"));

  for (const button of clusterSortButtons()) {
    button.addEventListener("click", () => {
      const key = button.dataset.clusterSort as ClusterSortKey | undefined;
      if (!key) {
        return;
      }
      clusterTableSort =
        clusterTableSort.key === key
          ? { key, direction: clusterTableSort.direction === "asc" ? "desc" : "asc" }
          : { key, direction: defaultClusterSortDirection(key) };
      renderTables();
    });
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
  resetInputToDefault(elements.topCount);
  fatalPercentInputs().forEach(resetInputToDefault);
  normalizeLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut);
  normalizeNumberInput(elements.minAccidents);
  normalizeNumberInput(elements.topCount);
  normalizeFatalPercentInputs();
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

function normalizeFatalPercentInputs(): void {
  normalizeNumberInput(elements.fatalFullSample);
  fatalPercentDecimalInputs().forEach(normalizeDecimalInput);
}

function fatalPercentInputs(): HTMLInputElement[] {
  return [
    elements.fatalWeight,
    elements.seriousWeight,
    elements.fatalFullSample,
    elements.fatalTrendDeadZone,
    elements.fatalTrendFullSignal,
    elements.fatalMaxTrendAdjustment,
    elements.fatalMaxPercent
  ];
}

function fatalPercentDecimalInputs(): HTMLInputElement[] {
  return [
    elements.fatalWeight,
    elements.seriousWeight,
    elements.fatalTrendDeadZone,
    elements.fatalTrendFullSignal,
    elements.fatalMaxTrendAdjustment,
    elements.fatalMaxPercent
  ];
}

function formatInputNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value, 4));
}

function markAnalysisSettingsDirty(): void {
  if (!accidents.length && !result) {
    return;
  }
  analysisSettingsDirty = true;
  updateAnalyzeButton();
  if (result) {
    setStatus("Settings changed. Click Analyze to update results.", 100);
  }
}

async function loadBundledData(): Promise<void> {
  setBusy(true);
  let analysisStarted = false;
  try {
    accidents = [];
    result = null;
    selectedCluster = null;
    activeAnalysisOptions = null;
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    analysisSettingsDirty = false;
    activeDataVersion = null;
    updateAnalyzeButton();
    populateFilters();
    renderAll();
    const dataVersion = bundledDataVersion();
    activeDataVersion = dataVersion;
    setStatus("Checking parsed data cache.", 4);
    const cached = await readParsedDataCache(dataVersion, setStatus);
    if (cached) {
      accidents = cached.accidents;
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      populateFilters();
      setStatus(`${accidents.length.toLocaleString()} accidents loaded from cache.`, 66);
      analysisStarted = true;
      runAnalysis();
      return;
    }

    setStatus("Cache miss. Parsing bundled CSV files.", 10);
    const loadedAccidents: AccidentRecord[] = [];
    for (const [index, path] of BUNDLED_CSV_FILES.entries()) {
      const blob = await readBundledBlob(path);
      const file = new File([blob], path.split("/").pop() ?? "accidents.csv", { type: "text/csv" });
      const parsed = await parseAccidentCsvFiles([file], (progress) => {
        const baseProgress = 10 + index * 9;
        setStatus(progress.message ?? `Parsing ${progress.label}`, Math.min(55, baseProgress + 8));
      });
      loadedAccidents.push(...parsed);
      accidents = loadedAccidents;
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      populateFilters();
    }
    setStatus(`${accidents.length.toLocaleString()} accident records loaded.`, 60);

    try {
      await writeParsedDataCache(dataVersion, accidents, setStatus);
      setStatus("Parsed data cached for future refreshes.", 74);
    } catch (error) {
      setStatus(`Parsed data loaded. Cache write skipped: ${errorMessage(error)}`, 74);
    }
    analysisStarted = true;
    runAnalysis();
  } catch (error) {
    setStatus(errorMessage(error), 0);
  } finally {
    if (!analysisStarted) {
      setBusy(false);
    }
  }
}

async function loadAccidentCsv(files: File[], replace: boolean, manageBusy = true): Promise<void> {
  if (manageBusy) {
    setBusy(true);
  }
  try {
    const parsed = await parseAccidentCsvFiles(files, (progress) => {
      setStatus(progress.message ?? `Parsing ${progress.label}`, progress.total ? progressValue(progress.loaded, progress.total) : 45);
    });
    accidents = replace ? parsed : accidents.concat(parsed);
    result = null;
    selectedCluster = null;
    activeAnalysisOptions = null;
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    populateFilters();
    setStatus(`${accidents.length.toLocaleString()} accident records loaded.`, 100);
    activeDataVersion = null;
  } catch (error) {
    setStatus(errorMessage(error), 0);
  } finally {
    if (manageBusy) {
      setBusy(false);
    }
    renderAll();
  }
}

function runAnalysis(): void {
  if (accidents.length === 0) {
    setStatus("Load accident data first.", 0);
    return;
  }

  normalizeLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut);
  const options = readOptions();
  const cacheContext = activeDataVersion ? { dataVersion: activeDataVersion, appVersion: APP_CACHE_VERSION } : null;
  setBusy(true);
  void runAnalysisWithCache(options, cacheContext);
}

async function runAnalysisWithCache(options: AnalysisOptions, cacheContext: AnalysisCacheContext | null): Promise<void> {
  try {
    if (cacheContext) {
      setStatus("Checking analysis cache.", 75);
      const cached = await readAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options);
      if (cached) {
        result = cached;
        selectedCluster = null;
        activeAnalysisOptions = cloneAnalysisOptions(options);
        crossingAccidentIndexCache = null;
        accidentKeyLookupCache = null;
        analysisSettingsDirty = false;
        renderAll();
        setStatus(`${result.clusters.length.toLocaleString()} intersection clusters loaded from cache.`, 100);
        return;
      }
    }

    setStatus("Analyzing intersections.", 75);
    await yieldToBrowser();
    result = await analyzeDangerousIntersectionsInBackground(accidents, options, updateAnalysisPlanStatus);
    selectedCluster = null;
    activeAnalysisOptions = cloneAnalysisOptions(options);
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    analysisSettingsDirty = false;
    renderAll();

    if (cacheContext) {
      try {
        setStatus("Caching analysis result.", 96);
        await writeAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options, result);
      } catch {
        // The analysis result is already rendered; cache failures only affect later reload speed.
      }
    }

    setStatus(`${result.clusters.length.toLocaleString()} intersection clusters analyzed.`, 100);
  } catch (error) {
    setStatus(errorMessage(error), 0);
  } finally {
    setBusy(false);
  }
}

function updateAnalysisPlanStatus(): void {
  setStatus("Analyzing intersections.", 75);
}

function readOptions(): AnalysisOptions {
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
    stateCode: elements.stateFilter.value as AnalysisOptions["stateCode"],
    fatalPercent: readFatalPercentOptions()
  };
}

function readFatalPercentOptions(): FatalPercentOptions {
  const trendDeadZonePercent = normalizeDecimalInput(elements.fatalTrendDeadZone);
  const trendFullSignalPercent = Math.max(trendDeadZonePercent + 0.1, normalizeDecimalInput(elements.fatalTrendFullSignal));
  elements.fatalTrendFullSignal.value = formatInputNumber(trendFullSignalPercent);

  return {
    fatalWeight: normalizeDecimalInput(elements.fatalWeight),
    seriousWeight: normalizeDecimalInput(elements.seriousWeight),
    fullSampleAccidents: normalizeNumberInput(elements.fatalFullSample),
    trendDeadZone: trendDeadZonePercent / 100,
    trendFullSignal: trendFullSignalPercent / 100,
    maxTrendAdjustment: normalizeDecimalInput(elements.fatalMaxTrendAdjustment) / 100,
    maxFatalPercent: normalizeDecimalInput(elements.fatalMaxPercent) / 100
  };
}

function cloneAnalysisOptions(options: AnalysisOptions): AnalysisOptions {
  return {
    ...options,
    years: new Set(options.years),
    fatalPercent: { ...options.fatalPercent }
  };
}

function populateFilters(): void {
  const selectedState = elements.stateFilter.value;
  const selectedBrowseState = elements.browseState.value;
  elements.stateFilter.innerHTML = `<option value="all">All Bundeslaender</option>`;
  elements.browseState.innerHTML = `<option value="all">All Bundeslaender</option>`;
  const stateOptions = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1], "de", { sensitivity: "base" }));
  for (const [code, name] of stateOptions) {
    if (accidents.some((accident) => accident.stateCode === code)) {
      elements.stateFilter.append(new Option(name, code));
      elements.browseState.append(new Option(name, code));
    }
  }
  elements.stateFilter.value = [...elements.stateFilter.options].some((option) => option.value === selectedState) ? selectedState : "all";
  elements.browseState.value = [...elements.browseState.options].some((option) => option.value === selectedBrowseState)
    ? selectedBrowseState
    : "all";

  const years = Array.from(new Set(accidents.map((accident) => accident.year).filter(Boolean))).sort((a, b) => a - b);
  elements.yearFilter.innerHTML = "";
  for (const year of years) {
    const label = document.createElement("label");
    label.className = "year-pill";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(year);
    input.checked = true;
    input.addEventListener("change", markAnalysisSettingsDirty);
    label.append(input, document.createTextNode(String(year)));
    elements.yearFilter.append(label);
  }
  setAnalysisControlsDisabled(elements.analyzeBtn.disabled);
}

function renderAll(): void {
  updateRangeOutputs();
  renderTables();
  renderExplore();
  applySeverityFilter();
  if (result) {
    map.setData(result.clusters);
    elements.mapEmpty.hidden = result.clusters.length > 0;
  } else {
    elements.mapEmpty.hidden = false;
    renderSelection(null);
  }
}

function handleClusterSelection(cluster: IntersectionCluster | null, _reason: SelectionReason): void {
  selectedCluster = cluster;
  renderSelection(cluster);
  renderExplore();

  if (!cluster) {
    return;
  }

}

function applySeverityFilter(): void {
  map.setSeverityFilters({
    fatal: elements.showFatalPoints.checked,
    serious: elements.showSeriousPoints.checked,
    other: elements.showOtherPoints.checked
  });
  renderExplore();
}

function locateUser(options: { selectNearest: boolean }): void {
  if (!navigator.geolocation) {
    setStatus("Browser geolocation is not available on this page.", 100);
    return;
  }

  setLocateBusy(true);
  setStatus("Requesting your browser location.", 100);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      userLocation = { lat: latitude, lon: longitude, accuracyMeters: accuracy };
      map.setUserLocation(userLocation, !options.selectNearest);
      elements.locateMeBtn.classList.add("located");
      setLocateBusy(false);
      renderExplore();
      const selectedNearest = options.selectNearest ? selectNearestCluster() : null;
      if (options.selectNearest) {
        setStatus(
          selectedNearest
            ? `Showing nearest visible dangerous intersection (${formatDistance(selectedNearest.distanceMeters)} away, ${Math.round(accuracy)} m location accuracy).`
            : `Centered map on your location (${Math.round(accuracy)} m accuracy). No visible dangerous intersection matched the active filters.`,
          100
        );
      } else {
        setStatus(`Centered map on your location (${Math.round(accuracy)} m accuracy).`, 100);
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
      return "Location permission was denied.";
    case error.POSITION_UNAVAILABLE:
      return "Your location is currently unavailable.";
    case error.TIMEOUT:
      return "Location request timed out.";
    default:
      return "Could not get your location.";
  }
}

function renderTables(): void {
  updateClusterSortHeaders();
  elements.stateTableBody.innerHTML = "";
  elements.clusterTableBody.innerHTML = "";
  if (!result) {
    return;
  }

  for (const summary of result.stateSummaries) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(summary.stateName)}</td>
      <td>${summary.accidentCount.toLocaleString()}</td>
      <td>${summary.clusterCount.toLocaleString()}</td>
      <td>${formatFatalPercent(summary)}</td>
      <td>${summary.topCluster ? clusterLocation(summary.topCluster) : ""}</td>
    `;
    if (summary.topCluster) {
      row.addEventListener("click", () => {
        setView("map");
        map.select(summary.topCluster, true);
      });
    }
    elements.stateTableBody.append(row);
  }

  const topCount = normalizeNumberInput(elements.topCount);
  const clusters = clustersForTable(result.clusters, topCount);
  for (const cluster of clusters) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.innerHTML = `
      <td>${escapeHtml(cluster.stateName)}</td>
      <td>${clusterLocation(cluster)}</td>
      <td>${cluster.accidentCount.toLocaleString()}</td>
      <td>${cluster.fatalCount.toLocaleString()}</td>
      <td>${cluster.seriousCount.toLocaleString()}</td>
      <td>${formatFatalPercent(cluster)}</td>
    `;
    row.addEventListener("click", () => {
      setView("map");
      map.select(cluster, true);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        setView("map");
        map.select(cluster, true);
      }
    });
    elements.clusterTableBody.append(row);
  }
}

function clustersForTable(clusters: IntersectionCluster[], topCount: number): IntersectionCluster[] {
  const sortedClusters = sortClustersForTable(clusters);
  if (elements.stateFilter.value !== "all") {
    return sortedClusters.slice(0, topCount);
  }

  const byState = new Map<string, number>();
  const selected: IntersectionCluster[] = [];
  for (const cluster of sortedClusters) {
    const current = byState.get(cluster.stateCode) ?? 0;
    if (current < topCount) {
      selected.push(cluster);
      byState.set(cluster.stateCode, current + 1);
    }
  }
  return selected;
}

function sortClustersForTable(clusters: IntersectionCluster[]): IntersectionCluster[] {
  return clusters.slice().sort((a, b) => {
    const primary = compareClusterSortValue(a, b, clusterTableSort.key, clusterTableSort.direction);
    return primary || compareClusterCoreMetric(a, b);
  });
}

function compareClusterSortValue(
  a: IntersectionCluster,
  b: IntersectionCluster,
  key: ClusterSortKey,
  direction: SortDirection
): number {
  const aValue = clusterSortValue(a, key);
  const bValue = clusterSortValue(b, key);
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

function clusterSortValue(cluster: IntersectionCluster, key: ClusterSortKey): number | string | null {
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
    case "fatalPercent":
      return cluster.fatalPercent;
  }
}

function compareClusterCoreMetric(a: IntersectionCluster, b: IntersectionCluster): number {
  return (
    b.fatalPercent - a.fatalPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount ||
    clusterLocationText(a).localeCompare(clusterLocationText(b), "de", { sensitivity: "base" })
  );
}

function defaultClusterSortDirection(key: ClusterSortKey): SortDirection {
  return key === "state" || key === "location" ? "asc" : "desc";
}

function updateClusterSortHeaders(): void {
  for (const button of clusterSortButtons()) {
    const key = button.dataset.clusterSort as ClusterSortKey | undefined;
    const active = key === clusterTableSort.key;
    const indicator = button.querySelector<HTMLElement>(".sort-indicator");
    const label = button.querySelector("span")?.textContent?.trim() ?? "Column";
    const header = button.closest("th");
    button.classList.toggle("active", active);
    button.setAttribute("aria-label", `${label} sorted ${active ? clusterTableSort.direction : "none"}`);
    if (indicator) {
      indicator.textContent = active ? (clusterTableSort.direction === "asc" ? "^" : "v") : "";
    }
    if (header) {
      header.setAttribute("aria-sort", active ? (clusterTableSort.direction === "asc" ? "ascending" : "descending") : "none");
    }
  }
}

function clusterSortButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-cluster-sort]"));
}

function renderExplore(): void {
  renderNearbyList();
  renderStateHotspotList();
}

function renderNearbyList(): void {
  elements.nearbyList.innerHTML = "";
  elements.nearbyList.hidden = false;
  if (!result || !userLocation) {
    elements.nearbyList.hidden = true;
    return;
  }

  const nearby = nearbyClusters(6);
  if (nearby.length === 0) {
    elements.nearbyList.append(emptyHotspotMessage("No intersections match the active severity filters near this location."));
    return;
  }

  nearby.forEach((entry) => {
    elements.nearbyList.append(hotspotButton(entry.cluster, `${formatDistance(entry.distanceMeters)} away`));
  });
}

function renderStateHotspotList(): void {
  elements.stateHotspotList.innerHTML = "";
  if (!result) {
    elements.stateHotspotList.append(emptyHotspotMessage("State hotspots will appear after the data loads."));
    return;
  }

  const stateCode = elements.browseState.value;
  const clusters =
    stateCode === "all"
      ? topClusterByState()
      : (result?.clusters ?? [])
          .filter((cluster) => cluster.stateCode === stateCode)
          .slice(0, 8);

  if (clusters.length === 0) {
    elements.stateHotspotList.append(emptyHotspotMessage("No intersections match the active analysis settings."));
    return;
  }

  clusters.forEach((cluster) => {
    elements.stateHotspotList.append(hotspotButton(cluster, cluster.stateName, { metricPlacement: "header" }));
  });
}

function topClusterByState(): IntersectionCluster[] {
  return (result?.stateSummaries ?? [])
    .flatMap((summary) => (summary.topCluster ? [summary.topCluster] : []))
    .sort((a, b) => a.stateName.localeCompare(b.stateName, "de", { sensitivity: "base" }));
}

function hotspotButton(
  cluster: IntersectionCluster,
  context: string,
  options: { metricPlacement?: HotspotMetricPlacement } = {}
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hotspot-button";
  button.classList.toggle("selected", selectedCluster?.id === cluster.id);
  const metricPlacement = options.metricPlacement ?? "stats";
  const metricStat = `<span class="hotspot-stat hotspot-stat-metric"><strong>${formatFatalPercent(cluster)}</strong> Harm</span>`;
  button.innerHTML = `
    <span class="hotspot-main">
      <span class="hotspot-heading">
        <span class="hotspot-title">${escapeHtml(context)}</span>
        ${metricPlacement === "header" ? metricStat : ""}
      </span>
      <span class="hotspot-stats">
        ${metricPlacement === "stats" ? metricStat : ""}
        <span class="hotspot-stat hotspot-stat-total"><strong>${cluster.accidentCount.toLocaleString()}</strong> ${pluralNoun(cluster.accidentCount, "accident")}</span>
        <span class="hotspot-stat"><strong>${cluster.fatalCount.toLocaleString()}</strong> fatal</span>
        <span class="hotspot-stat"><strong>${cluster.seriousCount.toLocaleString()}</strong> serious</span>
      </span>
    </span>
  `;
  button.addEventListener("click", () => {
    setView("map");
    map.select(cluster, true);
  });
  return button;
}

function pluralNoun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function emptyHotspotMessage(message: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "hotspot-empty";
  element.textContent = message;
  return element;
}

function nearbyClusters(limit: number): Array<{ cluster: IntersectionCluster; distanceMeters: number }> {
  const location = userLocation;
  if (!location) {
    return [];
  }

  return visibleSeverityClusters()
    .map((cluster) => ({ cluster, distanceMeters: distanceMeters(location, cluster) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters || compareClusterCoreMetric(a.cluster, b.cluster))
    .slice(0, limit);
}

function selectNearestCluster(): { cluster: IntersectionCluster; distanceMeters: number } | null {
  const nearest = nearbyClusters(1)[0];
  if (!nearest) {
    setView("map");
    return null;
  }
  setView("map");
  map.select(nearest.cluster, true);
  return nearest;
}

function visibleSeverityClusters(): IntersectionCluster[] {
  return (result?.clusters ?? []).filter(clusterMatchesSeverityFilter);
}

function clusterMatchesSeverityFilter(cluster: IntersectionCluster): boolean {
  switch (clusterSeverity(cluster)) {
    case "fatal":
      return elements.showFatalPoints.checked;
    case "serious":
      return elements.showSeriousPoints.checked;
    case "other":
      return elements.showOtherPoints.checked;
  }
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
    elements.selectedAside.hidden = true;
    elements.selectedMapActions.hidden = true;
    elements.selectedMapActions.innerHTML = "";
    elements.mapView.classList.remove("has-selection");
    elements.selectionDetails.textContent = "No intersection selected.";
    updateStreetViewPanel();
    return;
  }

  elements.selectedAside.hidden = false;
  elements.selectedMapActions.hidden = false;
  elements.mapView.classList.add("has-selection");
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  const openStreetMapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const trendPanel = renderTrendPanel(cluster);
  const recordPanel = renderSidebarAccidentRecords(clusterAccidentRecords(cluster), cluster.accidentCount);

  elements.selectedMapActions.innerHTML = renderMapServiceActions(openStreetMapUrl, googleMapsUrl);
  elements.selectionDetails.innerHTML = `
    <dl>
      <div><dt>Bundesland</dt><dd>${escapeHtml(cluster.stateName)}</dd></div>
      <div><dt>Coordinates</dt><dd>${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}</dd></div>
      <div><dt>Years</dt><dd>${cluster.years.join(", ")}</dd></div>
      <div><dt>Accidents</dt><dd>${cluster.accidentCount.toLocaleString()}</dd></div>
      <div><dt>Fatal / serious</dt><dd>${cluster.fatalCount} / ${cluster.seriousCount}</dd></div>
      <div><dt>Harm %</dt><dd>${formatFatalPercent(cluster)}</dd></div>
      <div><dt>Vulnerable users</dt><dd>${cluster.vulnerableCount.toLocaleString()}</dd></div>
    </dl>
    ${trendPanel}
    ${recordPanel}
  `;
  updateStreetViewPanel();
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
  elements.streetViewToggleText.textContent = isExpanded ? "Hide" : "Show";
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
  elements.streetViewFrame.title = `Google Street View near ${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
  elements.streetViewFrame.hidden = false;
  elements.streetViewEmpty.hidden = true;
  scheduleMapRefresh();
}

function clearStreetViewFrame(): void {
  elements.streetViewFrame.hidden = true;
  elements.streetViewFrame.removeAttribute("src");
  delete elements.streetViewFrame.dataset.src;
}

function googleStreetViewEmbedUrl(cluster: IntersectionCluster): string {
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  return `https://www.google.com/maps?layer=c&cbll=${lat},${lon}&cbp=11,0,0,0,0&output=svembed`;
}

function scheduleMapRefresh(): void {
  window.requestAnimationFrame(() => map.refresh());
}

function renderMapServiceActions(openStreetMapUrl: string, googleMapsUrl: string): string {
  return `
    <a class="map-service-icon" href="${openStreetMapUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open in OpenStreetMap" title="Open in OpenStreetMap">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6.5 9 4l6 2.5 6-2.5v13.5L15 20l-6-2.5L3 20V6.5z" />
        <path d="M9 4v13.5" />
        <path d="M15 6.5V20" />
      </svg>
    </a>
    <a class="map-service-icon" href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps" title="Open in Google Maps">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21s6-5.4 6-11a6 6 0 0 0-12 0c0 5.6 6 11 6 11z" />
        <path d="M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />
      </svg>
    </a>
  `;
}

function renderSidebarAccidentRecords(records: CrossingAccident[], totalCount: number): string {
  const countText = `${records.length.toLocaleString()} of ${totalCount.toLocaleString()}`;
  if (records.length === 0) {
    return `
      <section class="sidebar-accident-records">
        <div class="section-heading-row">
          <h3>Known accident records</h3>
          <span>${countText}</span>
        </div>
        <p class="hotspot-empty">No matching source accident records were found near this intersection.</p>
      </section>
    `;
  }

  const items = records
    .map(({ accident, distanceMeters }) => {
      const severity = accidentSeverity(accident);
      const rows = accidentRecordRows(accident, distanceMeters)
        .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
        .join("");
      return `
        <li class="accident-record-item">
          <div class="accident-record-topline">
            <span class="severity-pill severity-${severity}">${accidentSeverityLabel(accident)}</span>
            <strong>${escapeHtml(accidentTimeLabel(accident))}</strong>
          </div>
          <dl class="accident-record-fields">${rows}</dl>
        </li>
      `;
    })
    .join("");

  return `
    <section class="sidebar-accident-records">
      <div class="section-heading-row">
        <h3>Known accident records</h3>
        <span>${countText}</span>
      </div>
      <ol class="accident-record-list">${items}</ol>
    </section>
  `;
}

function accidentRecordRows(accident: AccidentRecord, distanceMeters: number): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  addRecordRow(rows, "Category", codeLabel(accident.category, ACCIDENT_CATEGORY_LABELS));
  addRecordRow(rows, "Kind", codeLabel(accident.accidentKind, ACCIDENT_KIND_LABELS));
  addRecordRow(rows, "Type", codeLabel(accident.accidentType, ACCIDENT_TYPE_LABELS));
  addRecordRow(rows, "Light", codeLabel(accident.lightCondition, LIGHT_CONDITION_LABELS));
  addRecordRow(rows, "Surface", codeLabel(accident.roadSurface, ROAD_SURFACE_LABELS));
  addRecordRow(rows, "Road users", roadUsersLabel(accident));
  addRecordRow(rows, "Area", administrativeAreaLabel(accident));
  addRecordRow(rows, "Coordinates", `${accident.lat.toFixed(6)}, ${accident.lon.toFixed(6)}`);
  addRecordRow(rows, "LINREF", linRefLabel(accident));
  addRecordRow(rows, "Location check", codeLabel(accident.plausibilityLevel, PLAUSIBILITY_LEVEL_LABELS));
  addRecordRow(rows, "Distance", `${Math.round(distanceMeters)} m`);
  addRecordRow(rows, "Record ID", recordIdLabel(accident));
  addRecordRow(rows, "Source", accident.source);
  return rows;
}

function addRecordRow(rows: Array<{ label: string; value: string }>, label: string, value: string | null): void {
  if (value) {
    rows.push({ label, value });
  }
}

function clusterAccidentRecords(cluster: IntersectionCluster): CrossingAccident[] {
  const exactRecords = exactClusterAccidentRecords(cluster);
  if (exactRecords.length > 0) {
    return exactRecords.sort(compareCrossingAccidents);
  }

  const options = activeAnalysisOptions ?? readOptions();
  const searchRadiusMeters = clusterAccidentSearchRadius(options);
  const index = accidentIndexForCrossings(options, searchRadiusMeters);
  const candidates = index
    .nearby(cluster)
    .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }))
    .filter((entry) => entry.distanceMeters <= searchRadiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return pickClusterAccidents(candidates, cluster).sort(compareCrossingAccidents);
}

function exactClusterAccidentRecords(cluster: IntersectionCluster): CrossingAccident[] {
  if (!cluster.accidentKeys?.length) {
    return [];
  }

  const lookup = accidentKeyLookup();
  return cluster.accidentKeys
    .map((key) => lookup.get(key))
    .filter((accident): accident is AccidentRecord => Boolean(accident))
    .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }));
}

function accidentKeyLookup(): Map<string, AccidentRecord> {
  if (accidentKeyLookupCache?.source === accidents) {
    return accidentKeyLookupCache.map;
  }

  const map = new Map<string, AccidentRecord>();
  for (const accident of accidents) {
    map.set(accidentKey(accident), accident);
  }
  accidentKeyLookupCache = { source: accidents, map };
  return map;
}

function pickClusterAccidents(candidates: CrossingAccident[], cluster: IntersectionCluster): CrossingAccident[] {
  const selected = new Set<AccidentRecord>();
  const selectedRecords: CrossingAccident[] = [];
  const remainingBySeverity = new Map<SeverityFilterKey, number>([
    ["fatal", cluster.fatalCount],
    ["serious", cluster.seriousCount],
    ["other", Math.max(0, cluster.accidentCount - cluster.fatalCount - cluster.seriousCount)]
  ]);

  for (const candidate of candidates) {
    const severity = accidentSeverity(candidate.accident);
    const remaining = remainingBySeverity.get(severity) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    selected.add(candidate.accident);
    selectedRecords.push(candidate);
    remainingBySeverity.set(severity, remaining - 1);
    if (selectedRecords.length >= cluster.accidentCount) {
      return selectedRecords;
    }
  }

  for (const candidate of candidates) {
    if (selected.has(candidate.accident)) {
      continue;
    }
    selectedRecords.push(candidate);
    if (selectedRecords.length >= cluster.accidentCount) {
      break;
    }
  }

  return selectedRecords;
}

function accidentIndexForCrossings(options: AnalysisOptions, searchRadiusMeters: number): GeoGridIndex<AccidentRecord> {
  const key = analysisOptionsIndexKey(options, searchRadiusMeters);
  if (crossingAccidentIndexCache?.key === key) {
    return crossingAccidentIndexCache.index;
  }

  const index = new GeoGridIndex<AccidentRecord>(searchRadiusMeters);
  for (const accident of accidents) {
    if (accidentMatchesAnalysisOptions(accident, options)) {
      index.insert(accident);
    }
  }
  crossingAccidentIndexCache = { key, index };
  return index;
}

function accidentMatchesAnalysisOptions(accident: AccidentRecord, options: AnalysisOptions): boolean {
  if (options.years.size > 0 && !options.years.has(accident.year)) {
    return false;
  }
  return options.stateCode === "all" || accident.stateCode === options.stateCode;
}

function analysisOptionsIndexKey(options: AnalysisOptions, searchRadiusMeters: number): string {
  return [
    options.stateCode,
    options.clusterRadiusMeters,
    searchRadiusMeters,
    [...options.years].sort((a, b) => a - b).join(",")
  ].join("|");
}

function clusterAccidentSearchRadius(options: AnalysisOptions): number {
  return Math.max(150, options.clusterRadiusMeters * 3);
}

function compareCrossingAccidents(a: CrossingAccident, b: CrossingAccident): number {
  return (
    b.accident.year - a.accident.year ||
    (b.accident.month ?? 0) - (a.accident.month ?? 0) ||
    (b.accident.hour ?? -1) - (a.accident.hour ?? -1) ||
    severityOrder(a.accident) - severityOrder(b.accident) ||
    a.distanceMeters - b.distanceMeters
  );
}

function severityOrder(accident: AccidentRecord): number {
  switch (accidentSeverity(accident)) {
    case "fatal":
      return 0;
    case "serious":
      return 1;
    case "other":
      return 2;
  }
}

function accidentSeverity(accident: AccidentRecord): SeverityFilterKey {
  if (accident.category === 1) {
    return "fatal";
  }
  if (accident.category === 2) {
    return "serious";
  }
  return "other";
}

function accidentSeverityLabel(accident: AccidentRecord): string {
  if (accident.category === 1) {
    return "Fatal";
  }
  if (accident.category === 2) {
    return "Serious";
  }
  if (accident.category === 3) {
    return "Light";
  }
  return accident.category === null ? "Unknown" : `Category ${accident.category}`;
}

function accidentTimeLabel(accident: AccidentRecord): string {
  const parts = [accident.year ? String(accident.year) : "Unknown year"];
  if (accident.month) {
    parts.push(monthLabel(accident.month));
  }
  if (accident.weekday) {
    parts.push(weekdayLabel(accident.weekday));
  }
  if (accident.hour !== null) {
    parts.push(`${String(accident.hour).padStart(2, "0")}:00`);
  }
  return parts.join(", ");
}

function monthLabel(month: number): string {
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return labels[month - 1] ?? `Month ${month}`;
}

function weekdayLabel(weekday: number): string {
  const labels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return labels[weekday - 1] ?? `Weekday ${weekday}`;
}

function codeLabel(value: number | null | undefined, labels: Record<number, string>): string | null {
  if (typeof value !== "number") {
    return null;
  }
  return `${value} - ${labels[value] ?? "Unknown code"}`;
}

function roadUsersLabel(accident: AccidentRecord): string {
  const flags: Array<[string, boolean | null]> = [
    ["Pedestrian", accident.involvesPedestrian],
    ["Bicycle", accident.involvesBike],
    ["Motorcycle", accident.involvesMotorcycle],
    ["Passenger car", accident.involvesCar],
    ["Goods road vehicle", accident.involvesTruck],
    ["Other means of transport", accident.involvesOther]
  ];
  const knownFlags = flags.filter((entry): entry is [string, boolean] => entry[1] !== null);
  if (knownFlags.length === 0) {
    return "No road-user fields";
  }
  return knownFlags.map(([label, value]) => `${label}: ${value ? "yes" : "no"}`).join("; ");
}

function administrativeAreaLabel(accident: AccidentRecord): string {
  const parts = [`${accident.stateName} (${accident.stateCode})`];
  if (accident.administrativeRegionCode) {
    parts.push(`administrative region ${accident.administrativeRegionCode}`);
  }
  if (accident.districtCode) {
    parts.push(`district ${accident.districtCode}`);
  }
  if (accident.municipalityCode) {
    parts.push(`municipality ${accident.municipalityCode}`);
  }
  return parts.join(", ");
}

function linRefLabel(accident: AccidentRecord): string | null {
  if (typeof accident.linRefX !== "number" || typeof accident.linRefY !== "number") {
    return null;
  }
  return `${formatNumber(accident.linRefX)}, ${formatNumber(accident.linRefY)} (EPSG:25832)`;
}

function recordIdLabel(accident: AccidentRecord): string {
  const parts = [accident.id];
  if (accident.serialNumber && accident.serialNumber !== accident.id) {
    parts.push(`serial ${accident.serialNumber}`);
  }
  return parts.join(", ");
}

function accidentKey(accident: AccidentRecord): string {
  return `${accident.source}\0${accident.id}`;
}

function renderTrendPanel(cluster: IntersectionCluster): string {
  const years = result?.years.length ? result.years : cluster.years;
  const series = clusterTrendSeries(cluster, years);
  const trend = cluster.accidentTrend;
  const trendLabel = trendDirectionLabel(trend.direction);
  const relativeSlope = trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}/yr`;
  const latestAccidents = [...series].reverse().find((point) => point.accidentCount > 0)?.accidentCount ?? 0;

  return `
    <section class="trend-panel" aria-label="Selected intersection trend">
      <div class="trend-summary">
        <span>Accident trend</span>
        <strong class="trend-value ${trendClassName(trend.direction)}">${trendLabel}${relativeSlope}</strong>
        <small>${latestAccidents.toLocaleString()} latest</small>
      </div>
      ${renderTrendChart(series, trend.direction)}
      <div class="trend-legend">
        <span class="legend-accidents">Accidents</span>
      </div>
      <p class="trend-note">Selected years with no accidents count as zero.</p>
    </section>
  `;
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

function renderTrendChart(series: ClusterYearStat[], direction: AccidentTrendDirection): string {
  if (series.length === 0) {
    return "";
  }

  const chart = { left: 24, top: 12, width: 232, height: 80, bottom: 92 };
  const maxAccidents = Math.max(1, ...series.map((point) => point.accidentCount));

  const plotted = series.map((point, index): TrendSeriesPoint => {
    const x = series.length === 1 ? chart.left + chart.width / 2 : chart.left + (index / (series.length - 1)) * chart.width;
    const accidentY = chart.bottom - (point.accidentCount / maxAccidents) * chart.height;
    return { ...point, x, accidentY };
  });
  const accidentPath = linePath(plotted.map((point) => ({ x: point.x, y: point.accidentY })));
  const yearLabels = plotted
    .map((point) => `<text class="chart-year" x="${round(point.x, 1)}" y="126">${point.year}</text>`)
    .join("");
  const accidentDots = plotted
    .map(
      (point) =>
        `<circle class="chart-dot chart-dot-accident" cx="${round(point.x, 1)}" cy="${round(point.accidentY, 1)}" r="2.6"><title>${point.year}: ${point.accidentCount} accidents</title></circle>`
    )
    .join("");

  return `
    <svg class="trend-chart" viewBox="0 0 280 136" role="img" aria-label="Accident trend, ${trendDirectionLabel(direction).toLowerCase()}">
      <line class="chart-grid" x1="24" y1="12" x2="256" y2="12"></line>
      <line class="chart-grid" x1="24" y1="52" x2="256" y2="52"></line>
      <line class="chart-axis" x1="24" y1="92" x2="256" y2="92"></line>
      ${accidentPath ? `<path class="chart-line chart-line-accidents" d="${accidentPath}"></path>` : ""}
      ${accidentDots}
      ${yearLabels}
    </svg>
  `;
}

function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) {
    return "";
  }
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x, 1)} ${round(point.y, 1)}`).join(" ");
}

function trendDirectionLabel(direction: AccidentTrendDirection): string {
  switch (direction) {
    case "falling":
      return "Falling";
    case "rising":
      return "Rising";
    case "stable":
      return "Stable";
    case "unknown":
      return "No trend";
  }
}

function trendClassName(direction: AccidentTrendDirection): string {
  return `trend-${direction}`;
}

function setView(view: ViewKey): void {
  const entries = [
    { key: "map", tab: elements.mapTab, panel: elements.mapView },
    { key: "state", tab: elements.stateTab, panel: elements.stateView },
    { key: "table", tab: elements.tableTab, panel: elements.tableView },
    { key: "settings", tab: elements.settingsTab, panel: elements.settingsView }
  ] as const;

  for (const entry of entries) {
    const active = entry.key === view;
    entry.tab.classList.toggle("active", active);
    entry.tab.setAttribute("aria-selected", String(active));
    entry.panel.classList.toggle("active", active);
  }
}

function updateRangeOutputs(): void {
  elements.clusterRadiusOut.value = elements.clusterRadius.value;
}

function clearData(): void {
  accidents = [];
  result = null;
  selectedCluster = null;
  userLocation = null;
  activeAnalysisOptions = null;
  crossingAccidentIndexCache = null;
  accidentKeyLookupCache = null;
  analysisSettingsDirty = false;
  populateFilters();
  renderAll();
  updateAnalyzeButton();
  setStatus("Data cleared. Use Reload data to load bundled files again.", 0);
}

function exportClusters(): void {
  if (!result || result.clusters.length === 0) {
    setStatus("No analyzed clusters to export.", 0);
    return;
  }

  const header = [
    "state",
    "lat",
    "lon",
    "accidents",
    "fatal",
    "serious",
    "fatal_percent"
  ];
  const rows = result.clusters.map((cluster) =>
    [
      cluster.stateName,
      cluster.lat,
      cluster.lon,
      cluster.accidentCount,
      cluster.fatalCount,
      cluster.seriousCount,
      fatalPercentValue(cluster)
    ]
      .map(csvCell)
      .join(",")
  );

  const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "dangerous-intersections.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function clusterLocation(cluster: IntersectionCluster): string {
  return escapeHtml(clusterLocationText(cluster));
}

function clusterLocationText(cluster: IntersectionCluster): string {
  return `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
}

function setBusy(isBusy: boolean): void {
  elements.analyzeBtn.disabled = isBusy;
  elements.loadBundledBtn.disabled = isBusy;
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
    elements.topCount,
    elements.stateFilter,
    ...fatalPercentInputs()
  ];
  elements.yearFilter.querySelectorAll<HTMLInputElement>("input").forEach((input) => controls.push(input));

  for (const control of controls) {
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
      control.disabled = isDisabled;
    }
  }
}

function updateAnalyzeButton(): void {
  elements.analyzeBtn.textContent = analysisSettingsDirty ? "Analyze changes" : "Analyze";
  elements.analyzeBtn.classList.toggle("dirty", analysisSettingsDirty);
}

function setStatus(message: string, progress: number): void {
  const normalizedProgress = Math.max(0, Math.min(100, progress));
  updateLoadingPanels(message, normalizedProgress);
}

function updateLoadingPanels(message: string, progress: number): void {
  const lowerMessage = message.toLowerCase();
  const isProblem =
    (lowerMessage.includes("could not") || lowerMessage.includes("failed") || lowerMessage.includes("error") || lowerMessage.includes("blocked")) &&
    !lowerMessage.includes("cache write skipped");
  const isIdle =
    lowerMessage.startsWith("data cleared") || lowerMessage.startsWith("load accident data") || lowerMessage.startsWith("no analyzed");
  const hasNoClusters = lowerMessage.startsWith("0 intersection clusters analyzed");
  const activeStep = loadingStepForProgress(progress);
  const title = loadingTitle(activeStep, progress, isProblem, isIdle, hasNoClusters);

  elements.mapLoadingStatus.textContent = message;
  elements.splashLoadingStatus.textContent = message;
  elements.mapLoadingBar.style.width = `${progress}%`;
  elements.splashLoadingBar.style.width = `${progress}%`;
  elements.mapLoadingTitle.textContent = title;
  elements.splashLoadingTitle.textContent = title;

  const activeIndex = LOADING_STEP_ORDER.indexOf(activeStep);
  for (const step of elements.loadingSteps) {
    const key = step.dataset.loadingStep as LoadingStepKey | undefined;
    const index = key ? LOADING_STEP_ORDER.indexOf(key) : -1;
    const isDone = index >= 0 && !isProblem && !isIdle && (index < activeIndex || progress >= 100);
    step.classList.toggle("done", isDone);
    step.classList.toggle("active", index === activeIndex && !isDone && !isIdle);
  }
}

function loadingStepForProgress(progress: number): LoadingStepKey {
  if (progress >= 75) {
    return "analyze";
  }
  if (progress >= 10) {
    return "parse";
  }
  return "cache";
}

function loadingTitle(step: LoadingStepKey, progress: number, isProblem: boolean, isIdle: boolean, hasNoClusters: boolean): string {
  if (isProblem) {
    return "Data load issue";
  }
  if (isIdle) {
    return "No results yet";
  }
  if (hasNoClusters) {
    return "No matching intersections";
  }
  if (progress >= 100) {
    return "Analysis ready";
  }
  switch (step) {
    case "cache":
      return "Checking data cache";
    case "parse":
      return "Parsing accident records";
    case "analyze":
      return "Analyzing intersections";
  }
}

function bundledDataVersion(): string {
  const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
  if (bundle?.version) {
    return bundle.version;
  }
  if (bundle?.files.length) {
    return `legacy:${bundle.files.map((file) => `${file.path}:${file.size}:${file.compressedSize}`).join("|")}`;
  }
  return `fetch:${BUNDLED_CSV_FILES.join("|")}`;
}

async function readBundledBlob(path: string): Promise<Blob> {
  const embedded = readEmbeddedBlob(path);
  if (embedded) {
    return embedded;
  }

  const candidates = Array.from(new Set([path, `docs/${path}`]));
  const errors: string[] = [];

  for (const candidate of candidates) {
    const url = new URL(candidate, window.location.href).href;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return response.blob();
      }
      errors.push(`${candidate}: HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${candidate}: ${errorMessage(error)}`);
    }

    try {
      return await readBlobWithXhr(url);
    } catch (error) {
      errors.push(`${candidate}: ${errorMessage(error)}`);
    }
  }

  throw new Error(
    `Could not load ${path}. The docs/data files must sit next to docs/index.html. Some browsers block automatic file:// reads; GitHub Pages or any static host will work. ${errors.join(" ")}`
  );
}

function readEmbeddedBlob(path: string): Blob | null {
  const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
  if (!bundle) {
    return null;
  }

  const normalizedPath = normalizeBundledPath(path);
  const file = bundle.files.find((entry) => normalizeBundledPath(entry.path) === normalizedPath);
  if (!file) {
    return null;
  }

  const compressed = decodeBase64Chunks(file.chunks);
  const bytes = file.encoding === "gzip-base64" ? gunzipSync(compressed) : compressed;
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Blob([arrayBuffer], { type: file.type });
}

function decodeBase64Chunks(chunks: string[]): Uint8Array {
  const decodedChunks = chunks.map((chunk) => {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  });
  const length = decodedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of decodedChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function normalizeBundledPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^docs\//, "");
}

function readBlobWithXhr(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url);
    request.responseType = "blob";
    request.onload = () => {
      if ((request.status >= 200 && request.status < 300) || request.status === 0) {
        resolve(request.response);
      } else {
        reject(new Error(`HTTP ${request.status}`));
      }
    };
    request.onerror = () => reject(new Error("local read blocked"));
    request.send();
  });
}

function progressValue(loaded = 0, total = 1): number {
  return Math.round((loaded / Math.max(total, 1)) * 100);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

function formatFatalPercent(source: FatalPercentSource): string {
  return `${fatalPercentValue(source)}%`;
}

function fatalPercentValue(source: FatalPercentSource): number {
  return Math.round(source.fatalPercent * 100);
}

function formatDistance(valueMeters: number): string {
  if (valueMeters >= 10_000) {
    return `${formatNumber(valueMeters / 1000)} km`;
  }
  if (valueMeters >= 1000) {
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(valueMeters / 1000)} km`;
  }
  return `${Math.round(valueMeters)} m`;
}

function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const hav =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function inputMin(input: HTMLInputElement): number {
  return input.min === "" ? Number.NEGATIVE_INFINITY : Number(input.min);
}

function inputMax(input: HTMLInputElement): number {
  return input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
