import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const csvModule = loadCsvModule();

test("cluster CSV export writes header and cluster rows", async () => {
  const { clustersCsv } = await csvModule;

  assert.equal(
    clustersCsv([
      sampleCluster({
        stateName: 'North "Rhine"',
        administrativeRegionName: "Duesseldorf, Region",
        administrativeRegionPopulation: 5_244_379,
        districtName: "Duesseldorf",
        municipalityName: "Duesseldorf",
        municipalityPopulation: 653_253,
        osmRoundabout: true,
        osmTrafficSignal: false,
        severityPercent: 0.237
      })
    ]),
    [
      "state,administrative_region,administrative_region_population,district,municipality,municipality_population,lat,lon,accidents,fatal,serious,osm_roundabout,osm_traffic_signal,severity_percent",
      '"North ""Rhine""","Duesseldorf, Region",5244379,Duesseldorf,Duesseldorf,653253,50.9876543,7.1234567,3,1,2,yes,no,24'
    ].join("\n")
  );
});

test("cluster CSV export leaves missing fields empty and unknown OSM metadata explicit", async () => {
  const { clustersCsv } = await csvModule;
  const lines = clustersCsv([sampleCluster()]).split("\n");

  assert.equal(lines[1], "Nordrhein-Westfalen,,,,,,50.9876543,7.1234567,3,1,2,unknown,unknown,12");
});

async function loadCsvModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/clusterCsvExport.ts")],
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
    seriousCount: 2,
    lightCount: 0,
    vulnerableCount: 0,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0.123,
    years: [2025],
    yearlyStats: [],
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
