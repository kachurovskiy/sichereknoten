import "./styles.css";
import { gunzipSync } from "fflate";
import { analyzeDangerousIntersections } from "./analysis";
import { readAnalysisCache, readParsedDataCache, writeAnalysisCache, writeParsedDataCache } from "./cache";
import { MapCanvas } from "./mapCanvas";
import { parseAccidentCsvFiles } from "./parsers/csv";
import { parseTrafficWorkbook } from "./parsers/traffic";
import { STATE_NAMES } from "./states";
import {
  AccidentRecord,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  IntersectionCluster,
  RateTrendDirection,
  ScoreMode,
  TrafficPoint
} from "./types";

const BUNDLED_CSV_FILES = [
  "data/csv/Unfallorte_2021_LinRef.csv",
  "data/csv/Unfallorte2022_LinRef.csv",
  "data/csv/Unfallorte2023_LinRef.csv",
  "data/csv/Unfallorte2024_LinRef.csv",
  "data/csv/Unfallorte_2025_LR_BasisDLM.csv"
];
const BUNDLED_TRAFFIC_FILE = "data/Bundesstrassen-2021.xlsx";

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

type ClusterSortKey = "rank" | "state" | "location" | "accidents" | "fatal" | "serious" | "severity" | "dtv" | "risk" | "trafficDistance";
type SortDirection = "asc" | "desc";
type LoadingStepKey = "cache" | "parse" | "traffic" | "rank";
const LOADING_STEP_ORDER: LoadingStepKey[] = ["cache", "parse", "traffic", "rank"];
const APP_CACHE_VERSION = typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev";

interface ClusterTableSort {
  key: ClusterSortKey;
  direction: SortDirection;
}

interface TrendSeriesPoint extends ClusterYearStat {
  x: number;
  accidentY: number;
  trafficY: number | null;
}

interface AnalysisCacheContext {
  dataVersion: string;
  appVersion: string;
}

let accidents: AccidentRecord[] = [];
let traffic: TrafficPoint[] = [];
let result: AnalysisResult | null = null;
let selectedCluster: IntersectionCluster | null = null;
let clusterTableSort: ClusterTableSort = { key: "rank", direction: "asc" };
let analysisSettingsDirty = false;
let activeDataVersion: string | null = null;

const elements = {
  loadBundledBtn: byId<HTMLButtonElement>("loadBundledBtn"),
  clearBtn: byId<HTMLButtonElement>("clearBtn"),
  analyzeBtn: byId<HTMLButtonElement>("analyzeBtn"),
  clusterRadius: byId<HTMLInputElement>("clusterRadius"),
  clusterRadiusOut: byId<HTMLInputElement>("clusterRadiusOut"),
  matchRadius: byId<HTMLInputElement>("matchRadius"),
  matchRadiusOut: byId<HTMLInputElement>("matchRadiusOut"),
  minAccidents: byId<HTMLInputElement>("minAccidents"),
  topCount: byId<HTMLInputElement>("topCount"),
  scoreMode: byId<HTMLSelectElement>("scoreMode"),
  stateFilter: byId<HTMLSelectElement>("stateFilter"),
  yearFilter: byId<HTMLDivElement>("yearFilter"),
  progressBar: byId<HTMLDivElement>("progressBar"),
  statusText: byId<HTMLParagraphElement>("statusText"),
  metricAccidents: byId<HTMLElement>("metricAccidents"),
  metricClusters: byId<HTMLElement>("metricClusters"),
  metricMatched: byId<HTMLElement>("metricMatched"),
  metricTopScore: byId<HTMLElement>("metricTopScore"),
  mapCanvas: byId<HTMLCanvasElement>("mapCanvas"),
  mapEmpty: byId<HTMLDivElement>("mapEmpty"),
  mapLoadingTitle: byId<HTMLHeadingElement>("mapLoadingTitle"),
  mapLoadingStatus: byId<HTMLParagraphElement>("mapLoadingStatus"),
  mapLoadingBar: byId<HTMLDivElement>("mapLoadingBar"),
  mapLoadingSteps: Array.from(document.querySelectorAll<HTMLElement>("[data-loading-step]")),
  selectionDetails: byId<HTMLDivElement>("selectionDetails"),
  stateTableBody: byId<HTMLTableSectionElement>("stateTableBody"),
  clusterTableBody: byId<HTMLTableSectionElement>("clusterTableBody"),
  mapTab: byId<HTMLButtonElement>("mapTab"),
  stateTab: byId<HTMLButtonElement>("stateTab"),
  tableTab: byId<HTMLButtonElement>("tableTab"),
  mapView: byId<HTMLElement>("mapView"),
  stateView: byId<HTMLElement>("stateView"),
  tableView: byId<HTMLElement>("tableView"),
  showTraffic: byId<HTMLInputElement>("showTraffic"),
  zoomInBtn: byId<HTMLButtonElement>("zoomInBtn"),
  zoomOutBtn: byId<HTMLButtonElement>("zoomOutBtn"),
  resetMapBtn: byId<HTMLButtonElement>("resetMapBtn"),
  exportBtn: byId<HTMLButtonElement>("exportBtn")
};

