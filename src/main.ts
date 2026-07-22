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
  SeverityPercentOptions,
  IntersectionCluster
} from "./types";

const BUNDLED_CSV_FILES = [
  "data/csv/Unfallorte_2021_LinRef.csv",
  "data/csv/Unfallorte2022_LinRef.csv",
  "data/csv/Unfallorte2023_LinRef.csv",
  "data/csv/Unfallorte2024_LinRef.csv",
  "data/csv/Unfallorte_2025_LR_BasisDLM.csv"
];
const TABLE_ROWS_PER_STATE = 10;
const STATE_BROWSE_MIN_SEVERITY_PERCENT = 0.1;
const STATE_BROWSE_MAX_INTERSECTIONS = 100;

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

type ClusterSortKey = "state" | "location" | "accidents" | "fatal" | "serious" | "severityPercent";
type SortDirection = "asc" | "desc";
type LoadingStepKey = "cache" | "parse" | "analyze";
type SeverityFilterKey = "fatal" | "serious" | "other";
type ViewKey = "explore" | "map" | "details" | "state" | "table" | "settings";
type SelectionReason = "auto" | "program" | "user";
type HotspotMetricPlacement = "header" | "stats";
type AppLocale = "en" | "de";
type LoadingStatusKind = "normal" | "problem" | "idle";
type RoadUserKey = "car" | "pedestrian" | "bicycle" | "motorcycle" | "truck" | "other";

interface RoadUserDefinition {
  key: RoadUserKey;
  labelKey: string;
  read: (accident: AccidentRecord) => boolean | null;
}

interface RoadUserSummaryItem {
  definition: RoadUserDefinition;
  label: string;
  count: number;
  share: number;
}

