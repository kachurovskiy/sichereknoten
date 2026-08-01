import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const supportModule = loadSupportModule();

test("accident record display helpers render localized labels and rows", async () => {
  const { TRANSLATIONS, accidentRecordRows, accidentSeverityLabel, accidentTimeLabel, configureI18n } = await supportModule;
  configureI18n("en", TRANSLATIONS);

  const accident = sampleAccident({
    category: 2,
    accidentKind: 5,
    accidentType: 3,
    lightCondition: 1,
    roadSurface: 0,
    plausibilityLevel: 2,
    serialNumber: "SER-1",
    streetNames: ["Koenigsallee", "Steinstrasse"],
    involvesBike: true,
    involvesCar: true,
    linRefX: 323456.75,
    linRefY: 5678901.25
  });

  assert.equal(accidentSeverityLabel(accident), "Serious");
  assert.equal(accidentTimeLabel(accident), "2025, Apr 16, Wednesday, 09:00");

  const rowsByLabel = new Map(accidentRecordRows(accident, 42.4, ["Steinstrasse", "Koenigsallee"]).map((row) => [row.label, row.value]));
  assert.equal(rowsByLabel.get("Category"), "2 - Accident with seriously injured");
  assert.equal(rowsByLabel.get("Road users"), "Passenger car, Bicycle");
  assert.equal(rowsByLabel.get("Distance"), "42 m");
  assert.equal(rowsByLabel.get("Record ID"), "accident-1, serial SER-1");
});

test("cluster accident matcher returns exact indexed records", async () => {
  const { ClusterAccidentRecordMatcher } = await supportModule;
  const matcher = new ClusterAccidentRecordMatcher();
  const exact = sampleAccident({ id: "exact", recordIndex: 77, category: 2 });
  const records = [sampleAccident({ id: "other", recordIndex: 1, category: 1 }), exact];
  const cluster = sampleCluster({
    accidentCount: 1,
    fatalCount: 0,
    seriousCount: 1,
    accidentIndexes: [77]
  });

  assert.deepEqual(
    matcher.records(cluster, records, sampleOptions()).map(({ accident }) => accident.id),
    ["exact"]
  );
});

test("cluster accident matcher returns exact keyed records", async () => {
  const { ClusterAccidentRecordMatcher, accidentKey } = await supportModule;
  const matcher = new ClusterAccidentRecordMatcher();
  const keyed = sampleAccident({ id: "keyed", source: "state.csv", category: 1 });
  const records = [sampleAccident({ id: "other", category: 2 }), keyed];
  const cluster = sampleCluster({
    accidentCount: 1,
    fatalCount: 1,
    seriousCount: 0,
    accidentKeys: [accidentKey(keyed)]
  });

  assert.deepEqual(
    matcher.records(cluster, records, sampleOptions()).map(({ accident }) => accident.id),
    ["keyed"]
  );
});

test("fallback accident selection respects cluster severity counts", async () => {
  const { pickClusterAccidents } = await supportModule;
  const other = { accident: sampleAccident({ id: "other", category: 3 }), distanceMeters: 1 };
  const serious = { accident: sampleAccident({ id: "serious", category: 2 }), distanceMeters: 2 };
  const fatal = { accident: sampleAccident({ id: "fatal", category: 1 }), distanceMeters: 3 };
  const cluster = sampleCluster({
    accidentCount: 2,
    fatalCount: 1,
    seriousCount: 1
  });

  assert.deepEqual(
    pickClusterAccidents([other, serious, fatal], cluster).map(({ accident }) => accident.id),
    ["serious", "fatal"]
  );
});

test("analysis option matching filters year, state, and road-user focus", async () => {
  const { accidentMatchesAnalysisOptions } = await supportModule;
  const accident = sampleAccident({ year: 2025, stateCode: "05", involvesBike: true, involvesCar: false });

  assert.equal(accidentMatchesAnalysisOptions(accident, sampleOptions({ years: new Set([2025]) })), true);
  assert.equal(accidentMatchesAnalysisOptions(accident, sampleOptions({ years: new Set([2024]) })), false);
  assert.equal(accidentMatchesAnalysisOptions(accident, sampleOptions({ stateCode: "11" })), false);
  assert.equal(accidentMatchesAnalysisOptions(accident, sampleOptions({ roadUserFocus: new Set(["bicycle"]) })), true);
  assert.equal(accidentMatchesAnalysisOptions(accident, sampleOptions({ roadUserFocus: new Set(["car"]) })), false);
});

async function loadSupportModule() {
  const result = await build({
    stdin: {
      contents: `
        export * from "./src/domain/accidentRecordDisplay.ts";
        export * from "./src/analysis/clusterAccidentRecords.ts";
        export { configureI18n } from "./src/shared/i18n.ts";
        export { TRANSLATIONS } from "./src/shared/translations.ts";
      `,
      resolveDir: process.cwd(),
      sourcefile: "accidentRecordSupport.test-entry.ts",
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

function sampleAccident(overrides = {}) {
  return {
    id: "accident-1",
    recordIndex: 7,
    serialNumber: null,
    source: "accidents.csv",
    sourceType: "csv",
    streetName: null,
    streetNames: [],
    osmRoundabout: false,
    osmTrafficSignal: true,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "051",
    administrativeRegionName: "Duesseldorf",
    districtCode: "05111",
    districtName: "Duesseldorf, Stadt",
    municipalityCode: "05111000",
    municipalityName: "Duesseldorf",
    year: 2025,
    month: 4,
    day: 16,
    hour: 9,
    weekday: 4,
    category: 2,
    accidentKind: null,
    accidentType: null,
    lightCondition: null,
    roadSurface: null,
    plausibilityLevel: null,
    linRefX: null,
    linRefY: null,
    lon: 7.123456,
    lat: 50.987654,
    involvesBike: false,
    involvesPedestrian: false,
    involvesMotorcycle: false,
    involvesCar: false,
    involvesTruck: false,
    involvesOther: false,
    ...overrides
  };
}

function sampleCluster(overrides = {}) {
  return {
    id: "cluster-1",
    lon: 7.123456,
    lat: 50.987654,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    accidentCount: 1,
    fatalCount: 0,
    seriousCount: 1,
    accidentKeys: undefined,
    accidentIndexes: undefined,
    ...overrides
  };
}

function sampleOptions(overrides = {}) {
  return {
    clusterRadiusMeters: 50,
    minAccidents: 2,
    years: new Set(),
    roadUserFocus: new Set(),
    stateCode: "all",
    severityPercent: {},
    ...overrides
  };
}
