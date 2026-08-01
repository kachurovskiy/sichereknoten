import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const analysisOptionsModule = loadTsModule("src/analysis/analysisOptions.ts");
const defaultsModule = loadTsModule("src/analysis/defaults.ts");

test("analysis option bundle serialization is stable", async () => {
  const { serializeAnalysisOptionsForBundle, analysisOptionsMetadataMatches } = await analysisOptionsModule;
  const options = {
    clusterRadiusMeters: 50,
    minAccidents: 2,
    years: new Set([2025, 2021, 2023]),
    roadUserFocus: new Set(["truck", "bicycle"]),
    stateCode: "all",
    severityPercent: {
      fatalWeight: 3,
      seriousWeight: 1,
      fullSampleAccidents: 8,
      trendYears: 5,
      trendDeadZone: 0.08,
      trendFullSignal: 0.25,
      maxTrendAdjustment: 0.2,
      maxSeverityPercent: 1
    }
  };

  const serialized = serializeAnalysisOptionsForBundle(options);

  assert.deepEqual(serialized.years, [2021, 2023, 2025]);
  assert.deepEqual(serialized.roadUserFocus, ["bicycle", "truck"]);
  assert.equal(
    analysisOptionsMetadataMatches(
      {
        dataVersion: "data-a",
        analysisCacheVersion: "analysis-a",
        options: serialized
      },
      "data-a",
      "analysis-a",
      options
    ),
    true
  );
  assert.equal(
    analysisOptionsMetadataMatches(
      {
        dataVersion: "data-b",
        analysisCacheVersion: "analysis-a",
        options: serialized
      },
      "data-a",
      "analysis-a",
      options
    ),
    false
  );
});

test("trend-year normalization uses the shared five-year default", async () => {
  const { DEFAULT_TREND_YEARS, normalizeTrendYears } = await defaultsModule;

  assert.equal(DEFAULT_TREND_YEARS, 5);
  assert.equal(normalizeTrendYears(undefined), 5);
  assert.equal(normalizeTrendYears(Number.NaN), 5);
  assert.equal(normalizeTrendYears(1), 2);
  assert.equal(normalizeTrendYears(4.9), 4);
});

async function loadTsModule(relativePath) {
  const result = await build({
    entryPoints: [path.join(process.cwd(), relativePath)],
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
