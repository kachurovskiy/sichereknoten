import {
  clusterAreaText,
  clusterLocationText,
  clusterStreetLabel,
  clusterStreetNamesForDisplay,
  formatClusterStreetNames,
  formatOsmBoolean
} from "../domain/clusterDisplay";
import { normalizeTrendYears } from "../analysis/defaults";
import { formatDate, formatDistance, formatInteger, formatSharePercent, formatSignedPercent } from "../shared/formatting";
import { tr, trf } from "../shared/i18n";
import { round, uniqueNumbers } from "../shared/math";
import {
  loadOsmTile,
  localMeterOffset,
  maxAbsoluteOffset,
  OSM_TILE_SIZE,
  osmWorldPixel,
  wrapOsmTileX
} from "../map/osmTiles";
import {
  clusterYearSeverityCounts,
  TREND_SEVERITY_STACK_ORDER,
  trendSeverityCount,
  type TrendSeverityCounts,
  type TrendSeverityKey
} from "./trendSeries";
import type { AccidentRecord, AccidentTrendDirection, ClusterYearStat, IntersectionCluster, RoadUserKey } from "../domain/types";

const FACTSHEET_PAGE_WIDTH = 1240;
const FACTSHEET_PAGE_HEIGHT = 1754;
const FACTSHEET_MARGIN = 64;
const FACTSHEET_BOTTOM_MARGIN = 96;
const FACTSHEET_CONTENT_WIDTH = FACTSHEET_PAGE_WIDTH - FACTSHEET_MARGIN * 2;
const FACTSHEET_INCIDENT_LINK_TOP_GAP = 18;
const FACTSHEET_TITLE_STREET_LIMIT = 3;
const PROJECT_REPOSITORY_URL = "https://github.com/kachurovskiy/sichereknoten";
const PROJECT_REPOSITORY_LABEL = "kachurovskiy/sichereknoten";

export interface FactsheetAccidentRecord {
  accident: AccidentRecord;
  distanceMeters: number;
}

export interface FactsheetRoadUserItem {
  key: RoadUserKey;
  label: string;
  count: number;
  share: number;
}

export interface FactsheetAccidentDetail {
  heading: string;
  rows: Array<[string, string]>;
  pressUrl: string;
}

export interface FactsheetMapUrls {
  openStreetMapUrl: string;
  googleMapsUrl: string;
  streetViewUrl: string;
}

export interface CreateFactsheetPdfOptions {
  cluster: IntersectionCluster;
  records: FactsheetAccidentRecord[];
  selectedYears: number[];
  trendSeries: ClusterYearStat[];
  trendPeriodYears: number;
  clusterRadiusMeters: number;
  latestBundledFileDate: Date | null;
  severityPercentText: string;
  mapUrls: FactsheetMapUrls;
  roadUserItems: FactsheetRoadUserItem[];
  accidentDetails: FactsheetAccidentDetail[];
}

interface FactsheetLayout {
  pages: HTMLCanvasElement[];
  context: CanvasRenderingContext2D;
  y: number;
  links: FactsheetPdfLink[];
  textSpans: FactsheetPdfTextSpan[];
}