const LOADING_STEP_ORDER: LoadingStepKey[] = ["cache", "parse", "analyze"];
const MOBILE_LAYOUT_QUERY = "(max-width: 640px)";
const APP_CACHE_VERSION =
  typeof __SICHERE_KNOTEN_APP_VERSION__ === "string" ? __SICHERE_KNOTEN_APP_VERSION__ : "dev-parallel-analysis";
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
    "action.reloadData": "Reload data",
    "action.clear": "Clear",
    "action.exportCsv": "Export CSV",
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
    "details.coordinates": "Coordinates",
    "details.years": "Years",
    "details.accidents": "Accidents",
    "details.fatalSerious": "Fatal / serious",
    "details.severityPercent": "Severity %",
    "details.vulnerableUsers": "Vulnerable users",
    "metric.severityPercent": "Severity %",
    "metric.severity": "Severity",
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
    "settings.dataNote": "Bundled CSV accident data loads automatically from the offline data bundle.",
    "settings.accidentData": "Accident data:",
    "settings.municipalityData": "Municipality data:",
    "settings.destatisMunicipalities": "/ Destatis municipality directory extract, 2nd quarter 2026.",
    "settings.statsOffices": "/ Federal and state statistical offices.",
    "settings.reusedUnder": "Reused under",
    "settings.licenseNote": "/ dl-de/by-2-0. Source data is processed, clustered, and analyzed by this app.",
    "settings.repository": "Project repository:",
    "settings.metricTitle": "Severity % metric",
    "settings.fatalWeight": "Fatal accident weight",
    "settings.seriousWeight": "Serious accident weight",
    "settings.fullSample": "Full sample accidents",
    "settings.trendDeadZone": "Trend dead zone (%/yr)",
    "settings.trendFullSignal": "Full trend signal (%/yr)",
    "settings.maxTrendAdjustment": "Max trend adjustment (%)",
    "settings.metricCap": "Metric cap (%)",
    "settings.analysis": "Analysis",
    "settings.clusterRadius": "Cluster radius (m)",
    "settings.clusterRadiusMeters": "Cluster radius in meters",
    "settings.minAccidents": "Minimum accidents",
    "settings.yearFilters": "Year filters",
    "settings.aboutSeverity": "About Severity %",
    "settings.whatMeasures": "What it measures",
    "settings.whatMeasuresText":
      "Severity % is a weighted share of severe outcomes at an inferred intersection. By default: <code>(fatal + serious / 2) / total</code>. Fatal accidents count once, serious-injury accidents count as half, and all accidents at the intersection form the denominator. In the raw formula, 100% severity means the weighted severe count equals the total accident count; with default weights, that means every known record at the intersection was fatal. The displayed value can also reach 100% when trend adjustment pushes a high raw score up to the metric cap.",
    "settings.discountText":
      "Low accident totals are weighted conservatively, and the accident trend adjusts the result gradually once the yearly change is large enough to influence the score.",
    "settings.whyFocus": "Why this focus",
    "settings.whyFocusText1":
      "We do not have reliable traffic volume data for each intersection. Intersections with many recorded incidents are therefore not automatically the highest-severity locations; they may also be very highly loaded.",
    "settings.whyFocusText2":
      "The metric focuses on intersections with higher recorded severity, using fatal and serious-injury outcomes to distinguish severe locations from high-volume ones.",
    "status.settingsChanged": "Settings changed. Click Analyze to update results.",
    "status.checkingParsedCache": "Checking parsed data cache.",
    "status.loadingCachedAccidents": "Loading cached accidents {current}/{total}.",
    "status.cacheMissParsingBundled": "Cache miss. Parsing bundled CSV files.",
    "status.parsingLabel": "Parsing {label}",
    "status.accidentsLoadedFromCache": "{count} accidents loaded from cache.",
    "status.accidentRecordsLoaded": "{count} accident records loaded.",
    "status.parsedDataCached": "Parsed data cached for future refreshes.",
    "status.cachingParsedAccidents": "Caching parsed accidents {current}/{total}.",
    "status.parsedDataCacheWriteSkipped": "Parsed data loaded. Cache write skipped: {error}",
    "status.loadDataFirst": "Load accident data first.",
    "status.checkingAnalysisCache": "Checking analysis cache.",
    "status.intersectionClustersLoadedFromCache": "{count} intersection clusters loaded from cache.",
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
    "status.dataCleared": "Data cleared. Use Reload data to load bundled files again.",
    "status.noClustersToExport": "No analyzed clusters to export.",
    "status.bundleLoadFailed":
      "Could not load {path}. The docs/data files must sit next to docs/index.html. Some browsers block automatic file:// reads; GitHub Pages or any static host will work. {errors}",
    "status.localReadBlocked": "local read blocked",
    "label.away": "{distance} away",
    "noun.accident.one": "accident",
    "noun.accident.other": "accidents",
    "map.openOsm": "Open in OpenStreetMap",
    "map.openGoogleMaps": "Open in Google Maps",
    "map.openStreetView": "Open Street View",
    "map.labelOsm": "OpenStreetMap",
    "map.labelGoogleMaps": "Google Maps",
    "map.labelStreetView": "Street View",
    "records.title": "Known accident records",
    "records.countOf": "{shown} of {total}",
    "records.empty": "No matching source accident records were found near this intersection.",
    "records.incidentNumber": "Incident {number}",
    "records.category": "Category",
    "records.kind": "Kind",
    "records.type": "Type",
    "records.light": "Light",
    "records.surface": "Surface",
    "records.roadUsers": "Road users",
    "records.area": "Area",
    "records.coordinates": "Coordinates",
    "records.locationCheck": "Location check",
    "records.distance": "Distance",
    "records.recordId": "Record ID",
    "records.source": "Source",
    "records.unknownYear": "Unknown year",
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
    "trend.note": "Selected years with no accidents count as zero.",
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
    "action.reloadData": "Daten neu laden",
    "action.clear": "Leeren",
    "action.exportCsv": "CSV exportieren",
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
    "details.coordinates": "Koordinaten",
    "details.years": "Jahre",
    "details.accidents": "Unfälle",
    "details.fatalSerious": "Tödlich / schwer",
    "details.severityPercent": "Schweregrad %",
    "details.vulnerableUsers": "Ungeschützte Verkehrsteilnehmer",
    "metric.severityPercent": "Schweregrad %",
    "metric.severity": "Schweregrad",
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
    "settings.dataNote": "Gebündelte CSV-Unfalldaten werden automatisch aus dem Offline-Datenpaket geladen.",
    "settings.accidentData": "Unfalldaten:",
    "settings.municipalityData": "Gemeindedaten:",
    "settings.destatisMunicipalities": "/ Destatis-Gemeindeverzeichnis-Auszug, 2. Quartal 2026.",
    "settings.statsOffices": "/ Statistische Ämter des Bundes und der Länder.",
    "settings.reusedUnder": "Weiterverwendet unter",
    "settings.licenseNote": "/ dl-de/by-2-0. Die Quelldaten werden von dieser App verarbeitet, geclustert und analysiert.",
    "settings.repository": "Projekt-Repository:",
    "settings.metricTitle": "Schweregrad-%-Metrik",
    "settings.fatalWeight": "Gewicht tödlicher Unfälle",
    "settings.seriousWeight": "Gewicht schwerer Unfälle",
    "settings.fullSample": "Volle Stichprobengröße",
    "settings.trendDeadZone": "Trend-Toleranzzone (%/Jahr)",
    "settings.trendFullSignal": "Volles Trendsignal (%/Jahr)",
    "settings.maxTrendAdjustment": "Maximale Trendanpassung (%)",
    "settings.metricCap": "Metrik-Obergrenze (%)",
    "settings.analysis": "Analyse",
    "settings.clusterRadius": "Cluster-Radius (m)",
    "settings.clusterRadiusMeters": "Cluster-Radius in Metern",
    "settings.minAccidents": "Mindestanzahl Unfälle",
    "settings.yearFilters": "Jahresfilter",
    "settings.aboutSeverity": "Über Schweregrad %",
    "settings.whatMeasures": "Was gemessen wird",
    "settings.whatMeasuresText":
      "Schweregrad % ist der gewichtete Anteil schwerer Folgen an einer abgeleiteten Kreuzung. Standardmäßig gilt: <code>(tödlich + schwer / 2) / gesamt</code>. Tödliche Unfälle zählen einfach, Unfälle mit Schwerverletzten halb, und alle Unfälle an der Kreuzung bilden den Nenner. In der Rohformel bedeutet 100% Schweregrad, dass die gewichtete Anzahl schwerer Folgen der Gesamtzahl der Unfälle entspricht; mit den Standardgewichten heißt das, dass jeder bekannte Datensatz an der Kreuzung tödlich war. Der angezeigte Wert kann ebenfalls 100% erreichen, wenn die Trendanpassung einen hohen Rohwert bis zur Metrik-Obergrenze anhebt.",
    "settings.discountText":
      "Niedrige Unfallzahlen werden konservativ gewichtet, und der Unfalltrend passt das Ergebnis schrittweise an, sobald die jährliche Veränderung deutlich genug ist, um den Wert zu beeinflussen.",
    "settings.whyFocus": "Warum dieser Fokus",
    "settings.whyFocusText1":
      "Wir haben keine verlässlichen Verkehrsstärkedaten für jede Kreuzung. Kreuzungen mit vielen registrierten Vorfällen sind deshalb nicht automatisch die Orte mit dem höchsten Schweregrad; sie können auch sehr stark belastet sein.",
    "settings.whyFocusText2":
      "Die Metrik fokussiert Kreuzungen mit höherem erfasstem Schweregrad und nutzt tödliche sowie schwere Unfallfolgen, um Orte mit schweren Folgen von stark belasteten Orten zu unterscheiden.",
    "status.settingsChanged": "Einstellungen geändert. Klicke auf Analysieren, um die Ergebnisse zu aktualisieren.",
    "status.checkingParsedCache": "Cache mit eingelesenen Daten wird geprüft.",
    "status.loadingCachedAccidents": "Unfälle aus dem Cache werden geladen {current}/{total}.",
    "status.cacheMissParsingBundled": "Kein Cachetreffer. Gebündelte CSV-Dateien werden eingelesen.",
    "status.parsingLabel": "{label} wird eingelesen",
    "status.accidentsLoadedFromCache": "{count} Unfälle aus dem Cache geladen.",
    "status.accidentRecordsLoaded": "{count} Unfalldatensätze geladen.",
    "status.parsedDataCached": "Eingelesene Daten wurden für spätere Aktualisierungen gespeichert.",
    "status.cachingParsedAccidents": "Eingelesene Unfälle werden gespeichert {current}/{total}.",
    "status.parsedDataCacheWriteSkipped": "Daten wurden eingelesen. Cache-Schreiben übersprungen: {error}",
    "status.loadDataFirst": "Lade zuerst Unfalldaten.",
    "status.checkingAnalysisCache": "Analysecache wird geprüft.",
    "status.intersectionClustersLoadedFromCache": "{count} Kreuzungscluster aus dem Cache geladen.",
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
    "status.dataCleared": "Daten geleert. Nutze Daten neu laden, um die gebündelten Dateien erneut zu laden.",
    "status.noClustersToExport": "Keine analysierten Cluster zum Exportieren.",
    "status.bundleLoadFailed":
      "{path} konnte nicht geladen werden. Die docs/data-Dateien müssen neben docs/index.html liegen. Einige Browser blockieren automatische file://-Zugriffe; GitHub Pages oder jeder statische Host funktioniert. {errors}",
    "status.localReadBlocked": "lokaler Lesezugriff blockiert",
    "label.away": "{distance} entfernt",
    "noun.accident.one": "Unfall",
    "noun.accident.other": "Unfälle",
    "map.openOsm": "In OpenStreetMap öffnen",
    "map.openGoogleMaps": "In Google Maps öffnen",
    "map.openStreetView": "Street View öffnen",
    "map.labelOsm": "OpenStreetMap",
    "map.labelGoogleMaps": "Google Maps",
    "map.labelStreetView": "Street View",
    "records.title": "Bekannte Unfalldatensätze",
    "records.countOf": "{shown} von {total}",
    "records.empty": "In der Nähe dieser Kreuzung wurden keine passenden Quelldatensätze gefunden.",
    "records.incidentNumber": "Unfall {number}",
    "records.category": "Kategorie",
    "records.kind": "Art",
    "records.type": "Typ",
    "records.light": "Licht",
    "records.surface": "Oberfläche",
    "records.roadUsers": "Verkehrsteilnehmer",
    "records.area": "Gebiet",
    "records.coordinates": "Koordinaten",
    "records.locationCheck": "Lageprüfung",
    "records.distance": "Entfernung",
    "records.recordId": "Datensatz-ID",
    "records.source": "Quelle",
    "records.unknownYear": "Unbekanntes Jahr",
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
    "trend.note": "Ausgewählte Jahre ohne Unfälle zählen als null.",
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
const ROAD_USER_DEFINITIONS: RoadUserDefinition[] = [
  { key: "car", labelKey: "roadUser.car", read: (accident) => accident.involvesCar },
  { key: "pedestrian", labelKey: "roadUser.pedestrian", read: (accident) => accident.involvesPedestrian },
  { key: "bicycle", labelKey: "roadUser.bicycle", read: (accident) => accident.involvesBike },
  { key: "motorcycle", labelKey: "roadUser.motorcycle", read: (accident) => accident.involvesMotorcycle },
  { key: "truck", labelKey: "roadUser.truck", read: (accident) => accident.involvesTruck },
  { key: "other", labelKey: "roadUser.other", read: (accident) => accident.involvesOther }
];