const map = new MapCanvas(elements.mapCanvas, (cluster) => {
  selectedCluster = cluster;
  renderSelection(cluster);
});

wireEvents();
renderAll();
void loadBundledData();

function wireEvents(): void {
  elements.loadBundledBtn.addEventListener("click", () => void loadBundledData());
  elements.clearBtn.addEventListener("click", clearData);
  elements.analyzeBtn.addEventListener("click", () => runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);

  wireLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut, markAnalysisSettingsDirty);
  wireLinkedNumberRange(elements.matchRadius, elements.matchRadiusOut, markAnalysisSettingsDirty);

  [elements.minAccidents, elements.scoreMode, elements.stateFilter].forEach((input) => {
    input.addEventListener("input", markAnalysisSettingsDirty);
    input.addEventListener("change", markAnalysisSettingsDirty);
  });

  elements.topCount.addEventListener("input", () => {
    if (result) {
      renderTables();
    }
  });

  elements.showTraffic.addEventListener("change", () => map.setShowTraffic(elements.showTraffic.checked));
  elements.zoomInBtn.addEventListener("click", () => map.zoom(1.6));
  elements.zoomOutBtn.addEventListener("click", () => map.zoom(0.625));
  elements.resetMapBtn.addEventListener("click", () => map.reset());

  elements.mapTab.addEventListener("click", () => setView("map"));
  elements.stateTab.addEventListener("click", () => setView("state"));
  elements.tableTab.addEventListener("click", () => setView("table"));

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

function normalizeLinkedNumberRange(range: HTMLInputElement, numberInput: HTMLInputElement): void {
  const fallback = Number(range.value);
  const value = Number.isFinite(Number(numberInput.value)) ? Number(numberInput.value) : fallback;
  const normalized = clampNumber(value, inputMin(numberInput), inputMax(numberInput));
  numberInput.value = String(normalized);
  range.value = String(normalized);
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
    traffic = [];
    result = null;
    selectedCluster = null;
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
      traffic = cached.traffic;
      populateFilters();
      setStatus(`${accidents.length.toLocaleString()} accidents and ${traffic.length.toLocaleString()} traffic points loaded from cache.`, 66);
      analysisStarted = true;
      runAnalysis();
      return;
    }

    setStatus("Cache miss. Parsing bundled CSV files and workbook.", 10);
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
      populateFilters();
    }
    setStatus(`${accidents.length.toLocaleString()} accident records loaded.`, 60);

    const trafficBlob = await readBundledBlob(BUNDLED_TRAFFIC_FILE);
    const trafficFile = new File([trafficBlob], "Bundesstrassen-2021.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    traffic = await parseTrafficWorkbook(trafficFile, (progress) => setStatus(progress.message ?? `Parsing ${progress.label}`, 58));
    setStatus(`${traffic.length.toLocaleString()} traffic count points loaded.`, 61);
    try {
      await writeParsedDataCache(dataVersion, accidents, traffic, setStatus);
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

async function loadTraffic(file: File, manageBusy = true): Promise<void> {
  if (manageBusy) {
    setBusy(true);
  }
  try {
    traffic = await parseTrafficWorkbook(file, (progress) => setStatus(progress.message ?? `Parsing ${progress.label}`, 55));
    setStatus(`${traffic.length.toLocaleString()} traffic count points loaded.`, 100);
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
  normalizeLinkedNumberRange(elements.matchRadius, elements.matchRadiusOut);
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
        selectedCluster = result.clusters[0] ?? null;
        analysisSettingsDirty = false;
        renderAll();
        setStatus(`${result.clusters.length.toLocaleString()} intersection clusters loaded from cache.`, 100);
        return;
      }
    }

    setStatus("Analyzing intersections.", 75);
    await yieldToBrowser();
    result = analyzeDangerousIntersections(accidents, traffic, options);
    selectedCluster = result.clusters[0] ?? null;
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

    setStatus(`${result.clusters.length.toLocaleString()} intersection clusters ranked.`, 100);
  } catch (error) {
    setStatus(errorMessage(error), 0);
  } finally {
    setBusy(false);
  }
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
    matchRadiusMeters: Number(elements.matchRadiusOut.value),
    minAccidents: Math.max(1, Number(elements.minAccidents.value) || 1),
    years,
    stateCode: elements.stateFilter.value as AnalysisOptions["stateCode"],
    scoreMode: elements.scoreMode.value as ScoreMode
  };
}

