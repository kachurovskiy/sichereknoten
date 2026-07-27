import { cloneAnalysisOptions } from "./analysisOptions";
import { analyzeDangerousIntersectionsInBackground, type AnalysisExecutionPlan } from "./analysisRunner";
import type { DataRepository, AnalysisCacheContext, DataRepositoryTelemetry } from "./dataRepository";
import { formatInteger } from "./formatting";
import { tr, trf } from "./i18n";
import { roadUserFocusKey } from "./roadUsers";
import type { RequestGate, RequestToken } from "./requestGate";
import {
  createInitializationTelemetry,
  createPostRenderCacheTelemetry,
  errorMessage,
  logInitializationTelemetry,
  measureInitializationStep,
  recordInitializationStep,
  type InitializationTelemetry,
  type InitializationTelemetryStatus
} from "./telemetry";
import type { AccidentRecord, AnalysisOptions, AnalysisResult } from "./types";

type LoadingStatusKind = "normal" | "problem" | "idle";

interface PendingAnalysisCacheWrite {
  cacheContext: AnalysisCacheContext;
  options: AnalysisOptions;
  result: AnalysisResult;
}

interface PostRenderCacheWrites {
  analysis: PendingAnalysisCacheWrite | null;
}

export interface AnalysisCoordinatorAccidentLoadContext {
  scope: "all" | "analysis";
  options: AnalysisOptions | null;
}

export interface AnalysisCoordinatorDependencies {
  dataRepository: DataRepository;
  requestGate: RequestGate;
  appVersion: string;
  analysisCacheVersion: string;
  readOptions: () => AnalysisOptions;
  normalizeOptionsDraft: () => void;
  resetRuntimeState: () => void;
  onAccidentsLoaded: (records: AccidentRecord[], context: AnalysisCoordinatorAccidentLoadContext) => void;
  commitAnalysisState: (options: AnalysisOptions, result: AnalysisResult, dataVersion: string | null) => void;
  populateFilters: () => void;
  renderAll: () => void | Promise<void>;
  scheduleSelectionSupportPrewarm: () => void;
  scheduleAfterFirstRender: (work: () => void) => void;
  setBusy: (isBusy: boolean) => void;
  setStatus: (message: string, progress: number, kind?: LoadingStatusKind) => void;
}