interface ClusterTableSort {
  key: ClusterSortKey;
  direction: SortDirection;
}

interface SeverityPercentSource {
  severityPercent: number;
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
let clusterTableSort: ClusterTableSort = { key: "severityPercent", direction: "desc" };
let analysisSettingsDirty = false;
let activeDataVersion: string | null = null;
let userLocation: { lat: number; lon: number; accuracyMeters: number | null } | null = null;
let activeAnalysisOptions: AnalysisOptions | null = null;
let crossingAccidentIndexCache: AccidentIndexCache | null = null;
let accidentKeyLookupCache: AccidentKeyLookupCache | null = null;
let isStreetViewOpen = readStoredStreetViewOpen();
let activeView: ViewKey = "map";
let loadingStatusKind: LoadingStatusKind = "normal";

const elements = {
  app: byId<HTMLDivElement>("app"),
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
  fatalWeight: byId<HTMLInputElement>("fatalWeight"),
  seriousWeight: byId<HTMLInputElement>("seriousWeight"),
  severityFullSample: byId<HTMLInputElement>("severityFullSample"),
  severityTrendDeadZone: byId<HTMLInputElement>("severityTrendDeadZone"),
  severityTrendFullSignal: byId<HTMLInputElement>("severityTrendFullSignal"),
  severityMaxTrendAdjustment: byId<HTMLInputElement>("severityMaxTrendAdjustment"),
  severityMaxPercent: byId<HTMLInputElement>("severityMaxPercent"),
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
  elements.loadBundledBtn.addEventListener("click", () => void loadBundledData());
  elements.clearBtn.addEventListener("click", clearData);
  elements.analyzeBtn.addEventListener("click", () => runAnalysis());
  elements.exportBtn.addEventListener("click", exportClusters);

  wireLinkedNumberRange(elements.clusterRadius, elements.clusterRadiusOut, markAnalysisSettingsDirty);

  wireClampedNumberInput(elements.minAccidents, markAnalysisSettingsDirty);
  wireClampedNumberInput(elements.severityFullSample, markAnalysisSettingsDirty);
  severityPercentDecimalInputs().forEach((input) => wireClampedDecimalInput(input, markAnalysisSettingsDirty));

  elements.stateFilter.addEventListener("input", markAnalysisSettingsDirty);
  elements.stateFilter.addEventListener("change", markAnalysisSettingsDirty);

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
  severityPercentDecimalInputs().forEach(normalizeDecimalInput);
}

function severityPercentInputs(): HTMLInputElement[] {
  return [
    elements.fatalWeight,
    elements.seriousWeight,
    elements.severityFullSample,
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
    setStatus(tr("status.checkingParsedCache"), 4);
    const cached = await readParsedDataCache(dataVersion, localizedCacheStatus);
    if (cached) {
      accidents = cached.accidents;
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      populateFilters();
      setStatus(trf("status.accidentsLoadedFromCache", { count: formatInteger(accidents.length) }), 66);
      analysisStarted = true;
      runAnalysis();
      return;
    }

    setStatus(tr("status.cacheMissParsingBundled"), 10);
    const loadedAccidents: AccidentRecord[] = [];
    for (const [index, path] of BUNDLED_CSV_FILES.entries()) {
      const blob = await readBundledBlob(path);
      const file = new File([blob], path.split("/").pop() ?? "accidents.csv", { type: "text/csv" });
      const parsed = await parseAccidentCsvFiles([file], (progress) => {
        const baseProgress = 10 + index * 9;
        setStatus(trf("status.parsingLabel", { label: progress.label }), Math.min(55, baseProgress + 8));
      });
      loadedAccidents.push(...parsed);
      accidents = loadedAccidents;
      crossingAccidentIndexCache = null;
      accidentKeyLookupCache = null;
      populateFilters();
    }
    setStatus(trf("status.accidentRecordsLoaded", { count: formatInteger(accidents.length) }), 60);

    try {
      await writeParsedDataCache(dataVersion, accidents, localizedCacheStatus);
      setStatus(tr("status.parsedDataCached"), 74);
    } catch (error) {
      setStatus(trf("status.parsedDataCacheWriteSkipped", { error: errorMessage(error) }), 74);
    }
    analysisStarted = true;
    runAnalysis();
  } catch (error) {
    setStatus(errorMessage(error), 0, "problem");
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
      setStatus(trf("status.parsingLabel", { label: progress.label }), progress.total ? progressValue(progress.loaded, progress.total) : 45);
    });
    accidents = replace ? parsed : accidents.concat(parsed);
    result = null;
    selectedCluster = null;
    activeAnalysisOptions = null;
    crossingAccidentIndexCache = null;
    accidentKeyLookupCache = null;
    populateFilters();
    setStatus(trf("status.accidentRecordsLoaded", { count: formatInteger(accidents.length) }), 100);
    activeDataVersion = null;
  } catch (error) {
    setStatus(errorMessage(error), 0, "problem");
  } finally {
    if (manageBusy) {
      setBusy(false);
    }
    renderAll();
  }
}

