import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const supportModule = loadSupportModule();

test("analysis coordinator commits bundled default analysis during startup", async () => {
  const { AnalysisCoordinator, TRANSLATIONS, configureI18n } = await supportModule;
  configureI18n("en", TRANSLATIONS);
  const startupAnalysis = sampleAnalysisResult("startup");
  const repository = stubRepository({
    readDefaultAnalysis: async () => startupAnalysis,
    readCachedAnalysis: async () => {
      throw new Error("cache should not be read after bundled default analysis");
    },
    loadAllAccidents: async () => {
      throw new Error("accidents should not be loaded after bundled default analysis");
    }
  });
  const calls = coordinatorCalls();
  const coordinator = new AnalysisCoordinator(createCoordinatorDeps(repository, calls));

  await withMutedTelemetry(() => coordinator.loadBundledData());

  assert.equal(repository.resetRuntimeStateCalls, 1);
  assert.equal(repository.ensureManifestCalls, 1);
  assert.equal(calls.resetRuntimeState, 1);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].result, startupAnalysis);
  assert.equal(calls.commits[0].dataVersion, "data-v1");
  assert.equal(calls.renderAll, 2);
  assert.equal(calls.selectionPrewarm, 1);
  assert.deepEqual(calls.busy, [true, false]);
  assert.deepEqual(calls.loadedAccidents, []);
});

test("analysis coordinator runs analysis on cache miss and writes cache after render", async () => {
  const { AnalysisCoordinator, TRANSLATIONS, configureI18n } = await supportModule;
  configureI18n("en", TRANSLATIONS);
  const startupAnalysis = sampleAnalysisResult("startup");
  const analysisAccidents = [sampleAccident()];
  const writes = [];
  const repository = stubRepository({
    readDefaultAnalysis: async () => startupAnalysis,
    readCachedAnalysis: async () => null,
    loadAccidentsForAnalysis: async function (_options, _telemetry, onProgress) {
      this.loadAccidentsForAnalysisCalls += 1;
      onProgress?.({ current: 1, total: 1 });
      return analysisAccidents;
    },
    writeCachedAnalysis: async (cacheContext, options, result) => {
      writes.push({ cacheContext, options, result });
    }
  });
  const calls = coordinatorCalls();
  const deps = createCoordinatorDeps(repository, calls);
  const coordinator = new AnalysisCoordinator(deps);

  await withMutedTelemetry(async () => {
    await coordinator.loadBundledData();
    calls.resetAfterStartup();
    coordinator.runAnalysis();
    await waitFor(() => writes.length === 1);
  });

  assert.equal(repository.loadAccidentsForAnalysisCalls, 1);
  assert.equal(calls.loadedAccidents.length, 1);
  assert.equal(calls.loadedAccidents[0].context.scope, "analysis");
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0].dataVersion, "data-v1");
  assert.equal(calls.commits[0].result.clusters.length, 1);
  assert.deepEqual(writes[0].cacheContext, { dataVersion: "data-v1", appVersion: "analysis-v1" });
  assert.equal(writes[0].result.clusters.length, 1);
  assert.deepEqual(calls.busy, [true, false]);
  assert.equal(calls.selectionPrewarm, 1);
});