export class AnalysisCoordinator {
  private activeDataVersion: string | null = null;
  private postRenderCacheWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AnalysisCoordinatorDependencies) {}

  async loadBundledData(): Promise<void> {
    const telemetry = createInitializationTelemetry(this.deps.appVersion);
    let analysisStarted = false;
    let telemetryStatus: Exclude<InitializationTelemetryStatus, "running"> = "done";
    this.deps.setBusy(true);

    try {
      this.activeDataVersion = null;
      this.deps.resetRuntimeState();
      this.deps.dataRepository.resetRuntimeState();
      this.deps.populateFilters();
      await this.deps.renderAll();

      this.deps.setStatus(tr("status.loadingDataManifest"), 2);
      await this.deps.dataRepository.ensureManifest(this.repositoryTelemetry(telemetry));
      const dataVersion = this.deps.dataRepository.dataVersion();
      telemetry.dataVersion = dataVersion;
      this.activeDataVersion = dataVersion;
      this.deps.populateFilters();
      recordInitializationStep(telemetry, "skip parsed data cache", dataVersion, {
        reason: "normalized bundle is faster than IndexedDB object cache"
      });

      const options = this.deps.readOptions();
      const cacheContext = { dataVersion, appVersion: this.deps.analysisCacheVersion };
      const detail = analysisTelemetryDetail(options);
      const bundledDefaultAnalysis = await this.deps.dataRepository.readDefaultAnalysis(
        dataVersion,
        this.deps.analysisCacheVersion,
        options,
        detail,
        this.repositoryTelemetry(telemetry)
      );
      if (bundledDefaultAnalysis) {
        await this.commitAndRender(telemetry, options, bundledDefaultAnalysis);
        this.deps.setStatus(
          trf("status.intersectionClustersLoadedFromBundle", { count: formatInteger(bundledDefaultAnalysis.clusters.length) }),
          100
        );
        return;
      }

      this.deps.setStatus(tr("status.checkingAnalysisCache"), 20);
      const cachedAnalysis = await measureInitializationStep(
        telemetry,
        "read analysis cache",
        detail,
        () => this.deps.dataRepository.readCachedAnalysis(cacheContext, options),
        (cachedResult) => ({
          cacheHit: Boolean(cachedResult),
          clusterCount: cachedResult?.clusters.length ?? 0
        })
      );
      if (cachedAnalysis) {
        await this.commitAndRender(telemetry, options, cachedAnalysis);
        this.deps.setStatus(
          trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(cachedAnalysis.clusters.length) }),
          100
        );
        return;
      }

      this.deps.setStatus(tr("status.cacheMissParsingBundled"), 10);
      const accidents = await this.loadAccidentData(telemetry);
      this.deps.setStatus(trf("status.accidentRecordsLoaded", { count: formatInteger(accidents.length) }), 60);

      analysisStarted = true;
      const requestToken = this.deps.requestGate.start("analysis", "startup fallback");
      void this.runAnalysisWithCache(
        options,
        cacheContext,
        telemetry,
        "analysis cache already missed before accident records loaded",
        null,
        requestToken
      );
    } catch (error) {
      telemetryStatus = "error";
      this.deps.setStatus(errorMessage(error), 0, "problem");
    } finally {
      if (!analysisStarted) {
        this.deps.setBusy(false);
        logInitializationTelemetry(telemetry, telemetryStatus);
      }
    }
  }

  runAnalysis(): void {
    this.deps.normalizeOptionsDraft();
    const options = this.deps.readOptions();
    const cacheContext = this.activeDataVersion
      ? { dataVersion: this.activeDataVersion, appVersion: this.deps.analysisCacheVersion }
      : null;
    const requestToken = this.deps.requestGate.start("analysis", analysisTelemetryDetail(options));
    this.deps.setBusy(true);
    void this.runAnalysisWhenAccidentsReady(requestToken, options, cacheContext, null);
  }

  private async runAnalysisWhenAccidentsReady(
    requestToken: RequestToken,
    options: AnalysisOptions,
    cacheContext: AnalysisCacheContext | null,
    initializationTelemetry: InitializationTelemetry | null
  ): Promise<void> {
    try {
      await this.runAnalysisWithCache(options, cacheContext, initializationTelemetry, null, null, requestToken);
    } catch (error) {
      if (this.deps.requestGate.isCurrent(requestToken)) {
        this.deps.setStatus(errorMessage(error), 0, "problem");
        this.deps.setBusy(false);
        logInitializationTelemetry(initializationTelemetry, "error");
      }
    }
  }

  private async runAnalysisWithCache(
    options: AnalysisOptions,
    cacheContext: AnalysisCacheContext | null,
    initializationTelemetry: InitializationTelemetry | null = null,
    skipAnalysisCacheReason: string | null = null,
    analysisAccidents: AccidentRecord[] | null = null,
    requestToken: RequestToken | null = null
  ): Promise<void> {
    let telemetryStatus: Exclude<InitializationTelemetryStatus, "running"> = "done";
    const detail = analysisTelemetryDetail(options);

    try {
      if (cacheContext && skipAnalysisCacheReason) {
        recordInitializationStep(initializationTelemetry, "skip analysis cache", detail, {
          reason: skipAnalysisCacheReason
        });
      } else if (cacheContext) {
        this.deps.setStatus(tr("status.checkingAnalysisCache"), 75);
        const cached = await measureInitializationStep(
          initializationTelemetry,
          "read analysis cache",
          detail,
          () => this.deps.dataRepository.readCachedAnalysis(cacheContext, options),
          (cachedResult) => ({
            cacheHit: Boolean(cachedResult),
            clusterCount: cachedResult?.clusters.length ?? 0
          })
        );
        if (cached) {
          if (requestToken && !this.deps.requestGate.isCurrent(requestToken)) {
            return;
          }
          await this.commitAndRender(initializationTelemetry, options, cached);
          this.deps.setStatus(trf("status.intersectionClustersLoadedFromCache", { count: formatInteger(cached.clusters.length) }), 100);
          return;
        }
      }

      if (requestToken && !this.deps.requestGate.isCurrent(requestToken)) {
        return;
      }
      this.deps.setStatus(tr("status.analyzingIntersections"), 75);
      await yieldToBrowser();
      let analysisPlan: AnalysisExecutionPlan | null = null;
      const sourceAccidents = analysisAccidents ?? (await this.loadAccidentsForAnalysis(options, initializationTelemetry));
      if (requestToken && !this.deps.requestGate.isCurrent(requestToken)) {
        return;
      }
      const analyzedResult = await measureInitializationStep(
        initializationTelemetry,
        "analyze intersections",
        detail,
        () =>
          analyzeDangerousIntersectionsInBackground(sourceAccidents, options, (plan) => {
            analysisPlan = plan;
            if (!requestToken || this.deps.requestGate.isCurrent(requestToken)) {
              this.updateAnalysisPlanStatus();
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
      if (requestToken && !this.deps.requestGate.isCurrent(requestToken)) {
        return;
      }
      await this.commitAndRender(initializationTelemetry, options, analyzedResult);

      this.deps.setStatus(trf("status.intersectionClustersAnalyzed", { count: formatInteger(analyzedResult.clusters.length) }), 100);
      this.enqueuePostRenderCacheWrites(initializationTelemetry, {
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
      if (!requestToken || this.deps.requestGate.isCurrent(requestToken)) {
        telemetryStatus = "error";
        this.deps.setStatus(errorMessage(error), 0, "problem");
      }
    } finally {
      if (!requestToken || this.deps.requestGate.isCurrent(requestToken)) {
        this.deps.setBusy(false);
        logInitializationTelemetry(initializationTelemetry, telemetryStatus);
      }
    }
  }

  private async commitAndRender(
    initializationTelemetry: InitializationTelemetry | null,
    options: AnalysisOptions,
    analysisResult: AnalysisResult
  ): Promise<void> {
    this.deps.commitAnalysisState(options, analysisResult, this.activeDataVersion);
    await measureInitializationStep(
      initializationTelemetry,
      "render analysis results",
      analysisTelemetryDetail(options),
      async () => {
        await this.deps.renderAll();
      },
      () => ({ clusterCount: analysisResult.clusters.length })
    );
    this.deps.scheduleSelectionSupportPrewarm();
  }

  private updateAnalysisPlanStatus(): void {
    this.deps.setStatus(tr("status.analyzingIntersections"), 75);
  }

  private async loadAccidentData(telemetry: InitializationTelemetry | null, options: { updateStatus?: boolean } = {}): Promise<AccidentRecord[]> {
    const records = await this.deps.dataRepository.loadAllAccidents(
      this.repositoryTelemetry(telemetry),
      options.updateStatus ?? true
        ? ({ current, total }) => {
            this.deps.setStatus(
              trf("status.loadingBundledChunk", { current, total }),
              Math.min(60, 10 + Math.floor((current / total) * 50))
            );
          }
        : null
    );
    this.deps.onAccidentsLoaded(records, { scope: "all", options: null });
    return records;
  }

  private async loadAccidentsForAnalysis(
    options: AnalysisOptions,
    telemetry: InitializationTelemetry | null
  ): Promise<AccidentRecord[]> {
    const records = await this.deps.dataRepository.loadAccidentsForAnalysis(
      options,
      this.repositoryTelemetry(telemetry),
      ({ current, total }) => {
        this.deps.setStatus(
          trf("status.loadingBundledChunk", { current, total }),
          Math.min(60, 10 + Math.floor((current / total) * 50))
        );
      }
    );
    this.deps.onAccidentsLoaded(records, { scope: "analysis", options });
    return records;
  }

  private enqueuePostRenderCacheWrites(
    initializationTelemetry: InitializationTelemetry | null,
    writes: PostRenderCacheWrites
  ): void {
    if (!writes.analysis) {
      return;
    }

    const telemetry = createPostRenderCacheTelemetry(initializationTelemetry);
    this.deps.scheduleAfterFirstRender(() => {
      this.postRenderCacheWriteQueue = this.postRenderCacheWriteQueue
        .catch(() => undefined)
        .then(() => this.writePostRenderCaches(telemetry, writes));
      void this.postRenderCacheWriteQueue;
    });
  }

  private async writePostRenderCaches(telemetry: InitializationTelemetry | null, writes: PostRenderCacheWrites): Promise<void> {
    let status: Exclude<InitializationTelemetryStatus, "running"> = "done";

    if (writes.analysis) {
      try {
        await measureInitializationStep(
          telemetry,
          "write analysis cache",
          analysisTelemetryDetail(writes.analysis.options),
          () =>
            this.deps.dataRepository.writeCachedAnalysis(
              writes.analysis!.cacheContext,
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

  private repositoryTelemetry(telemetry: InitializationTelemetry | null): DataRepositoryTelemetry | null {
    if (!telemetry) {
      return null;
    }

    return {
      measure: (name, detail, work, metadata) => measureInitializationStep(telemetry, name, detail, work, metadata),
      record: (name, detail, metadata) => recordInitializationStep(telemetry, name, detail, metadata)
    };
  }
}

function analysisTelemetryDetail(options: AnalysisOptions): string {
  const years = Array.from(options.years).sort((a, b) => a - b).join(",") || "all";
  const roadUsers = roadUserFocusKey(options.roadUserFocus) || "all";
  return `state=${options.stateCode}; years=${years}; roadUsers=${roadUsers}; radius=${options.clusterRadiusMeters}m; minAccidents=${options.minAccidents}`;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
