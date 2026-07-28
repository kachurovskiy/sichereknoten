import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const appStateModule = loadAppStateModule();

test("app state commits analysis with cloned options and invalidates rendered clusters", async () => {
  const { AppState } = await appStateModule;
  const state = new AppState();
  const options = sampleOptions();
  const result = sampleAnalysisResult();

  state.markRenderedMapClusters([]);
  state.commitAnalysis(options, result, "data-v1");
  options.years.add(2024);
  options.severityPercent.fatalWeight = 99;

  assert.equal(state.result, result);
  assert.equal(state.committedAnalysis.result, result);
  assert.equal(state.committedAnalysis.dataVersion, "data-v1");
  assert.deepEqual([...state.committedAnalysis.options.years], [2025]);
  assert.equal(state.committedAnalysis.options.severityPercent.fatalWeight, 3);
  assert.equal(state.renderedMapClusters, undefined);

  state.markRenderedMapClusters(result.clusters);
  assert.equal(state.renderedMapClusters, result.clusters);

  state.clearCommittedAnalysis();
  assert.equal(state.result, null);
  assert.equal(state.committedAnalysis, null);
  assert.equal(state.renderedMapClusters, undefined);
});

test("app state tracks loaded accidents and derives filter options", async () => {
  const { AppState } = await appStateModule;
  const state = new AppState();
  const records = [sampleAccident({ stateCode: "05", year: 2024 }), sampleAccident({ stateCode: "11", year: 2025 })];

  assert.deepEqual([...state.availableStateCodes(["01"])], ["01"]);
  assert.deepEqual(state.availableYears([2023]), [2023]);

  assert.equal(state.setAccidents(records), true);
  assert.equal(state.setAccidents(records), false);
  assert.equal(state.allAccidentsSnapshot(), records);
  assert.deepEqual([...state.availableStateCodes(["01"])].sort(), ["05", "11"]);
  assert.deepEqual(state.availableYears([2023]), [2024, 2025]);

  state.resetRuntimeAnalysis();
  assert.equal(state.allAccidentsSnapshot(), null);
  assert.deepEqual([...state.availableStateCodes(["01"])], ["01"]);
  assert.deepEqual(state.availableYears([2023]), [2023]);
});

async function loadAppStateModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/appState.ts")],
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

function sampleAnalysisResult() {
  const cluster = {
    id: "c-1",
    lon: 7.1234567,
    lat: 50.9876543,
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
    accidentCount: 3,
    fatalCount: 1,
    seriousCount: 1,
    lightCount: 1,
    vulnerableCount: 0,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0.2,
    years: [2025],
    yearlyStats: [{ year: 2025, accidentCount: 3 }],
    accidentTrend: {
      direction: "unknown",
      slopePerYear: null,
      relativeSlopePerYear: null,
      startAccidents: null,
      endAccidents: null,
      years: 1
    }
  };

  return {
    clusters: [cluster],
    stateSummaries: [],
    stateAccidentSummaries: [],
    regionAccidentSummaries: [],
    filteredAccidentCount: 3,
    years: [2025]
  };
}

function sampleAccident(overrides = {}) {
  return {
    id: "accident-1",
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
    category: null,
    accidentKind: null,
    accidentType: null,
    lightCondition: null,
    roadSurface: null,
    plausibilityLevel: null,
    linRefX: null,
    linRefY: null,
    lon: 7,
    lat: 50,
    involvesBike: null,
    involvesPedestrian: null,
    involvesMotorcycle: null,
    involvesCar: null,
    involvesTruck: null,
    involvesOther: null,
    ...overrides
  };
}
