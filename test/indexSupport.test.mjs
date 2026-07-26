import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const supportModule = loadSupportModule();

test("browse index aggregates regions and filters browse clusters", async () => {
  const { buildBrowseIndex } = await supportModule;
  const clusters = [
    sampleCluster({
      id: "duesseldorf-main",
      severityPercent: 0.4,
      accidentCount: 10,
      fatalCount: 1,
      seriousCount: 2,
      administrativeRegionCode: "051",
      administrativeRegionName: "Reg.-Bez. Duesseldorf"
    }),
    sampleCluster({
      id: "duesseldorf-second",
      severityPercent: 0.2,
      accidentCount: 5,
      seriousCount: 1,
      administrativeRegionCode: "051",
      administrativeRegionName: "Reg.-Bez. Duesseldorf"
    }),
    sampleCluster({
      id: "koeln-low",
      severityPercent: 0.05,
      accidentCount: 7,
      administrativeRegionCode: "053",
      administrativeRegionName: "Reg.-Bez. Koeln"
    }),
    sampleCluster({
      id: "berlin-main",
      stateCode: "11",
      stateName: "Berlin",
      administrativeRegionCode: null,
      administrativeRegionName: null,
      severityPercent: 0.3,
      accidentCount: 8,
      fatalCount: 1
    })
  ];

  const index = buildBrowseIndex(clusters);
  const duesseldorf = index.regionSummaries.find((summary) => summary.key === "05:051");

  assert.equal(index.clusters, clusters);
  assert.equal(duesseldorf?.regionName, "Duesseldorf");
  assert.equal(duesseldorf?.clusterCount, 2);
  assert.equal(duesseldorf?.accidentCount, 15);
  assert.equal(duesseldorf?.severityPercent, (0.4 * 10 + 0.2 * 5) / 15);
  assert.equal(duesseldorf?.topCluster?.id, "duesseldorf-main");
  assert.deepEqual(
    index.topClustersByState.map((cluster) => cluster.id),
    ["duesseldorf-main", "berlin-main"]
  );
  assert.deepEqual(
    index.browseClustersByState.get("05")?.map((cluster) => cluster.id),
    ["duesseldorf-main", "duesseldorf-second"]
  );
  assert.equal(index.browseClustersByRegion.has("05:053"), false);
});

test("browse index store reuses indexes by cluster array identity", async () => {
  const { BrowseIndexStore } = await supportModule;
  const clusters = [sampleCluster()];
  const store = new BrowseIndexStore();
  const first = store.forClusters(clusters);

  assert.equal(store.forClusters(clusters), first);
  store.clear();
  assert.notEqual(store.forClusters(clusters), first);
});

test("severity rank index reports state and Germany rank contexts", async () => {
  const { buildSeverityRankIndex, severityRankContextForCluster } = await supportModule;
  const clusters = [
    sampleCluster({ id: "state-top-a", severityPercent: 0.4, municipalityName: "Same place" }),
    sampleCluster({ id: "state-top-b", severityPercent: 0.4, municipalityName: "Same place" }),
    sampleCluster({ id: "state-third", severityPercent: 0.2, municipalityName: "Later place" }),
    sampleCluster({
      id: "berlin-only",
      stateCode: "11",
      stateName: "Berlin",
      administrativeRegionCode: null,
      administrativeRegionName: null,
      severityPercent: 0.3,
      municipalityName: "Berlin"
    })
  ];

  const index = buildSeverityRankIndex(clusters);

  assert.deepEqual(severityRankContextForCluster(index, clusters[1]), {
    state: { rank: 2, percentile: 67 },
    germany: { rank: 2, percentile: 50 }
  });
  assert.deepEqual(severityRankContextForCluster(index, clusters[3]), {
    state: { rank: 1, percentile: 100 },
    germany: { rank: 3, percentile: 75 }
  });
});

test("severity rank context omits Germany rank for single-state results", async () => {
  const { buildSeverityRankIndex, severityRankContextForCluster } = await supportModule;
  const clusters = [sampleCluster({ id: "first", severityPercent: 0.3 }), sampleCluster({ id: "second", severityPercent: 0.2 })];

  assert.deepEqual(severityRankContextForCluster(buildSeverityRankIndex(clusters), clusters[0]), {
    state: { rank: 1, percentile: 50 },
    germany: null
  });
});

async function loadSupportModule() {
  const result = await build({
    stdin: {
      contents: `
        export * from "./src/browseIndex.ts";
        export * from "./src/severityRankIndex.ts";
      `,
      resolveDir: process.cwd(),
      sourcefile: "indexSupport.test-entry.ts",
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

function sampleCluster(overrides = {}) {
  return {
    id: "cluster-1",
    lon: 7.123456,
    lat: 50.987654,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "051",
    administrativeRegionName: "Duesseldorf",
    administrativeRegionPopulation: 5_000_000,
    districtCode: "05111",
    districtName: "Duesseldorf, Stadt",
    municipalityCode: "05111000",
    municipalityName: "Duesseldorf",
    municipalityPopulation: 650_000,
    accidentCount: 2,
    fatalCount: 0,
    seriousCount: 1,
    lightCount: 1,
    vulnerableCount: 1,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0.2,
    years: [2025],
    yearlyStats: [{ year: 2025, accidentCount: 2 }],
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