interface FactsheetTrendPoint extends ClusterYearStat {
  x: number;
  barX: number;
  barWidth: number;
  counts: TrendSeverityCounts;
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

export async function createFactsheetPdf(options: CreateFactsheetPdfOptions): Promise<Blob> {
  const layout = createFactsheetLayout();
  await drawFactsheetOverview(layout, options);
  drawFactsheetAccidentDetails(layout, options.accidentDetails);
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

async function drawFactsheetOverview(layout: FactsheetLayout, options: CreateFactsheetPdfOptions): Promise<void> {
  const { cluster, records } = options;
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
  drawFactsheetRows(layout, [
    [tr("details.roundabout"), formatOsmBoolean(cluster.osmRoundabout)],
    [tr("details.trafficSignal"), formatOsmBoolean(cluster.osmTrafficSignal)]
  ]);

  drawFactsheetSectionHeading(layout, tr("factsheet.map"));
  const mapHeight = 470;
  ensureFactsheetSpace(layout, mapHeight + 44);
  await drawFactsheetOsmMap(layout.context, cluster, records, FACTSHEET_MARGIN, layout.y, FACTSHEET_CONTENT_WIDTH, mapHeight);
  layout.y += mapHeight + 16;
  drawFactsheetParagraph(layout, `${tr("factsheet.mapNote")} ${tr("factsheet.mapAttribution")}.`, 18, 25, "#53636d");
  drawFactsheetMapLinksSection(layout, options.mapUrls);

  drawFactsheetSectionHeading(layout, tr("factsheet.counts"));
  drawFactsheetRows(layout, [
    [tr("factsheet.period"), factsheetPeriodLabel(cluster, records)],
    [tr("factsheet.total"), formatInteger(cluster.accidentCount)],
    [tr("severity.fatal"), formatInteger(cluster.fatalCount)],
    [tr("severity.serious"), formatInteger(cluster.seriousCount)],
    [tr("factsheet.lightOther"), formatInteger(Math.max(0, cluster.accidentCount - cluster.fatalCount - cluster.seriousCount))],
    [tr("metric.severityPercent"), options.severityPercentText],
    [tr("factsheet.coordinates"), `${cluster.lat.toFixed(5)}, ${cluster.lon.toFixed(5)}`]
  ]);

  drawFactsheetTrendSection(layout, options);
  drawFactsheetRoadUserSection(layout, options.roadUserItems);
  drawFactsheetSourceSection(layout, options.latestBundledFileDate);
  drawFactsheetTextSection(layout, tr("factsheet.methodology"), factsheetMethodologyText(options.clusterRadiusMeters, options.trendPeriodYears));
  drawFactsheetTextSection(layout, tr("factsheet.limitations"), tr("factsheet.limitationsText"));
}

function factsheetTitle(cluster: IntersectionCluster, records: FactsheetAccidentRecord[]): string {
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

function drawFactsheetMapLinksSection(layout: FactsheetLayout, mapUrls: FactsheetMapUrls): void {
  drawFactsheetSectionHeading(layout, tr("factsheet.mapLinks"));
  drawFactsheetLinkRow(layout, tr("map.labelOsm"), mapUrls.openStreetMapUrl, tr("map.openOsm"));
  drawFactsheetLinkRow(layout, tr("map.labelGoogleMaps"), mapUrls.googleMapsUrl, tr("map.openGoogleMaps"));
  drawFactsheetLinkRow(layout, tr("map.labelStreetView"), mapUrls.streetViewUrl, tr("map.openStreetView"));
}

function drawFactsheetTrendSection(layout: FactsheetLayout, options: CreateFactsheetPdfOptions): void {
  const { cluster } = options;
  const years = options.selectedYears.length ? options.selectedYears : cluster.years;
  const series = options.trendSeries;
  if (series.length === 0) {
    return;
  }

  drawFactsheetSectionHeading(layout, tr("trend.title"));
  const trend = cluster.accidentTrend;
  const trendLabel = trendDirectionLabel(trend.direction);
  const relativeSlope = trend.relativeSlopePerYear === null ? "" : ` ${formatSignedPercent(trend.relativeSlopePerYear)}${tr("unit.perYear")}`;
  drawFactsheetParagraph(
    layout,
    factsheetTrendSummary(`${trendLabel}${relativeSlope}`, cluster, years, options.trendPeriodYears),
    19,
    26,
    "#38454b"
  );

  const chartHeight = 250;
  ensureFactsheetSpace(layout, chartHeight + 8);
  drawFactsheetTrendChart(layout, series, FACTSHEET_MARGIN, layout.y, FACTSHEET_CONTENT_WIDTH, chartHeight);
  layout.y += chartHeight + 8;
}

function factsheetTrendSummary(trendText: string, cluster: IntersectionCluster, chartYears: number[], trendPeriodYears: number): string {
  const trendYears = chartYears.slice(-Math.max(0, cluster.accidentTrend.years));
  return trf("factsheet.trendSummary", {
    trend: trendText,
    setting: formatInteger(normalizeTrendYears(trendPeriodYears)),
    trendYears: formatYearSelection(trendYears),
    chartYears: formatYearSelection(chartYears)
  });
}

function factsheetMethodologyText(radiusMeters: number, trendPeriodYears: number): string {
  return trf("factsheet.methodologyTextDetailed", {
    radius: formatDistance(radiusMeters),
    trendYears: formatInteger(normalizeTrendYears(trendPeriodYears))
  });
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
    bottom: y + height - 82
  };
  const chartWidth = chart.right - chart.left;
  const chartHeight = chart.bottom - chart.top;
  const maxAccidents = maxSeriesAccidents(series, 1);
  const yAxisTicks = uniqueNumbers([0, Math.ceil(maxAccidents / 2), maxAccidents]).sort((a, b) => a - b);

  context.font = factsheetFont(18, 500);
  context.fillStyle = "#53636d";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const value of yAxisTicks) {
    const tickY = chart.bottom - (value / maxAccidents) * chartHeight;
    drawFactsheetText(layout, formatInteger(value), chart.left - 12, tickY);
  }

  context.strokeStyle = "#d7ddd7";
  context.lineWidth = 1.5;
  for (const value of yAxisTicks.filter((tick) => tick > 0)) {
    const tickY = chart.bottom - (value / maxAccidents) * chartHeight;
    context.beginPath();
    context.moveTo(chart.left, tickY);
    context.lineTo(chart.right, tickY);
    context.stroke();
  }

  context.strokeStyle = "#8fa09a";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(chart.left, chart.top);
  context.lineTo(chart.left, chart.bottom);
  context.lineTo(chart.right, chart.bottom);
  context.stroke();

  const slotWidth = chartWidth / series.length;
  const barWidth = Math.min(64, Math.max(28, slotWidth * 0.58));
  const points = series.map((point, index): FactsheetTrendPoint => {
    const barX =
      series.length === 1
        ? chart.left + chartWidth / 2 - barWidth / 2
        : chart.left + index * slotWidth + (slotWidth - barWidth) / 2;
    return {
      ...point,
      x: barX + barWidth / 2,
      barX,
      barWidth,
      counts: clusterYearSeverityCounts(point)
    };
  });

  points.forEach((point) => drawFactsheetTrendBar(context, point, chart.bottom, chartHeight, maxAccidents));

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = factsheetFont(17, 500);
  points.forEach((point) => {
    context.fillStyle = "#53636d";
    drawFactsheetText(layout, String(point.year), point.x, chart.bottom + 34);
  });

  drawFactsheetTrendLegend(layout, chart.left, y + height - 22);

  context.textAlign = "start";
  context.textBaseline = "alphabetic";
}

function drawFactsheetTrendBar(
  context: CanvasRenderingContext2D,
  point: FactsheetTrendPoint,
  chartBottom: number,
  chartHeight: number,
  maxAccidents: number
): void {
  let stackedCount = 0;
  for (const key of TREND_SEVERITY_STACK_ORDER) {
    const count = trendSeverityCount(point.counts, key);
    if (count <= 0) {
      continue;
    }
    const segmentTop = stackedCount + count;
    const segmentHeight = (count / maxAccidents) * chartHeight;
    const segmentY = chartBottom - (segmentTop / maxAccidents) * chartHeight;
    drawFactsheetTrendSegment(context, key, point.barX, segmentY, point.barWidth, segmentHeight);
    stackedCount = segmentTop;
  }
}

function drawFactsheetTrendSegment(
  context: CanvasRenderingContext2D,
  key: TrendSeverityKey,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  if (height <= 0) {
    return;
  }

  context.fillStyle = trendSeverityColor(key);
  context.fillRect(x, y, width, height);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 1.5;
  context.strokeRect(x, y, width, height);
}

function drawFactsheetTrendLegend(layout: FactsheetLayout, x: number, y: number): void {
  const context = layout.context;
  const items: TrendSeverityKey[] = ["fatal", "serious", "light"];
  let currentX = x;
  context.font = factsheetFont(17, 500);
  context.textAlign = "start";
  context.textBaseline = "middle";

  for (const key of items) {
    drawFactsheetTrendSegment(context, key, currentX, y - 11, 22, 16);
    context.fillStyle = "#38454b";
    const label = trendSeverityLabel(key);
    drawFactsheetText(layout, label, currentX + 30, y - 3);
    currentX += 30 + context.measureText(label).width + 28;
  }
}

function trendSeverityColor(key: TrendSeverityKey): string {
  switch (key) {
    case "fatal":
      return "#b9392b";
    case "serious":
      return "#c1842f";
    case "light":
      return "#166b6d";
  }
}

function trendSeverityLabel(key: TrendSeverityKey): string {
  switch (key) {
    case "fatal":
      return tr("severity.fatal");
    case "serious":
      return tr("severity.serious");
    case "light":
      return tr("severity.light");
  }
}

function drawFactsheetRoadUserSection(layout: FactsheetLayout, items: FactsheetRoadUserItem[]): void {
  drawFactsheetSectionHeading(layout, tr("roadUsers.title"));
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
    context.fillStyle = roadUserColor(item.key);
    context.fillRect(currentX, barY, segmentWidth, barHeight);
    currentX += segmentWidth;
  }
  layout.y += 56;