function populateFilters(): void {
  const selectedState = elements.stateFilter.value;
  elements.stateFilter.innerHTML = `<option value="all">All Bundeslaender</option>`;
  for (const [code, name] of Object.entries(STATE_NAMES)) {
    if (accidents.some((accident) => accident.stateCode === code)) {
      elements.stateFilter.append(new Option(name, code));
    }
  }
  elements.stateFilter.value = [...elements.stateFilter.options].some((option) => option.value === selectedState) ? selectedState : "all";

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
  renderMetrics();
  renderTables();
  map.setShowTraffic(elements.showTraffic.checked);
  if (result) {
    map.setData(result.clusters, traffic);
    elements.mapEmpty.hidden = result.clusters.length > 0;
  } else {
    elements.mapEmpty.hidden = false;
    renderSelection(null);
  }
}

function renderMetrics(): void {
  const clusters = result?.clusters ?? [];
  const matched = clusters.filter((cluster) => cluster.trafficMatch).length;
  elements.metricAccidents.textContent = (result?.filteredAccidentCount ?? accidents.length).toLocaleString();
  elements.metricClusters.textContent = clusters.length.toLocaleString();
  elements.metricMatched.textContent = clusters.length ? `${Math.round((matched / clusters.length) * 100)}%` : "0%";
  elements.metricTopScore.textContent = clusters[0] ? formatNumber(clusters[0].dangerScore) : "0";
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
      <td>${formatNumber(summary.severityPoints)}</td>
      <td>${summary.clusterCount ? Math.round((summary.matchedClusterCount / summary.clusterCount) * 100) : 0}%</td>
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

  const topCount = Math.max(3, Number(elements.topCount.value) || 10);
  const clusters = clustersForTable(result.clusters, topCount);
  for (const cluster of clusters) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.innerHTML = `
      <td>${cluster.rank}</td>
      <td>${escapeHtml(cluster.stateName)}</td>
      <td>${clusterLocation(cluster)}</td>
      <td>${cluster.accidentCount.toLocaleString()}</td>
      <td>${cluster.fatalCount.toLocaleString()}</td>
      <td>${cluster.seriousCount.toLocaleString()}</td>
      <td>${formatNumber(cluster.severityPoints)}</td>
      <td>${cluster.trafficMatch?.point.dtv ? formatNumber(cluster.trafficMatch.point.dtv) : "No match"}</td>
      <td>${formatNumber(cluster.dangerScore)}</td>
      <td>${cluster.trafficMatch ? `${Math.round(cluster.trafficMatch.distanceMeters)} m` : ""}</td>
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
    return primary || a.rank - b.rank;
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
    case "rank":
      return cluster.rank;
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
    case "severity":
      return cluster.severityPoints;
    case "dtv":
      return cluster.trafficMatch?.point.dtv ?? null;
    case "risk":
      return cluster.dangerScore;
    case "trafficDistance":
      return cluster.trafficMatch?.distanceMeters ?? null;
  }
}

function defaultClusterSortDirection(key: ClusterSortKey): SortDirection {
  return key === "rank" || key === "state" || key === "location" || key === "trafficDistance" ? "asc" : "desc";
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

function renderSelection(cluster: IntersectionCluster | null): void {
  if (!cluster) {
    elements.selectionDetails.textContent = "No intersection selected.";
    return;
  }

  const trafficDetails = cluster.trafficMatch
    ? `${cluster.trafficMatch.point.road} ${cluster.trafficMatch.point.stationNo}, ${Math.round(
        cluster.trafficMatch.distanceMeters
      )} m, DTV ${cluster.trafficMatch.point.dtv ? formatNumber(cluster.trafficMatch.point.dtv) : "unknown"}`
    : "No traffic match";
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  const openStreetMapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const trendPanel = renderTrendPanel(cluster);

  elements.selectionDetails.innerHTML = `
    <dl>
      <div><dt>Rank</dt><dd>${cluster.rank}</dd></div>
      <div><dt>Bundesland</dt><dd>${escapeHtml(cluster.stateName)}</dd></div>
      <div><dt>Coordinates</dt><dd>${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}</dd></div>
      <div><dt>Years</dt><dd>${cluster.years.join(", ")}</dd></div>
      <div><dt>Accidents</dt><dd>${cluster.accidentCount.toLocaleString()}</dd></div>
      <div><dt>Fatal / serious</dt><dd>${cluster.fatalCount} / ${cluster.seriousCount}</dd></div>
      <div><dt>Vulnerable users</dt><dd>${cluster.vulnerableCount.toLocaleString()}</dd></div>
      <div><dt>Severity</dt><dd>${formatNumber(cluster.severityPoints)}</dd></div>
      <div><dt>Risk score</dt><dd>${formatNumber(cluster.dangerScore)}</dd></div>
      <div><dt>Traffic</dt><dd>${escapeHtml(trafficDetails)}</dd></div>
    </dl>
    ${trendPanel}
    <div class="external-map-actions" aria-label="Open selected intersection in map services">
      <a class="map-service-link" href="${openStreetMapUrl}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
      <a class="map-service-link" href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer">Google Maps</a>
    </div>
  `;
}

function renderTrendPanel(cluster: IntersectionCluster): string {
  const years = result?.years.length ? result.years : cluster.years;
  const series = clusterTrendSeries(cluster, years);
  const trend = cluster.accidentsPerVehicleTrend;
  const trendLabel = trendDirectionLabel(trend.direction);
  const relativeSlope = trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}/yr`;
  const latestRate = [...series].reverse().find((point) => point.accidentsPerMillionVehicles !== null)?.accidentsPerMillionVehicles ?? null;
  const rateText = latestRate === null ? "No traffic rate" : `${formatRate(latestRate)} latest`;
  const footnote = series.some((point) => point.trafficDtv !== null) ? "Traffic DTV uses the matched 2021 count." : "No matched traffic count.";

  return `
    <section class="trend-panel" aria-label="Selected intersection trend">
      <div class="trend-summary">
        <span>Accidents / 1M vehicles</span>
        <strong class="trend-value ${trendClassName(trend.direction)}">${trendLabel}${relativeSlope}</strong>
        <small>${escapeHtml(rateText)}</small>
      </div>
      ${renderTrendChart(series, trend.direction)}
      <div class="trend-legend">
        <span class="legend-accidents">Accidents</span>
        ${series.some((point) => point.trafficDtv !== null) ? `<span class="legend-traffic">Traffic DTV</span>` : ""}
      </div>
      <p class="trend-note">${escapeHtml(footnote)}</p>
    </section>
  `;
}

