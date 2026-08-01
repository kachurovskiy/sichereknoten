import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const intersectionFeatureModule = loadIntersectionFeatureModule();

test("area population rows compute accidents per unique municipality population", async () => {
  const { populationIntersectionFeatureRows } = await intersectionFeatureModule;
  const rows = populationIntersectionFeatureRows([
    sampleCluster({
      accidentCount: 10,
      administrativeRegionCode: "1",
      districtCode: "01",
      municipalityCode: "000",
      municipalityPopulation: 5_000,
      administrativeRegionPopulation: 1_000_000
    }),
    sampleCluster({
      accidentCount: 20,
      administrativeRegionCode: "1",
      districtCode: "01",
      municipalityCode: "000",
      municipalityPopulation: 5_000,
      administrativeRegionPopulation: 1_000_000
    }),
    sampleCluster({
      accidentCount: 30,
      administrativeRegionCode: "1",
      districtCode: "02",
      municipalityCode: "000",
      municipalityPopulation: 7_000,
      administrativeRegionPopulation: 2_000_000
    })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].municipalityPopulation, 12_000);
  assert.equal(rows[0].municipalityAccidentRate, 500);
});

test("area population renderer separates per-intersection and population-rate tables", async () => {
  const { populationIntersectionFeatureRows, renderIntersectionFeatureSection } = await intersectionFeatureModule;
  const rows = populationIntersectionFeatureRows([
    sampleCluster({
      accidentCount: 10,
      fatalCount: 1,
      seriousCount: 2,
      municipalityCode: "05315000",
      municipalityPopulation: 20_000,
      administrativeRegionCode: "053",
      administrativeRegionPopulation: 3_000_000
    })
  ]);

  const perIntersectionHtml = renderIntersectionFeatureSection(rows);
  assert.match(perIntersectionHtml, /intersectionFeature\.fatalPer100/);
  assert.match(perIntersectionHtml, /intersectionFeature\.seriousPer100/);
  assert.match(perIntersectionHtml, /intersectionFeature\.totalPerIntersection/);
  assert.doesNotMatch(perIntersectionHtml, /intersectionFeature\.totalPer100kPopulation/);
  assert.match(perIntersectionHtml, /<strong>100<\/strong>/);

  const populationHtml = renderIntersectionFeatureSection(rows, { rateBasis: "population" });
  assert.match(populationHtml, /intersectionFeature\.fatalPer100kPopulation/);
  assert.match(populationHtml, /intersectionFeature\.seriousPer100kPopulation/);
  assert.match(populationHtml, /intersectionFeature\.totalPer100kPopulation/);
  assert.doesNotMatch(populationHtml, /intersectionFeature\.totalPerIntersection/);
  assert.match(populationHtml, /<strong>5<\/strong>/);
  assert.match(populationHtml, /<strong>10<\/strong>/);
  assert.match(populationHtml, /<strong>50<\/strong>/);
});

test("intersection feature summary view renders both area-population tables", async () => {
  const { IntersectionFeatureSummaryView } = await intersectionFeatureModule;
  const container = fakeContainer();
  const view = new IntersectionFeatureSummaryView({
    container,
    getResult: () =>
      sampleResult([
        sampleCluster({
          accidentCount: 10,
          fatalCount: 1,
          seriousCount: 2,
          municipalityCode: "05315000",
          municipalityPopulation: 20_000
        })
      ])
  });

  view.render();

  assert.match(container.innerHTML, /intersectionFeature\.perIntersection/);
  assert.match(container.innerHTML, /intersectionFeature\.perPopulation/);
  assert.match(container.innerHTML, /intersectionFeature\.totalPerIntersection/);
  assert.match(container.innerHTML, /intersectionFeature\.totalPer100kPopulation/);
  assert.equal([...container.innerHTML.matchAll(/class="intersection-feature-table"/g)].length, 2);
});

async function loadIntersectionFeatureModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/views/intersectionFeatureSummaryView.ts")],
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

function fakeContainer() {
  let innerHTML = "";
  return {
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(value) {
      innerHTML = value;
    }
  };
}

function sampleResult(clusters) {
  return {
    clusters,
    stateSummaries: [],
    stateAccidentSummaries: [],
    regionAccidentSummaries: [],
    filteredAccidentCount: clusters.reduce((total, cluster) => total + cluster.accidentCount, 0),
    years: [2025]
  };
}

function sampleCluster(overrides = {}) {
  return {
    id: "cluster",
    lon: 7.1234567,
    lat: 50.9876543,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "053",
    administrativeRegionName: "Koeln",
    administrativeRegionPopulation: 4_486_282,
    districtCode: null,
    districtName: null,
    municipalityCode: null,
    municipalityName: null,
    municipalityPopulation: 5_000,
    accidentCount: 3,
    fatalCount: 0,
    seriousCount: 1,
    lightCount: 2,
    vulnerableCount: 1,
    streetNames: [],
    osmRoundabout: null,
    osmRoundaboutRadiusMeters: null,
    osmRoundaboutMatchRadiusMeters: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0.123,
    years: [2025],
    yearlyStats: [{ year: 2025, accidentCount: 3, fatalCount: 0, seriousCount: 1, lightCount: 2 }],
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
