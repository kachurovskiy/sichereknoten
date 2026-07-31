import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const similarModule = loadSimilarModule();

test("similar view renders road-class choices without requiring an intersection selection", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...comparableRoadClassClusters("A 1", "a-road"),
    ...comparableRoadClassClusters("B 7", "b-road"),
    ...comparableRoadClassClusters("K 3", "k-road", { plain: 30, roundabout: 30, trafficSignal: 29 })
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
  assert.match(container.innerHTML, /A \(90\)/);
  assert.match(container.innerHTML, /B \(90\)/);
  assert.doesNotMatch(container.innerHTML, /K \(89\)/);
  assert.doesNotMatch(container.innerHTML, /similar\.selectedFeatures/);
  assert.doesNotMatch(container.innerHTML, /similar\.noSelection/);
  assert.doesNotMatch(container.innerHTML, /similar\.matches/);
  assert.match(container.innerHTML, /<h3>similar\.group\.plain<\/h3>/);
  assert.match(container.innerHTML, /<h3>similar\.group\.roundabout<\/h3>/);
  assert.match(container.innerHTML, /<h3>similar\.group\.trafficSignal<\/h3>/);
});

test("similar view auto-picks the selected intersection road class when selection changes", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const aClusters = comparableRoadClassClusters("A 1", "a-road");
  const bClusters = comparableRoadClassClusters("B 7", "b-road");
  const clusters = [...aClusters, ...bClusters];
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
  assert.match(container.innerHTML, /<option value="a" selected>A \(90\)<\/option>/);

  selected = bClusters[0];
  selectedSignature = view.roadClassSignatureForStreetNames(selected.streetNames);
  view.render();

  assert.match(container.innerHTML, /<option value="b" selected>B \(90\)<\/option>/);
  assert.doesNotMatch(container.innerHTML, /similar\.matches/);
});

test("similar view reuses rendered output when the result and road class are unchanged", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = comparableRoadClassClusters("A 1", "a-road");
  const result = sampleResult(clusters);
  const view = new SimilarView({
    container,
    getResult: () => result,
    getSelectedCluster: () => null,
    getSelectedRoadClassSignature: () => null,
    getActiveView: () => "similar",
    selectCluster: () => {}
  });

  view.render();
  const renderedHtml = container.innerHTML;
  const writeCount = container.innerHTMLWriteCount();

  view.render();

  assert.equal(container.innerHTML, renderedHtml);
  assert.equal(container.innerHTMLWriteCount(), writeCount);
});

test("similar view hides road classes unless every feature group has at least thirty intersections", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...comparableRoadClassClusters("A 1", "a-road", { plain: 30, roundabout: 30, trafficSignal: 29 }),
    ...comparableRoadClassClusters("B 7", "b-road", { plain: 90, roundabout: 0, trafficSignal: 0 })
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
    ...similarGroupClusters("B 7", "trafficSignal", 29, "signal"),
    ...similarGroupClusters("B 7", "plain", 30, "plain"),
    ...similarGroupClusters("B 7", "roundabout", 30, "roundabout")
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
  assert.match(container.innerHTML, /30 intersectionfeature\.intersections/);
});

test("similar view does not offer partially comparable road classes", async () => {
  const { SimilarView } = await similarModule;
  const container = fakeContainer();
  const clusters = [
    ...comparableRoadClassClusters("A 1", "a-road", { plain: 29, roundabout: 60, trafficSignal: 60 }),
    ...comparableRoadClassClusters("B 7", "b-road", { plain: 60, roundabout: 29, trafficSignal: 60 }),
    ...comparableRoadClassClusters("K 3", "k-road", { plain: 60, roundabout: 60, trafficSignal: 29 })
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
  let innerHTML = "";
  let writeCount = 0;
  return {
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(value) {
      innerHTML = value;
      writeCount += 1;
    },
    innerHTMLWriteCount() {
      return writeCount;
    },
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

function comparableRoadClassClusters(streetName, idPrefix, counts = { plain: 30, roundabout: 30, trafficSignal: 30 }) {
  return [
    ...similarGroupClusters(streetName, "plain", counts.plain, `${idPrefix}-plain`),
    ...similarGroupClusters(streetName, "roundabout", counts.roundabout, `${idPrefix}-roundabout`),
    ...similarGroupClusters(streetName, "trafficSignal", counts.trafficSignal, `${idPrefix}-traffic-signal`)
  ];
}

function similarGroupClusters(streetName, group, count, idPrefix) {
  const featureFlags = {
    plain: { osmRoundabout: false, osmTrafficSignal: false },
    roundabout: { osmRoundabout: true, osmTrafficSignal: false },
    trafficSignal: { osmRoundabout: false, osmTrafficSignal: true }
  }[group];
  return Array.from({ length: count }, (_value, index) =>
    sampleCluster({ id: `${idPrefix}-${index}`, streetNames: [streetName], ...featureFlags })
  );
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