function clusterTrendSeries(cluster: IntersectionCluster, years: number[]): ClusterYearStat[] {
  const byYear = new Map(cluster.yearlyStats.map((stats) => [stats.year, stats]));
  const trafficDtv = cluster.trafficMatch?.point.dtv && cluster.trafficMatch.point.dtv > 0 ? cluster.trafficMatch.point.dtv : null;

  return years.map((year) => {
    const existing = byYear.get(year);
    if (existing) {
      return existing;
    }
    const estimatedVehicles = trafficDtv ? Math.round(trafficDtv * daysInYear(year)) : null;
    return {
      year,
      accidentCount: 0,
      severityPoints: 0,
      trafficDtv,
      estimatedVehicles,
      accidentsPerMillionVehicles: estimatedVehicles ? 0 : null
    };
  });
}

function renderTrendChart(series: ClusterYearStat[], direction: RateTrendDirection): string {
  if (series.length === 0) {
    return "";
  }

  const chart = { left: 24, top: 12, width: 232, height: 80, bottom: 92 };
  const maxAccidents = Math.max(1, ...series.map((point) => point.accidentCount));
  const trafficValues = series.map((point) => point.trafficDtv).filter((value): value is number => value !== null && value > 0);
  const minTraffic = trafficValues.length ? Math.min(...trafficValues) : 0;
  const maxTraffic = trafficValues.length ? Math.max(...trafficValues) : 0;
  const trafficSpan = maxTraffic - minTraffic;

  const plotted = series.map((point, index): TrendSeriesPoint => {
    const x = series.length === 1 ? chart.left + chart.width / 2 : chart.left + (index / (series.length - 1)) * chart.width;
    const accidentY = chart.bottom - (point.accidentCount / maxAccidents) * chart.height;
    const trafficY =
      point.trafficDtv === null
        ? null
        : trafficSpan === 0
          ? chart.top + chart.height * 0.28
          : chart.bottom - ((point.trafficDtv - minTraffic) / trafficSpan) * chart.height;
    return { ...point, x, accidentY, trafficY };
  });
  const accidentPath = linePath(plotted.map((point) => ({ x: point.x, y: point.accidentY })));
  const trafficPoints = plotted
    .filter((point) => point.trafficY !== null)
    .map((point) => ({ x: point.x, y: point.trafficY ?? chart.top }));
  const trafficPath = linePath(trafficPoints);
  const yearLabels = plotted
    .map((point) => `<text class="chart-year" x="${round(point.x, 1)}" y="126">${point.year}</text>`)
    .join("");
  const accidentDots = plotted
    .map(
      (point) =>
        `<circle class="chart-dot chart-dot-accident" cx="${round(point.x, 1)}" cy="${round(point.accidentY, 1)}" r="2.6"><title>${point.year}: ${point.accidentCount} accidents</title></circle>`
    )
    .join("");
  const trafficDots = plotted
    .filter((point) => point.trafficY !== null)
    .map(
      (point) =>
        `<circle class="chart-dot chart-dot-traffic" cx="${round(point.x, 1)}" cy="${round(point.trafficY ?? chart.top, 1)}" r="2.3"><title>${point.year}: DTV ${formatNumber(point.trafficDtv ?? 0)}</title></circle>`
    )
    .join("");

  return `
    <svg class="trend-chart" viewBox="0 0 280 136" role="img" aria-label="Accident and traffic trend, ${trendDirectionLabel(direction).toLowerCase()}">
      <line class="chart-grid" x1="24" y1="12" x2="256" y2="12"></line>
      <line class="chart-grid" x1="24" y1="52" x2="256" y2="52"></line>
      <line class="chart-axis" x1="24" y1="92" x2="256" y2="92"></line>
      ${trafficPath ? `<path class="chart-line chart-line-traffic" d="${trafficPath}"></path>` : ""}
      ${accidentPath ? `<path class="chart-line chart-line-accidents" d="${accidentPath}"></path>` : ""}
      ${trafficDots}
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

function trendDirectionLabel(direction: RateTrendDirection): string {
  switch (direction) {
    case "falling":
      return "Falling";
    case "rising":
      return "Rising";
    case "stable":
      return "Stable";
    case "unknown":
      return "No rate";
  }
}

function trendClassName(direction: RateTrendDirection): string {
  return `trend-${direction}`;
}

function setView(view: "map" | "state" | "table"): void {
  const entries = [
    { key: "map", tab: elements.mapTab, panel: elements.mapView },
    { key: "state", tab: elements.stateTab, panel: elements.stateView },
    { key: "table", tab: elements.tableTab, panel: elements.tableView }
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
  elements.matchRadiusOut.value = elements.matchRadius.value;
}

function clearData(): void {
  accidents = [];
  traffic = [];
  result = null;
  selectedCluster = null;
  analysisSettingsDirty = false;
  populateFilters();
  renderAll();
  updateAnalyzeButton();
  setStatus("Data cleared. Use Reload data to load bundled files again.", 0);
}

function exportClusters(): void {
  if (!result || result.clusters.length === 0) {
    setStatus("No ranked clusters to export.", 0);
    return;
  }

  const header = [
    "rank",
    "state",
    "lat",
    "lon",
    "accidents",
    "fatal",
    "serious",
    "severity_points",
    "danger_score",
    "dtv",
    "traffic_distance_m",
    "traffic_road",
    "traffic_station"
  ];
  const rows = result.clusters.map((cluster) =>
    [
      cluster.rank,
      cluster.stateName,
      cluster.lat,
      cluster.lon,
      cluster.accidentCount,
      cluster.fatalCount,
      cluster.seriousCount,
      cluster.severityPoints,
      cluster.dangerScore,
      cluster.trafficMatch?.point.dtv ?? "",
      cluster.trafficMatch ? Math.round(cluster.trafficMatch.distanceMeters) : "",
      cluster.trafficMatch?.point.road ?? "",
      cluster.trafficMatch?.point.stationNo ?? ""
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
  if (cluster.trafficMatch) {
    const point = cluster.trafficMatch.point;
    return `${point.road || "Road"} ${point.from ? `${point.from} to ${point.to}` : point.stationNo}`;
  }
  return `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
}

