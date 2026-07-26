import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const urlModule = loadUrlModule();

test("cluster map URLs use stable coordinate precision", async () => {
  const { googleStreetViewEmbedUrl, mapUrlsForCluster } = await urlModule;
  const cluster = sampleCluster();

  assert.deepEqual(mapUrlsForCluster(cluster), {
    openStreetMapUrl: "https://www.openstreetmap.org/?mlat=50.987654&mlon=7.123457#map=18/50.987654/7.123457",
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=50.987654,7.123457",
    streetViewUrl: "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=50.987654,7.123457"
  });
  assert.equal(
    googleStreetViewEmbedUrl(cluster),
    "https://www.google.com/maps?layer=c&cbll=50.987654,7.123457&cbp=11,0,0,0,0&output=svembed"
  );
});

test("responsible authority search URL includes regional context", async () => {
  const { responsibleAuthoritySearchUrlForCluster } = await urlModule;
  const query = searchQuery(responsibleAuthoritySearchUrlForCluster(sampleCluster()));

  assert.match(query, /zust\u00e4ndige Stra\u00dfenverkehrsbeh\u00f6rde/);
  assert.match(query, /Unfallkommission/);
  assert.match(query, /D\u00fcsseldorf, Stadt/);
  assert.match(query, /Nordrhein-Westfalen/);
  assert.match(query, /50\.98765, 7\.12346/);
});

test("press search URL for clusters normalizes street and place names", async () => {
  const { pressSearchUrlForCluster } = await urlModule;
  const query = searchQuery(pressSearchUrlForCluster(sampleCluster(), ["B 7", "st 2244", "B7"]));

  assert.match(query, /Unfall/);
  assert.match(query, /B7/);
  assert.match(query, /St2244/);
  assert.match(query, /D\u00fcsseldorf/);
  assert.doesNotMatch(query, /Stadt/);
});

test("press search URL for accidents includes severity, date, and place", async () => {
  const { pressSearchUrlForAccident } = await urlModule;
  const query = searchQuery(pressSearchUrlForAccident(sampleAccident()));

  assert.match(query, /Unfall/);
  assert.match(query, /schwer verletzt/);
  assert.match(query, /06\.04\.2025/);
  assert.match(query, /D\u00fcsseldorf/);
});

async function loadUrlModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/urlBuilders.ts")],
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

function searchQuery(url) {
  return new URL(url).searchParams.get("q") ?? "";
}

function sampleCluster(overrides = {}) {
  return {
    id: "cluster-1",
    lon: 7.1234567,
    lat: 50.9876543,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "051",
    administrativeRegionName: "D\u00fcsseldorf",
    administrativeRegionPopulation: null,
    districtCode: "05111",
    districtName: "D\u00fcsseldorf, Stadt",
    municipalityCode: null,
    municipalityName: null,
    municipalityPopulation: null,
    accidentCount: 1,
    fatalCount: 0,
    seriousCount: 1,
    lightCount: 0,
    vulnerableCount: 0,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    osmRoundaboutCount: 0,
    osmTrafficSignalCount: 0,
    severityPercent: 0,
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

function sampleAccident(overrides = {}) {
  return {
    id: "accident-1",
    source: "accidents.csv",
    sourceType: "csv",
    streetName: null,
    streetNames: [],
    osmRoundabout: null,
    osmTrafficSignal: null,
    stateCode: "05",
    stateName: "Nordrhein-Westfalen",
    administrativeRegionCode: "051",
    administrativeRegionName: "D\u00fcsseldorf",
    districtCode: "05111",
    districtName: "D\u00fcsseldorf, Stadt",
    municipalityCode: null,
    municipalityName: null,
    year: 2025,
    month: 4,
    day: 6,
    hour: null,
    weekday: null,
    category: 2,
    accidentKind: null,
    accidentType: null,
    lightCondition: null,
    roadSurface: null,
    plausibilityLevel: null,
    linRefX: null,
    linRefY: null,
    lon: 7.1234567,
    lat: 50.9876543,
    involvesBike: false,
    involvesPedestrian: false,
    involvesMotorcycle: false,
    involvesCar: false,
    involvesTruck: false,
    involvesOther: false,
    ...overrides
  };
}
