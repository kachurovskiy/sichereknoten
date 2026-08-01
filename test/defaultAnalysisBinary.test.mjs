import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const codecModule = loadCodecModule();

test("default analysis binary codec round-trips representative analysis results", async () => {
  const { encodeDefaultAnalysisBinary, decodeDefaultAnalysisBinary } = await codecModule;
  const analysis = sampleAnalysisResult();
  const decoded = decodeDefaultAnalysisBinary(encodeDefaultAnalysisBinary(analysis));

  assert.deepEqual(decoded, analysis);
  assert.equal(decoded.stateSummaries[0].topCluster, decoded.clusters[0]);
  assert.equal(decoded.stateSummaries[1].topCluster, null);
});

test("default analysis binary decoder rejects invalid headers", async () => {
  const { decodeDefaultAnalysisBinary } = await codecModule;

  assert.throws(() => decodeDefaultAnalysisBinary(new TextEncoder().encode("not-binary")), /invalid header/i);
});

test("default analysis binary decoder rejects trailing bytes", async () => {
  const { encodeDefaultAnalysisBinary, decodeDefaultAnalysisBinary } = await codecModule;
  const encoded = encodeDefaultAnalysisBinary(sampleAnalysisResult());
  const withTrailingByte = new Uint8Array(encoded.byteLength + 1);
  withTrailingByte.set(encoded);

  assert.throws(() => decodeDefaultAnalysisBinary(withTrailingByte), /trailing bytes/i);
});

async function loadCodecModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/data/defaultAnalysisBinary.ts")],
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

function sampleAnalysisResult() {
  const clusterA = {
    id: "c-1",
    lon: 7.1234567,
    lat: 50.7654321,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "051",
    administrativeRegionName: "Duesseldorf",
    administrativeRegionPopulation: 5244379,
    districtCode: "05111",
    districtName: "Duesseldorf, Stadt",
    municipalityCode: "05111000",
    municipalityName: "Duesseldorf",
    municipalityPopulation: 653253,
    accidentCount: 3,
    fatalCount: 1,
    seriousCount: 1,
    lightCount: 1,
    vulnerableCount: 2,
    streetNames: ["Koenigsallee", "Steinstrasse"],
    osmRoundabout: true,
    osmRoundaboutRadiusMeters: 18,
    osmRoundaboutMatchRadiusMeters: 38,
    osmTrafficSignal: false,
    osmRoundaboutCount: 2,
    osmTrafficSignalCount: 1,
    severityPercent: 0.3456,
    years: [2021, 2023],
    yearlyStats: [
      { year: 2021, accidentCount: 1, fatalCount: 1, seriousCount: 0, lightCount: 0 },
      { year: 2023, accidentCount: 2, fatalCount: 0, seriousCount: 1, lightCount: 1 }
    ],
    accidentTrend: {
      direction: "rising",
      slopePerYear: 0.1256,
      relativeSlopePerYear: -0.0345,
      startAccidents: 1,
      endAccidents: 2,
      years: 4
    },
    accidentIndexes: [2, 5, 9]
  };
  const clusterB = {
    id: "c-20",
    lon: 13.405,
    lat: 52.52,
    stateCode: "11",
    stateName: "Berlin",
    administrativeRegionCode: null,
    administrativeRegionName: null,
    administrativeRegionPopulation: null,
    districtCode: null,
    districtName: null,
    municipalityCode: null,
    municipalityName: null,
    municipalityPopulation: null,
    accidentCount: 2,
    fatalCount: 0,
    seriousCount: 1,
    lightCount: 1,
    vulnerableCount: 0,
    streetNames: [],
    osmRoundabout: null,
    osmRoundaboutRadiusMeters: null,
    osmRoundaboutMatchRadiusMeters: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0.01,
    years: [2022],
    yearlyStats: [{ year: 2022, accidentCount: 2, fatalCount: 0, seriousCount: 1, lightCount: 1 }],
    accidentTrend: {
      direction: "unknown",
      slopePerYear: null,
      relativeSlopePerYear: null,
      startAccidents: null,
      endAccidents: null,
      years: 0
    }
  };

  return {
    clusters: [clusterA, clusterB],
    stateSummaries: [
      {
        stateCode: "05",
        stateName: "Nordrhein-Westfalen",
        accidentCount: 3,
        clusterCount: 1,
        fatalCount: 1,
        seriousCount: 1,
        severityPercent: 0.3456,
        topCluster: clusterA
      },
      {
        stateCode: "11",
        stateName: "Berlin",
        accidentCount: 2,
        clusterCount: 1,
        fatalCount: 0,
        seriousCount: 1,
        severityPercent: 0.01,
        topCluster: null
      }
    ],
    stateAccidentSummaries: [
      {
        key: "05",
        name: "Nordrhein-Westfalen",
        stateCode: "05",
        stateName: "Nordrhein-Westfalen",
        population: 18034454,
        accidentCount: 3,
        fatalCount: 1,
        seriousCount: 1,
        lightCount: 1
      }
    ],
    regionAccidentSummaries: [
      {
        key: "051",
        name: "Duesseldorf",
        stateCode: "05",
        stateName: "Nordrhein-Westfalen",
        population: null,
        accidentCount: 3,
        fatalCount: 1,
        seriousCount: 1,
        lightCount: 1
      }
    ],
    filteredAccidentCount: 5,
    years: [2021, 2022, 2023]
  };
}