  drawFactsheetRows(
    layout,
    items.map((item) => [item.label, `${formatInteger(item.count)} (${formatSharePercent(item.share)})`])
  );
}

function drawFactsheetSourceSection(layout: FactsheetLayout, latestDate: Date | null): void {
  drawFactsheetSectionHeading(layout, tr("factsheet.dataSource"));
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

function drawFactsheetAccidentDetails(layout: FactsheetLayout, details: FactsheetAccidentDetail[]): void {
  drawFactsheetSectionHeading(layout, tr("records.title"));
  if (details.length === 0) {
    drawFactsheetParagraph(layout, tr("records.empty"), 21, 29, "#38454b");
    return;
  }

  details.forEach((detail, index) => {
    ensureFactsheetSpace(layout, 84);
    if (index > 0) {
      layout.y += 18;
    }
    const context = layout.context;
    context.fillStyle = "#172126";
    context.font = factsheetFont(22, 600);
    const heading = `${index + 1}. ${detail.heading}`;
    drawFactsheetLines(layout, wrappedCanvasLines(context, heading, FACTSHEET_CONTENT_WIDTH), FACTSHEET_MARGIN, 29);
    drawFactsheetRows(layout, detail.rows);
    layout.y += FACTSHEET_INCIDENT_LINK_TOP_GAP;
    drawFactsheetLinkRow(layout, tr("press.label"), detail.pressUrl, tr("press.searchIncident"));
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
    drawCanvasTextLines(layout, labelLines, labelX, layout.y + 18, lineHeight);
    drawContext.font = factsheetFont(18, 500);
    drawContext.fillStyle = "#172126";
    drawCanvasTextLines(layout, valueLines, valueX, layout.y + 18, lineHeight);
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
  records: FactsheetAccidentRecord[],
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
  const startTileX = Math.floor(topLeft.x / OSM_TILE_SIZE);
  const endTileX = Math.floor((topLeft.x + width) / OSM_TILE_SIZE);
  const startTileY = Math.max(0, Math.floor(topLeft.y / OSM_TILE_SIZE));
  const endTileY = Math.min(tileCount - 1, Math.floor((topLeft.y + height) / OSM_TILE_SIZE));
  let loadedTiles = 0;
  const tileJobs: Array<Promise<{ tileX: number; tileY: number; image: HTMLImageElement | null }>> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const wrappedX = wrapOsmTileX(tileX, tileCount);
      tileJobs.push(loadOsmTile(zoom, wrappedX, tileY).then((image) => ({ tileX, tileY, image })));
    }
  }

  const tiles = await Promise.all(tileJobs);
  for (const { tileX, tileY, image } of tiles) {
    if (!image) {
      continue;
    }
    const drawX = x + tileX * OSM_TILE_SIZE - topLeft.x;
    const drawY = y + tileY * OSM_TILE_SIZE - topLeft.y;
    context.drawImage(image, drawX, drawY, OSM_TILE_SIZE, OSM_TILE_SIZE);
    loadedTiles += 1;
  }

  if (loadedTiles === 0) {
    context.fillStyle = "#53636d";
    context.font = factsheetFont(22, 600);
    context.fillText(tr("factsheet.mapTilesUnavailable"), x + 24, y + 48);
  }

  drawFactsheetOsmMarkers(context, cluster, records, x, y, width, height, zoom, topLeft);
  context.restore();
  drawFactsheetMapAttribution(context, x, y, height);
}

function drawFactsheetOsmMarkers(
  context: CanvasRenderingContext2D,
  cluster: IntersectionCluster,
  records: FactsheetAccidentRecord[],
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

function drawFactsheetMapAttribution(context: CanvasRenderingContext2D, x: number, y: number, height: number): void {
  const label = tr("factsheet.mapAttribution");
  context.font = factsheetFont(15, 600);
  const labelWidth = context.measureText(label).width + 14;
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.fillRect(x + 8, y + height - 30, labelWidth, 22);
  context.fillStyle = "#1d2d34";
  context.fillText(label, x + 15, y + height - 14);
}

function chooseFactsheetMapZoom(cluster: IntersectionCluster, records: FactsheetAccidentRecord[], width: number, height: number): number {
  const offsets = records.map(({ accident }) => localMeterOffset(cluster, accident));
  const radiusMeters = maxAbsoluteOffset(Math.max(90, cluster.osmRoundaboutMatchRadiusMeters ?? 90), offsets) + 70;
  for (let zoom = 19; zoom >= 10; zoom -= 1) {
    const metersPerPixel = (156_543.03392 * Math.cos(radians(cluster.lat))) / 2 ** zoom;
    if (width * metersPerPixel >= radiusMeters * 2 && height * metersPerPixel >= radiusMeters * 2) {
      return zoom;
    }
  }
  return 10;
}

function maxSeriesAccidents(series: ClusterYearStat[], fallback: number): number {
  let maximum = fallback;
  for (const point of series) {
    maximum = Math.max(maximum, point.accidentCount);
  }
  return maximum;
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

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function factsheetPeriodLabel(cluster: IntersectionCluster, records: FactsheetAccidentRecord[]): string {
  const years = uniqueNumbers((records.length ? records.map(({ accident }) => accident.year) : cluster.years).filter(Boolean)).sort((a, b) => a - b);
  if (years.length === 0) {
    return "-";
  }
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

export function factsheetFileName(cluster: IntersectionCluster): string {
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