function runAnalysis(): void {
  if (accidents.length === 0) {
    setStatus(tr("status.loadDataFirst"), 0, "idle");
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
      setStatus(tr("status.checkingAnalysisCache"), 75);
      const cached = await readAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options);
      if (cached) {
        result = cached;
        selectedCluster = null;
        activeAnalysisOptions = cloneAnalysisOptions(options);
        crossingAccidentIndexCache = null;
        accidentKeyLookupCache = null;
        analysisSettingsDirty = false;
        renderAll();
        setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(result.clusters.length) }), 100);
        return;
      }
    }

    setStatus(tr("status.analyzingIntersections"), 75);
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
        setStatus(tr("status.cachingAnalysisResult"), 96);
        await writeAnalysisCache(cacheContext.dataVersion, cacheContext.appVersion, options, result);
      } catch {
        // The analysis result is already rendered; cache failures only affect later reload speed.
      }
    }

    setStatus(trf("status.intersectionClustersAnalyzed", { count: formatInteger(result.clusters.length) }), 100);
  } catch (error) {
    setStatus(errorMessage(error), 0, "problem");
  } finally {
    setBusy(false);
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
    stateCode: elements.stateFilter.value as AnalysisOptions["stateCode"],
    severityPercent: readSeverityPercentOptions()
  };
}

