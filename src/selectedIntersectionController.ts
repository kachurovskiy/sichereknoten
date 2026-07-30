import { accidentRecordRows, accidentSeverityLabel, accidentTimeLabel } from "./accidentRecordDisplay";
import { ClusterAccidentRecordMatcher, type ClusterAccidentRecordsSnapshot, type CrossingAccident } from "./clusterAccidentRecords";
import { clusterStreetNamesForDisplay } from "./clusterDisplay";
import { createFactsheetPdf, factsheetFileName, type CreateFactsheetPdfOptions } from "./factsheet";
import { tr, trf } from "./i18n";
import type { LoadingStatusKind } from "./loadingStatusPresenter";
import { RequestGate } from "./requestGate";
import { errorMessage, type TelemetryMetadata } from "./telemetry";
import type { AccidentRecord, AnalysisOptions, AnalysisResult, ClusterYearStat, IntersectionCluster } from "./types";
import {
  googleStreetViewEmbedUrl,
  mapUrlsForCluster,
  pressSearchUrlForAccident,
  pressSearchUrlForCluster,
  responsibleAuthoritySearchUrlForCluster
} from "./urlBuilders";
import { roadUserSummaryItems, SelectedIntersectionPanelView, type SelectedIntersectionPanelViewModel } from "./views/selectedIntersectionPanelView";
import { SelectedPreviewMapView, type SelectedPreviewMapIncidentPoint } from "./views/selectedPreviewMapView";
import type { RoadClassSignature } from "./views/similarView";
import type { MapCanvas } from "./mapCanvas";

const STREET_VIEW_OPEN_STORAGE_KEY = "sichere-knoten:street-view-open";

type SelectedIntersectionViewKey = "map" | "details" | "similar";
type SelectionReason = "auto" | "program" | "user";

interface SelectedIntersectionViewModel {
  cluster: IntersectionCluster;
  roadClassSignature: RoadClassSignature | null;
  panel: SelectedIntersectionPanelViewModel;
  incidentPoints: SelectedPreviewMapIncidentPoint[];
}

export interface SelectedIntersectionControllerElements {
  mapColumn: HTMLElement;
  mapView: HTMLElement;
  selectedAside: HTMLElement;
  selectedPermalinkBtn: HTMLButtonElement;
  selectionDetails: HTMLElement;
  detailsTab: HTMLButtonElement;
  similarTab: HTMLButtonElement;
  incidentDialog: HTMLDialogElement;
  incidentDialogBody: HTMLElement;
  streetViewPanel: HTMLElement;
  streetViewToggle: HTMLButtonElement;
  streetViewToggleText: HTMLElement;
  streetViewBody: HTMLElement;
  streetViewFrame: HTMLIFrameElement;
  streetViewEmpty: HTMLElement;
}

export interface SelectedIntersectionBrowseRenderResult {
  nearbyCount: number;
  stateHotspotCount: number;
}

export type MeasureSelectedIntersectionStep = <T>(
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => TelemetryMetadata
) => T;

export interface SelectedIntersectionControllerDependencies {
  elements: SelectedIntersectionControllerElements;
  panelView: SelectedIntersectionPanelView;
  previewMapView: SelectedPreviewMapView;
  map: MapCanvas;
  requestGate: RequestGate;
  getAnalysisResult: () => AnalysisResult | null;
  getAnalysisOptions: () => AnalysisOptions;
  getCachedAccidentsForState: (stateCode: string) => AccidentRecord[] | null;
  hasAccidentStateShard: (stateCode: string) => boolean;
  loadAccidentsForState: (stateCode: string) => Promise<AccidentRecord[]>;
  latestBundledFileDate: () => Date | null;
  formatSeverityPercentWithContext: (cluster: IntersectionCluster) => string;
  roadClassSignatureForStreetNames: (streetNames: string[]) => RoadClassSignature | null;
  renderVisibleSimilarView: () => void;
  renderBrowseLists: () => SelectedIntersectionBrowseRenderResult;
  getActiveView: () => string;
  isMobileLayout: () => boolean;
  setView: (view: SelectedIntersectionViewKey) => void;
  setStatus: (message: string, progress: number, kind?: LoadingStatusKind) => void;
  updateIntersectionSelectionUrl: (cluster: IntersectionCluster) => void;
  scheduleMapRefresh: () => void;
  measureStep: MeasureSelectedIntersectionStep;
}

