import "./styles.css";
import { gunzipSync } from "fflate";
import { analyzeDangerousIntersectionsInBackground, type AnalysisExecutionPlan } from "./analysisRunner";
import { readAnalysisCache, resetAppStorage, writeAnalysisCache } from "./cache";
import { GeoGridIndex } from "./geo";
import { MapCanvas } from "./mapCanvas";
import { accidentMatchesRoadUserFocus, ROAD_USER_DEFINITIONS, RoadUserDefinition, roadUserFocusKey } from "./roadUsers";
import { STATE_NAMES } from "./states";
import {
  AccidentRecord,
  AccidentTrendDirection,
  AnalysisOptions,
  AnalysisResult,
  ClusterYearStat,
  SeverityPercentOptions,
  IntersectionCluster,
  RoadUserKey
} from "./types";

const TABLE_ROWS_PER_STATE = 10;
const STATE_BROWSE_MIN_SEVERITY_PERCENT = 0.1;
const STATE_BROWSE_MAX_INTERSECTIONS = 100;

interface EmbeddedDataFile {
  path: string;
  name: string;
  type: string;
  size: number;
  modifiedTime?: string;
}

interface EmbeddedAccidentChunk {
  id: string;
  encoding: "gzip-base64-json-compact-v1";
  recordCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface EmbeddedAccidentShardFile {
  stateCode: string;
  fileName: string;
  recordCount: number;
}

interface EmbeddedAccidentShard {
  id: string;
  stateCode: string;
  encoding: "gzip-base64-json-compact-v1" | "gzip-base64-json-compact-v2";
  recordCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface SerializedAnalysisOptions {
  clusterRadiusMeters: number;
  minAccidents: number;
  years: number[];
  roadUserFocus: RoadUserKey[];
  stateCode: string | "all";
  severityPercent: SeverityPercentOptions;
}

interface EmbeddedDefaultAnalysisMetadata {
  dataVersion: string;
  analysisCacheVersion: string;
  options: SerializedAnalysisOptions;
}

interface EmbeddedDefaultAnalysis {
  id: string;
  encoding: "gzip-base64-json-v1";
  metadata: EmbeddedDefaultAnalysisMetadata;
  clusterCount: number;
  filteredAccidentCount: number;
  size: number;
  compressedSize: number;
  chunks: string[];
}

interface EmbeddedDataBundle {
  version?: string;
  files: EmbeddedDataFile[];
  accidentShardFiles?: EmbeddedAccidentShardFile[];
  accidentShards?: EmbeddedAccidentShard[];
  accidentChunkFiles?: string[];
  accidentChunks?: EmbeddedAccidentChunk[];
  defaultAnalysisFile?: string;
  defaultAnalysisMetadata?: EmbeddedDefaultAnalysisMetadata;
  defaultAnalysis?: EmbeddedDefaultAnalysis | null;
}

type CompactAccidentRecord = [
  string,
  string | null,
  string,
  string[],
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  number,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  number | null | undefined
];

declare global {
  var __SICHERE_KNOTEN_DATA__: EmbeddedDataBundle | undefined;
}

declare const __SICHERE_KNOTEN_APP_VERSION__: string | undefined;
declare const __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__: string | undefined;

type ClusterSortKey = "state" | "location" | "accidents" | "fatal" | "serious" | "severityPercent";
type SortDirection = "asc" | "desc";
type LoadingStepKey = "cache" | "parse" | "analyze";
type SeverityFilterKey = "fatal" | "serious" | "other";
type ViewKey = "explore" | "map" | "details" | "state" | "table" | "settings";
type SelectionReason = "auto" | "program" | "user";
type HotspotMetricPlacement = "header" | "stats";
type AppLocale = "en" | "de";
type LoadingStatusKind = "normal" | "problem" | "idle";
type InitializationTelemetryStatus = "running" | "done" | "error";
type InitializationTelemetryMetadata = Record<string, string | number | boolean | null>;

interface InitializationTelemetry {
  startedAt: string;
  startMark: number;
  appVersion: string;
  dataVersion: string | null;
  steps: InitializationTelemetryStep[];
  logged: boolean;
}

interface InitializationTelemetryStep {
  name: string;
  detail: string | null;
  startTime: string;
  startMark: number;
  startOffsetMs: number;
  durationMs: number | null;
  status: InitializationTelemetryStatus;
  metadata: InitializationTelemetryMetadata;
}

interface InteractionTelemetry {
  label: string;
  source: string;
  startedAt: string;
  startMark: number;
  clusterId: string | null;
  clusterLabel: string | null;
  steps: InteractionTelemetryStep[];
  logged: boolean;
}

interface InteractionTelemetryStep {
  name: string;
  detail: string | null;
  startTime: string;
  startMark: number;
  startOffsetMs: number;
  durationMs: number | null;
  metadata: InitializationTelemetryMetadata;
}

interface SiteVersionManifest {
  appVersion?: string;
  analysisCacheVersion?: string;
}

interface RoadUserSummaryItem {
  definition: RoadUserDefinition;
  label: string;
  count: number;
  share: number;
}

interface FactsheetLayout {
  pages: HTMLCanvasElement[];
  context: CanvasRenderingContext2D;
  y: number;
  links: FactsheetPdfLink[];
  textSpans: FactsheetPdfTextSpan[];
}

interface FactsheetPdfPage {
  jpegBytes: Uint8Array;
  width: number;
  height: number;
  links: FactsheetPdfLink[];
  textSpans: FactsheetPdfTextSpan[];
}

interface FactsheetPdfLink {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

interface FactsheetPdfTextSpan {
  pageIndex: number;
  x: number;
  y: number;
  fontSize: number;
  text: string;
}

const LOADING_STEP_ORDER: LoadingStepKey[] = ["cache", "parse", "analyze"];
const MOBILE_LAYOUT_QUERY = "(max-width: 640px)";
const FACTSHEET_PAGE_WIDTH = 1240;
const FACTSHEET_PAGE_HEIGHT = 1754;
const FACTSHEET_MARGIN = 64;
const FACTSHEET_BOTTOM_MARGIN = 96;
const FACTSHEET_CONTENT_WIDTH = FACTSHEET_PAGE_WIDTH - FACTSHEET_MARGIN * 2;
const FACTSHEET_INCIDENT_LINK_TOP_GAP = 18;
const FACTSHEET_TITLE_STREET_LIMIT = 3;
const STREET_NAME_SEPARATOR = " × ";
const OSM_TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const PROJECT_REPOSITORY_URL = "https://github.com/kachurovskiy/sichereknoten";
const PROJECT_REPOSITORY_LABEL = "kachurovskiy/sichereknoten";
const APP_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev-cluster-streets";
const ANALYSIS_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ === "string" ? __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__ : APP_CACHE_VERSION;
const offlineBundleScriptPromises = new Map<string, Promise<string>>();
const STREET_VIEW_OPEN_STORAGE_KEY = "sichere-knoten:street-view-open";
const TRANSLATIONS: Record<AppLocale, Record<string, string>> = {
  en: {
    "document.title": "Safe Intersections",
    "loading.preparing": "Preparing data",
    "loading.checkingBundled": "Checking bundled accident data.",
    "loading.bundle": "Automatic offline bundle",
    "loading.step.cache": "Cache",
    "loading.step.parse": "Parse",
    "loading.step.analyze": "Analyze",
    "loading.title.problem": "Data load issue",
    "loading.title.idle": "No results yet",
    "loading.title.noMatches": "No matching intersections",
    "loading.title.ready": "Analysis ready",
    "loading.title.cache": "Checking data cache",
    "loading.title.parse": "Parsing accident records",
    "loading.title.analyze": "Analyzing intersections",
    "aria.sidebar": "Application sidebar",
    "aria.toolbar": "Workspace toolbar",
    "aria.views": "Views",
    "aria.mapControls": "Map display controls",
    "aria.map": "High-severity intersections map",
    "aria.selectedDetails": "Selected intersection details",
    "aria.openMapServices": "Open selected intersection in map services",
    "aria.loadingSteps": "Loading steps",
    "brand.name": "Safe Intersections",
    "brand.description": "Explore German accident data to identify elevated-risk intersections by severity, location, and year.",
    "browse.title": "Browse by state",
    "field.state": "State",
    "field.accidentOutcome": "Accident outcome",
    "option.allStates": "All states",
    "tab.browse": "Browse",
    "tab.map": "Map",
    "tab.details": "Details",
    "tab.streetView": "Street View",
    "tab.moreViews": "More views",
    "tab.state": "State",
    "tab.intersections": "Intersections",
    "tab.settings": "Settings",
    "severity.fatal": "Fatal",
    "severity.serious": "Serious",
    "severity.light": "Light",
    "severity.other": "Other",
    "severity.unknown": "Unknown",
    "action.findNearby": "Find nearby intersections",
    "action.centerLocation": "Center map on your location",
    "action.show": "Show",
    "action.hide": "Hide",
    "action.resetApp": "Reset app",
    "action.exportCsv": "Export CSV",
    "action.downloadFactsheet": "Download factsheet",
    "action.labelFactsheet": "PDF",
    "action.analyze": "Analyze",
    "action.analyzeChanges": "Analyze changes",
    "streetView.title": "Google Street View",
    "streetView.empty": "Select an intersection to show Street View.",
    "streetView.near": "Google Street View near {lat}, {lon}",
    "details.title": "Selected intersection",
    "details.none": "No intersection selected.",
    "details.selectFirst": "Select an intersection first.",
    "details.state": "State",
    "details.adminRegion": "Administrative region",
    "details.district": "District",
    "details.municipality": "Municipality",
    "details.street": "Street",
    "details.streets": "Streets",
    "details.coordinates": "Coordinates",
    "details.years": "Years",
    "details.accidents": "Accidents",
    "details.fatalSerious": "Fatal / serious",
    "details.severityPercent": "Severity %",
    "metric.severityPercent": "Severity %",
    "metric.severity": "Severity",
    "metric.severityPercentContextGermany":
      "{value} ({state}: #{stateRank}, top {statePercent}%; Germany: #{germanyRank}, top {germanyPercent}%)",
    "metric.severityPercentContextState": "{value} ({state}: #{stateRank}, top {statePercent}%)",
    "unit.perYear": "/yr",
    "table.state": "State",
    "table.accidents": "Accidents",
    "table.clusters": "Clusters",
    "table.topCluster": "Top cluster",
    "table.location": "Location",
    "table.sorted": "{label} sorted {direction}",
    "table.sort.asc": "ascending",
    "table.sort.desc": "descending",
    "table.sort.none": "none",
    "settings.data": "Data",
    "settings.dataNote": "Bundled normalized accident data loads automatically from the offline data bundle.",
    "settings.accidentData": "Accident data:",
    "settings.municipalityData": "Municipality data:",
    "settings.destatisMunicipalities": "/ Destatis municipality directory extract, 2nd quarter 2026.",
    "settings.statsOffices": "/ Federal and state statistical offices.",
    "settings.reusedUnder": "Reused under",
    "settings.licenseNote": "/ dl-de/by-2-0. Source data is processed, clustered, and analyzed by this app.",
    "settings.repository": "Project repository:",
    "settings.impressum": "Legal notice",
    "settings.metricTitle": "Severity % metric",
    "settings.fatalWeight": "Fatal accident weight",
    "settings.seriousWeight": "Serious accident weight",
    "settings.fullSample": "Full sample accidents",
    "settings.trendYears": "Trend period (years)",
    "settings.trendDeadZone": "Trend dead zone (%/yr)",
    "settings.trendFullSignal": "Full trend signal (%/yr)",
    "settings.maxTrendAdjustment": "Max trend adjustment (%)",
    "settings.metricCap": "Metric cap (%)",
    "settings.analysis": "Analysis",
    "settings.clusterRadius": "Cluster radius (m)",
    "settings.clusterRadiusMeters": "Cluster radius in meters",
    "settings.minAccidents": "Minimum accidents",
    "settings.roadUserFocus": "Road-user focus",
    "settings.roadUserFocusNote": "Select one or more to include only accidents involving at least one selected road user. Leave all unchecked to include all accidents.",
    "settings.yearFilters": "Year filters",
    "settings.aboutSeverity": "About Severity %",
    "settings.whatMeasures": "What it measures",
    "settings.whatMeasuresText":
      "Severity % is a weighted share of severe outcomes at an inferred intersection. By default: <code>(fatal + serious / 2) / total</code>. Fatal accidents count once, serious-injury accidents count as half, and all accidents at the intersection form the denominator. In the raw formula, 100% severity means the weighted severe count equals the total accident count; with default weights, that means every known record at the intersection was fatal. The displayed value can also reach 100% when trend adjustment pushes a high raw score up to the metric cap.",
    "settings.discountText":
      "Low accident totals are weighted conservatively, and the accident trend adjusts the result gradually using the latest configured selected years.",
    "settings.whyFocus": "Why this focus",
    "settings.whyFocusText1":
      "We do not have reliable traffic volume data for each intersection. Intersections with many recorded incidents are therefore not automatically the highest-severity locations; they may also be very highly loaded.",
    "settings.whyFocusText2":
      "The metric focuses on intersections with higher recorded severity, using fatal and serious-injury outcomes to distinguish severe locations from high-volume ones.",
    "status.settingsChanged": "Settings changed. Click Analyze to update results.",
    "status.loadingDataManifest": "Loading bundled data manifest.",
    "status.cacheMissParsingBundled": "Cache miss. Loading bundled accident records.",
    "status.loadingBundledChunk": "Loading bundled accident records {current}/{total}.",
    "status.loadingAccidentsInBackground": "Loading accident records in the background.",
    "status.accidentRecordsLoaded": "{count} accident records loaded.",
    "status.loadDataFirst": "Load accident data first.",
    "status.checkingAnalysisCache": "Checking analysis cache.",
    "status.intersectionClustersLoadedFromCache": "{count} intersection clusters loaded from cache.",
    "status.intersectionClustersLoadedFromBundle": "{count} intersection clusters loaded from bundled default analysis.",
    "status.analyzingIntersections": "Analyzing intersections.",
    "status.cachingAnalysisResult": "Caching analysis result.",
    "status.intersectionClustersAnalyzed": "{count} intersection clusters analyzed.",
    "status.geolocationUnavailable": "Browser geolocation is not available on this page.",
    "status.requestingLocation": "Requesting your browser location.",
    "status.nearestIntersection":
      "Showing nearest visible high-severity intersection ({distance} away, {accuracy} m location accuracy).",
    "status.centeredNoMatch":
      "Centered map on your location ({accuracy} m accuracy). No visible high-severity intersection matched the active filters.",
    "status.centeredLocation": "Centered map on your location ({accuracy} m accuracy).",
    "status.locationDenied": "Location permission was denied.",
    "status.locationUnavailable": "Your location is currently unavailable.",
    "status.locationTimedOut": "Location request timed out.",
    "status.locationFailed": "Could not get your location.",
    "status.noSeverityNearby": "No intersections match the active severity filters near this location.",
    "status.stateHotspotsPending": "State hotspots will appear after the data loads.",
    "status.noAnalysisMatches": "No intersections match the active analysis settings.",
    "status.resettingApp": "Resetting app storage...",
    "status.noClustersToExport": "No analyzed clusters to export.",
    "status.factsheetCreating": "Preparing factsheet PDF.",
    "status.factsheetDownloaded": "Factsheet downloaded.",
    "status.factsheetFailed": "Could not create factsheet: {error}",
    "label.away": "{distance} away",
    "noun.accident.one": "accident",
    "noun.accident.other": "accidents",
    "map.openOsm": "Open in OpenStreetMap",
    "map.openGoogleMaps": "Open in Google Maps",
    "map.openStreetView": "Open Street View",
    "map.searchResponsibleAuthority": "Search responsible authority",
    "map.labelOsm": "OpenStreetMap",
    "map.labelGoogleMaps": "Google Maps",
    "map.labelStreetView": "Street View",
    "map.labelResponsibleAuthority": "Authority",
    "press.label": "Press",
    "press.searchIntersection": "Search press coverage",
    "press.searchIncident": "Search press coverage for this incident",
    "records.title": "Known accident records",
    "records.countOf": "{shown} of {total}",
    "records.loading": "Accident record details are still loading.",
    "records.empty": "No matching source accident records were found near this intersection.",
    "records.incidentNumber": "Incident {number}",
    "records.category": "Category",
    "records.kind": "Kind",
    "records.type": "Type",
    "records.light": "Light",
    "records.surface": "Surface",
    "records.street": "Street",
    "records.roadUsers": "Road users",
    "records.area": "Area",
    "records.coordinates": "Coordinates",
    "records.locationCheck": "Location check",
    "records.distance": "Distance",
    "records.recordId": "Record ID",
    "records.source": "Source",
    "records.unknownYear": "Unknown year",
    "records.dayNotProvided": "day not provided",
    "records.unknownCode": "Unknown code",
    "records.noRoadUserFields": "No road-user fields",
    "records.yes": "yes",
    "records.no": "no",
    "records.adminRegion": "administrative region {code}",
    "records.district": "district {code}",
    "records.municipality": "municipality {code}",
    "records.serial": "serial {serial}",
    "records.categoryNumber": "Category {category}",
    "roadUser.pedestrian": "Pedestrian",
    "roadUser.bicycle": "Bicycle",
    "roadUser.motorcycle": "Motorcycle",
    "roadUser.car": "Passenger car",
    "roadUser.truck": "Goods road vehicle",
    "roadUser.other": "Other means of transport",
    "roadUsers.title": "Road users",
    "roadUsers.summaryAria": "Road-user distribution for selected intersection",
    "roadUsers.segmentLabel": "{label}: {count} involved, {percent}",
    "factsheet.title": "Selected intersection factsheet",
    "factsheet.titleMoreStreets": "{count} more",
    "factsheet.generated": "Generated",
    "factsheet.location": "Location",
    "factsheet.map": "Map image",
    "factsheet.mapLinks": "Map links",
    "factsheet.mapAttribution": "(C) OpenStreetMap contributors",
    "factsheet.mapTilesUnavailable": "OpenStreetMap tiles could not be loaded.",
    "factsheet.period": "Period",
    "factsheet.coordinates": "Coordinates",
    "factsheet.counts": "Exact accident counts",
    "factsheet.total": "Total",
    "factsheet.lightOther": "Light / other",
    "factsheet.severity": "Severity",
    "factsheet.dataSource": "Data source and publication date",
    "factsheet.accidentSource": "Accident data: Unfallatlas, Federal and state statistical offices.",
    "factsheet.municipalitySource": "Municipality names: Destatis municipality directory extract, 2nd quarter 2026.",
    "factsheet.license": "License: Datenlizenz Deutschland - Namensnennung - Version 2.0.",
    "factsheet.publicationUnknown": "Publication date is not included in the bundled CSV metadata.",
    "factsheet.latestBundleDate": "Latest bundled file timestamp: {date}.",
    "factsheet.trendSummary":
      "{trend}. Trend period setting: {setting} years; trend calculated from selected years {trendYears}. Chart shows selected years {chartYears}. Years with no accidents count as zero.",
    "factsheet.methodology": "Methodology note",
    "factsheet.methodologyText": "Accident points are clustered within the configured radius. Severity % is a weighted share of fatal and serious-injury outcomes, adjusted conservatively for small samples and the selected trend period.",
    "factsheet.methodologyTextDetailed":
      "Accident points are clustered within a {radius} radius. Severity % is a weighted share of fatal and serious-injury outcomes, adjusted conservatively for small samples and the trend period setting ({trendYears} years).",
    "factsheet.limitations": "Limitations",
    "factsheet.limitationsText": "Coordinates are generalized source accident locations, not surveyed junction geometry. No traffic-volume exposure data is available, so high counts may also reflect high traffic volumes. Road-user counts use involvement flags and one accident can involve multiple user types.",
    "factsheet.mapNote": "OpenStreetMap base map with source accident coordinates; marker positions are based on generalized source coordinates.",
    "factsheet.noRoadUsers": "No road-user involvement fields are available for these records.",
    "factsheet.filePrefix": "intersection-factsheet",
    "accident.category.killed": "Accident with persons killed",
    "accident.category.seriouslyInjured": "Accident with seriously injured",
    "accident.category.slightlyInjured": "Accident with slightly injured",
    "accident.kind.other": "Accident of another kind",
    "accident.kind.startsStopsStationary": "Collision with another vehicle which starts, stops, or is stationary",
    "accident.kind.movingAheadWaiting": "Collision with another vehicle moving ahead or waiting",
    "accident.kind.lateralSameDirection": "Collision with another vehicle moving laterally in the same direction",
    "accident.kind.oncoming": "Collision with another oncoming vehicle",
    "accident.kind.turnsOrCrosses": "Collision with another vehicle which turns into or crosses a road",
    "accident.kind.pedestrian": "Collision between vehicle and pedestrian",
    "accident.kind.obstacle": "Collision with an obstacle in the carriageway",
    "accident.kind.leavingRight": "Leaving the carriageway to the right",
    "accident.kind.leavingLeft": "Leaving the carriageway to the left",
    "accident.type.driving": "Driving accident",
    "accident.type.turningOff": "Accident caused by turning off the road",
    "accident.type.turningIntoCrossing": "Accident caused by turning into a road or by crossing it",
    "accident.type.crossingRoad": "Accident caused by crossing the road",
    "accident.type.stationaryTraffic": "Accident involving stationary traffic",
    "accident.type.sameCarriageway": "Accident between vehicles moving along in carriageway",
    "accident.type.other": "Other accident",
    "accident.light.daylight": "Daylight",
    "accident.light.twilight": "Twilight",
    "accident.light.darkness": "Darkness",
    "accident.surface.dry": "Dry",
    "accident.surface.wet": "Wet, damp, or slippery",
    "accident.surface.winter": "Slippery, winter conditions",
    "accident.plausibility.regular": "Successful location check, regular proceedings",
    "accident.plausibility.bicycle": "Successful location check, advanced bicycle proceedings",
    "month.1": "Jan",
    "month.2": "Feb",
    "month.3": "Mar",
    "month.4": "Apr",
    "month.5": "May",
    "month.6": "Jun",
    "month.7": "Jul",
    "month.8": "Aug",
    "month.9": "Sep",
    "month.10": "Oct",
    "month.11": "Nov",
    "month.12": "Dec",
    "weekday.1": "Sunday",
    "weekday.2": "Monday",
    "weekday.3": "Tuesday",
    "weekday.4": "Wednesday",
    "weekday.5": "Thursday",
    "weekday.6": "Friday",
    "weekday.7": "Saturday",
    "trend.title": "Accident trend",
    "trend.aria": "Selected intersection trend",
    "trend.latest": "{count} latest",
    "trend.legend.accidents": "Accidents",
    "trend.note": "Chart shows selected years; trend label uses the latest configured years. Years with no accidents count as zero.",
    "trend.chartAria": "Accident trend, {direction}",
    "trend.dotTitle": "{year}: {count} accidents",
    "trend.falling": "Falling",
    "trend.rising": "Rising",
    "trend.stable": "Stable",
    "trend.unknown": "No trend"
  },
  de: {
    "document.title": "Sichere Knoten",
    "loading.preparing": "Daten werden vorbereitet",
    "loading.checkingBundled": "Gebündelte Unfalldaten werden geprüft.",
    "loading.bundle": "Automatisches Offline-Paket",
    "loading.step.cache": "Cache",
    "loading.step.parse": "Einlesen",
    "loading.step.analyze": "Analyse",
    "loading.title.problem": "Problem beim Laden",
    "loading.title.idle": "Noch keine Ergebnisse",
    "loading.title.noMatches": "Keine passenden Kreuzungen",
    "loading.title.ready": "Analyse bereit",
    "loading.title.cache": "Datencache wird geprüft",
    "loading.title.parse": "Unfalldatensätze werden eingelesen",
    "loading.title.analyze": "Kreuzungen werden analysiert",
    "aria.sidebar": "Anwendungsseitenleiste",
    "aria.toolbar": "Arbeitsbereich-Werkzeugleiste",
    "aria.views": "Ansichten",
    "aria.mapControls": "Kartendarstellung",
    "aria.map": "Karte der Kreuzungen mit hohem Schweregrad",
    "aria.selectedDetails": "Details zur ausgewählten Kreuzung",
    "aria.openMapServices": "Ausgewählte Kreuzung in Kartendiensten öffnen",
    "aria.loadingSteps": "Ladeschritte",
    "brand.name": "Sichere Knoten",
    "brand.description": "Erkunde deutsche Unfalldaten, um Kreuzungen mit erhöhtem Risiko nach Schwere, Ort und Jahr zu erkennen.",
    "browse.title": "Nach Bundesland suchen",
    "field.state": "Bundesland",
    "field.accidentOutcome": "Unfallfolge",
    "option.allStates": "Alle Bundesländer",
    "tab.browse": "Suche",
    "tab.map": "Karte",
    "tab.details": "Details",
    "tab.streetView": "Street View",
    "tab.moreViews": "Weitere Ansichten",
    "tab.state": "Bundesland",
    "tab.intersections": "Kreuzungen",
    "tab.settings": "Einstellungen",
    "severity.fatal": "Tödlich",
    "severity.serious": "Schwer",
    "severity.light": "Leicht",
    "severity.other": "Andere",
    "severity.unknown": "Unbekannt",
    "action.findNearby": "Kreuzungen in der Nähe finden",
    "action.centerLocation": "Karte auf deinen Standort zentrieren",
    "action.show": "Anzeigen",
    "action.hide": "Ausblenden",
    "action.resetApp": "App zurücksetzen",
    "action.exportCsv": "CSV exportieren",
    "action.downloadFactsheet": "Faktenblatt herunterladen",
    "action.labelFactsheet": "PDF",
    "action.analyze": "Analysieren",
    "action.analyzeChanges": "Änderungen analysieren",
    "streetView.title": "Google Street View",
    "streetView.empty": "Wähle eine Kreuzung aus, um Street View anzuzeigen.",
    "streetView.near": "Google Street View nahe {lat}, {lon}",
    "details.title": "Ausgewählte Kreuzung",
    "details.none": "Keine Kreuzung ausgewählt.",
    "details.selectFirst": "Wähle zuerst eine Kreuzung aus.",
    "details.state": "Bundesland",
    "details.adminRegion": "Regierungsbezirk",
    "details.district": "Kreis",
    "details.municipality": "Gemeinde",
    "details.street": "Straße",
    "details.streets": "Straßen",
    "details.coordinates": "Koordinaten",
    "details.years": "Jahre",
    "details.accidents": "Unfälle",
    "details.fatalSerious": "Tödlich / schwer",
    "details.severityPercent": "Schweregrad %",
    "metric.severityPercent": "Schweregrad %",
    "metric.severity": "Schweregrad",
    "metric.severityPercentContextGermany":
      "{value} ({state}: #{stateRank}, oberste {statePercent}%; Deutschland: #{germanyRank}, oberste {germanyPercent}%)",
    "metric.severityPercentContextState": "{value} ({state}: #{stateRank}, oberste {statePercent}%)",
    "unit.perYear": "/Jahr",
    "table.state": "Bundesland",
    "table.accidents": "Unfälle",
    "table.clusters": "Cluster",
    "table.topCluster": "Größter Cluster",
    "table.location": "Ort",
    "table.sorted": "{label} sortiert {direction}",
    "table.sort.asc": "aufsteigend",
    "table.sort.desc": "absteigend",
    "table.sort.none": "nicht",
    "settings.data": "Daten",
    "settings.dataNote": "Gebündelte normalisierte Unfalldaten werden automatisch aus dem Offline-Datenpaket geladen.",
    "settings.accidentData": "Unfalldaten:",
    "settings.municipalityData": "Gemeindedaten:",
    "settings.destatisMunicipalities": "/ Destatis-Gemeindeverzeichnis-Auszug, 2. Quartal 2026.",
    "settings.statsOffices": "/ Statistische Ämter des Bundes und der Länder.",
    "settings.reusedUnder": "Weiterverwendet unter",
    "settings.licenseNote": "/ dl-de/by-2-0. Die Quelldaten werden von dieser App verarbeitet, geclustert und analysiert.",
    "settings.repository": "Projekt-Repository:",
    "settings.impressum": "Impressum",
    "settings.metricTitle": "Schweregrad-%-Metrik",
    "settings.fatalWeight": "Gewicht tödlicher Unfälle",
    "settings.seriousWeight": "Gewicht schwerer Unfälle",
    "settings.fullSample": "Volle Stichprobengröße",
    "settings.trendYears": "Trendzeitraum (Jahre)",
    "settings.trendDeadZone": "Trend-Toleranzzone (%/Jahr)",
    "settings.trendFullSignal": "Volles Trendsignal (%/Jahr)",
    "settings.maxTrendAdjustment": "Maximale Trendanpassung (%)",
    "settings.metricCap": "Metrik-Obergrenze (%)",
    "settings.analysis": "Analyse",
    "settings.clusterRadius": "Cluster-Radius (m)",
    "settings.clusterRadiusMeters": "Cluster-Radius in Metern",
    "settings.minAccidents": "Mindestanzahl Unfälle",
    "settings.roadUserFocus": "Fokus Verkehrsteilnehmer",
    "settings.roadUserFocusNote": "Wähle einen oder mehrere aus, um nur Unfälle mit mindestens einem ausgewählten Verkehrsteilnehmer einzubeziehen. Wenn nichts ausgewählt ist, werden alle Unfälle einbezogen.",
    "settings.yearFilters": "Jahresfilter",
    "settings.aboutSeverity": "Über Schweregrad %",
    "settings.whatMeasures": "Was gemessen wird",
    "settings.whatMeasuresText":
      "Schweregrad % ist der gewichtete Anteil schwerer Folgen an einer abgeleiteten Kreuzung. Standardmäßig gilt: <code>(tödlich + schwer / 2) / gesamt</code>. Tödliche Unfälle zählen einfach, Unfälle mit Schwerverletzten halb, und alle Unfälle an der Kreuzung bilden den Nenner. In der Rohformel bedeutet 100% Schweregrad, dass die gewichtete Anzahl schwerer Folgen der Gesamtzahl der Unfälle entspricht; mit den Standardgewichten heißt das, dass jeder bekannte Datensatz an der Kreuzung tödlich war. Der angezeigte Wert kann ebenfalls 100% erreichen, wenn die Trendanpassung einen hohen Rohwert bis zur Metrik-Obergrenze anhebt.",
    "settings.discountText":
      "Niedrige Unfallzahlen werden konservativ gewichtet, und der Unfalltrend passt das Ergebnis schrittweise anhand der neuesten ausgewählten Jahre an.",
    "settings.whyFocus": "Warum dieser Fokus",
    "settings.whyFocusText1":
      "Wir haben keine verlässlichen Verkehrsstärkedaten für jede Kreuzung. Kreuzungen mit vielen registrierten Vorfällen sind deshalb nicht automatisch die Orte mit dem höchsten Schweregrad; sie können auch sehr stark belastet sein.",
    "settings.whyFocusText2":
      "Die Metrik fokussiert Kreuzungen mit höherem erfasstem Schweregrad und nutzt tödliche sowie schwere Unfallfolgen, um Orte mit schweren Folgen von stark belasteten Orten zu unterscheiden.",
    "status.settingsChanged": "Einstellungen geändert. Klicke auf Analysieren, um die Ergebnisse zu aktualisieren.",
    "status.loadingDataManifest": "Gebündeltes Datenmanifest wird geladen.",
    "status.cacheMissParsingBundled": "Kein Cachetreffer. Gebündelte Unfalldatensätze werden geladen.",
    "status.loadingBundledChunk": "Gebündelte Unfalldatensätze werden geladen {current}/{total}.",
    "status.loadingAccidentsInBackground": "Unfalldatensätze werden im Hintergrund geladen.",
    "status.accidentRecordsLoaded": "{count} Unfalldatensätze geladen.",
    "status.loadDataFirst": "Lade zuerst Unfalldaten.",
    "status.checkingAnalysisCache": "Analysecache wird geprüft.",
    "status.intersectionClustersLoadedFromCache": "{count} Kreuzungscluster aus dem Cache geladen.",
    "status.intersectionClustersLoadedFromBundle": "{count} Kreuzungscluster aus der gebündelten Standardanalyse geladen.",
    "status.analyzingIntersections": "Kreuzungen werden analysiert.",
    "status.cachingAnalysisResult": "Analyseergebnis wird gespeichert.",
    "status.intersectionClustersAnalyzed": "{count} Kreuzungscluster analysiert.",
    "status.geolocationUnavailable": "Browser-Geolokalisierung ist auf dieser Seite nicht verfügbar.",
    "status.requestingLocation": "Browser-Standort wird angefragt.",
    "status.nearestIntersection": "Nächste sichtbare Kreuzung mit hohem Schweregrad wird angezeigt ({distance} entfernt, {accuracy} m Standortgenauigkeit).",
    "status.centeredNoMatch":
      "Karte auf deinen Standort zentriert ({accuracy} m Genauigkeit). Keine sichtbare Kreuzung mit hohem Schweregrad passt zu den aktiven Filtern.",
    "status.centeredLocation": "Karte auf deinen Standort zentriert ({accuracy} m Genauigkeit).",
    "status.locationDenied": "Standortberechtigung wurde verweigert.",
    "status.locationUnavailable": "Dein Standort ist derzeit nicht verfügbar.",
    "status.locationTimedOut": "Standortanfrage hat zu lange gedauert.",
    "status.locationFailed": "Standort konnte nicht ermittelt werden.",
    "status.noSeverityNearby": "Keine Kreuzungen in der Nähe passen zu den aktiven Unfallfolge-Filtern.",
    "status.stateHotspotsPending": "Bundesland-Hotspots erscheinen, sobald die Daten geladen sind.",
    "status.noAnalysisMatches": "Keine Kreuzungen passen zu den aktiven Analyse-Einstellungen.",
    "status.resettingApp": "App-Speicher wird zurückgesetzt...",
    "status.noClustersToExport": "Keine analysierten Cluster zum Exportieren.",
    "status.factsheetCreating": "Faktenblatt-PDF wird vorbereitet.",
    "status.factsheetDownloaded": "Faktenblatt heruntergeladen.",
    "status.factsheetFailed": "Faktenblatt konnte nicht erstellt werden: {error}",
    "label.away": "{distance} entfernt",
    "noun.accident.one": "Unfall",
    "noun.accident.other": "Unfälle",
    "map.openOsm": "In OpenStreetMap öffnen",
    "map.openGoogleMaps": "In Google Maps öffnen",
    "map.openStreetView": "Street View öffnen",
    "map.searchResponsibleAuthority": "Zuständige Behörde suchen",
    "map.labelOsm": "OpenStreetMap",
    "map.labelGoogleMaps": "Google Maps",
    "map.labelStreetView": "Street View",
    "map.labelResponsibleAuthority": "Behörde",
    "press.label": "Presse",
    "press.searchIntersection": "Presseberichte suchen",
    "press.searchIncident": "Presseberichte zu diesem Unfall suchen",
    "records.title": "Bekannte Unfalldatensätze",
    "records.countOf": "{shown} von {total}",
    "records.loading": "Details zu den Unfalldatensätzen werden noch geladen.",
    "records.empty": "In der Nähe dieser Kreuzung wurden keine passenden Quelldatensätze gefunden.",
    "records.incidentNumber": "Unfall {number}",
    "records.category": "Kategorie",
    "records.kind": "Art",
    "records.type": "Typ",
    "records.light": "Licht",
    "records.surface": "Oberfläche",
    "records.street": "Straße",
    "records.roadUsers": "Verkehrsteilnehmer",
    "records.area": "Gebiet",
    "records.coordinates": "Koordinaten",
    "records.locationCheck": "Lageprüfung",
    "records.distance": "Entfernung",
    "records.recordId": "Datensatz-ID",
    "records.source": "Quelle",
    "records.unknownYear": "Unbekanntes Jahr",
    "records.dayNotProvided": "Tag nicht enthalten",
    "records.unknownCode": "Unbekannter Code",
    "records.noRoadUserFields": "Keine Verkehrsteilnehmerfelder",
    "records.yes": "ja",
    "records.no": "nein",
    "records.adminRegion": "Regierungsbezirk {code}",
    "records.district": "Kreis {code}",
    "records.municipality": "Gemeinde {code}",
    "records.serial": "laufende Nummer {serial}",
    "records.categoryNumber": "Kategorie {category}",
    "roadUser.pedestrian": "Fußgänger",
    "roadUser.bicycle": "Fahrrad",
    "roadUser.motorcycle": "Motorrad",
    "roadUser.car": "Pkw",
    "roadUser.truck": "Güterkraftfahrzeug",
    "roadUser.other": "Sonstiges Verkehrsmittel",
    "roadUsers.title": "Verkehrsteilnehmer",
    "roadUsers.summaryAria": "Verteilung der Verkehrsteilnehmer dieser Kreuzung",
    "roadUsers.segmentLabel": "{label}: {count} beteiligt, {percent}",
    "factsheet.title": "Faktenblatt ausgewählte Kreuzung",
    "factsheet.titleMoreStreets": "{count} weitere",
    "factsheet.generated": "Erstellt",
    "factsheet.location": "Ort",
    "factsheet.map": "Kartenbild",
    "factsheet.mapLinks": "Kartenlinks",
    "factsheet.mapAttribution": "(C) OpenStreetMap-Mitwirkende",
    "factsheet.mapTilesUnavailable": "OpenStreetMap-Kacheln konnten nicht geladen werden.",
    "factsheet.period": "Zeitraum",
    "factsheet.coordinates": "Koordinaten",
    "factsheet.counts": "Exakte Unfallzahlen",
    "factsheet.total": "Gesamt",
    "factsheet.lightOther": "Leicht / sonstige",
    "factsheet.severity": "Schweregrad",
    "factsheet.dataSource": "Datenquelle und Veröffentlichungsdatum",
    "factsheet.accidentSource": "Unfalldaten: Unfallatlas, Statistische Ämter des Bundes und der Länder.",
    "factsheet.municipalitySource": "Gemeindenamen: Destatis-Gemeindeverzeichnis-Auszug, 2. Quartal 2026.",
    "factsheet.license": "Lizenz: Datenlizenz Deutschland - Namensnennung - Version 2.0.",
    "factsheet.publicationUnknown": "Ein formales Veröffentlichungsdatum ist in den gebündelten CSV-Metadaten nicht enthalten.",
    "factsheet.latestBundleDate": "Neuester gebündelter Dateizeitstempel: {date}.",
    "factsheet.trendSummary":
      "{trend}. Trendzeitraum-Einstellung: {setting} Jahre; Trend berechnet aus den ausgewählten Jahren {trendYears}. Die Grafik zeigt die ausgewählten Jahre {chartYears}. Jahre ohne Unfälle zählen als null.",
    "factsheet.methodology": "Methodischer Hinweis",
    "factsheet.methodologyText": "Unfallpunkte werden innerhalb des eingestellten Radius geclustert. Schweregrad % ist der gewichtete Anteil tödlicher und schwerer Unfallfolgen, mit konservativer Anpassung für kleine Stichproben und den ausgewählten Trendzeitraum.",
    "factsheet.methodologyTextDetailed":
      "Unfallpunkte werden innerhalb eines Radius von {radius} geclustert. Schweregrad % ist der gewichtete Anteil tödlicher und schwerer Unfallfolgen, mit konservativer Anpassung für kleine Stichproben und die Trendzeitraum-Einstellung ({trendYears} Jahre).",
    "factsheet.limitations": "Einschränkungen",
    "factsheet.limitationsText": "Koordinaten sind generalisierte Unfallorte aus den Quelldaten, keine vermessene Kreuzungsgeometrie. Verkehrsstärkedaten fehlen, daher können hohe Unfallzahlen auch hohe Verkehrsbelastung widerspiegeln. Verkehrsteilnehmer-Zahlen nutzen Beteiligungskennzeichen; ein Unfall kann mehrere Nutzerarten betreffen.",
    "factsheet.mapNote": "OpenStreetMap-Grundkarte mit Unfallkoordinaten aus den Quelldaten; Markierungen basieren auf generalisierten Quellkoordinaten.",
    "factsheet.noRoadUsers": "Für diese Datensätze sind keine Verkehrsteilnehmerfelder verfügbar.",
    "factsheet.filePrefix": "faktenblatt-kreuzung",
    "accident.category.killed": "Unfall mit Getöteten",
    "accident.category.seriouslyInjured": "Unfall mit Schwerverletzten",
    "accident.category.slightlyInjured": "Unfall mit Leichtverletzten",
    "accident.kind.other": "Unfall anderer Art",
    "accident.kind.startsStopsStationary": "Zusammenstoß mit anfahrendem, anhaltendem oder ruhendem Fahrzeug",
    "accident.kind.movingAheadWaiting": "Zusammenstoß mit vorausfahrendem oder wartendem Fahrzeug",
    "accident.kind.lateralSameDirection": "Zusammenstoß mit seitlich in gleicher Richtung fahrendem Fahrzeug",
    "accident.kind.oncoming": "Zusammenstoß mit entgegenkommendem Fahrzeug",
    "accident.kind.turnsOrCrosses": "Zusammenstoß mit einbiegendem oder kreuzendem Fahrzeug",
    "accident.kind.pedestrian": "Zusammenstoß zwischen Fahrzeug und Fußgänger",
    "accident.kind.obstacle": "Aufprall auf ein Hindernis auf der Fahrbahn",
    "accident.kind.leavingRight": "Abkommen von der Fahrbahn nach rechts",
    "accident.kind.leavingLeft": "Abkommen von der Fahrbahn nach links",
    "accident.type.driving": "Fahrunfall",
    "accident.type.turningOff": "Abbiegeunfall",
    "accident.type.turningIntoCrossing": "Einbiegen-/Kreuzen-Unfall",
    "accident.type.crossingRoad": "Überschreiten-Unfall",
    "accident.type.stationaryTraffic": "Unfall durch ruhenden Verkehr",
    "accident.type.sameCarriageway": "Unfall im Längsverkehr",
    "accident.type.other": "Sonstiger Unfall",
    "accident.light.daylight": "Tageslicht",
    "accident.light.twilight": "Dämmerung",
    "accident.light.darkness": "Dunkelheit",
    "accident.surface.dry": "Trocken",
    "accident.surface.wet": "Nass, feucht oder glatt",
    "accident.surface.winter": "Glatt, winterliche Bedingungen",
    "accident.plausibility.regular": "Erfolgreiche Lageprüfung, Standardverfahren",
    "accident.plausibility.bicycle": "Erfolgreiche Lageprüfung, erweitertes Radverkehrsverfahren",
    "month.1": "Jan",
    "month.2": "Feb",
    "month.3": "Mär",
    "month.4": "Apr",
    "month.5": "Mai",
    "month.6": "Jun",
    "month.7": "Jul",
    "month.8": "Aug",
    "month.9": "Sep",
    "month.10": "Okt",
    "month.11": "Nov",
    "month.12": "Dez",
    "weekday.1": "Sonntag",
    "weekday.2": "Montag",
    "weekday.3": "Dienstag",
    "weekday.4": "Mittwoch",
    "weekday.5": "Donnerstag",
    "weekday.6": "Freitag",
    "weekday.7": "Samstag",
    "trend.title": "Unfalltrend",
    "trend.aria": "Trend der ausgewählten Kreuzung",
    "trend.latest": "{count} zuletzt",
    "trend.legend.accidents": "Unfälle",
    "trend.note": "Die Grafik zeigt ausgewählte Jahre; die Trendangabe nutzt die neuesten eingestellten Jahre. Jahre ohne Unfälle zählen als null.",
    "trend.chartAria": "Unfalltrend, {direction}",
    "trend.dotTitle": "{year}: {count} Unfälle",
    "trend.falling": "Fallend",
    "trend.rising": "Steigend",
    "trend.stable": "Stabil",
    "trend.unknown": "Kein Trend"
  }
};
const ACTIVE_LOCALE: AppLocale = detectLocale();
const NUMBER_LOCALE = ACTIVE_LOCALE === "de" ? "de-DE" : "en-US";
const ACCIDENT_CATEGORY_LABELS: Record<number, string> = {
  1: "accident.category.killed",
  2: "accident.category.seriouslyInjured",
  3: "accident.category.slightlyInjured"
};
const ACCIDENT_KIND_LABELS: Record<number, string> = {
  0: "accident.kind.other",
  1: "accident.kind.startsStopsStationary",
  2: "accident.kind.movingAheadWaiting",
  3: "accident.kind.lateralSameDirection",
  4: "accident.kind.oncoming",
  5: "accident.kind.turnsOrCrosses",
  6: "accident.kind.pedestrian",
  7: "accident.kind.obstacle",
  8: "accident.kind.leavingRight",
  9: "accident.kind.leavingLeft"
};
const ACCIDENT_TYPE_LABELS: Record<number, string> = {
  1: "accident.type.driving",
  2: "accident.type.turningOff",
  3: "accident.type.turningIntoCrossing",
  4: "accident.type.crossingRoad",
  5: "accident.type.stationaryTraffic",
  6: "accident.type.sameCarriageway",
  7: "accident.type.other"
};
const LIGHT_CONDITION_LABELS: Record<number, string> = {
  0: "accident.light.daylight",
  1: "accident.light.twilight",
  2: "accident.light.darkness"
};
const ROAD_SURFACE_LABELS: Record<number, string> = {
  0: "accident.surface.dry",
  1: "accident.surface.wet",
  2: "accident.surface.winter"
};
const PLAUSIBILITY_LEVEL_LABELS: Record<number, string> = {
  1: "accident.plausibility.regular",
  2: "accident.plausibility.bicycle"
};
const factsheetTileCache = new Map<string, Promise<HTMLImageElement | null>>();

interface ClusterTableSort {
  key: ClusterSortKey;
  direction: SortDirection;
}

interface SeverityPercentSource {
  severityPercent: number;
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

interface TrendSeriesPoint extends ClusterYearStat {
  x: number;
  accidentY: number;
}

interface AnalysisCacheContext {
  dataVersion: string;
  appVersion: string;
}

interface PendingAnalysisCacheWrite {
  cacheContext: AnalysisCacheContext;
  options: AnalysisOptions;
  result: AnalysisResult;
}

interface PostRenderCacheWrites {
  analysis: PendingAnalysisCacheWrite | null;
}

interface AccidentIndexCache {
  key: string;
  source: AccidentRecord[];
  index: GeoGridIndex<AccidentRecord>;
}

interface AccidentKeyLookupCache {
  source: AccidentRecord[];
  map: Map<string, AccidentRecord>;
}

interface AccidentRecordIndexLookupCache {
  source: AccidentRecord[];
  map: Map<number, AccidentRecord>;
}

interface CrossingAccident {
  accident: AccidentRecord;
  distanceMeters: number;
}

interface ClusterAccidentRecordsSnapshot {
  records: CrossingAccident[];
  loading: boolean;
}

let accidents: AccidentRecord[] = [];
let result: AnalysisResult | null = null;
let selectedCluster: IntersectionCluster | null = null;
let clusterTableSort: ClusterTableSort = { key: "severityPercent", direction: "desc" };
let analysisSettingsDirty = false;
let activeDataVersion: string | null = null;
let userLocation: { lat: number; lon: number; accuracyMeters: number | null } | null = null;
let activeAnalysisOptions: AnalysisOptions | null = null;
let crossingAccidentIndexCache: AccidentIndexCache | null = null;
let accidentKeyLookupCache: AccidentKeyLookupCache | null = null;
let accidentRecordIndexLookupCache: AccidentRecordIndexLookupCache | null = null;
let severityRankCache: SeverityRankCache | null = null;
let accidentDataLoadPromise: Promise<AccidentRecord[]> | null = null;
let accidentStateRecords = new Map<string, AccidentRecord[]>();
let accidentStateLoadPromises = new Map<string, Promise<AccidentRecord[]>>();
let selectedAccidentRecordsRequestId = 0;
let postRenderCacheWriteQueue: Promise<void> = Promise.resolve();
let isStreetViewOpen = readStoredStreetViewOpen();
let activeView: ViewKey = "map";
let loadingStatusKind: LoadingStatusKind = "normal";
let activeInteractionTelemetry: InteractionTelemetry | null = null;

const elements = {
  app: byId<HTMLDivElement>("app"),
  splash: byId<HTMLDivElement>("appSplash"),
  splashLoadingTitle: byId<HTMLHeadingElement>("splashLoadingTitle"),
  splashLoadingStatus: byId<HTMLParagraphElement>("splashLoadingStatus"),
  splashLoadingBar: byId<HTMLDivElement>("splashLoadingBar"),
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
  loadingSteps: Array.from(document.querySelectorAll<HTMLElement>("[data-loading-step]")),
  selectedAside: byId<HTMLElement>("selectedAside"),
  selectionDetails: byId<HTMLDivElement>("selectionDetails"),
  findNearbyBtn: byId<HTMLButtonElement>("findNearbyBtn"),
  nearbyList: byId<HTMLDivElement>("nearbyList"),
  browseState: byId<HTMLSelectElement>("browseState"),
  stateHotspotList: byId<HTMLDivElement>("stateHotspotList"),
  stateTableBody: byId<HTMLTableSectionElement>("stateTableBody"),
  clusterTableBody: byId<HTMLTableSectionElement>("clusterTableBody"),
  exploreTab: byId<HTMLButtonElement>("exploreTab"),
  mapTab: byId<HTMLButtonElement>("mapTab"),
  detailsTab: byId<HTMLButtonElement>("detailsTab"),
  moreTab: byId<HTMLButtonElement>("moreTab"),
  stateTab: byId<HTMLButtonElement>("stateTab"),
  tableTab: byId<HTMLButtonElement>("tableTab"),
  settingsTab: byId<HTMLButtonElement>("settingsTab"),
  mobileMoreMenu: byId<HTMLDivElement>("mobileMoreMenu"),
  mobileStateTab: byId<HTMLButtonElement>("mobileStateTab"),
  mobileTableTab: byId<HTMLButtonElement>("mobileTableTab"),
  mobileSettingsTab: byId<HTMLButtonElement>("mobileSettingsTab"),
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
const mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);

applyStaticTranslations();
resetAnalysisControlsToDefaults();
wireEvents();
setView(initialView());
renderAll();
void checkForFreshDeploymentHtml();
void loadBundledData();

function detectLocale(): AppLocale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const languageCode = language.toLowerCase().split("-")[0];
    if (languageCode === "de" || languageCode === "en") {
      return languageCode;
    }
  }
  return "en";
}

function tr(key: string): string {
  return TRANSLATIONS[ACTIVE_LOCALE][key] ?? TRANSLATIONS.en[key] ?? key;
}

function trf(key: string, values: Record<string, string | number>): string {
  return tr(key).replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}

function applyStaticTranslations(): void {
  document.documentElement.lang = ACTIVE_LOCALE;
  document.title = tr("document.title");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = tr(key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((element) => {
    const key = element.dataset.i18nHtml;
    if (key) {
      element.innerHTML = tr(key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.dataset.i18nAriaLabel;
    if (key) {
      element.setAttribute("aria-label", tr(key));
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle;
    if (key) {
      element.setAttribute("title", tr(key));
    }
  });
}

function wireEvents(): void {
  elements.resetAppBtn.addEventListener("click", () => void resetApp());
  elements.analyzeBtn.addEventListener("click", () => runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);
  elements.selectionDetails.addEventListener("click", handleSelectionDetailsClick);

  wireLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut, markAnalysisSettingsDirty);

  wireClampedNumberInput(elements.minAccidents, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.severityFullSample, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.severityTrendYears, markAnalysisSettingsDirty);
  severityPercentDecimalInputs().forEach((input) => wireClampedDecimalInput(input, markAnalysisSettingsDirty));

  elements.stateFilter.addEventListener("input", markAnalysisSettingsDirty);
  elements.stateFilter.addEventListener("change", markAnalysisSettingsDirty);
  roadUserFocusInputs().forEach((input) => input.addEventListener("change", markAnalysisSettingsDirty));

  [elements.showFatalPoints, elements.showSeriousPoints, elements.showOtherPoints].forEach((input) => {
    input.addEventListener("change", applySeverityFilter);
  });
  elements.locateMeBtn.addEventListener("click", () => locateUser({ selectNearest: false }));
  elements.findNearbyBtn.addEventListener("click", () => locateUser({ selectNearest: true }));
  elements.streetViewToggle.addEventListener("click", toggleStreetViewPanel);
  elements.browseState.addEventListener("change", renderExplore);

  elements.exploreTab.addEventListener("click", () => setView("explore"));
  elements.mapTab.addEventListener("click", () => setView("map"));
  elements.detailsTab.addEventListener("click", () => setView("details"));
  elements.moreTab.addEventListener("click", toggleMobileMoreMenu);
  elements.stateTab.addEventListener("click", () => setView("state"));
  elements.tableTab.addEventListener("click", () => setView("table"));
  elements.settingsTab.addEventListener("click", () => setView("settings"));
  elements.mobileStateTab.addEventListener("click", () => setView("state"));
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

function handleSelectionDetailsClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }

  const factsheetButton = event.target.closest<HTMLButtonElement>("[data-selected-action='factsheet']");
  if (factsheetButton) {
    void downloadSelectedFactsheet();
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
  if (!accidents.length && !result) {
    return;
  }
  analysisSettingsDirty = true;
  updateAnalyzeButton();
  if (result) {
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

async function loadBundledData(): Promise<void> {
  const telemetry = createInitializationTelemetry();
  setBusy(true);
  let analysisStarted = false;
  try {
    accidents = [];
    result = null;
    selectedCluster = null;
    activeAnalysisOptions = null;
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    accidentRecordIndexLookupCache = null;
    severityRankCache = null;
    accidentDataLoadPromise = null;
    accidentStateRecords = new Map();
    accidentStateLoadPromises = new Map();
    analysisSettingsDirty = false;
    activeDataVersion = null;
    updateAnalyzeButton();
    populateFilters();
    renderAll();
    setStatus(tr("status.loadingDataManifest"), 2);
    await ensureBundledDataManifest(telemetry);
    const dataVersion = bundledDataVersion();
    telemetry.dataVersion = dataVersion;
    activeDataVersion = dataVersion;
    populateFilters();
    recordInitializationStep(telemetry, "skip parsed data cache", dataVersion, {
      reason: "normalized bundle is faster than IndexedDB object cache"
    });

    const options = readOptions();
    const cacheContext = { dataVersion, appVersion: ANALYSIS_CACHE_VERSION };
    const bundledDefaultAnalysis = await readBundledDefaultAnalysis(telemetry, dataVersion, ANALYSIS_CACHE_VERSION, options);
    if (bundledDefaultAnalysis) {
      result = bundledDefaultAnalysis;
      selectedCluster = null;
      activeAnalysisOptions = cloneAnalysisOptions(options);
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      accidentRecordIndexLookupCache = null;
      severityRankCache = null;
      analysisSettingsDirty = false;
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
      setStatus(trf("status.intersectionClustersLoadedFromBundle", { count: formatInteger(result.clusters.length) }), 100);
      setBusy(false);
      logInitializationTelemetry(telemetry, "done");
      return;
    }

    setStatus(tr("status.checkingAnalysisCache"), 20);
    const cachedAnalysis = await measureInitializationStep(
      telemetry,
      "read analysis cache",
      analysisTelemetryDetail(options),
      () => readAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options),
      (cachedResult) => ({
        cacheHit: Boolean(cachedResult),
        clusterCount: cachedResult?.clusters.length ?? 0
      })
    );
    if (cachedAnalysis) {
      result = cachedAnalysis;
      selectedCluster = null;
      activeAnalysisOptions = cloneAnalysisOptions(options);
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      accidentRecordIndexLookupCache = null;
      severityRankCache = null;
      analysisSettingsDirty = false;
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
      setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(result.clusters.length) }), 100);
      setBusy(false);
      logInitializationTelemetry(telemetry, "done");
      return;
    }

    setStatus(tr("status.cacheMissParsingBundled"), 10);
    await loadAccidentData(telemetry);
    setStatus(trf("status.accidentRecordsLoaded", { count: formatInteger(accidents.length) }), 60);

    analysisStarted = true;
    void runAnalysisWithCache(options, cacheContext, telemetry, "analysis cache already missed before accident records loaded");
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
  const options = readOptions();
  const cacheContext = activeDataVersion ? { dataVersion: activeDataVersion, appVersion: ANALYSIS_CACHE_VERSION } : null;
  setBusy(true);
  void runAnalysisWhenAccidentsReady(options, cacheContext, initializationTelemetry);
}

async function runAnalysisWhenAccidentsReady(
  options: AnalysisOptions,
  cacheContext: AnalysisCacheContext | null,
  initializationTelemetry: InitializationTelemetry | null
): Promise<void> {
  try {
    await runAnalysisWithCache(options, cacheContext, initializationTelemetry);
  } catch (error) {
    setStatus(errorMessage(error), 0, "problem");
    setBusy(false);
    logInitializationTelemetry(initializationTelemetry, "error");
  }
}

async function runAnalysisWithCache(
  options: AnalysisOptions,
  cacheContext: AnalysisCacheContext | null,
  initializationTelemetry: InitializationTelemetry | null = null,
  skipAnalysisCacheReason: string | null = null,
  analysisAccidents: AccidentRecord[] | null = null
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
        () => readAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options),
        (cachedResult) => ({
          cacheHit: Boolean(cachedResult),
          clusterCount: cachedResult?.clusters.length ?? 0
        })
      );
      if (cached) {
        result = cached;
        selectedCluster = null;
        activeAnalysisOptions = cloneAnalysisOptions(options);
        crossingAccidentIndexCache = null;
        accidentKeyLookupCache = null;
        accidentRecordIndexLookupCache = null;
        severityRankCache = null;
        analysisSettingsDirty = false;
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
        setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(result.clusters.length) }), 100);
        return;
      }
    }

    setStatus(tr("status.analyzingIntersections"), 75);
    await yieldToBrowser();
    let analysisPlan: AnalysisExecutionPlan | null = null;
    const sourceAccidents = analysisAccidents ?? (await loadAccidentsForAnalysis(options, initializationTelemetry));
    result = await measureInitializationStep(
      initializationTelemetry,
      "analyze intersections",
      analysisTelemetryDetail(options),
      () =>
        analyzeDangerousIntersectionsInBackground(sourceAccidents, options, (plan) => {
          analysisPlan = plan;
          updateAnalysisPlanStatus();
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
    selectedCluster = null;
    activeAnalysisOptions = cloneAnalysisOptions(options);
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    accidentRecordIndexLookupCache = null;
    severityRankCache = null;
    analysisSettingsDirty = false;
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

    setStatus(trf("status.intersectionClustersAnalyzed", { count: formatInteger(result.clusters.length) }), 100);
    enqueuePostRenderCacheWrites(initializationTelemetry, {
      analysis:
        cacheContext && result
          ? {
              cacheContext,
              options: cloneAnalysisOptions(options),
              result
            }
          : null
    });
  } catch (error) {
    telemetryStatus = "error";
    setStatus(errorMessage(error), 0, "problem");
  } finally {
    setBusy(false);
    logInitializationTelemetry(initializationTelemetry, telemetryStatus);
  }
}

function updateAnalysisPlanStatus(): void {
  setStatus(tr("status.analyzingIntersections"), 75);
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

function populateFilters(): void {
  const selectedState = elements.stateFilter.value;
  const selectedBrowseState = elements.browseState.value;
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
  const years = new Set<number>();
  for (const file of globalThis.__SICHERE_KNOTEN_DATA__?.files ?? []) {
    const label = `${file.path} ${file.name}`;
    for (const match of label.matchAll(/(20\d{2})/g)) {
      years.add(Number(match[1]));
    }
  }
  return Array.from(years).sort((a, b) => a - b);
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

function handleClusterSelection(cluster: IntersectionCluster | null, reason: SelectionReason): void {
  measureActiveInteractionStep("store selected cluster", cluster?.id ?? null, () => {
    selectedCluster = cluster;
  });
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
    renderExplore,
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
      renderExplore();
      const selectedNearest = options.selectNearest ? selectNearestCluster() : null;
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
      <td>${formatInteger(summary.accidentCount)}</td>
      <td>${formatInteger(summary.clusterCount)}</td>
      <td>${formatSeverityPercent(summary)}</td>
      <td>${summary.topCluster ? clusterLocation(summary.topCluster) : ""}</td>
    `;
    const topCluster = summary.topCluster;
    if (topCluster) {
      row.addEventListener("click", () => {
        selectClusterOnMap(topCluster);
      });
    }
    elements.stateTableBody.append(row);
  }

  const clusters = clustersForTable(result.clusters);
  for (const cluster of clusters) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.innerHTML = `
      <td>${escapeHtml(cluster.stateName)}</td>
      <td>${clusterLocation(cluster)}</td>
      <td>${formatInteger(cluster.accidentCount)}</td>
      <td>${formatInteger(cluster.fatalCount)}</td>
      <td>${formatInteger(cluster.seriousCount)}</td>
      <td>${formatSeverityPercent(cluster)}</td>
    `;
    row.addEventListener("click", () => {
      selectClusterOnMap(cluster);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        selectClusterOnMap(cluster);
      }
    });
    elements.clusterTableBody.append(row);
  }
}

function clustersForTable(clusters: IntersectionCluster[]): IntersectionCluster[] {
  if (elements.stateFilter.value !== "all") {
    return topSortedClusters(clusters, TABLE_ROWS_PER_STATE);
  }

  const selectedByState = new Map<string, IntersectionCluster[]>();
  for (const cluster of clusters) {
    const stateClusters = selectedByState.get(cluster.stateCode) ?? [];
    insertSortedCluster(stateClusters, cluster, TABLE_ROWS_PER_STATE, compareClustersForTable);
    selectedByState.set(cluster.stateCode, stateClusters);
  }
  return Array.from(selectedByState.values()).flat().sort(compareClustersForTable);
}

function topSortedClusters(clusters: IntersectionCluster[], limit: number): IntersectionCluster[] {
  const selected: IntersectionCluster[] = [];
  for (const cluster of clusters) {
    insertSortedCluster(selected, cluster, limit, compareClustersForTable);
  }
  return selected;
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

function compareClustersForTable(a: IntersectionCluster, b: IntersectionCluster): number {
  const primary = compareClusterSortValue(a, b, clusterTableSort.key, clusterTableSort.direction);
  return primary || compareClusterCoreMetric(a, b);
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
    case "severityPercent":
      return cluster.severityPercent;
  }
}

function compareClusterCoreMetric(a: IntersectionCluster, b: IntersectionCluster): number {
  return (
    b.severityPercent - a.severityPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount ||
    clusterLocationText(a).localeCompare(clusterLocationText(b), "de", { sensitivity: "base" })
  );
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

function defaultClusterSortDirection(key: ClusterSortKey): SortDirection {
  return key === "state" || key === "location" ? "asc" : "desc";
}

function updateClusterSortHeaders(): void {
  for (const button of clusterSortButtons()) {
    const key = button.dataset.clusterSort as ClusterSortKey | undefined;
    const active = key === clusterTableSort.key;
    const indicator = button.querySelector<HTMLElement>(".sort-indicator");
    const label = button.querySelector("span")?.textContent?.trim() ?? tr("table.location");
    const header = button.closest("th");
    button.classList.toggle("active", active);
    button.setAttribute(
      "aria-label",
      trf("table.sorted", {
        label,
        direction: active ? tr(clusterTableSort.direction === "asc" ? "table.sort.asc" : "table.sort.desc") : tr("table.sort.none")
      })
    );
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
    elements.nearbyList.append(emptyHotspotMessage(tr("status.noSeverityNearby")));
    return;
  }

  nearby.forEach((entry) => {
    elements.nearbyList.append(
      hotspotButton(entry.cluster, trf("label.away", { distance: formatDistance(entry.distanceMeters) }), { telemetrySource: "nearby hotspot" })
    );
  });
}

function renderStateHotspotList(): void {
  elements.stateHotspotList.innerHTML = "";
  if (!result) {
    elements.stateHotspotList.append(emptyHotspotMessage(tr("status.stateHotspotsPending")));
    return;
  }

  const stateCode = elements.browseState.value;
  const clusters =
    stateCode === "all"
      ? topClusterByState()
      : (result?.clusters ?? [])
          .filter((cluster) => cluster.stateCode === stateCode && cluster.severityPercent >= STATE_BROWSE_MIN_SEVERITY_PERCENT)
          .slice(0, STATE_BROWSE_MAX_INTERSECTIONS);

  if (clusters.length === 0) {
    elements.stateHotspotList.append(emptyHotspotMessage(tr("status.noAnalysisMatches")));
    return;
  }

  clusters.forEach((cluster) => {
    elements.stateHotspotList.append(
      hotspotButton(cluster, stateCode === "all" ? cluster.stateName : clusterLocationText(cluster), {
        metricPlacement: "header",
        telemetrySource: "state hotspot"
      })
    );
  });
}

function topClusterByState(): IntersectionCluster[] {
  return (result?.stateSummaries ?? [])
    .flatMap((summary) => (summary.topCluster ? [summary.topCluster] : []))
    .sort(compareClusterCoreMetric);
}

function hotspotButton(
  cluster: IntersectionCluster,
  context: string,
  options: { metricPlacement?: HotspotMetricPlacement; telemetrySource?: string } = {}
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hotspot-button";
  button.classList.toggle("selected", selectedCluster?.id === cluster.id);
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
        <span class="hotspot-stat hotspot-stat-total"><strong>${formatInteger(cluster.accidentCount)}</strong> ${escapeHtml(accidentCountNoun(cluster.accidentCount))}</span>
        <span class="hotspot-stat"><strong>${formatInteger(cluster.fatalCount)}</strong> ${escapeHtml(tr("severity.fatal").toLowerCase())}</span>
        <span class="hotspot-stat"><strong>${formatInteger(cluster.seriousCount)}</strong> ${escapeHtml(tr("severity.serious").toLowerCase())}</span>
      </span>
    </span>
  `;
  button.addEventListener("click", () => {
    selectClusterOnMap(cluster, options.telemetrySource ?? "hotspot");
  });
  return button;
}

function accidentCountNoun(count: number): string {
  return tr(count === 1 ? "noun.accident.one" : "noun.accident.other");
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
  selectClusterOnMap(nearest.cluster, "nearest hotspot");
  return nearest;
}

function selectClusterOnMap(cluster: IntersectionCluster, telemetrySource = "cluster selection"): void {
  const telemetry = createInteractionTelemetry("select cluster from list", telemetrySource, cluster);
  activeInteractionTelemetry = telemetry;
  measureInteractionStep(telemetry, "ensure severity visible", cluster.id, () => ensureClusterSeverityVisible(cluster), () => ({
    severity: clusterSeverity(cluster),
    fatalCount: cluster.fatalCount,
    seriousCount: cluster.seriousCount
  }));
  measureInteractionStep(telemetry, "set view to map", activeView, () => setView("map"), () => ({ activeView }));
  const frameStep = startInteractionStep(telemetry, "wait for selection animation frame", cluster.id);
  window.requestAnimationFrame(() => {
    finishInteractionStep(frameStep, {});
    try {
      withInteractionTelemetry(telemetry, () => {
        measureInteractionStep(telemetry, "map select, focus, draw, callback", cluster.id, () => map.select(cluster, true), () => ({
          clusterId: cluster.id,
          accidentCount: cluster.accidentCount
        }));
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
    elements.mapView.classList.remove("has-selection");
    elements.selectionDetails.textContent = tr("details.none");
    map.setSelectedIncidentPoints([]);
    updateContextTabs();
    if (activeView === "details") {
      setView("map");
    } else {
      updateStreetViewPanel();
    }
    return;
  }

  elements.selectedAside.hidden = false;
  elements.mapView.classList.add("has-selection");
  const urls = measureActiveInteractionStep(
    "build selected external URLs",
    cluster.id,
    () => ({
      openStreetMapUrl: openStreetMapUrlForCluster(cluster),
      googleMapsUrl: googleMapsUrlForCluster(cluster),
      streetViewUrl: googleStreetViewUrl(cluster),
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
  const pressSearchUrl = measureActiveInteractionStep("build press search URL", cluster.id, () =>
    pressSearchUrlForCluster(cluster, accidentRecords)
  );
  const streetNames = measureActiveInteractionStep(
    "derive selected street names",
    cluster.id,
    () => clusterStreetNamesForDisplay(cluster, accidentRecords),
    (names) => ({ streetCount: names.length })
  );
  const trendPanel = measureActiveInteractionStep("render trend panel html", cluster.id, () => renderTrendPanel(cluster));
  const roadUserPanel = measureActiveInteractionStep(
    "render road-user panel html",
    cluster.id,
    () => renderRoadUserPanel(accidentRecords),
    () => ({ recordCount: accidentRecords.length })
  );
  const recordPanel = measureActiveInteractionStep(
    "render accident record list html",
    cluster.id,
    () => renderSidebarAccidentRecords(accidentRecords, cluster.accidentCount, streetNames, accidentRecordSnapshot.loading),
    () => ({ recordCount: accidentRecords.length })
  );
  measureActiveInteractionStep(
    "update selected incident points",
    cluster.id,
    () =>
      map.setSelectedIncidentPoints(
        accidentRecords.map(({ accident }, index) => ({
          lat: accident.lat,
          lon: accident.lon,
          label: String(index + 1)
        }))
      ),
    () => ({ pointCount: accidentRecords.length })
  );

  const detailsHtml = measureActiveInteractionStep("build selected panel html", cluster.id, () => `
      <dl>
        <div><dt>${escapeHtml(tr("details.state"))}</dt><dd>${escapeHtml(cluster.stateName)}</dd></div>
        ${cluster.administrativeRegionName ? `<div><dt>${escapeHtml(tr("details.adminRegion"))}</dt><dd>${escapeHtml(cluster.administrativeRegionName)}</dd></div>` : ""}
        ${cluster.districtName ? `<div><dt>${escapeHtml(tr("details.district"))}</dt><dd>${escapeHtml(cluster.districtName)}</dd></div>` : ""}
        ${cluster.municipalityName ? `<div><dt>${escapeHtml(tr("details.municipality"))}</dt><dd>${escapeHtml(cluster.municipalityName)}</dd></div>` : ""}
        ${renderClusterStreetDetailRow(streetNames)}
        <div><dt>${escapeHtml(tr("details.coordinates"))}</dt><dd>${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}</dd></div>
        <div><dt>${escapeHtml(tr("details.years"))}</dt><dd>${escapeHtml(formatYearSelection(cluster.years))}</dd></div>
        <div><dt>${escapeHtml(tr("details.accidents"))}</dt><dd>${formatInteger(cluster.accidentCount)}</dd></div>
        <div><dt>${escapeHtml(tr("details.fatalSerious"))}</dt><dd>${formatInteger(cluster.fatalCount)} / ${formatInteger(cluster.seriousCount)}</dd></div>
        <div><dt>${escapeHtml(tr("details.severityPercent"))}</dt><dd>${escapeHtml(formatSeverityPercentWithContext(cluster))}</dd></div>
      </dl>
      ${renderMapServiceActions(urls.openStreetMapUrl, urls.googleMapsUrl, urls.streetViewUrl)}
      ${renderSelectedWorkflowActions(urls.authoritySearchUrl, pressSearchUrl)}
      ${trendPanel}
      ${roadUserPanel}
      ${recordPanel}
    `);
  measureActiveInteractionStep("apply selected panel html", cluster.id, () => {
    elements.selectionDetails.innerHTML = detailsHtml;
  });
  measureActiveInteractionStep("update details tabs", cluster.id, updateContextTabs);
  measureActiveInteractionStep("update street view panel", cluster.id, updateStreetViewPanel, () => ({
    streetViewOpen: isStreetViewOpen
  }));
  if (accidentRecordSnapshot.loading) {
    queueSelectedAccidentRecordsLoad(cluster);
  }
}

function renderClusterStreetDetailRow(streetNames: string[]): string {
  if (streetNames.length === 0) {
    return "";
  }
  return `<div><dt>${escapeHtml(clusterStreetLabel(streetNames))}</dt><dd>${escapeHtml(formatClusterStreetNames(streetNames))}</dd></div>`;
}

function clusterStreetNamesForDisplay(cluster: IntersectionCluster, records: CrossingAccident[] = []): string[] {
  const storedNames = uniqueStreetNames(Array.isArray(cluster.streetNames) ? cluster.streetNames : []);
  return storedNames.length > 0 ? storedNames : uniqueStreetNames(records.flatMap(({ accident }) => accidentStreetNamesForDisplay(accident)));
}

function accidentStreetNamesForDisplay(accident: AccidentRecord): string[] {
  return uniqueStreetNames(Array.isArray(accident.streetNames) && accident.streetNames.length > 0 ? accident.streetNames : [accident.streetName]);
}

function uniqueStreetNames(values: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLocaleLowerCase("de");
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function clusterStreetLabel(streetNames: string[]): string {
  return streetNames.length === 1 ? tr("details.street") : tr("details.streets");
}

function formatClusterStreetNames(streetNames: string[]): string {
  return streetNames.join(STREET_NAME_SEPARATOR);
}

function formatAccidentStreetNames(accident: AccidentRecord, streetOrder: string[] = []): string | null {
  const streetNames = orderStreetNamesForCrossing(accidentStreetNamesForDisplay(accident), streetOrder);
  return streetNames.length > 0 ? formatClusterStreetNames(streetNames) : null;
}

function orderStreetNamesForCrossing(streetNames: string[], streetOrder: string[]): string[] {
  if (streetNames.length < 2 || streetOrder.length === 0) {
    return streetNames;
  }

  const rankByName = new Map(streetOrder.map((name, index) => [streetNameSortKey(name), index]));
  return streetNames.slice().sort((a, b) => {
    const aRank = rankByName.get(streetNameSortKey(a)) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankByName.get(streetNameSortKey(b)) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.localeCompare(b, "de", { sensitivity: "base" });
  });
}

function streetNameSortKey(name: string): string {
  return name.toLocaleLowerCase("de");
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

function openStreetMapUrlForCluster(cluster: IntersectionCluster): string {
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

function googleMapsUrlForCluster(cluster: IntersectionCluster): string {
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function googleStreetViewEmbedUrl(cluster: IntersectionCluster): string {
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  return `https://www.google.com/maps?layer=c&cbll=${lat},${lon}&cbp=11,0,0,0,0&output=svembed`;
}

function googleStreetViewUrl(cluster: IntersectionCluster): string {
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
}

function responsibleAuthoritySearchUrlForCluster(cluster: IntersectionCluster): string {
  const queryParts = [
    "zuständige Straßenverkehrsbehörde",
    "Unfallkommission",
    "Verkehrssicherheit",
    "Unfallhäufungsstelle",
    "Kreuzung",
    cluster.municipalityName,
    cluster.districtName,
    cluster.administrativeRegionName,
    cluster.stateName,
    `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`
  ].filter((part): part is string => Boolean(part));
  return `https://www.google.com/search?q=${encodeURIComponent(queryParts.join(" "))}`;
}

function pressSearchUrlForCluster(cluster: IntersectionCluster, records: CrossingAccident[]): string {
  const latestRecord = records[0]?.accident ?? null;
  const queryParts = [
    "Unfall",
    cluster.fatalCount > 0 ? "toedlicher Unfall" : cluster.seriousCount > 0 ? "schwer verletzt" : "Verkehrsunfall",
    latestRecord ? accidentSearchDateLabel(latestRecord) : null,
    pressSearchPlaceName(cluster)
  ].filter((part): part is string => Boolean(part));
  return googleSearchUrl(queryParts);
}

function pressSearchUrlForAccident(accident: AccidentRecord): string {
  const queryParts = [
    "Unfall",
    pressSeveritySearchTerm(accident),
    accidentSearchDateLabel(accident),
    pressSearchPlaceName(accident)
  ].filter((part): part is string => Boolean(part));
  return googleSearchUrl(queryParts);
}

function googleSearchUrl(queryParts: string[]): string {
  return `https://www.google.com/search?q=${encodeURIComponent(queryParts.join(" "))}`;
}

function pressSearchPlaceName(location: {
  municipalityName: string | null;
  districtName: string | null;
  administrativeRegionName: string | null;
  stateName: string;
}): string {
  return location.municipalityName ?? location.districtName ?? location.administrativeRegionName ?? location.stateName;
}

function accidentSearchDateLabel(accident: AccidentRecord): string {
  if (accident.year && accident.month && accident.day) {
    return `${String(accident.day).padStart(2, "0")}.${String(accident.month).padStart(2, "0")}.${accident.year}`;
  }
  if (accident.year && accident.month) {
    return `${String(accident.month).padStart(2, "0")}.${accident.year}`;
  }
  return accident.year ? String(accident.year) : "";
}

function pressSeveritySearchTerm(accident: AccidentRecord): string {
  switch (accident.category) {
    case 1:
      return "toedlicher Unfall";
    case 2:
      return "schwer verletzt";
    case 3:
      return "leicht verletzt";
    default:
      return "Verkehrsunfall";
  }
}

function scheduleMapRefresh(): void {
  window.requestAnimationFrame(() => {
    if (mobileLayout.matches && activeView !== "map") {
      return;
    }
    map.refresh();
  });
}

function renderMapServiceActions(
  openStreetMapUrl: string,
  googleMapsUrl: string,
  streetViewUrl: string
): string {
  return `
    <div class="selected-map-actions" aria-label="${escapeHtml(tr("aria.openMapServices"))}">
      ${mapServiceLink(openStreetMapUrl, tr("map.openOsm"), tr("map.labelOsm"))}
      ${mapServiceLink(googleMapsUrl, tr("map.openGoogleMaps"), tr("map.labelGoogleMaps"))}
      ${mapServiceLink(streetViewUrl, tr("map.openStreetView"), tr("map.labelStreetView"))}
    </div>
  `;
}

function mapServiceLink(url: string, accessibleLabel: string, visibleLabel: string): string {
  const label = escapeHtml(accessibleLabel);
  return `<a class="map-service-link" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${label}" title="${label}">${escapeHtml(visibleLabel)}</a>`;
}

function renderSelectedWorkflowActions(authoritySearchUrl: string, pressSearchUrl: string): string {
  return `
    <div class="selected-workflow-actions">
      <button class="map-service-link factsheet-button" type="button" data-selected-action="factsheet" aria-label="${escapeHtml(tr("action.downloadFactsheet"))}" title="${escapeHtml(tr("action.downloadFactsheet"))}">
        ${escapeHtml(tr("action.labelFactsheet"))}
      </button>
      ${mapServiceLink(authoritySearchUrl, tr("map.searchResponsibleAuthority"), tr("map.labelResponsibleAuthority"))}
      ${mapServiceLink(pressSearchUrl, tr("press.searchIntersection"), tr("press.label"))}
    </div>
  `;
}

function renderAccidentActionLinks(accident: AccidentRecord): string {
  return `
    <div class="accident-record-actions">
      <a href="${escapeHtml(pressSearchUrlForAccident(accident))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tr("press.searchIncident"))}" title="${escapeHtml(tr("press.searchIncident"))}">
        ${escapeHtml(tr("press.label"))}
      </a>
    </div>
  `;
}

function renderSidebarAccidentRecords(records: CrossingAccident[], totalCount: number, streetOrder: string[] = [], isLoading = false): string {
  const countText = trf("records.countOf", { shown: formatInteger(records.length), total: formatInteger(totalCount) });
  if (records.length === 0) {
    const emptyMessage = isLoading ? tr("records.loading") : tr("records.empty");
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

  const items = records
    .map(({ accident, distanceMeters }, index) => {
      const severity = accidentSeverity(accident);
      const recordNumber = String(index + 1);
      const actionLinks = renderAccidentActionLinks(accident);
      const rows = accidentRecordRows(accident, distanceMeters, streetOrder)
        .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
        .join("");
      return `
        <li class="accident-record-item">
          <div class="accident-record-topline">
            <span class="accident-record-number" aria-label="${escapeHtml(trf("records.incidentNumber", { number: recordNumber }))}">${recordNumber}</span>
            <span class="severity-pill severity-${severity}">${accidentSeverityLabel(accident)}</span>
            <strong>${escapeHtml(accidentTimeLabel(accident))}</strong>
            ${actionLinks}
          </div>
          <dl class="accident-record-fields">${rows}</dl>
        </li>
      `;
    })
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

function accidentRecordRows(
  accident: AccidentRecord,
  distanceMeters: number,
  streetOrder: string[] = []
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  addRecordRow(rows, tr("records.category"), codeLabel(accident.category, ACCIDENT_CATEGORY_LABELS));
  addRecordRow(rows, tr("records.kind"), codeLabel(accident.accidentKind, ACCIDENT_KIND_LABELS));
  addRecordRow(rows, tr("records.type"), codeLabel(accident.accidentType, ACCIDENT_TYPE_LABELS));
  addRecordRow(rows, tr("records.light"), codeLabel(accident.lightCondition, LIGHT_CONDITION_LABELS));
  addRecordRow(rows, tr("records.surface"), codeLabel(accident.roadSurface, ROAD_SURFACE_LABELS));
  addRecordRow(rows, tr("records.street"), formatAccidentStreetNames(accident, streetOrder));
  addRecordRow(rows, tr("records.roadUsers"), roadUsersLabel(accident));
  addRecordRow(rows, tr("records.area"), administrativeAreaLabel(accident));
  addRecordRow(rows, tr("records.coordinates"), `${accident.lat.toFixed(6)}, ${accident.lon.toFixed(6)}`);
  addRecordRow(rows, "LINREF", linRefLabel(accident));
  addRecordRow(rows, tr("records.locationCheck"), codeLabel(accident.plausibilityLevel, PLAUSIBILITY_LEVEL_LABELS));
  addRecordRow(rows, tr("records.distance"), `${formatInteger(Math.round(distanceMeters))} m`);
  addRecordRow(rows, tr("records.recordId"), recordIdLabel(accident));
  addRecordRow(rows, tr("records.source"), accident.source);
  return rows;
}

function addRecordRow(rows: Array<{ label: string; value: string }>, label: string, value: string | null): void {
  if (value) {
    rows.push({ label, value });
  }
}

function clusterAccidentRecordsSnapshot(cluster: IntersectionCluster): ClusterAccidentRecordsSnapshot {
  const sourceRecords = cachedAccidentRecordsForCluster(cluster);
  if (sourceRecords) {
    return {
      records: clusterAccidentRecords(cluster, sourceRecords),
      loading: false
    };
  }

  return {
    records: [],
    loading: hasAccidentStateShard(cluster.stateCode)
  };
}

function cachedAccidentRecordsForCluster(cluster: IntersectionCluster): AccidentRecord[] | null {
  if (accidents.length > 0) {
    return accidents;
  }
  return accidentStateRecords.get(cluster.stateCode) ?? null;
}

function hasAccidentStateShard(stateCode: string): boolean {
  const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
  return Boolean(
    bundle?.accidentShardFiles?.some((entry) => entry.stateCode === stateCode) ||
      bundle?.accidentChunkFiles?.length ||
      bundle?.accidentChunks?.length
  );
}

function queueSelectedAccidentRecordsLoad(cluster: IntersectionCluster): void {
  const requestId = ++selectedAccidentRecordsRequestId;
  void loadAccidentsForState(cluster.stateCode)
    .then(() => {
      if (selectedCluster?.id !== cluster.id || requestId !== selectedAccidentRecordsRequestId) {
        return;
      }
      renderSelection(cluster);
    })
    .catch((error) => {
      if (selectedCluster?.id === cluster.id) {
        console.warn("[Safe Intersections] Could not load selected accident records.", error);
      }
    });
}

async function clusterAccidentRecordsReady(cluster: IntersectionCluster): Promise<CrossingAccident[]> {
  const sourceRecords = cachedAccidentRecordsForCluster(cluster) ?? (await loadAccidentsForState(cluster.stateCode));
  return clusterAccidentRecords(cluster, sourceRecords);
}

function clusterAccidentRecords(cluster: IntersectionCluster, sourceRecords: AccidentRecord[] = accidents): CrossingAccident[] {
  if (sourceRecords.length === 0) {
    return [];
  }

  const exactRecords = exactClusterAccidentRecords(cluster, sourceRecords);
  if (exactRecords.length > 0) {
    return exactRecords.sort(compareCrossingAccidents);
  }

  const options = activeAnalysisOptions ?? readOptions();
  const searchRadiusMeters = clusterAccidentSearchRadius(options);
  const index = accidentIndexForCrossings(options, searchRadiusMeters, sourceRecords);
  const candidates = index
    .nearby(cluster)
    .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }))
    .filter((entry) => entry.distanceMeters <= searchRadiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return pickClusterAccidents(candidates, cluster).sort(compareCrossingAccidents);
}

function exactClusterAccidentRecords(cluster: IntersectionCluster, sourceRecords: AccidentRecord[]): CrossingAccident[] {
  const indexedRecords = exactClusterAccidentRecordsByIndex(cluster, sourceRecords);
  if (indexedRecords.length > 0) {
    return indexedRecords;
  }

  if (!cluster.accidentKeys?.length) {
    return [];
  }

  const lookup = accidentKeyLookup(sourceRecords);
  return cluster.accidentKeys
    .map((key) => lookup.get(key))
    .filter((accident): accident is AccidentRecord => Boolean(accident))
    .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) }));
}

function exactClusterAccidentRecordsByIndex(cluster: IntersectionCluster, sourceRecords: AccidentRecord[]): CrossingAccident[] {
  const indexes = cluster.accidentIndexes;
  if (!indexes?.length) {
    return [];
  }

  const lookup = accidentRecordIndexLookup(sourceRecords);
  return measureActiveInteractionStep(
    "read indexed accident records",
    cluster.id,
    () =>
      indexes
        .map((index) => lookup.get(index))
        .filter((accident): accident is AccidentRecord => Boolean(accident))
        .map((accident) => ({ accident, distanceMeters: distanceMeters(cluster, accident) })),
    (records) => ({
      recordCount: records.length,
      indexCount: indexes.length
    })
  );
}

function accidentRecordIndexLookup(sourceRecords: AccidentRecord[]): Map<number, AccidentRecord> {
  if (accidentRecordIndexLookupCache?.source === sourceRecords) {
    return accidentRecordIndexLookupCache.map;
  }

  const map = new Map<number, AccidentRecord>();
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const accident = sourceRecords[index];
    map.set(accident.recordIndex ?? index, accident);
  }
  accidentRecordIndexLookupCache = { source: sourceRecords, map };
  return map;
}

function accidentKeyLookup(sourceRecords: AccidentRecord[] = accidents): Map<string, AccidentRecord> {
  if (accidentKeyLookupCache?.source === sourceRecords) {
    return accidentKeyLookupCache.map;
  }

  return measureActiveInteractionStep(
    "build accident key lookup",
    "all accident records",
    () => buildAccidentKeyLookup(sourceRecords),
    (map) => ({
      accidentCount: sourceRecords.length,
      recordCount: map.size
    })
  );
}

function buildAccidentKeyLookup(sourceRecords: AccidentRecord[]): Map<string, AccidentRecord> {
  const map = new Map<string, AccidentRecord>();
  for (const accident of sourceRecords) {
    map.set(accidentKey(accident), accident);
  }
  accidentKeyLookupCache = { source: sourceRecords, map };
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

function accidentIndexForCrossings(
  options: AnalysisOptions,
  searchRadiusMeters: number,
  sourceRecords: AccidentRecord[] = accidents
): GeoGridIndex<AccidentRecord> {
  const key = analysisOptionsIndexKey(options, searchRadiusMeters);
  if (crossingAccidentIndexCache?.key === key && crossingAccidentIndexCache.source === sourceRecords) {
    return crossingAccidentIndexCache.index;
  }

  const index = new GeoGridIndex<AccidentRecord>(searchRadiusMeters);
  for (const accident of sourceRecords) {
    if (accidentMatchesAnalysisOptions(accident, options)) {
      index.insert(accident);
    }
  }
  crossingAccidentIndexCache = { key, source: sourceRecords, index };
  return index;
}

function accidentMatchesAnalysisOptions(accident: AccidentRecord, options: AnalysisOptions): boolean {
  if (options.years.size > 0 && !options.years.has(accident.year)) {
    return false;
  }
  if (options.stateCode !== "all" && accident.stateCode !== options.stateCode) {
    return false;
  }
  return accidentMatchesRoadUserFocus(accident, options.roadUserFocus);
}

function analysisOptionsIndexKey(options: AnalysisOptions, searchRadiusMeters: number): string {
  return [
    options.stateCode,
    options.clusterRadiusMeters,
    searchRadiusMeters,
    [...options.years].sort((a, b) => a - b).join(","),
    roadUserFocusKey(options.roadUserFocus) || "all"
  ].join("|");
}

function clusterAccidentSearchRadius(options: AnalysisOptions): number {
  return Math.max(150, options.clusterRadiusMeters * 3);
}

function compareCrossingAccidents(a: CrossingAccident, b: CrossingAccident): number {
  return (
    b.accident.year - a.accident.year ||
    (b.accident.month ?? 0) - (a.accident.month ?? 0) ||
    (b.accident.day ?? 0) - (a.accident.day ?? 0) ||
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
    return tr("severity.fatal");
  }
  if (accident.category === 2) {
    return tr("severity.serious");
  }
  if (accident.category === 3) {
    return tr("severity.light");
  }
  return accident.category === null ? tr("severity.unknown") : trf("records.categoryNumber", { category: accident.category });
}

function accidentTimeLabel(accident: AccidentRecord): string {
  const parts = [accident.year ? String(accident.year) : tr("records.unknownYear")];
  if (accident.month) {
    parts.push(accident.day ? `${monthLabel(accident.month)} ${formatInteger(accident.day)}` : `${monthLabel(accident.month)} (${tr("records.dayNotProvided")})`);
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
  return tr(`month.${month}`);
}

function weekdayLabel(weekday: number): string {
  return tr(`weekday.${weekday}`);
}

function codeLabel(value: number | null | undefined, labels: Record<number, string>): string | null {
  if (typeof value !== "number") {
    return null;
  }
  return `${value} - ${labels[value] ? tr(labels[value]) : tr("records.unknownCode")}`;
}

function roadUsersLabel(accident: AccidentRecord): string {
  const flags: Array<[string, boolean | null]> = ROAD_USER_DEFINITIONS.map((definition) => [
    tr(definition.labelKey),
    definition.read(accident)
  ]);
  const knownFlags = flags.filter((entry): entry is [string, boolean] => entry[1] !== null);
  if (knownFlags.length === 0) {
    return tr("records.noRoadUserFields");
  }
  return knownFlags.map(([label, value]) => `${label}: ${value ? tr("records.yes") : tr("records.no")}`).join("; ");
}

function administrativeAreaLabel(accident: AccidentRecord): string {
  const parts = [`${accident.stateName} (${accident.stateCode})`];
  if (accident.administrativeRegionCode) {
    parts.push(namedCodeLabel(accident.administrativeRegionName, accident.administrativeRegionCode) ?? trf("records.adminRegion", { code: accident.administrativeRegionCode }));
  }
  if (accident.districtCode) {
    parts.push(namedCodeLabel(accident.districtName, accident.districtCode) ?? trf("records.district", { code: accident.districtCode }));
  }
  if (accident.municipalityCode) {
    const municipalityLabel = namedCodeLabel(accident.municipalityName, accident.municipalityCode);
    if (municipalityLabel && accident.municipalityName !== accident.districtName) {
      parts.push(municipalityLabel);
    } else if (!municipalityLabel && !hasEquivalentDistrictMunicipalityCode(accident)) {
      parts.push(trf("records.municipality", { code: accident.municipalityCode }));
    }
  }
  return parts.join(", ");
}

function namedCodeLabel(name: string | null, code: string | null): string | null {
  return name && code ? `${name} (${code})` : null;
}

function hasEquivalentDistrictMunicipalityCode(accident: AccidentRecord): boolean {
  return Boolean(
    accident.districtName &&
      accident.districtCode &&
      accident.municipalityCode &&
      normalizeCodePart(accident.municipalityCode, 3).endsWith(normalizeCodePart(accident.districtCode, 2))
  );
}

function normalizeCodePart(value: string, width: number): string {
  return value.trim().replace(/\D/g, "").padStart(width, "0").slice(-width);
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
    parts.push(trf("records.serial", { serial: accident.serialNumber }));
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
  const relativeSlope = trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}${tr("unit.perYear")}`;
  const latestAccidents = [...series].reverse().find((point) => point.accidentCount > 0)?.accidentCount ?? 0;

  return `
    <section class="trend-panel" aria-label="${escapeHtml(tr("trend.aria"))}">
      <div class="trend-summary">
        <span>${escapeHtml(tr("trend.title"))}</span>
        <strong class="trend-value ${trendClassName(trend.direction)}">${trendLabel}${relativeSlope}</strong>
        <small>${escapeHtml(trf("trend.latest", { count: formatInteger(latestAccidents) }))}</small>
      </div>
      ${renderTrendChart(series, trend.direction)}
      <div class="trend-legend">
        <span class="legend-accidents">${escapeHtml(tr("trend.legend.accidents"))}</span>
      </div>
      <p class="trend-note">${escapeHtml(tr("trend.note"))}</p>
    </section>
  `;
}

function renderRoadUserPanel(records: CrossingAccident[]): string {
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
        >${roadUserIcon(item.definition.key)}</span>
      `;
    })
    .join("");
  const legend = items
    .map(
      (item) => `
        <span class="road-user-legend-item road-user-${item.definition.key}">
          ${roadUserIcon(item.definition.key)}
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

function roadUserSummaryItems(records: CrossingAccident[]): RoadUserSummaryItem[] {
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

function roadUserIcon(key: RoadUserKey): string {
  switch (key) {
    case "car":
      return svgRoadUserIcon(
        '<path d="M5 16h14l-1.4-5.2A2.4 2.4 0 0 0 15.3 9H8.7a2.4 2.4 0 0 0-2.3 1.8L5 16Z"></path><path d="M7 16v2m10-2v2"></path><circle cx="8" cy="16" r="1.2"></circle><circle cx="16" cy="16" r="1.2"></circle><path d="M7.2 12h9.6"></path>'
      );
    case "pedestrian":
      return svgRoadUserIcon(
        '<circle cx="12" cy="5" r="2"></circle><path d="M12 7v6m0 0-4 7m4-7 4 7m-5-9-4 2m5-2 4 2"></path>'
      );
    case "bicycle":
      return svgRoadUserIcon(
        '<circle cx="6" cy="17" r="3"></circle><circle cx="18" cy="17" r="3"></circle><path d="M8.5 17 11 11h3l2 6m-5-6-2-3m5 3 3-2m-6 2 5 6"></path>'
      );
    case "motorcycle":
      return svgRoadUserIcon(
        '<circle cx="6" cy="17" r="3"></circle><circle cx="18" cy="17" r="3"></circle><path d="M7 17h5l2.5-4H18l2 4m-8-4-2-3h3m2 0h3"></path>'
      );
    case "truck":
      return svgRoadUserIcon(
        '<path d="M3 8h11v8H3Z"></path><path d="M14 11h4l3 3v2h-7Z"></path><circle cx="7" cy="17" r="1.5"></circle><circle cx="17" cy="17" r="1.5"></circle>'
      );
    case "other":
      return svgRoadUserIcon('<path d="M12 3 21 8v8l-9 5-9-5V8l9-5Z"></path><path d="M12 9v3"></path><path d="M12 16h.01"></path>');
  }
}

function svgRoadUserIcon(paths: string): string {
  return `<svg class="road-user-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
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

  const chart = { left: 38, top: 12, width: 218, height: 80, bottom: 92 };
  const maxAccidents = Math.max(1, ...series.map((point) => point.accidentCount));
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
  const yearLabels = plotted
    .map((point) => `<text class="chart-year" x="${round(point.x, 1)}" y="126">${point.year}</text>`)
    .join("");
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
      trf("trend.chartAria", { direction: trendDirectionLabel(direction).toLowerCase() })
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

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
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
      return tr("trend.falling");
    case "rising":
      return tr("trend.rising");
    case "stable":
      return tr("trend.stable");
    case "unknown":
      return tr("trend.unknown");
  }
}

function trendClassName(direction: AccidentTrendDirection): string {
  return `trend-${direction}`;
}

function setView(view: ViewKey): void {
  if (view === "details" && !selectedCluster) {
    setStatus(tr("details.selectFirst"), 100);
    view = "map";
  }

  activeView = view;
  elements.app.dataset.activeView = view;

  const tabs = [
    { key: "explore", tab: elements.exploreTab },
    { key: "map", tab: elements.mapTab },
    { key: "details", tab: elements.detailsTab },
    { key: "state", tab: elements.stateTab },
    { key: "state", tab: elements.mobileStateTab },
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
  elements.tableView.classList.toggle("active", view === "table");
  elements.settingsView.classList.toggle("active", view === "settings");

  updateContextTabs();
  updateStreetViewPanel();
  setMobileMoreMenuOpen(false);
  scheduleMapRefresh();
}

function updateContextTabs(): void {
  const hasSelection = selectedCluster !== null;
  elements.detailsTab.disabled = !hasSelection;
}

function isMobilePaneView(view: ViewKey): boolean {
  return view === "explore" || view === "details";
}

function isSecondaryView(view: ViewKey): boolean {
  return view === "state" || view === "table" || view === "settings";
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
  return mobileLayout.matches ? "explore" : "map";
}

function updateRangeOutputs(): void {
  elements.clusterRadiusOut.value = elements.clusterRadius.value;
}

async function resetApp(): Promise<void> {
  setBusy(true);
  setStatus(tr("status.resettingApp"), 0);
  try {
    await resetAppStorage();
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
    "district",
    "municipality",
    "lat",
    "lon",
    "accidents",
    "fatal",
    "serious",
    "severity_percent"
  ];
  const rows = result.clusters.map((cluster) =>
    [
      cluster.stateName,
      cluster.administrativeRegionName ?? "",
      cluster.districtName ?? "",
      cluster.municipalityName ?? "",
      cluster.lat,
      cluster.lon,
      cluster.accidentCount,
      cluster.fatalCount,
      cluster.seriousCount,
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

async function downloadSelectedFactsheet(): Promise<void> {
  const cluster = selectedCluster;
  if (!cluster) {
    setStatus(tr("details.selectFirst"), 100, "idle");
    return;
  }

  const factsheetButtons = selectedFactsheetButtons();
  factsheetButtons.forEach((button) => {
    button.disabled = true;
  });
  setStatus(tr("status.factsheetCreating"), 100);
  try {
    const records = await clusterAccidentRecordsReady(cluster);
    const blob = await createFactsheetPdf(cluster, records);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = factsheetFileName(cluster);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(tr("status.factsheetDownloaded"), 100);
  } catch (error) {
    setStatus(trf("status.factsheetFailed", { error: errorMessage(error) }), 100, "problem");
  } finally {
    factsheetButtons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function selectedFactsheetButtons(): HTMLButtonElement[] {
  return Array.from(elements.selectionDetails.querySelectorAll<HTMLButtonElement>("[data-selected-action='factsheet']"));
}

async function createFactsheetPdf(cluster: IntersectionCluster, records: CrossingAccident[]): Promise<Blob> {
  const layout = createFactsheetLayout();
  await drawFactsheetOverview(layout, cluster, records);
  drawFactsheetAccidentDetails(layout, cluster, records);
  drawFactsheetPageFooters(layout);
  const pages = layout.pages.map((canvas, pageIndex): FactsheetPdfPage => ({
    jpegBytes: dataUrlBytes(canvas.toDataURL("image/jpeg", 0.9)),
    width: canvas.width,
    height: canvas.height,
    links: layout.links.filter((link) => link.pageIndex === pageIndex),
    textSpans: layout.textSpans.filter((span) => span.pageIndex === pageIndex)
  }));
  return createImagePagesPdf(pages);
}

function createFactsheetLayout(): FactsheetLayout {
  const { canvas, context } = createFactsheetPage();
  return {
    pages: [canvas],
    context,
    y: FACTSHEET_MARGIN,
    links: [],
    textSpans: []
  };
}

function createFactsheetPage(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = FACTSHEET_PAGE_WIDTH;
  canvas.height = FACTSHEET_PAGE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "alphabetic";
  return { canvas, context };
}

function addFactsheetPage(layout: FactsheetLayout): void {
  const { canvas, context } = createFactsheetPage();
  layout.pages.push(canvas);
  layout.context = context;
  layout.y = FACTSHEET_MARGIN;
}

function ensureFactsheetSpace(layout: FactsheetLayout, neededHeight: number): void {
  if (layout.y + neededHeight > FACTSHEET_PAGE_HEIGHT - FACTSHEET_BOTTOM_MARGIN) {
    addFactsheetPage(layout);
  }
}

async function drawFactsheetOverview(layout: FactsheetLayout, cluster: IntersectionCluster, records: CrossingAccident[]): Promise<void> {
  const context = layout.context;
  context.fillStyle = "#172126";
  context.font = factsheetFont(40, 600);
  layout.y += 20;
  drawFactsheetLines(
    layout,
    wrappedCanvasLines(context, factsheetTitle(cluster, records), FACTSHEET_CONTENT_WIDTH),
    FACTSHEET_MARGIN,
    46
  );
  layout.y += 8;

  context.fillStyle = "#53636d";
  context.font = factsheetFont(18, 400);
  drawFactsheetText(layout, `${tr("factsheet.generated")}: ${formatDate(new Date())}`, FACTSHEET_MARGIN, layout.y);
  layout.y += 36;

  drawFactsheetSectionHeading(layout, tr("factsheet.location"));
  context.fillStyle = "#172126";
  context.font = factsheetFont(30, 600);
  drawFactsheetLines(layout, wrappedCanvasLines(context, clusterLocationText(cluster), FACTSHEET_CONTENT_WIDTH), FACTSHEET_MARGIN, 35);
  const area = clusterAreaText(cluster);
  if (area) {
    drawFactsheetParagraph(layout, area, 19, 26, "#53636d");
  }
  const streetNames = clusterStreetNamesForDisplay(cluster, records);
  if (streetNames.length > 0) {
    drawFactsheetRows(layout, [[clusterStreetLabel(streetNames), formatClusterStreetNames(streetNames)]]);
  }

  drawFactsheetSectionHeading(layout, tr("factsheet.map"));
  const mapHeight = 470;
  ensureFactsheetSpace(layout, mapHeight + 44);
  await drawFactsheetOsmMap(layout.context, cluster, records, FACTSHEET_MARGIN, layout.y, FACTSHEET_CONTENT_WIDTH, mapHeight);
  layout.y += mapHeight + 16;
  drawFactsheetParagraph(layout, `${tr("factsheet.mapNote")} ${tr("factsheet.mapAttribution")}.`, 18, 25, "#53636d");
  drawFactsheetMapLinksSection(layout, cluster);

  drawFactsheetSectionHeading(layout, tr("factsheet.counts"));
  drawFactsheetRows(layout, [
    [tr("factsheet.period"), factsheetPeriodLabel(cluster, records)],
    [tr("factsheet.total"), formatInteger(cluster.accidentCount)],
    [tr("severity.fatal"), formatInteger(cluster.fatalCount)],
    [tr("severity.serious"), formatInteger(cluster.seriousCount)],
    [tr("factsheet.lightOther"), formatInteger(Math.max(0, cluster.accidentCount - cluster.fatalCount - cluster.seriousCount))],
    [tr("metric.severityPercent"), formatSeverityPercentWithContext(cluster)],
    [tr("factsheet.coordinates"), `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`]
  ]);

  drawFactsheetTrendSection(layout, cluster);
  drawFactsheetRoadUserSection(layout, records);
  drawFactsheetSourceSection(layout);
  drawFactsheetTextSection(layout, tr("factsheet.methodology"), factsheetMethodologyText(cluster));
  drawFactsheetTextSection(layout, tr("factsheet.limitations"), tr("factsheet.limitationsText"));
}

function factsheetTitle(cluster: IntersectionCluster, records: CrossingAccident[]): string {
  const streetNames = clusterStreetNamesForDisplay(cluster, records);
  if (streetNames.length === 0) {
    return tr("factsheet.title");
  }

  return `${tr("factsheet.title")}: ${formatFactsheetTitleStreetNames(streetNames)}`;
}

function formatFactsheetTitleStreetNames(streetNames: string[]): string {
  const displayedNames = streetNames.slice(0, FACTSHEET_TITLE_STREET_LIMIT);
  const remainingCount = streetNames.length - displayedNames.length;
  const suffix =
    remainingCount > 0 ? ` + ${trf("factsheet.titleMoreStreets", { count: formatInteger(remainingCount) })}` : "";
  return `${formatClusterStreetNames(displayedNames)}${suffix}`;
}

function drawFactsheetMapLinksSection(layout: FactsheetLayout, cluster: IntersectionCluster): void {
  drawFactsheetSectionHeading(layout, tr("factsheet.mapLinks"));
  drawFactsheetLinkRow(layout, tr("map.labelOsm"), openStreetMapUrlForCluster(cluster), tr("map.openOsm"));
  drawFactsheetLinkRow(layout, tr("map.labelGoogleMaps"), googleMapsUrlForCluster(cluster), tr("map.openGoogleMaps"));
  drawFactsheetLinkRow(layout, tr("map.labelStreetView"), googleStreetViewUrl(cluster), tr("map.openStreetView"));
}

function drawFactsheetTrendSection(layout: FactsheetLayout, cluster: IntersectionCluster): void {
  const years = result?.years.length ? result.years : cluster.years;
  const series = clusterTrendSeries(cluster, years);
  if (series.length === 0) {
    return;
  }

  drawFactsheetSectionHeading(layout, tr("trend.title"));
  const trend = cluster.accidentTrend;
  const trendLabel = trendDirectionLabel(trend.direction);
  const relativeSlope = trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}${tr("unit.perYear")}`;
  drawFactsheetParagraph(
    layout,
    factsheetTrendSummary(`${trendLabel}${relativeSlope}`, cluster, years),
    19,
    26,
    "#38454b"
  );

  const chartHeight = 250;
  ensureFactsheetSpace(layout, chartHeight + 8);
  drawFactsheetTrendChart(layout, series, FACTSHEET_MARGIN, layout.y, FACTSHEET_CONTENT_WIDTH, chartHeight);
  layout.y += chartHeight + 8;
}

function factsheetTrendSummary(trendText: string, cluster: IntersectionCluster, chartYears: number[]): string {
  const trendYears = chartYears.slice(-Math.max(0, cluster.accidentTrend.years));
  return trf("factsheet.trendSummary", {
    trend: trendText,
    setting: formatInteger(factsheetTrendPeriodSetting(cluster)),
    trendYears: formatYearSelection(trendYears),
    chartYears: formatYearSelection(chartYears)
  });
}

function factsheetMethodologyText(cluster: IntersectionCluster): string {
  const radiusMeters = activeAnalysisOptions?.clusterRadiusMeters ?? Number(elements.clusterRadiusOut.value);
  return trf("factsheet.methodologyTextDetailed", {
    radius: formatDistance(radiusMeters),
    trendYears: formatInteger(factsheetTrendPeriodSetting(cluster))
  });
}

function factsheetTrendPeriodSetting(cluster: IntersectionCluster): number {
  const configuredTrendYears = activeAnalysisOptions?.severityPercent.trendYears ?? cluster.accidentTrend.years;
  return Math.max(2, Math.trunc(Number.isFinite(configuredTrendYears) ? configuredTrendYears : 4));
}

function formatYearSelection(years: number[]): string {
  if (years.length === 0) {
    return tr("trend.unknown").toLowerCase();
  }
  const isContinuous = years.every((year, index) => index === 0 || year === years[index - 1] + 1);
  if (isContinuous && years.length > 1) {
    return `${years[0]}-${years[years.length - 1]}`;
  }
  return years.map(String).join(", ");
}

function drawFactsheetTrendChart(
  layout: FactsheetLayout,
  series: ClusterYearStat[],
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const context = layout.context;
  context.fillStyle = "#f8faf7";
  context.fillRect(x, y, width, height);

  const chart = {
    left: x + 78,
    right: x + width - 34,
    top: y + 32,
    bottom: y + height - 50
  };
  const chartWidth = chart.right - chart.left;
  const chartHeight = chart.bottom - chart.top;
  const maxAccidents = Math.max(1, ...series.map((point) => point.accidentCount));
  const yAxisTicks = uniqueNumbers([0, Math.ceil(maxAccidents / 2), maxAccidents]).sort((a, b) => a - b);

  context.font = factsheetFont(18, 500);
  context.fillStyle = "#53636d";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const value of yAxisTicks) {
    const tickY = chart.bottom - (value / maxAccidents) * chartHeight;
    drawFactsheetText(layout, formatInteger(value), chart.left - 12, tickY);
  }

  context.strokeStyle = "#8fa09a";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(chart.left, chart.top);
  context.lineTo(chart.left, chart.bottom);
  context.stroke();

  const points = series.map((point, index) => {
    const pointX = series.length === 1 ? chart.left + chartWidth / 2 : chart.left + (index / (series.length - 1)) * chartWidth;
    const pointY = chart.bottom - (point.accidentCount / maxAccidents) * chartHeight;
    return { ...point, x: pointX, y: pointY };
  });

  context.strokeStyle = "#166b6d";
  context.lineWidth = 5;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.stroke();

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = factsheetFont(17, 500);
  points.forEach((point) => {
    context.fillStyle = "#166b6d";
    context.beginPath();
    context.arc(point.x, point.y, 7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#53636d";
    drawFactsheetText(layout, String(point.year), point.x, chart.bottom + 34);
  });

  context.textAlign = "start";
  context.textBaseline = "alphabetic";
}

function drawFactsheetRoadUserSection(layout: FactsheetLayout, records: CrossingAccident[]): void {
  drawFactsheetSectionHeading(layout, tr("roadUsers.title"));
  const items = roadUserSummaryItems(records);
  if (items.length === 0) {
    drawFactsheetParagraph(layout, tr("factsheet.noRoadUsers"), 19, 26, "#38454b");
    return;
  }

  ensureFactsheetSpace(layout, 56);
  const context = layout.context;
  const barX = FACTSHEET_MARGIN;
  const barY = layout.y;
  const barHeight = 34;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let currentX = barX;
  for (const item of items) {
    const segmentWidth = Math.max(10, (FACTSHEET_CONTENT_WIDTH * item.count) / total);
    context.fillStyle = roadUserColor(item.definition.key);
    context.fillRect(currentX, barY, segmentWidth, barHeight);
    currentX += segmentWidth;
  }
  layout.y += 56;

  drawFactsheetRows(
    layout,
    items.map((item) => [item.label, `${formatInteger(item.count)} (${formatSharePercent(item.share)})`])
  );
}

function drawFactsheetSourceSection(layout: FactsheetLayout): void {
  drawFactsheetSectionHeading(layout, tr("factsheet.dataSource"));
  const latestDate = latestBundledFileDate();
  const lines = [
    tr("factsheet.accidentSource"),
    tr("factsheet.municipalitySource"),
    tr("factsheet.license"),
    tr("factsheet.publicationUnknown"),
    latestDate ? trf("factsheet.latestBundleDate", { date: formatDate(latestDate) }) : ""
  ].filter(Boolean);
  for (const line of lines) {
    drawFactsheetParagraph(layout, line, 19, 26, "#38454b");
  }
  drawFactsheetRepositoryLink(layout);
}

function drawFactsheetRepositoryLink(layout: FactsheetLayout): void {
  drawFactsheetLinkRow(layout, tr("settings.repository"), PROJECT_REPOSITORY_URL, PROJECT_REPOSITORY_LABEL);
}

function drawFactsheetLinkRow(layout: FactsheetLayout, label: string, url: string, linkLabel = url): void {
  let context = layout.context;
  context.font = factsheetFont(19, 400);
  const prefix = `${label.replace(/:\s*$/, "")}: `;
  const linkX = FACTSHEET_MARGIN + context.measureText(prefix).width;
  const availableWidth = Math.max(220, FACTSHEET_CONTENT_WIDTH - (linkX - FACTSHEET_MARGIN));
  const lineHeight = 26;
  const linkLines = wrappedCanvasLines(context, linkLabel, availableWidth);
  ensureFactsheetSpace(layout, Math.max(1, linkLines.length) * lineHeight + 12);

  context = layout.context;
  const pageIndex = layout.pages.length - 1;
  context.font = factsheetFont(19, 400);
  context.fillStyle = "#38454b";
  drawFactsheetText(layout, prefix, FACTSHEET_MARGIN, layout.y);

  context.fillStyle = "#0b5d87";
  linkLines.forEach((line, index) => {
    const lineY = layout.y + index * lineHeight;
    const lineX = index === 0 ? linkX : FACTSHEET_MARGIN;
    const lineWidth = context.measureText(line).width;
    drawFactsheetText(layout, line, lineX, lineY);
    layout.links.push({
      pageIndex,
      x: lineX,
      y: lineY - 24,
      width: lineWidth,
      height: 34,
      url
    });
  });
  layout.y += Math.max(1, linkLines.length) * lineHeight + 8;
}

function drawFactsheetTextSection(layout: FactsheetLayout, title: string, text: string): void {
  drawFactsheetSectionHeading(layout, title);
  drawFactsheetParagraph(layout, text, 19, 26, "#38454b");
}

function drawFactsheetAccidentDetails(layout: FactsheetLayout, cluster: IntersectionCluster, records: CrossingAccident[]): void {
  drawFactsheetSectionHeading(layout, tr("records.title"));
  if (records.length === 0) {
    drawFactsheetParagraph(layout, tr("records.empty"), 21, 29, "#38454b");
    return;
  }

  const streetOrder = clusterStreetNamesForDisplay(cluster, records);
  records.forEach(({ accident, distanceMeters }, index) => {
    ensureFactsheetSpace(layout, 84);
    if (index > 0) {
      layout.y += 18;
    }
    const context = layout.context;
    context.fillStyle = "#172126";
    context.font = factsheetFont(22, 600);
    const heading = `${index + 1}. ${accidentSeverityLabel(accident)} - ${accidentTimeLabel(accident)}`;
    drawFactsheetLines(layout, wrappedCanvasLines(context, heading, FACTSHEET_CONTENT_WIDTH), FACTSHEET_MARGIN, 29);
    drawFactsheetRows(
      layout,
      accidentRecordRows(accident, distanceMeters, streetOrder).map((row) => [row.label, row.value])
    );
    layout.y += FACTSHEET_INCIDENT_LINK_TOP_GAP;
    drawFactsheetLinkRow(layout, tr("press.label"), pressSearchUrlForAccident(accident), tr("press.searchIncident"));
    layout.y += 16;
  });
}

function drawFactsheetSectionHeading(layout: FactsheetLayout, title: string): void {
  ensureFactsheetSpace(layout, 74);
  if (layout.y > FACTSHEET_MARGIN + 4) {
    layout.y += 12;
  }
  const context = layout.context;
  context.fillStyle = "#172126";
  context.font = factsheetFont(25, 600);
  drawFactsheetText(layout, title, FACTSHEET_MARGIN, layout.y + 22);
  layout.y += 62;
}

function drawFactsheetRows(layout: FactsheetLayout, rows: Array<[string, string]>): void {
  const labelX = FACTSHEET_MARGIN;
  const labelWidth = 280;
  const valueX = labelX + labelWidth + 28;
  const valueWidth = FACTSHEET_CONTENT_WIDTH - labelWidth - 28;
  const lineHeight = 25;

  for (const [label, value] of rows) {
    const context = layout.context;
    context.font = factsheetFont(18, 600);
    const labelLines = wrappedCanvasLines(context, label, labelWidth);
    context.font = factsheetFont(18, 400);
    const valueLines = wrappedCanvasLines(context, value, valueWidth);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    ensureFactsheetSpace(layout, lineCount * lineHeight + 8);

    const drawContext = layout.context;
    drawContext.font = factsheetFont(18, 600);
    drawContext.fillStyle = "#53636d";
    drawCanvasTextLines(layout, drawContext, labelLines, labelX, layout.y + 18, lineHeight);
    drawContext.font = factsheetFont(18, 500);
    drawContext.fillStyle = "#172126";
    drawCanvasTextLines(layout, drawContext, valueLines, valueX, layout.y + 18, lineHeight);
    layout.y += lineCount * lineHeight + 8;
  }
}

function drawFactsheetParagraph(
  layout: FactsheetLayout,
  text: string,
  fontSize: number,
  lineHeight: number,
  color: string,
  maxWidth = FACTSHEET_CONTENT_WIDTH
): void {
  const context = layout.context;
  context.font = factsheetFont(fontSize, 400);
  context.fillStyle = color;
  const lines = wrappedCanvasLines(context, text, maxWidth);
  drawFactsheetLines(layout, lines, FACTSHEET_MARGIN, lineHeight);
  layout.y += 8;
}

function drawFactsheetText(layout: FactsheetLayout, text: string, x: number, y: number): void {
  layout.context.fillText(text, x, y);
  recordFactsheetText(layout, text, x, y);
}

function recordFactsheetText(layout: FactsheetLayout, text: string, x: number, y: number): void {
  if (!text.trim()) {
    return;
  }
  layout.textSpans.push({
    pageIndex: layout.pages.length - 1,
    x,
    y,
    fontSize: factsheetTextFontSize(layout.context.font),
    text
  });
}

function factsheetTextFontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 18;
}

function drawFactsheetLines(layout: FactsheetLayout, lines: string[], x: number, lineHeight: number): void {
  for (const line of lines) {
    const font = layout.context.font;
    const fillStyle = layout.context.fillStyle;
    ensureFactsheetSpace(layout, lineHeight + 4);
    layout.context.font = font;
    layout.context.fillStyle = fillStyle;
    drawFactsheetText(layout, line, x, layout.y);
    layout.y += lineHeight;
  }
}

function drawCanvasTextLines(
  layout: FactsheetLayout,
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number
): void {
  lines.forEach((line, index) => {
    drawFactsheetText(layout, line, x, y + index * lineHeight);
  });
}

function wrappedCanvasLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (context.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  }
  lines.push(line);
  return lines;
}

function factsheetFont(size: number, weight: number): string {
  const safeWeight = Math.min(weight, 600);
  return `${safeWeight} ${size}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function drawFactsheetPageFooters(layout: FactsheetLayout): void {
  layout.pages.forEach((canvas, index) => {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.fillStyle = "#53636d";
    context.font = factsheetFont(17, 400);
    const footerText = `${index + 1} / ${layout.pages.length}`;
    context.fillText(footerText, FACTSHEET_MARGIN, FACTSHEET_PAGE_HEIGHT - 44);
    layout.textSpans.push({
      pageIndex: index,
      x: FACTSHEET_MARGIN,
      y: FACTSHEET_PAGE_HEIGHT - 44,
      fontSize: 17,
      text: footerText
    });
  });
}

async function drawFactsheetOsmMap(
  context: CanvasRenderingContext2D,
  cluster: IntersectionCluster,
  records: CrossingAccident[],
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.fillStyle = "#eef2ef";
  context.fillRect(x, y, width, height);

  const zoom = chooseFactsheetMapZoom(cluster, records, width, height);
  const center = osmWorldPixel(cluster.lon, cluster.lat, zoom);
  const topLeft = { x: center.x - width / 2, y: center.y - height / 2 };
  const tileCount = 2 ** zoom;
  const startTileX = Math.floor(topLeft.x / 256);
  const endTileX = Math.floor((topLeft.x + width) / 256);
  const startTileY = Math.max(0, Math.floor(topLeft.y / 256));
  const endTileY = Math.min(tileCount - 1, Math.floor((topLeft.y + height) / 256));
  let loadedTiles = 0;
  const tileJobs: Array<Promise<{ tileX: number; tileY: number; image: HTMLImageElement | null }>> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const wrappedX = wrapOsmTileX(tileX, tileCount);
      tileJobs.push(loadFactsheetOsmTile(zoom, wrappedX, tileY).then((image) => ({ tileX, tileY, image })));
    }
  }

  const tiles = await Promise.all(tileJobs);
  for (const { tileX, tileY, image } of tiles) {
    if (!image) {
      continue;
    }
    const drawX = x + tileX * 256 - topLeft.x;
    const drawY = y + tileY * 256 - topLeft.y;
    context.drawImage(image, drawX, drawY, 256, 256);
    loadedTiles += 1;
  }

  if (loadedTiles === 0) {
    context.fillStyle = "#53636d";
    context.font = factsheetFont(22, 600);
    context.fillText(tr("factsheet.mapTilesUnavailable"), x + 24, y + 48);
  }

  drawFactsheetOsmMarkers(context, cluster, records, x, y, width, height, zoom, topLeft);
  context.restore();
  drawFactsheetMapAttribution(context, x, y, width, height);
}

function drawFactsheetOsmMarkers(
  context: CanvasRenderingContext2D,
  cluster: IntersectionCluster,
  records: CrossingAccident[],
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
  topLeft: { x: number; y: number }
): void {
  const center = osmWorldPixel(cluster.lon, cluster.lat, zoom);
  const centerX = x + center.x - topLeft.x;
  const centerY = y + center.y - topLeft.y;
  context.fillStyle = "rgba(22, 107, 109, 0.18)";
  context.beginPath();
  context.arc(centerX, centerY, 42, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#166b6d";
  context.beginPath();
  context.arc(centerX, centerY, 10, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#ffffff";
  context.lineWidth = 4;
  context.stroke();

  context.font = factsheetFont(17, 600);
  context.textAlign = "center";
  context.textBaseline = "middle";
  records.forEach(({ accident }, index) => {
    const point = osmWorldPixel(accident.lon, accident.lat, zoom);
    const pointX = x + point.x - topLeft.x;
    const pointY = y + point.y - topLeft.y;
    if (pointX < x || pointX > x + width || pointY < y || pointY > y + height) {
      return;
    }
    const label = String(index + 1);
    const radius = Math.max(11, context.measureText(label).width / 2 + 6);
    context.fillStyle = "#050505";
    context.beginPath();
    context.arc(pointX, pointY, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.fillText(label, pointX, pointY + 1);
  });
  context.textAlign = "start";
  context.textBaseline = "alphabetic";
}

function drawFactsheetMapAttribution(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  const label = tr("factsheet.mapAttribution");
  context.font = factsheetFont(15, 600);
  const labelWidth = context.measureText(label).width + 14;
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.fillRect(x + 8, y + height - 30, labelWidth, 22);
  context.fillStyle = "#1d2d34";
  context.fillText(label, x + 15, y + height - 14);
}

function chooseFactsheetMapZoom(cluster: IntersectionCluster, records: CrossingAccident[], width: number, height: number): number {
  const offsets = records.map(({ accident }) => localMeterOffset(cluster, accident));
  const radiusMeters = Math.max(90, ...offsets.flatMap((offset) => [Math.abs(offset.x), Math.abs(offset.y)])) + 70;
  for (let zoom = 19; zoom >= 10; zoom -= 1) {
    const metersPerPixel = (156_543.03392 * Math.cos(radians(cluster.lat))) / 2 ** zoom;
    if (width * metersPerPixel >= radiusMeters * 2 && height * metersPerPixel >= radiusMeters * 2) {
      return zoom;
    }
  }
  return 10;
}

function osmWorldPixel(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const clampedLat = clampNumber(lat, -85.05112878, 85.05112878);
  const sinLat = Math.sin(radians(clampedLat));
  const scale = 256 * 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

function wrapOsmTileX(x: number, tileCount: number): number {
  return ((x % tileCount) + tileCount) % tileCount;
}

function loadFactsheetOsmTile(zoom: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const key = `${zoom}/${x}/${y}`;
  const cached = factsheetTileCache.get(key);
  if (cached) {
    return cached;
  }

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.referrerPolicy = "origin";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = OSM_TILE_URL_TEMPLATE.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
  });
  factsheetTileCache.set(key, promise);
  return promise;
}

function localMeterOffset(center: { lat: number; lon: number }, point: { lat: number; lon: number }): { x: number; y: number } {
  return {
    x: (point.lon - center.lon) * 111_320 * Math.cos(radians(center.lat)),
    y: (point.lat - center.lat) * 110_540
  };
}

function clusterAreaText(cluster: IntersectionCluster): string {
  return [cluster.stateName, cluster.administrativeRegionName, cluster.districtName, cluster.municipalityName]
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join(", ");
}

function factsheetPeriodLabel(cluster: IntersectionCluster, records: CrossingAccident[]): string {
  const years = uniqueNumbers((records.length ? records.map(({ accident }) => accident.year) : cluster.years).filter(Boolean)).sort((a, b) => a - b);
  if (years.length === 0) {
    return "-";
  }
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

function latestBundledFileDate(): Date | null {
  const files = globalThis.__SICHERE_KNOTEN_DATA__?.files ?? [];
  const timestamps = files
    .map((file) => (file.modifiedTime ? new Date(file.modifiedTime) : null))
    .filter((date): date is Date => date instanceof Date && Number.isFinite(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return timestamps[0] ?? null;
}

function factsheetFileName(cluster: IntersectionCluster): string {
  const slug = clusterLocationText(cluster)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${tr("factsheet.filePrefix")}-${slug || cluster.id}.pdf`;
}

function createImagePagesPdf(pages: FactsheetPdfPage[]): Blob {
  if (pages.length === 0) {
    throw new Error("No factsheet pages were rendered.");
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const encoder = new TextEncoder();
  const push = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const addObject = (id: number, parts: Array<string | Uint8Array>): void => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    parts.forEach(push);
    push("\nendobj\n");
  };
  const pageObjectId = (index: number): number => 3 + index * 3;
  const imageObjectId = (index: number): number => pageObjectId(index) + 1;
  const contentObjectId = (index: number): number => pageObjectId(index) + 2;
  const baseObjectCount = 2 + pages.length * 3;
  const fontObjectId = baseObjectCount + 1;
  let nextAnnotationObjectId = fontObjectId + 1;
  const annotationObjectIds = pages.map((page) => page.links.map(() => nextAnnotationObjectId++));
  const objectCount = nextAnnotationObjectId - 1;

  push("%PDF-1.4\n");
  addObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  addObject(2, [
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(" ")}] /Count ${pages.length} >>`
  ]);
  pages.forEach((page, index) => {
    const pageId = pageObjectId(index);
    const imageId = imageObjectId(index);
    const contentId = contentObjectId(index);
    const imageName = `Im${index}`;
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/${imageName} Do\nQ\n${createPdfTextLayer(page, pageWidth, pageHeight)}`;
    const annotationIds = annotationObjectIds[index];
    const annotations = annotationIds.length > 0 ? ` /Annots [${annotationIds.map((id) => `${id} 0 R`).join(" ")}]` : "";
    addObject(pageId, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R${annotations} >>`
    ]);
    addObject(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\nstream\n`,
      page.jpegBytes,
      "\nendstream"
    ]);
    addObject(contentId, [`<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`]);
  });
  addObject(fontObjectId, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
  pages.forEach((page, pageIndex) => {
    const scaleX = pageWidth / page.width;
    const scaleY = pageHeight / page.height;
    page.links.forEach((link, linkIndex) => {
      const left = link.x * scaleX;
      const right = (link.x + link.width) * scaleX;
      const top = pageHeight - link.y * scaleY;
      const bottom = pageHeight - (link.y + link.height) * scaleY;
      addObject(annotationObjectIds[pageIndex][linkIndex], [
        `<< /Type /Annot /Subtype /Link /Rect [${formatPdfNumber(left)} ${formatPdfNumber(bottom)} ${formatPdfNumber(
          right
        )} ${formatPdfNumber(top)}] /Border [0 0 0] /A << /S /URI /URI ${pdfLiteralString(link.url)} >> >>`
      ]);
    });
  });
  const xrefOffset = length;
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f\r\n`);
  for (let id = 1; id <= objectCount; id += 1) {
    push(`${String(offsets[id]).padStart(10, "0")} 00000 n\r\n`);
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdfBytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pdfBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
}

function createPdfTextLayer(page: FactsheetPdfPage, pageWidth: number, pageHeight: number): string {
  if (page.textSpans.length === 0) {
    return "";
  }

  const scaleX = pageWidth / page.width;
  const scaleY = pageHeight / page.height;
  return page.textSpans
    .map((span) => {
      const x = formatPdfNumber(span.x * scaleX);
      const y = formatPdfNumber(pageHeight - span.y * scaleY);
      const fontSize = formatPdfNumber(span.fontSize * scaleY);
      return `BT\n/F1 ${fontSize} Tf\n3 Tr\n1 0 0 1 ${x} ${y} Tm\n${pdfWinAnsiHexString(span.text)} Tj\nET\n`;
    })
    .join("");
}

function formatPdfNumber(value: number): string {
  return String(round(value, 2));
}

function pdfLiteralString(value: string): string {
  return `(${value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "\\r").replace(/\n/g, "\\n")})`;
}

function pdfWinAnsiHexString(value: string): string {
  const bytes = encodePdfWinAnsi(value);
  return `<${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`;
}

function encodePdfWinAnsi(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    bytes.push(pdfWinAnsiByte(char));
  }
  return bytes;
}

function pdfWinAnsiByte(char: string): number {
  const code = char.codePointAt(0) ?? 63;
  if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
    return code;
  }
  const mapped = PDF_WIN_ANSI_EXTRA_BYTES[code];
  return mapped ?? 63;
}

const PDF_WIN_ANSI_EXTRA_BYTES: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

function dataUrlBytes(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) {
    throw new Error("Could not encode factsheet image.");
  }
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function roadUserColor(key: RoadUserKey): string {
  switch (key) {
    case "car":
      return "#425b70";
    case "pedestrian":
      return "#7c4d12";
    case "bicycle":
      return "#166b6d";
    case "motorcycle":
      return "#8b3f7a";
    case "truck":
      return "#b9392b";
    case "other":
      return "#53636d";
  }
}

function clusterLocation(cluster: IntersectionCluster): string {
  return escapeHtml(clusterLocationText(cluster));
}

function clusterLocationText(cluster: IntersectionCluster): string {
  return cluster.municipalityName ?? cluster.districtName ?? cluster.administrativeRegionName ?? `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
}

function setBusy(isBusy: boolean): void {
  elements.analyzeBtn.disabled = isBusy;
  elements.resetAppBtn.disabled = isBusy;
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
  switch (step) {
    case "cache":
      return tr("loading.title.cache");
    case "parse":
      return tr("loading.title.parse");
    case "analyze":
      return tr("loading.title.analyze");
  }
}

async function ensureBundledDataManifest(telemetry: InitializationTelemetry | null): Promise<EmbeddedDataBundle> {
  const existingBundle = globalThis.__SICHERE_KNOTEN_DATA__;
  if (existingBundle?.version) {
    return existingBundle;
  }

  await measureInitializationStep(
    telemetry,
    "load data manifest",
    "data-manifest.js",
    () => loadOfflineBundleScript("data-manifest.js"),
    (url) => ({
      url,
      automatic: true
    })
  );

  const loadedBundle = globalThis.__SICHERE_KNOTEN_DATA__;
  if (!loadedBundle?.version) {
    throw new Error("Bundled data manifest is missing. Run npm run build so docs/assets contains the generated offline bundle.");
  }
  return loadedBundle;
}

async function loadAccidentData(
  telemetry: InitializationTelemetry | null,
  options: { updateStatus?: boolean } = {}
): Promise<AccidentRecord[]> {
  if (accidents.length > 0) {
    return accidents;
  }
  if (!accidentDataLoadPromise) {
    accidentDataLoadPromise = readBundledAccidents(telemetry, { updateStatus: options.updateStatus ?? true })
      .then((records) => {
        accidents = normalizeAccidentRecordIndexes(records);
        crossingAccidentIndexCache = null;
        accidentKeyLookupCache = null;
        accidentRecordIndexLookupCache = null;
        populateFilters();
        return accidents;
      })
      .catch((error) => {
        accidentDataLoadPromise = null;
        throw error;
      });
  }
  return accidentDataLoadPromise;
}

function bundledDataVersion(): string {
  const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
  if (bundle?.version) {
    return bundle.version;
  }
  if (bundle?.files.length) {
    return `legacy:${bundle.files.map((file) => `${file.path}:${file.size}:${file.modifiedTime ?? ""}`).join("|")}`;
  }
  return "missing-normalized-data";
}

function normalizeAccidentRecordIndexes(records: AccidentRecord[]): AccidentRecord[] {
  if (records.every((record) => typeof record.recordIndex === "number")) {
    return records.sort((a, b) => (a.recordIndex ?? 0) - (b.recordIndex ?? 0));
  }
  for (let index = 0; index < records.length; index += 1) {
    records[index].recordIndex = index;
  }
  return records;
}

async function loadAccidentsForAnalysis(
  options: AnalysisOptions,
  telemetry: InitializationTelemetry | null
): Promise<AccidentRecord[]> {
  if (options.stateCode !== "all") {
    return loadAccidentsForState(options.stateCode, telemetry);
  }
  return loadAccidentData(telemetry, { updateStatus: true });
}

async function loadAccidentsForState(stateCode: string, telemetry: InitializationTelemetry | null = null): Promise<AccidentRecord[]> {
  if (accidents.length > 0) {
    const cachedRecords = accidentStateRecords.get(stateCode);
    if (cachedRecords) {
      return cachedRecords;
    }
    const records = accidents.filter((accident) => accident.stateCode === stateCode);
    accidentStateRecords.set(stateCode, records);
    return records;
  }

  const cachedRecords = accidentStateRecords.get(stateCode);
  if (cachedRecords) {
    return cachedRecords;
  }

  const existingPromise = accidentStateLoadPromises.get(stateCode);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = readBundledAccidentState(stateCode, telemetry)
    .then((records) => {
      accidentStateRecords.set(stateCode, records);
      return records;
    })
    .catch((error) => {
      accidentStateLoadPromises.delete(stateCode);
      throw error;
    });
  accidentStateLoadPromises.set(stateCode, promise);
  return promise;
}

async function readBundledAccidents(
  telemetry: InitializationTelemetry | null,
  options: { updateStatus?: boolean } = {}
): Promise<AccidentRecord[]> {
  const bundle = await ensureBundledDataManifest(telemetry);
  const shardFiles = bundle.accidentShardFiles ?? [];
  if (shardFiles.length > 0) {
    const shardLoadPromises = shardFiles.map((entry) => ensureBundledAccidentShard(entry.fileName, telemetry));
    const loadedAccidents: AccidentRecord[] = [];
    for (let index = 0; index < shardFiles.length; index += 1) {
      const shard = await shardLoadPromises[index];
      const records = await readBundledAccidentRecords(shard, telemetry, shardFiles.length);
      accidentStateRecords.set(shard.stateCode, records);
      loadedAccidents.push(...records);
      if (options.updateStatus ?? true) {
        setStatus(
          trf("status.loadingBundledChunk", { current: index + 1, total: shardFiles.length }),
          Math.min(60, 10 + Math.floor(((index + 1) / shardFiles.length) * 50))
        );
      }
    }

    return loadedAccidents;
  }

  const chunkFiles = bundle.accidentChunkFiles ?? [];
  const preloadedChunks = bundle.accidentChunks ?? [];
  const totalChunks = chunkFiles.length || preloadedChunks.length;
  if (totalChunks === 0) {
    throw new Error("Bundled normalized accident data is missing. Run npm run build so docs/assets contains accidents-*.js.");
  }

  const chunkLoadPromises = chunkFiles.length > 0 ? chunkFiles.map((fileName) => ensureBundledAccidentChunk(fileName, telemetry)) : [];
  const loadedAccidents: AccidentRecord[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = chunkLoadPromises.length > 0 ? await chunkLoadPromises[index] : preloadedChunks[index];
    const records = await readBundledAccidentRecords(chunk, telemetry, totalChunks);
    loadedAccidents.push(...records);
    if (options.updateStatus ?? true) {
      setStatus(
        trf("status.loadingBundledChunk", { current: index + 1, total: totalChunks }),
        Math.min(60, 10 + Math.floor(((index + 1) / totalChunks) * 50))
      );
    }
  }

  return loadedAccidents;
}

async function readBundledAccidentState(stateCode: string, telemetry: InitializationTelemetry | null): Promise<AccidentRecord[]> {
  const bundle = await ensureBundledDataManifest(telemetry);
  const shardInfo = bundle.accidentShardFiles?.find((entry) => entry.stateCode === stateCode);
  if (shardInfo) {
    const shard = await ensureBundledAccidentShard(shardInfo.fileName, telemetry);
    return readBundledAccidentRecords(shard, telemetry, 1);
  }

  const allRecords = await loadAccidentData(telemetry, { updateStatus: true });
  return allRecords.filter((accident) => accident.stateCode === stateCode);
}

async function readBundledAccidentRecords(
  bundlePart: EmbeddedAccidentChunk | EmbeddedAccidentShard,
  telemetry: InitializationTelemetry | null,
  totalParts: number
): Promise<AccidentRecord[]> {
  const isShard = "stateCode" in bundlePart;
  return measureInitializationStep(
    telemetry,
    isShard ? "read normalized accident state shard" : "read normalized accident chunk",
    bundlePart.id,
    async () => {
      const compressed = decodeBase64Chunks(bundlePart.chunks);
      const bytes = gunzipSync(compressed);
      const text = new TextDecoder().decode(bytes);
      const parsed = (JSON.parse(text) as CompactAccidentRecord[]).map(accidentFromCompactRecord);
      await yieldToBrowser();
      return parsed;
    },
    (parsed) => ({
      accidentCount: parsed.length,
      stateCode: isShard ? bundlePart.stateCode : null,
      bytes: bundlePart.size,
      compressedBytes: bundlePart.compressedSize,
      shardCount: isShard ? totalParts : null,
      chunkCount: isShard ? null : totalParts
    })
  );
}

async function readBundledDefaultAnalysis(
  telemetry: InitializationTelemetry | null,
  dataVersion: string,
  analysisCacheVersion: string,
  options: AnalysisOptions
): Promise<AnalysisResult | null> {
  const bundle = globalThis.__SICHERE_KNOTEN_DATA__;
  const fileName = bundle?.defaultAnalysisFile;
  const metadata = bundle?.defaultAnalysisMetadata;
  if (typeof fileName !== "string" || !metadata) {
    recordInitializationStep(telemetry, "skip bundled default analysis", analysisTelemetryDetail(options), {
      reason: "bundled default analysis is missing"
    });
    return null;
  }
  if (!defaultAnalysisMetadataMatches(metadata, dataVersion, analysisCacheVersion, options)) {
    recordInitializationStep(telemetry, "skip bundled default analysis", analysisTelemetryDetail(options), {
      reason: "settings or version mismatch"
    });
    return null;
  }

  try {
    const bundledAnalysis = await ensureBundledDefaultAnalysis(fileName, telemetry);
    if (!defaultAnalysisMetadataMatches(bundledAnalysis.metadata, dataVersion, analysisCacheVersion, options)) {
      recordInitializationStep(telemetry, "skip bundled default analysis", analysisTelemetryDetail(options), {
        reason: "loaded bundle metadata mismatch"
      });
      return null;
    }

    return await measureInitializationStep(
      telemetry,
      "read bundled default analysis",
      bundledAnalysis.id,
      async () => {
        const compressed = decodeBase64Chunks(bundledAnalysis.chunks);
        const bytes = gunzipSync(compressed);
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text) as AnalysisResult;
        await yieldToBrowser();
        return parsed;
      },
      (analysisResult) => ({
        cacheHit: true,
        clusterCount: analysisResult.clusters.length,
        filteredAccidentCount: analysisResult.filteredAccidentCount,
        bytes: bundledAnalysis.size,
        compressedBytes: bundledAnalysis.compressedSize
      })
    );
  } catch (error) {
    console.warn("[Safe Intersections] Could not load bundled default analysis; falling back to runtime analysis.", error);
    recordInitializationStep(telemetry, "skip bundled default analysis", analysisTelemetryDetail(options), {
      reason: errorMessage(error)
    });
    return null;
  }
}

async function ensureBundledDefaultAnalysis(
  fileName: string,
  telemetry: InitializationTelemetry | null
): Promise<EmbeddedDefaultAnalysis> {
  const existingAnalysis = globalThis.__SICHERE_KNOTEN_DATA__?.defaultAnalysis;
  if (existingAnalysis) {
    return existingAnalysis;
  }

  await measureInitializationStep(
    telemetry,
    "load default analysis script",
    fileName,
    () => loadOfflineBundleScript(fileName),
    (url) => ({
      url,
      automatic: true
    })
  );

  const loadedAnalysis = globalThis.__SICHERE_KNOTEN_DATA__?.defaultAnalysis;
  if (!loadedAnalysis) {
    throw new Error(`Bundled default analysis ${fileName} did not register itself.`);
  }
  if (loadedAnalysis.encoding !== "gzip-base64-json-v1") {
    throw new Error(`Bundled default analysis ${fileName} uses unsupported encoding ${loadedAnalysis.encoding}.`);
  }
  return loadedAnalysis;
}

async function ensureBundledAccidentShard(fileName: string, telemetry: InitializationTelemetry | null): Promise<EmbeddedAccidentShard> {
  const existingShard = findBundledAccidentShard(fileName);
  if (existingShard) {
    return existingShard;
  }

  await measureInitializationStep(
    telemetry,
    "load normalized accident state shard script",
    fileName,
    () => loadOfflineBundleScript(fileName),
    (url) => ({
      url,
      automatic: true
    })
  );

  const loadedShard = findBundledAccidentShard(fileName);
  if (!loadedShard) {
    throw new Error(`Bundled accident state shard ${fileName} did not register itself.`);
  }
  return loadedShard;
}

async function ensureBundledAccidentChunk(fileName: string, telemetry: InitializationTelemetry | null): Promise<EmbeddedAccidentChunk> {
  const existingChunk = findBundledAccidentChunk(fileName);
  if (existingChunk) {
    return existingChunk;
  }

  await measureInitializationStep(
    telemetry,
    "load normalized accident chunk script",
    fileName,
    () => loadOfflineBundleScript(fileName),
    (url) => ({
      url,
      automatic: true
    })
  );

  const loadedChunk = findBundledAccidentChunk(fileName);
  if (!loadedChunk) {
    throw new Error(`Bundled accident chunk ${fileName} did not register itself.`);
  }
  return loadedChunk;
}

function findBundledAccidentShard(fileName: string): EmbeddedAccidentShard | null {
  const shardId = fileName.replace(/\.js$/i, "");
  return globalThis.__SICHERE_KNOTEN_DATA__?.accidentShards?.find((shard) => shard.id === shardId || `${shard.id}.js` === fileName) ?? null;
}

function findBundledAccidentChunk(fileName: string): EmbeddedAccidentChunk | null {
  const chunkId = fileName.replace(/\.js$/i, "");
  return globalThis.__SICHERE_KNOTEN_DATA__?.accidentChunks?.find((chunk) => chunk.id === chunkId || `${chunk.id}.js` === fileName) ?? null;
}

function defaultAnalysisMetadataMatches(
  metadata: EmbeddedDefaultAnalysisMetadata,
  dataVersion: string,
  analysisCacheVersion: string,
  options: AnalysisOptions
): boolean {
  return (
    metadata.dataVersion === dataVersion &&
    metadata.analysisCacheVersion === analysisCacheVersion &&
    JSON.stringify(metadata.options) === JSON.stringify(serializeAnalysisOptionsForBundle(options))
  );
}

function serializeAnalysisOptionsForBundle(options: AnalysisOptions): SerializedAnalysisOptions {
  return {
    clusterRadiusMeters: options.clusterRadiusMeters,
    minAccidents: options.minAccidents,
    years: Array.from(options.years).sort((a, b) => a - b),
    roadUserFocus: Array.from(options.roadUserFocus).sort(),
    stateCode: options.stateCode,
    severityPercent: { ...options.severityPercent }
  };
}

async function loadOfflineBundleScript(fileName: string): Promise<string> {
  const urls = offlineBundleScriptUrls(fileName);
  let lastError: unknown = null;

  for (const url of urls) {
    try {
      await appendOfflineBundleScript(url);
      return url;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError ? ` Last error: ${errorMessage(lastError)}` : "";
  throw new Error(`Could not load offline data asset ${fileName}.${detail}`);
}

function offlineBundleScriptUrls(fileName: string): string[] {
  const baseUrls = offlineBundleAssetBaseUrls();
  return baseUrls.map((baseUrl) => new URL(fileName, baseUrl).href);
}

function offlineBundleAssetBaseUrls(): string[] {
  const sourceModuleScript = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src$="/src/main.ts"], script[type="module"][src$="src/main.ts"]'
  );
  const preferred = sourceModuleScript ? "./docs/assets/" : "./assets/";
  const fallback = sourceModuleScript ? "./assets/" : "./docs/assets/";
  return uniqueStrings([new URL(preferred, document.baseURI).href, new URL(fallback, document.baseURI).href]);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function appendOfflineBundleScript(url: string): Promise<string> {
  const existingPromise = offlineBundleScriptPromises.get(url);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = new Promise<string>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    script.onload = () => resolve(url);
    script.onerror = () => {
      script.remove();
      offlineBundleScriptPromises.delete(url);
      reject(new Error(`Failed to load ${url}`));
    };
    document.head.append(script);
  });
  offlineBundleScriptPromises.set(url, promise);
  return promise;
}

function accidentFromCompactRecord(record: CompactAccidentRecord): AccidentRecord {
  const streetNames = record[3];
  const stateCode = record[4];
  const administrativeRegionCode = record[5];
  const districtCode = record[6];
  const municipalityCode = record[7];
  const recordIndex = typeof record[32] === "number" ? record[32] : undefined;
  return {
    id: record[0],
    recordIndex,
    serialNumber: record[1],
    source: record[2],
    sourceType: "csv",
    streetName: streetNames[0] ?? null,
    streetNames,
    stateCode,
    stateName: STATE_NAMES[stateCode] ?? `Bundesland ${stateCode || "unknown"}`,
    administrativeRegionCode,
    administrativeRegionName: record[8],
    districtCode,
    districtName: record[9],
    municipalityCode,
    municipalityName: record[10],
    year: record[11],
    month: record[12],
    day: record[13],
    hour: record[14],
    weekday: record[15],
    category: record[16],
    accidentKind: record[17],
    accidentType: record[18],
    lightCondition: record[19],
    roadSurface: record[20],
    plausibilityLevel: record[21],
    linRefX: record[22],
    linRefY: record[23],
    lon: record[24],
    lat: record[25],
    involvesBike: record[26],
    involvesPedestrian: record[27],
    involvesMotorcycle: record[28],
    involvesCar: record[29],
    involvesTruck: record[30],
    involvesOther: record[31]
  };
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

function formatInteger(value: number): string {
  return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 2 }).format(value);
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE, { year: "numeric", month: "short", day: "2-digit" }).format(value);
}

function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

function formatSharePercent(value: number): string {
  return `${new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 0 }).format(value * 100)}%`;
}

function formatSeverityPercent(source: SeverityPercentSource): string {
  return `${severityPercentValue(source)}%`;
}

function severityPercentValue(source: SeverityPercentSource): number {
  return Math.round(source.severityPercent * 100);
}

function formatDistance(valueMeters: number): string {
  if (valueMeters >= 10_000) {
    return `${formatNumber(valueMeters / 1000)} km`;
  }
  if (valueMeters >= 1000) {
    return `${new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 1 }).format(valueMeters / 1000)} km`;
  }
  return `${formatInteger(Math.round(valueMeters))} m`;
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

function createInitializationTelemetry(): InitializationTelemetry {
  return {
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    appVersion: APP_CACHE_VERSION,
    dataVersion: null,
    steps: [],
    logged: false
  };
}

function createPostRenderCacheTelemetry(source: InitializationTelemetry | null): InitializationTelemetry | null {
  if (!source) {
    return null;
  }

  return {
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    appVersion: source.appVersion,
    dataVersion: source.dataVersion,
    steps: [],
    logged: false
  };
}

function recordInitializationStep(
  telemetry: InitializationTelemetry | null,
  name: string,
  detail: string | null,
  metadata: InitializationTelemetryMetadata
): void {
  if (!telemetry) {
    return;
  }

  const step = startInitializationStep(telemetry, name, detail);
  finishInitializationStep(step, "done", metadata);
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
        () =>
          writeAnalysisCache(
            writes.analysis!.cacheContext.dataVersion,
            writes.analysis!.cacheContext.appVersion,
            writes.analysis!.options,
            writes.analysis!.result
          ),
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

async function measureInitializationStep<T>(
  telemetry: InitializationTelemetry | null,
  name: string,
  detail: string | null,
  work: () => Promise<T>,
  metadata?: (result: T) => InitializationTelemetryMetadata
): Promise<T> {
  if (!telemetry) {
    return work();
  }

  const step = startInitializationStep(telemetry, name, detail);
  try {
    const result = await work();
    finishInitializationStep(step, "done", metadata?.(result) ?? {});
    return result;
  } catch (error) {
    finishInitializationStep(step, "error", { error: errorMessage(error) });
    throw error;
  }
}

function startInitializationStep(telemetry: InitializationTelemetry, name: string, detail: string | null): InitializationTelemetryStep {
  const startMark = performance.now();
  const step: InitializationTelemetryStep = {
    name,
    detail,
    startTime: new Date().toISOString(),
    startMark,
    startOffsetMs: startMark - telemetry.startMark,
    durationMs: null,
    status: "running",
    metadata: {}
  };
  telemetry.steps.push(step);
  return step;
}

function finishInitializationStep(
  step: InitializationTelemetryStep,
  status: Exclude<InitializationTelemetryStatus, "running">,
  metadata: InitializationTelemetryMetadata
): void {
  step.durationMs = performance.now() - step.startMark;
  step.status = status;
  step.metadata = metadata;
}

function logInitializationTelemetry(
  telemetry: InitializationTelemetry | null,
  status: Exclude<InitializationTelemetryStatus, "running">,
  label = "initialization telemetry"
): void {
  if (!telemetry || telemetry.logged) {
    return;
  }

  telemetry.logged = true;
  const finishedAt = new Date().toISOString();
  const durationMs = round(performance.now() - telemetry.startMark, 2);
  const summary = {
    status,
    appVersion: telemetry.appVersion,
    dataVersion: telemetry.dataVersion ?? "unknown",
    startedAt: telemetry.startedAt,
    finishedAt,
    durationMs,
    stepCount: telemetry.steps.length
  };
  const rows = telemetry.steps.map((step, index) => ({
    "#": index + 1,
    step: step.name,
    detail: step.detail ?? "",
    status: step.status,
    "start time": step.startTime,
    "start +ms": round(step.startOffsetMs, 2),
    "duration ms": step.durationMs === null ? null : round(step.durationMs, 2),
    ...step.metadata
  }));

  console.groupCollapsed(`[Safe Intersections] ${label}: ${status} in ${durationMs} ms`);
  console.info(summary);
  console.table(rows);
  console.groupEnd();
}

function createInteractionTelemetry(label: string, source: string, cluster: IntersectionCluster | null): InteractionTelemetry {
  return {
    label,
    source,
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    clusterId: cluster?.id ?? null,
    clusterLabel: cluster ? clusterLocationText(cluster) : null,
    steps: [],
    logged: false
  };
}

function measureActiveInteractionStep<T>(
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => InitializationTelemetryMetadata
): T {
  const telemetry = activeInteractionTelemetry;
  return telemetry ? measureInteractionStep(telemetry, name, detail, work, metadata) : work();
}

function measureInteractionStep<T>(
  telemetry: InteractionTelemetry,
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => InitializationTelemetryMetadata
): T {
  const step = startInteractionStep(telemetry, name, detail);
  try {
    const result = work();
    finishInteractionStep(step, metadata?.(result) ?? {});
    return result;
  } catch (error) {
    finishInteractionStep(step, { error: errorMessage(error) });
    throw error;
  }
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

function startInteractionStep(telemetry: InteractionTelemetry, name: string, detail: string | null): InteractionTelemetryStep {
  const startMark = performance.now();
  const step: InteractionTelemetryStep = {
    name,
    detail,
    startTime: new Date().toISOString(),
    startMark,
    startOffsetMs: startMark - telemetry.startMark,
    durationMs: null,
    metadata: {}
  };
  telemetry.steps.push(step);
  return step;
}

function finishInteractionStep(step: InteractionTelemetryStep, metadata: InitializationTelemetryMetadata): void {
  step.durationMs = performance.now() - step.startMark;
  step.metadata = metadata;
}

function scheduleInteractionTelemetryLog(telemetry: InteractionTelemetry): void {
  const paintStep = startInteractionStep(telemetry, "wait for browser paint", telemetry.clusterId);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      finishInteractionStep(paintStep, { activeView });
      logInteractionTelemetry(telemetry);
      if (activeInteractionTelemetry === telemetry) {
        activeInteractionTelemetry = null;
      }
    });
  });
}

function logInteractionTelemetry(telemetry: InteractionTelemetry): void {
  if (telemetry.logged) {
    return;
  }

  telemetry.logged = true;
  const finishedAt = new Date().toISOString();
  const durationMs = round(performance.now() - telemetry.startMark, 2);
  const summary = {
    label: telemetry.label,
    source: telemetry.source,
    clusterId: telemetry.clusterId ?? "",
    cluster: telemetry.clusterLabel ?? "",
    startedAt: telemetry.startedAt,
    finishedAt,
    durationMs,
    stepCount: telemetry.steps.length,
    activeView
  };
  const rows = telemetry.steps.map((step, index) => ({
    "#": index + 1,
    step: step.name,
    detail: step.detail ?? "",
    "start time": step.startTime,
    "start +ms": round(step.startOffsetMs, 2),
    "duration ms": step.durationMs === null ? null : round(step.durationMs, 2),
    ...step.metadata
  }));

  console.groupCollapsed(`[Safe Intersections] interaction telemetry: ${telemetry.source} in ${durationMs} ms`);
  console.info(summary);
  console.table(rows);
  console.groupEnd();
}

function analysisTelemetryDetail(options: AnalysisOptions): string {
  const years = Array.from(options.years).sort((a, b) => a - b).join(",") || "all";
  const roadUsers = roadUserFocusKey(options.roadUserFocus) || "all";
  return `state=${options.stateCode}; years=${years}; roadUsers=${roadUsers}; radius=${options.clusterRadiusMeters}m; minAccidents=${options.minAccidents}`;
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
