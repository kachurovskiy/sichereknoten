import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const similarModule = loadSimilarModule();

test("similar view renders road-class choices without requiring an intersection selection", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...Array.from({ length: 10 }, (_value, index) =>
      sampleCluster({ id: `a-road-${index}`, streetNames: ["A 1"], osmRoundabout: false, osmTrafficSignal: false })
    ),
    ...Array.from({ length: 10 }, (_value, index) =>
      sampleCluster({ id: `b-road-${index}`, streetNames: ["B 7"], osmRoundabout: false, osmTrafficSignal: true })
    ),
    sampleCluster({ id: "k-road", streetNames: ["K 3"], osmRoundabout: false, osmTrafficSignal: false })
  ];
  const view = new SimilarView({
    container,
    getResult: () => sampleResult(clusters),
    getSelectedCluster: () => null,
    getSelectedRoadClassSignature: () => null,
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();

  assert.match(container.innerHTML, /<select id="similarRoadClassSelect"/);
  assert.match(container.innerHTML, /similar\.class:<\/span>/);
  assert.match(container.innerHTML, /A \(10\)/);
  assert.match(container.innerHTML, /B \(10\)/);
  assert.doesNotMatch(container.innerHTML, /K \(1\)/);
  assert.doesNotMatch(container.innerHTML, /similar\.selectedFeatures/);
  assert.doesNotMatch(container.innerHTML, /similar\.noSelection/);
  assert.doesNotMatch(container.innerHTML, /similar\.matches/);
  assert.match(container.innerHTML, /<h3>similar\.group\.plain<\/h3>/);
});

test("similar view auto-picks the selected intersection road class when selection changes", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...Array.from({ length: 10 }, (_value, index) =>
      sampleCluster({ id: `a-road-${index}`, streetNames: ["A 1"], osmRoundabout: false, osmTrafficSignal: false })
    ),
    ...Array.from({ length: 10 }, (_value, index) =>
      sampleCluster({ id: `b-road-${index}`, streetNames: ["B 7"], osmRoundabout: false, osmTrafficSignal: true })
    )
  ];
  let selected = null;
  let selectedSignature = null;
  const view = new SimilarView({
    container,
    getResult: () => sampleResult(clusters),
    getSelectedCluster: () => selected,
    getSelectedRoadClassSignature: () => selectedSignature,
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();
  assert.match(container.innerHTML, /<option value="a" selected>A \(10\)<\/option>/);

  selected = clusters[10];
  selectedSignature = view.roadClassSignatureForStreetNames(clusters[10].streetNames);
  view.render();

  assert.match(container.innerHTML, /<option value="b" selected>B \(10\)<\/option>/);
  assert.doesNotMatch(container.innerHTML, /similar\.matches/);
});

test("similar view hides road classes with fewer than ten intersections", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...Array.from({ length: 9 }, (_value, index) =>
      sampleCluster({ id: `a-road-${index}`, streetNames: ["A 1"], osmRoundabout: false, osmTrafficSignal: false })
    ),
    sampleCluster({ id: "b-road", streetNames: ["B 7"], osmRoundabout: false, osmTrafficSignal: true })
  ];
  const view = new SimilarView({
    container,
    getResult: () => sampleResult(clusters),
    getSelectedCluster: () => null,
    getSelectedRoadClassSignature: () => null,
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();

  assert.doesNotMatch(container.innerHTML, /<select id="similarRoadClassSelect"/);
  assert.match(container.innerHTML, /similar\.noRoadClasses/);
});

test("similar view includes the selected intersection in comparison groups", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    sampleCluster({ id: "selected-signal", streetNames: ["B 7"], osmRoundabout: false, osmTrafficSignal: true }),
    ...Array.from({ length: 9 }, (_value, index) =>
      sampleCluster({ id: `signal-${index}`, streetNames: ["B 7"], osmRoundabout: false, osmTrafficSignal: true })
    )
  ];
  let selected = clusters[0];
  const view = new SimilarView({
    container,
    getResult: () => sampleResult(clusters),
    getSelectedCluster: () => selected,
    getSelectedRoadClassSignature: () => view.roadClassSignatureForStreetNames(selected.streetNames),
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();

  assert.match(container.innerHTML, /<h3>similar\.group\.trafficSignal<\/h3>/);
  assert.match(container.innerHTML, /10 intersectionfeature\.intersections/);
});

test("similar view omits feature groups with fewer than ten intersections", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...Array.from({ length: 9 }, (_value, index) =>
      sampleCluster({ id: `plain-${index}`, streetNames: ["A 1"], osmRoundabout: false, osmTrafficSignal: false })
    ),
    ...Array.from({ length: 10 }, (_value, index) =>
      sampleCluster({ id: `signal-${index}`, streetNames: ["A 1"], osmRoundabout: false, osmTrafficSignal: true })
    )
  ];
  const view = new SimilarView({
    container,
    getResult: () => sampleResult(clusters),
    getSelectedCluster: () => null,
    getSelectedRoadClassSignature: () => null,
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();

  assert.doesNotMatch(container.innerHTML, /<h3>similar\.group\.plain<\/h3>/);
  assert.match(container.innerHTML, /<h3>similar\.group\.trafficSignal<\/h3>/);
  assert.match(container.innerHTML, /10 intersectionfeature\.intersections/);
});

async function loadSimilarModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/views/similarView.ts")],
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
  return {
    innerHTML: "",
    addEventListener() {}
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
    administrativeRegionCode: null,
    administrativeRegionName: null,
    administrativeRegionPopulation: null,
    districtCode: null,
    districtName: null,
    municipalityCode: null,
    municipalityName: null,
    municipalityPopulation: null,
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