async function loadSupportModule() {
  const result = await build({
    stdin: {
      contents: `
        export * from "./src/analysisCoordinator.ts";
        export { configureI18n } from "./src/i18n.ts";
        export { TRANSLATIONS } from "./src/translations.ts";
      `,
      resolveDir: process.cwd(),
      sourcefile: "analysisCoordinator.test-entry.ts",
      loader: "ts"
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    legalComments: "none"
  });
  const code = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return import(moduleUrl);
}

function createCoordinatorDeps(repository, calls) {
  return {
    dataRepository: repository,
    requestGate: createRequestGate(),
    appVersion: "app-v1",
    analysisCacheVersion: "analysis-v1",
    readOptions: () => sampleOptions(),
    normalizeOptionsDraft: () => {
      calls.normalizeOptionsDraft += 1;
    },
    resetRuntimeState: () => {
      calls.resetRuntimeState += 1;
    },
    onAccidentsLoaded: (records, context) => {
      calls.loadedAccidents.push({ records, context });
    },
    commitAnalysisState: (options, result, dataVersion) => {
      calls.commits.push({ options, result, dataVersion });
    },
    populateFilters: () => {
      calls.populateFilters += 1;
    },
    renderAll: () => {
      calls.renderAll += 1;
    },
    scheduleSelectionSupportPrewarm: () => {
      calls.selectionPrewarm += 1;
    },
    scheduleAfterFirstRender: (work) => {
      setTimeout(work, 0);
    },
    setBusy: (isBusy) => {
      calls.busy.push(isBusy);
    },
    setStatus: (message, progress, kind = "normal") => {
      calls.statuses.push({ message, progress, kind });
    }
  };
}

function coordinatorCalls() {
  return {
    normalizeOptionsDraft: 0,
    resetRuntimeState: 0,
    loadedAccidents: [],
    commits: [],
    populateFilters: 0,
    renderAll: 0,
    selectionPrewarm: 0,
    busy: [],
    statuses: [],
    resetAfterStartup() {
      this.normalizeOptionsDraft = 0;
      this.loadedAccidents = [];
      this.commits = [];
      this.renderAll = 0;
      this.selectionPrewarm = 0;
      this.busy = [];
      this.statuses = [];
    }
  };
}

function stubRepository(overrides = {}) {
  return {
    resetRuntimeStateCalls: 0,
    ensureManifestCalls: 0,
    loadAccidentsForAnalysisCalls: 0,
    resetRuntimeState() {
      this.resetRuntimeStateCalls += 1;
    },
    async ensureManifest() {
      this.ensureManifestCalls += 1;
      return { version: "data-v1", files: [] };
    },
    dataVersion() {
      return "data-v1";
    },
    async readDefaultAnalysis() {
      return null;
    },
    async readCachedAnalysis() {
      return null;
    },
    async loadAllAccidents(_telemetry, onProgress) {
      onProgress?.({ current: 1, total: 1 });
      return [sampleAccident()];
    },
    async loadAccidentsForAnalysis(options, telemetry, onProgress) {
      this.loadAccidentsForAnalysisCalls += 1;
      onProgress?.({ current: 1, total: 1 });
      return [sampleAccident()];
    },
    async writeCachedAnalysis() {},
    ...overrides
  };
}

function createRequestGate() {
  const latestIds = new Map();
  return {
    start(kind, detail = null) {
      const id = (latestIds.get(kind) ?? 0) + 1;
      latestIds.set(kind, id);
      return { kind, id, detail };
    },
    cancel(kind) {
      latestIds.set(kind, (latestIds.get(kind) ?? 0) + 1);
    },
    isCurrent(token) {
      return latestIds.get(token.kind) === token.id;
    }
  };
}

function sampleOptions() {
  return {
    clusterRadiusMeters: 50,
    minAccidents: 1,
    years: new Set([2025]),
    roadUserFocus: new Set(),
    stateCode: "all",
    severityPercent: {
      fatalWeight: 3,
      seriousWeight: 1,
      fullSampleAccidents: 1,
      trendYears: 5,
      trendDeadZone: 0.08,
      trendFullSignal: 0.25,
      maxTrendAdjustment: 0.2,
      maxSeverityPercent: 1
    }
  };
}

function sampleAnalysisResult(id) {
  const cluster = sampleCluster({ id: `c-${id}` });
  return {
    clusters: [cluster],
    stateSummaries: [
      {
        stateCode: cluster.stateCode,
        stateName: cluster.stateName,
        accidentCount: cluster.accidentCount,
        clusterCount: 1,
        fatalCount: cluster.fatalCount,
        seriousCount: cluster.seriousCount,
        severityPercent: cluster.severityPercent,
        topCluster: cluster
      }
    ],
    stateAccidentSummaries: [],
    regionAccidentSummaries: [],
    filteredAccidentCount: cluster.accidentCount,
    years: [2025]
  };
}

function sampleCluster(overrides = {}) {
  return {
    id: "c-1",
    lon: 7.12345,
    lat: 50.98765,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: null,
    administrativeRegionName: null,
    administrativeRegionPopulation: null,
    districtCode: null,
    districtName: null,
    municipalityCode: null,
    municipalityName: null,
    municipalityPopulation: null,
    accidentCount: 1,
    fatalCount: 1,
    seriousCount: 0,
    lightCount: 0,
    vulnerableCount: 0,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 1,
    years: [2025],
    yearlyStats: [{ year: 2025, accidentCount: 1 }],
    accidentTrend: {
      direction: "unknown",
      slopePerYear: null,
      relativeSlopePerYear: null,
      startAccidents: null,
      endAccidents: null,
      years: 1
    },
    ...overrides
  };
}

function sampleAccident(overrides = {}) {
  return {
    id: "a-1",
    recordIndex: 0,
    serialNumber: null,
    source: "sample.csv",
    sourceType: "csv",
    streetName: null,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: null,
    administrativeRegionName: null,
    districtCode: null,
    districtName: null,
    municipalityCode: null,
    municipalityName: null,
    year: 2025,
    month: null,
    day: null,
    hour: null,
    weekday: null,
    category: 1,
    accidentKind: null,
    accidentType: null,
    lightCondition: null,
    roadSurface: null,
    plausibilityLevel: null,
    linRefX: null,
    linRefY: null,
    lon: 7.12345,
    lat: 50.98765,
    involvesBike: false,
    involvesPedestrian: false,
    involvesMotorcycle: false,
    involvesCar: true,
    involvesTruck: false,
    involvesOther: false,
    ...overrides
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for async coordinator work.");
}

async function withMutedTelemetry(work) {
  const previousWindow = globalThis.window;
  const previousWorker = globalThis.Worker;
  const originalConsole = {
    groupCollapsed: console.groupCollapsed,
    groupEnd: console.groupEnd,
    info: console.info,
    table: console.table
  };
  globalThis.window = { setTimeout };
  globalThis.Worker = undefined;
  console.groupCollapsed = () => {};
  console.groupEnd = () => {};
  console.info = () => {};
  console.table = () => {};
  try {
    return await work();
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = previousWorker;
    }
    console.groupCollapsed = originalConsole.groupCollapsed;
    console.groupEnd = originalConsole.groupEnd;
    console.info = originalConsole.info;
    console.table = originalConsole.table;
  }
}
