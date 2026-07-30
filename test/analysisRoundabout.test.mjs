import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const analysisModule = loadAnalysisModule();

test("analysis centers qualifying roundabout clusters on OSM roundabout geometry", async () => {
  const { analyzeDangerousIntersections } = await analysisModule;
  const result = analyzeDangerousIntersections(
    [
      roundaboutAccident("roundabout-a", { recordIndex: 1, lon: 8.00008, lat: 50 }),
      roundaboutAccident("roundabout-b", { recordIndex: 2, lon: 7.99992, lat: 50 }),
      sampleAccident({ id: "nearby-normal", recordIndex: 3, lon: 8.0005, lat: 50.0001, osmRoundabout: false, osmTrafficSignal: false })
    ],
    analysisOptions({ clusterRadiusMeters: 100, minAccidents: 2 })
  );

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].osmRoundabout, true);
  assert.equal(result.clusters[0].lon, 8);
  assert.equal(result.clusters[0].lat, 50);
  assert.equal(result.clusters[0].accidentCount, 2);
  assert.equal(result.clusters[0].osmRoundaboutRadiusMeters, 24);
  assert.equal(result.clusters[0].osmRoundaboutMatchRadiusMeters, 44);
  assert.deepEqual(result.clusters[0].accidentIndexes, [1, 2]);
});

test("analysis suppresses roundabout metadata when the geometry-centered group is below the minimum", async () => {
  const { analyzeDangerousIntersections } = await analysisModule;
  const result = analyzeDangerousIntersections(
    [
      roundaboutAccident("roundabout-a", { lon: 8.00008, lat: 50 }),
      roundaboutAccident("roundabout-b", { lon: 7.99992, lat: 50 }),
      sampleAccident({ id: "nearby-normal", lon: 8.00045, lat: 50.0001, osmRoundabout: false, osmTrafficSignal: false })
    ],
    analysisOptions({ clusterRadiusMeters: 100, minAccidents: 3 })
  );

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].accidentCount, 3);
  assert.equal(result.clusters[0].osmRoundabout, false);
  assert.equal(result.clusters[0].osmRoundaboutCount, 0);
  assert.equal(result.clusters[0].osmRoundaboutRadiusMeters, null);
  assert.equal(result.clusters[0].osmRoundaboutMatchRadiusMeters, null);
});

async function loadAnalysisModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/analysis.ts")],
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

function analysisOptions(overrides = {}) {
  return {
    clusterRadiusMeters: 60,
    minAccidents: 2,
    years: new Set(),
    roadUserFocus: new Set(),
    stateCode: "all",
    severityPercent: {
      fatalWeight: 1,
      seriousWeight: 0.5,
      fullSampleAccidents: 10,
      trendYears: 3,
      trendDeadZone: 0.05,
      trendFullSignal: 0.15,
      maxTrendAdjustment: 0.15,
      maxSeverityPercent: 1
    },
    ...overrides
  };
}

function roundaboutAccident(id, overrides = {}) {
  return sampleAccident({
    id,
    osmRoundabout: true,
    osmRoundaboutId: 101,
    osmRoundaboutLon: 8,
    osmRoundaboutLat: 50,
    osmRoundaboutRadiusMeters: 24,
    osmRoundaboutMatchRadiusMeters: 44,
    osmTrafficSignal: false,
    ...overrides
  });
}

function sampleAccident(overrides = {}) {
  return {
    id: "accident",
    serialNumber: null,
    source: "test.csv",
    sourceType: "csv",
    streetName: null,
    streetNames: [],
    osmRoundabout: null,
    osmRoundaboutId: null,
    osmRoundaboutLon: null,
    osmRoundaboutLat: null,
    osmRoundaboutRadiusMeters: null,
    osmRoundaboutMatchRadiusMeters: null,
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
    category: 3,
    accidentKind: null,
    accidentType: null,
    lightCondition: null,
    roadSurface: null,
    plausibilityLevel: null,
    linRefX: null,
    linRefY: null,
    lon: 8,
    lat: 50,
    involvesBike: false,
    involvesPedestrian: false,
    involvesMotorcycle: false,
    involvesCar: true,
    involvesTruck: false,
    involvesOther: false,
    ...overrides
  };
}
