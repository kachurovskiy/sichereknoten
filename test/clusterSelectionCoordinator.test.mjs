import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const coordinatorModule = loadCoordinatorModule();

test("cluster selection severity key favors fatal then serious", async () => {
  const { clusterSeverityKey } = await coordinatorModule;

  assert.equal(clusterSeverityKey(sampleCluster({ fatalCount: 1, seriousCount: 2 })), "fatal");
  assert.equal(clusterSeverityKey(sampleCluster({ fatalCount: 0, seriousCount: 2 })), "serious");
  assert.equal(clusterSeverityKey(sampleCluster({ fatalCount: 0, seriousCount: 0 })), "other");
});

test("cluster selection coordinator selects desktop clusters on the map view", async () => {
  const { ClusterSelectionCoordinator } = await coordinatorModule;
  const calls = [];
  const cluster = sampleCluster({ id: "desktop-cluster", fatalCount: 0, seriousCount: 1 });
  let activeView = "table";
  let coordinator;
  coordinator = new ClusterSelectionCoordinator({
    getActiveView: () => activeView,
    isMobileLayout: () => false,
    setView: (view) => {
      calls.push(["setView", view]);
      activeView = view;
    },
    mapSelect: (selectedCluster, focus, reason, zoomLevel) => {
      calls.push(["mapSelect", selectedCluster.id, focus, reason, zoomLevel]);
      calls.push(["measured", coordinator.measureActiveInteractionStep("inside map select", selectedCluster.id, () => "ok")]);
    },
    ensureSeverityVisible: (selectedCluster) => calls.push(["ensureSeverity", selectedCluster.id]),
    scheduleFrame: (work) => {
      calls.push(["frame"]);
      work();
    }
  });

  await withMutedInteractionLog(() => coordinator.selectCluster(cluster, "table row", 12));

  assert.deepEqual(calls, [
    ["ensureSeverity", "desktop-cluster"],
    ["setView", "map"],
    ["frame"],
    ["mapSelect", "desktop-cluster", true, "program", 12],
    ["measured", "ok"],
    ["frame"],
    ["frame"]
  ]);
});

test("cluster selection coordinator opens details after mobile map selection", async () => {
  const { ClusterSelectionCoordinator } = await coordinatorModule;
  const calls = [];
  const cluster = sampleCluster({ id: "mobile-cluster" });
  let activeView = "explore";
  const coordinator = new ClusterSelectionCoordinator({
    getActiveView: () => activeView,
    isMobileLayout: () => true,
    setView: (view) => {
      calls.push(["setView", view]);
      activeView = view;
    },
    mapSelect: (selectedCluster, focus, reason, zoomLevel) => calls.push(["mapSelect", selectedCluster.id, focus, reason, zoomLevel]),
    ensureSeverityVisible: (selectedCluster) => calls.push(["ensureSeverity", selectedCluster.id]),
    scheduleFrame: (work) => {
      calls.push(["frame"]);
      work();
    }
  });

  await withMutedInteractionLog(() => coordinator.selectCluster(cluster));

  assert.deepEqual(calls, [
    ["ensureSeverity", "mobile-cluster"],
    ["frame"],
    ["mapSelect", "mobile-cluster", true, "program", null],
    ["setView", "details"],
    ["frame"],
    ["frame"]
  ]);
});

test("cluster selection coordinator measures work without an active selection", async () => {
  const { ClusterSelectionCoordinator } = await coordinatorModule;
  const coordinator = new ClusterSelectionCoordinator({
    getActiveView: () => "map",
    isMobileLayout: () => false,
    setView: () => {},
    mapSelect: () => {},
    ensureSeverityVisible: () => {},
    scheduleFrame: (work) => work()
  });

  assert.equal(coordinator.measureActiveInteractionStep("standalone", null, () => 42), 42);
});

async function loadCoordinatorModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/clusterSelectionCoordinator.ts")],
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

async function withMutedInteractionLog(work) {
  const originalConsole = {
    groupCollapsed: console.groupCollapsed,
    groupEnd: console.groupEnd,
    info: console.info,
    table: console.table
  };
  console.groupCollapsed = () => {};
  console.groupEnd = () => {};
  console.info = () => {};
  console.table = () => {};
  try {
    return await work();
  } finally {
    console.groupCollapsed = originalConsole.groupCollapsed;
    console.groupEnd = originalConsole.groupEnd;
    console.info = originalConsole.info;
    console.table = originalConsole.table;
  }
}