export class SelectedIntersectionController {
  private selectedClusterValue: IntersectionCluster | null = null;
  private selectedRoadClassSignatureValue: RoadClassSignature | null = null;
  private isStreetViewOpen = readStoredStreetViewOpen();
  private readonly clusterAccidentRecordMatcher: ClusterAccidentRecordMatcher;

  constructor(private readonly deps: SelectedIntersectionControllerDependencies) {
    this.clusterAccidentRecordMatcher = new ClusterAccidentRecordMatcher(deps.measureStep);
  }

  get selectedCluster(): IntersectionCluster | null {
    return this.selectedClusterValue;
  }

  get selectedClusterId(): string | null {
    return this.selectedClusterValue?.id ?? null;
  }

  get selectedRoadClassSignature(): RoadClassSignature | null {
    return this.selectedRoadClassSignatureValue;
  }

  get hasSelection(): boolean {
    return this.selectedClusterValue !== null;
  }

  get canCompareSimilar(): boolean {
    return this.selectedClusterValue !== null && this.selectedRoadClassSignatureValue !== null;
  }

  bindEvents(): void {
    this.deps.elements.selectedPermalinkBtn.addEventListener("click", () => void this.copySelectedIntersectionPermalink());
    this.deps.elements.selectionDetails.addEventListener("click", (event) => this.handleSelectionDetailsClick(event));
    this.deps.elements.incidentDialog.addEventListener("click", (event) => this.handleIncidentDialogClick(event));
    this.deps.elements.streetViewToggle.addEventListener("click", () => this.toggleStreetViewPanel());
  }

  resetSelectionState(): void {
    this.selectedClusterValue = null;
    this.selectedRoadClassSignatureValue = null;
  }

  clearAccidentRecordCaches(): void {
    this.clusterAccidentRecordMatcher.clearCaches();
  }

  handleMapSelection(cluster: IntersectionCluster | null, reason: SelectionReason): void {
    const previousClusterId = this.selectedClusterValue?.id ?? null;
    this.deps.measureStep("store selected cluster", cluster?.id ?? null, () => {
      this.selectedClusterValue = cluster;
      this.selectedRoadClassSignatureValue = null;
    });
    if (cluster) {
      this.deps.updateIntersectionSelectionUrl(cluster);
    }
    if (previousClusterId !== (cluster?.id ?? null)) {
      this.deps.requestGate.cancel("selectedAccidentRecords");
      this.deps.requestGate.cancel("factsheet");
    }
    this.deps.measureStep(
      "render selected intersection panel",
      cluster?.id ?? null,
      () => this.renderSelection(cluster),
      () => ({
        selected: Boolean(cluster),
        accidentCount: cluster?.accidentCount ?? 0
      })
    );
    this.deps.measureStep(
      "rerender browse lists after selection",
      cluster?.id ?? null,
      this.deps.renderBrowseLists,
      (counts) => ({
        stateHotspotCount: counts.stateHotspotCount,
        nearbyCount: counts.nearbyCount
      })
    );

    if (!cluster) {
      return;
    }

    if (reason === "user" && this.deps.isMobileLayout()) {
      this.deps.measureStep("mobile map focus", cluster.id, () => this.deps.map.focus(cluster));
      this.deps.measureStep("mobile set view details", cluster.id, () => this.deps.setView("details"), () => ({
        activeView: this.deps.getActiveView()
      }));
    }
  }

  clearSelection(): void {
    this.handleMapSelection(null, "program");
  }

  updateContextTabs(): void {
    const hasSelection = this.selectedClusterValue !== null;
    this.deps.elements.detailsTab.disabled = !hasSelection;
    this.deps.elements.similarTab.hidden = false;
    this.deps.elements.similarTab.disabled = false;
  }