function readSeverityPercentOptions(): SeverityPercentOptions {
  const trendDeadZonePercent = normalizeDecimalInput(elements.severityTrendDeadZone);
  const trendFullSignalPercent = Math.max(trendDeadZonePercent + 0.1, normalizeDecimalInput(elements.severityTrendFullSignal));
  elements.severityTrendFullSignal.value = formatInputNumber(trendFullSignalPercent);

  return {
    fatalWeight: normalizeDecimalInput(elements.fatalWeight),
    seriousWeight: normalizeDecimalInput(elements.seriousWeight),
    fullSampleAccidents: normalizeNumberInput(elements.severityFullSample),
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
    severityPercent: { ...options.severityPercent }
  };
}

function populateFilters(): void {
  const selectedState = elements.stateFilter.value;
  const selectedBrowseState = elements.browseState.value;
  elements.stateFilter.replaceChildren(new Option(tr("option.allStates"), "all"));
  elements.browseState.replaceChildren(new Option(tr("option.allStates"), "all"));
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

function handleClusterSelection(cluster: IntersectionCluster | null, reason: SelectionReason): void {
  selectedCluster = cluster;
  renderSelection(cluster);
  renderExplore();

  if (!cluster) {
    return;
  }

  if (reason === "user" && mobileLayout.matches) {
    map.focus(cluster);
    setView("details");
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
  const sortedClusters = sortClustersForTable(clusters);
  if (elements.stateFilter.value !== "all") {
    return sortedClusters.slice(0, TABLE_ROWS_PER_STATE);
  }

  const byState = new Map<string, number>();
  const selected: IntersectionCluster[] = [];
  for (const cluster of sortedClusters) {
    const current = byState.get(cluster.stateCode) ?? 0;
    if (current < TABLE_ROWS_PER_STATE) {
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
    elements.nearbyList.append(hotspotButton(entry.cluster, trf("label.away", { distance: formatDistance(entry.distanceMeters) })));
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
      hotspotButton(cluster, stateCode === "all" ? cluster.stateName : clusterLocationText(cluster), { metricPlacement: "header" })
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
  options: { metricPlacement?: HotspotMetricPlacement } = {}
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
    selectClusterOnMap(cluster);
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
  selectClusterOnMap(nearest.cluster);
  return nearest;
}

function selectClusterOnMap(cluster: IntersectionCluster): void {
  ensureClusterSeverityVisible(cluster);
  setView("map");
  window.requestAnimationFrame(() => {
    map.select(cluster, true);
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
  const lat = cluster.lat.toFixed(6);
  const lon = cluster.lon.toFixed(6);
  const openStreetMapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const streetViewUrl = googleStreetViewUrl(cluster);
  const accidentRecords = clusterAccidentRecords(cluster);
  const trendPanel = renderTrendPanel(cluster, accidentRecords);
  const recordPanel = renderSidebarAccidentRecords(accidentRecords, cluster.accidentCount);
  map.setSelectedIncidentPoints(
    accidentRecords.map(({ accident }, index) => ({
      lat: accident.lat,
      lon: accident.lon,
      label: String(index + 1)
    }))
  );

  elements.selectionDetails.innerHTML = `
    <dl>
      <div><dt>${escapeHtml(tr("details.state"))}</dt><dd>${escapeHtml(cluster.stateName)}</dd></div>
      ${cluster.administrativeRegionName ? `<div><dt>${escapeHtml(tr("details.adminRegion"))}</dt><dd>${escapeHtml(cluster.administrativeRegionName)}</dd></div>` : ""}
      ${cluster.districtName ? `<div><dt>${escapeHtml(tr("details.district"))}</dt><dd>${escapeHtml(cluster.districtName)}</dd></div>` : ""}
      ${cluster.municipalityName ? `<div><dt>${escapeHtml(tr("details.municipality"))}</dt><dd>${escapeHtml(cluster.municipalityName)}</dd></div>` : ""}
      <div><dt>${escapeHtml(tr("details.coordinates"))}</dt><dd>${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}</dd></div>
      <div><dt>${escapeHtml(tr("details.years"))}</dt><dd>${cluster.years.join(", ")}</dd></div>
      <div><dt>${escapeHtml(tr("details.accidents"))}</dt><dd>${formatInteger(cluster.accidentCount)}</dd></div>
      <div><dt>${escapeHtml(tr("details.fatalSerious"))}</dt><dd>${formatInteger(cluster.fatalCount)} / ${formatInteger(cluster.seriousCount)}</dd></div>
      <div><dt>${escapeHtml(tr("details.severityPercent"))}</dt><dd>${formatSeverityPercent(cluster)}</dd></div>
      <div><dt>${escapeHtml(tr("details.vulnerableUsers"))}</dt><dd>${formatInteger(cluster.vulnerableCount)}</dd></div>
    </dl>
    ${renderMapServiceActions(openStreetMapUrl, googleMapsUrl, streetViewUrl)}
    ${trendPanel}
    ${recordPanel}
  `;
  updateContextTabs();
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

function scheduleMapRefresh(): void {
  window.requestAnimationFrame(() => {
    if (mobileLayout.matches && activeView !== "map") {
      return;
    }
    map.refresh();
  });
}

function renderMapServiceActions(openStreetMapUrl: string, googleMapsUrl: string, streetViewUrl: string): string {
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

function renderSidebarAccidentRecords(records: CrossingAccident[], totalCount: number): string {
  const countText = trf("records.countOf", { shown: formatInteger(records.length), total: formatInteger(totalCount) });
  if (records.length === 0) {
    return `
      <section class="sidebar-accident-records">
        <div class="section-heading-row">
          <h3>${escapeHtml(tr("records.title"))}</h3>
          <span>${countText}</span>
        </div>
        <p class="hotspot-empty">${escapeHtml(tr("records.empty"))}</p>
      </section>
    `;
  }

  const items = records
    .map(({ accident, distanceMeters }, index) => {
      const severity = accidentSeverity(accident);
      const recordNumber = String(index + 1);
      const rows = accidentRecordRows(accident, distanceMeters)
        .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
        .join("");
      return `
        <li class="accident-record-item">
          <div class="accident-record-topline">
            <span class="accident-record-number" aria-label="${escapeHtml(trf("records.incidentNumber", { number: recordNumber }))}">${recordNumber}</span>
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
        <h3>${escapeHtml(tr("records.title"))}</h3>
        <span>${countText}</span>
      </div>
      <ol class="accident-record-list">${items}</ol>
    </section>
  `;
}

function accidentRecordRows(accident: AccidentRecord, distanceMeters: number): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  addRecordRow(rows, tr("records.category"), codeLabel(accident.category, ACCIDENT_CATEGORY_LABELS));
  addRecordRow(rows, tr("records.kind"), codeLabel(accident.accidentKind, ACCIDENT_KIND_LABELS));
  addRecordRow(rows, tr("records.type"), codeLabel(accident.accidentType, ACCIDENT_TYPE_LABELS));
  addRecordRow(rows, tr("records.light"), codeLabel(accident.lightCondition, LIGHT_CONDITION_LABELS));
  addRecordRow(rows, tr("records.surface"), codeLabel(accident.roadSurface, ROAD_SURFACE_LABELS));
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

function renderTrendPanel(cluster: IntersectionCluster, accidentRecords: CrossingAccident[]): string {
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
      ${renderRoadUserDistribution(accidentRecords)}
      <p class="trend-note">${escapeHtml(tr("trend.note"))}</p>
    </section>
  `;
}

function renderRoadUserDistribution(records: CrossingAccident[]): string {
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
    <div class="road-user-summary" aria-label="${escapeHtml(tr("roadUsers.summaryAria"))}">
      <div class="road-user-heading">
        <span>${escapeHtml(tr("roadUsers.title"))}</span>
        <strong>${escapeHtml(topItem.label)} ${formatSharePercent(topItem.share)}</strong>
      </div>
      <div class="road-user-strip" role="list">${segments}</div>
      <div class="road-user-legend">${legend}</div>
    </div>
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
  setStatus(tr("status.dataCleared"), 0, "idle");
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

function clusterLocation(cluster: IntersectionCluster): string {
  return escapeHtml(clusterLocationText(cluster));
}

function clusterLocationText(cluster: IntersectionCluster): string {
  return cluster.municipalityName ?? cluster.districtName ?? cluster.administrativeRegionName ?? `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`;
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
    elements.stateFilter,
    ...severityPercentInputs()
  ];
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
    trf("status.bundleLoadFailed", { path, errors: errors.join(" ") })
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
    request.onerror = () => reject(new Error(tr("status.localReadBlocked")));
    request.send();
  });
}

function localizedCacheStatus(message: string, progress: number): void {
  setStatus(translateCacheStatus(message), progress);
}

function translateCacheStatus(message: string): string {
  const loadingCached = /^Loading cached accidents (\d+)\/(\d+)\.$/.exec(message);
  if (loadingCached) {
    return trf("status.loadingCachedAccidents", { current: loadingCached[1], total: loadingCached[2] });
  }

  const cachingParsed = /^Caching parsed accidents (\d+)\/(\d+)\.$/.exec(message);
  if (cachingParsed) {
    return trf("status.cachingParsedAccidents", { current: cachingParsed[1], total: cachingParsed[2] });
  }

  return message;
}

function progressValue(loaded = 0, total = 1): number {
  return Math.round((loaded / Math.max(total, 1)) * 100);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 2 }).format(value);
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