function setBusy(isBusy: boolean): void {
  elements.analyzeBtn.disabled = isBusy;
  elements.loadBundledBtn.disabled = isBusy;
  setAnalysisControlsDisabled(isBusy);
  updateAnalyzeButton();
}

function setAnalysisControlsDisabled(isDisabled: boolean): void {
  const controls: HTMLElement[] = [
    elements.clusterRadius,
    elements.clusterRadiusOut,
    elements.matchRadius,
    elements.matchRadiusOut,
    elements.minAccidents,
    elements.topCount,
    elements.scoreMode,
    elements.stateFilter
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
  elements.statusText.textContent = message;
  elements.progressBar.style.width = `${normalizedProgress}%`;
  updateMapLoadingPanel(message, normalizedProgress);
}

function updateMapLoadingPanel(message: string, progress: number): void {
  const lowerMessage = message.toLowerCase();
  const isProblem =
    (lowerMessage.includes("could not") || lowerMessage.includes("failed") || lowerMessage.includes("error") || lowerMessage.includes("blocked")) &&
    !lowerMessage.includes("cache write skipped");
  const isIdle = lowerMessage.startsWith("data cleared") || lowerMessage.startsWith("load accident data") || lowerMessage.startsWith("no ranked");
  const hasNoClusters = lowerMessage.startsWith("0 intersection clusters ranked");
  const activeStep = loadingStepForProgress(progress);

  elements.mapLoadingStatus.textContent = message;
  elements.mapLoadingBar.style.width = `${progress}%`;
  elements.mapLoadingTitle.textContent = loadingTitle(activeStep, progress, isProblem, isIdle, hasNoClusters);

  const activeIndex = LOADING_STEP_ORDER.indexOf(activeStep);
  for (const step of elements.mapLoadingSteps) {
    const key = step.dataset.loadingStep as LoadingStepKey | undefined;
    const index = key ? LOADING_STEP_ORDER.indexOf(key) : -1;
    const isDone = index >= 0 && !isProblem && !isIdle && (index < activeIndex || progress >= 100);
    step.classList.toggle("done", isDone);
    step.classList.toggle("active", index === activeIndex && !isDone && !isIdle);
  }
}

function loadingStepForProgress(progress: number): LoadingStepKey {
  if (progress >= 75) {
    return "rank";
  }
  if (progress >= 58) {
    return "traffic";
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
    case "traffic":
      return "Loading traffic data";
    case "rank":
      return "Ranking intersections";
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
  return `fetch:${BUNDLED_CSV_FILES.join("|")}:${BUNDLED_TRAFFIC_FILE}`;
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

function formatRate(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

function daysInYear(year: number): number {
  return new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
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