  updateStreetViewPanel(): void {
    const cluster = this.selectedClusterValue;
    const hasSelection = cluster !== null;
    const isExpanded = hasSelection && this.isStreetViewOpen;
    const { elements } = this.deps;

    elements.streetViewPanel.hidden = !hasSelection;
    elements.mapColumn.classList.toggle("street-view-open", isExpanded);
    elements.streetViewToggle.setAttribute("aria-expanded", String(isExpanded));
    elements.streetViewToggleText.textContent = isExpanded ? tr("action.hide") : tr("action.show");
    elements.streetViewBody.hidden = !isExpanded;

    if (!hasSelection || !isExpanded) {
      this.clearStreetViewFrame();
      this.deps.scheduleMapRefresh();
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
    this.deps.scheduleMapRefresh();
  }

  openUnclusteredIncidentDialog(accident: AccidentRecord): void {
    const { elements } = this.deps;
    elements.incidentDialogBody.innerHTML = this.deps.panelView.renderIncidentDialogHtml(accident);
    if (typeof elements.incidentDialog.showModal === "function") {
      elements.incidentDialog.showModal();
    } else {
      elements.incidentDialog.setAttribute("open", "");
    }
  }

  private renderSelection(cluster: IntersectionCluster | null): void {
    if (!cluster) {
      this.renderEmptySelection();
      return;
    }

    const viewModel = this.buildSelectedIntersectionViewModel(cluster);
    this.applySelectedIntersectionViewModel(viewModel);
    if (viewModel.panel.accidentRecordsLoading) {
      this.queueSelectedAccidentRecordsLoad(cluster);
    }
  }

  private renderEmptySelection(): void {
    const { elements } = this.deps;
    elements.selectedAside.hidden = true;
    elements.mapView.classList.remove("has-selection");
    this.deps.panelView.renderEmpty();
    this.deps.previewMapView.clear();
    this.deps.map.setSelectedIncidentPoints([]);
    this.updateContextTabs();
    if (this.deps.getActiveView() === "details") {
      this.deps.setView("map");
    } else {
      if (this.deps.getActiveView() === "similar") {
        this.deps.renderVisibleSimilarView();
      }
      this.updateStreetViewPanel();
    }
  }

  private buildSelectedIntersectionViewModel(cluster: IntersectionCluster): SelectedIntersectionViewModel {
    const urls = this.deps.measureStep(
      "build selected external URLs",
      cluster.id,
      () => ({
        ...mapUrlsForCluster(cluster),
        authoritySearchUrl: responsibleAuthoritySearchUrlForCluster(cluster)
      }),
      () => ({ urlCount: 4 })
    );
    const accidentRecordSnapshot = this.deps.measureStep(
      "find selected accident records",
      cluster.id,
      () => this.clusterAccidentRecordsSnapshot(cluster),
      (snapshot) => ({
        recordCount: snapshot.records.length,
        clusterAccidentCount: cluster.accidentCount
      })
    );
    const accidentRecords = accidentRecordSnapshot.records;
    const streetNames = this.deps.measureStep(
      "derive selected street names",
      cluster.id,
      () => clusterStreetNamesForDisplay(cluster, accidentRecords),
      (names) => ({ streetCount: names.length })
    );
    const roadClassSignature = this.deps.measureStep(
      "derive selected road class signature",
      cluster.id,
      () => this.deps.roadClassSignatureForStreetNames(streetNames),
      (signature) => ({ comparable: signature !== null, roadClass: signature?.label ?? null })
    );
    const pressSearchUrl = this.deps.measureStep("build press search URL", cluster.id, () =>
      pressSearchUrlForCluster(cluster, streetNames)
    );
    const result = this.deps.getAnalysisResult();
    const analysisYears = result?.years.length ? result.years : cluster.years;
    const trendSeries = this.deps.measureStep(
      "derive selected trend series",
      cluster.id,
      () => this.clusterTrendSeries(cluster, analysisYears),
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

  private applySelectedIntersectionViewModel(viewModel: SelectedIntersectionViewModel): void {
    const { cluster } = viewModel;
    const { elements } = this.deps;
    this.selectedRoadClassSignatureValue = viewModel.roadClassSignature;
    elements.selectedAside.hidden = false;
    elements.mapView.classList.add("has-selection");
    this.deps.measureStep(
      "update selected incident points",
      cluster.id,
      () => this.deps.map.setSelectedIncidentPoints(viewModel.incidentPoints),
      () => ({ pointCount: viewModel.incidentPoints.length })
    );
    this.deps.measureStep(
      "render selected preview map",
      cluster.id,
      () => this.deps.previewMapView.render({ cluster, incidentPoints: viewModel.incidentPoints }),
      () => ({ pointCount: viewModel.incidentPoints.length })
    );

    this.deps.measureStep("render selected panel", cluster.id, () => this.deps.panelView.render(viewModel.panel));
    this.deps.measureStep("update details tabs", cluster.id, () => this.updateContextTabs());
    if (this.deps.getActiveView() === "similar") {
      this.deps.measureStep("render visible comparison", cluster.id, this.deps.renderVisibleSimilarView);
    }
    this.deps.measureStep("update street view panel", cluster.id, () => this.updateStreetViewPanel(), () => ({
      streetViewOpen: this.isStreetViewOpen
    }));
  }

  private toggleStreetViewPanel(): void {
    this.isStreetViewOpen = !this.isStreetViewOpen;
    writeStoredStreetViewOpen(this.isStreetViewOpen);
    this.updateStreetViewPanel();
  }

  private clearStreetViewFrame(): void {
    const { streetViewFrame } = this.deps.elements;
    streetViewFrame.hidden = true;
    streetViewFrame.removeAttribute("src");
    delete streetViewFrame.dataset.src;
  }

  private closeUnclusteredIncidentDialog(): void {
    const { incidentDialog } = this.deps.elements;
    if (incidentDialog.open) {
      incidentDialog.close();
    }
  }

  private handleIncidentDialogClick(event: MouseEvent): void {
    if (event.target === this.deps.elements.incidentDialog) {
      this.closeUnclusteredIncidentDialog();
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest("[data-incident-dialog-close]")) {
      this.closeUnclusteredIncidentDialog();
    }
  }

  private clusterAccidentRecordsSnapshot(cluster: IntersectionCluster): ClusterAccidentRecordsSnapshot {
    const sourceRecords = this.cachedAccidentRecordsForCluster(cluster);
    return this.clusterAccidentRecordMatcher.snapshot(
      cluster,
      sourceRecords,
      this.deps.hasAccidentStateShard(cluster.stateCode),
      this.deps.getAnalysisOptions()
    );
  }

  private cachedAccidentRecordsForCluster(cluster: IntersectionCluster): AccidentRecord[] | null {
    return this.deps.getCachedAccidentsForState(cluster.stateCode);
  }

  private queueSelectedAccidentRecordsLoad(cluster: IntersectionCluster): void {
    const requestToken = this.deps.requestGate.start("selectedAccidentRecords", cluster.id);
    void this.deps
      .loadAccidentsForState(cluster.stateCode)
      .then(() => {
        if (this.selectedClusterValue?.id !== cluster.id || !this.deps.requestGate.isCurrent(requestToken)) {
          return;
        }
        this.renderSelection(cluster);
      })
      .catch((error) => {
        if (this.selectedClusterValue?.id === cluster.id && this.deps.requestGate.isCurrent(requestToken)) {
          console.warn("[Safe Intersections] Could not load selected accident records.", error);
        }
      });
  }

  private async clusterAccidentRecordsReady(cluster: IntersectionCluster): Promise<CrossingAccident[]> {
    const sourceRecords = this.cachedAccidentRecordsForCluster(cluster) ?? (await this.deps.loadAccidentsForState(cluster.stateCode));
    return this.clusterAccidentRecordMatcher.records(cluster, sourceRecords, this.deps.getAnalysisOptions());
  }

  private clusterTrendSeries(cluster: IntersectionCluster, years: number[]): ClusterYearStat[] {
    const byYear = new Map(cluster.yearlyStats.map((stats) => [stats.year, stats]));

    return years.map((year) => {
      const existing = byYear.get(year);
      if (existing) {
        return existing;
      }
      return {
        year,
        accidentCount: 0,
        fatalCount: 0,
        seriousCount: 0,
        lightCount: 0
      };
    });
  }

  private handleSelectionDetailsClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) {
      return;
    }

    const factsheetButton = event.target.closest<HTMLButtonElement>("[data-selected-action='factsheet']");
    if (factsheetButton) {
      void this.downloadSelectedFactsheet();
      return;
    }

    const similarButton = event.target.closest<HTMLButtonElement>("[data-selected-action='similar']");
    if (similarButton) {
      this.deps.setView("similar");
    }
  }

  private async downloadSelectedFactsheet(): Promise<void> {
    const cluster = this.selectedClusterValue;
    if (!cluster) {
      this.deps.setStatus(tr("details.selectFirst"), 100, "idle");
      return;
    }
    const requestToken = this.deps.requestGate.start("factsheet", cluster.id);

    const factsheetButtons = this.deps.panelView.factsheetButtons();
    factsheetButtons.forEach((button) => {
      button.disabled = true;
    });
    this.deps.setStatus(tr("status.factsheetCreating"), 100);
    try {
      const records = await this.clusterAccidentRecordsReady(cluster);
      if (this.selectedClusterValue?.id !== cluster.id || !this.deps.requestGate.isCurrent(requestToken)) {
        return;
      }
      const blob = await createFactsheetPdf(this.createSelectedFactsheetOptions(cluster, records));
      if (this.selectedClusterValue?.id !== cluster.id || !this.deps.requestGate.isCurrent(requestToken)) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = factsheetFileName(cluster);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      this.deps.setStatus(tr("status.factsheetDownloaded"), 100);
    } catch (error) {
      if (this.deps.requestGate.isCurrent(requestToken)) {
        this.deps.setStatus(trf("status.factsheetFailed", { error: errorMessage(error) }), 100, "problem");
      }
    } finally {
      if (this.deps.requestGate.isCurrent(requestToken)) {
        factsheetButtons.forEach((button) => {
          button.disabled = false;
        });
      }
    }
  }

  private async copySelectedIntersectionPermalink(): Promise<void> {
    const cluster = this.selectedClusterValue;
    if (!cluster) {
      this.deps.setStatus(tr("details.selectFirst"), 100, "idle");
      return;
    }

    this.deps.updateIntersectionSelectionUrl(cluster);
    const permalink = window.location.href;
    this.deps.elements.selectedPermalinkBtn.disabled = true;
    try {
      await writeClipboardText(permalink);
      this.deps.setStatus(tr("status.permalinkCopied"), 100, "idle");
    } catch (error) {
      this.deps.setStatus(trf("status.permalinkCopyFailed", { error: errorMessage(error) }), 100, "problem");
    } finally {
      this.deps.elements.selectedPermalinkBtn.disabled = false;
    }
  }

  private createSelectedFactsheetOptions(cluster: IntersectionCluster, records: CrossingAccident[]): CreateFactsheetPdfOptions {
    const result = this.deps.getAnalysisResult();
    const selectedYears = result?.years.length ? result.years : cluster.years;
    const streetOrder = clusterStreetNamesForDisplay(cluster, records);
    const options = this.deps.getAnalysisOptions();
    return {
      cluster,
      records,
      selectedYears,
      trendSeries: this.clusterTrendSeries(cluster, selectedYears),
      trendPeriodYears: options.severityPercent.trendYears,
      clusterRadiusMeters: options.clusterRadiusMeters,
      latestBundledFileDate: this.deps.latestBundledFileDate(),
      severityPercentText: this.deps.formatSeverityPercentWithContext(cluster),
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
