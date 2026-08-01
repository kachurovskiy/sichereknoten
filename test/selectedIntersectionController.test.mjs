import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const controllerModule = loadControllerModule();

test("selected intersection URL history pushes only changed interactive selections", async () => {
  installBrowser();
  const { SelectedIntersectionController } = await controllerModule;
  const urlWrites = [];
  const controller = new SelectedIntersectionController(
    controllerDependencies({
      updateIntersectionSelectionUrl: (cluster, historyMode) => urlWrites.push([cluster.id, historyMode])
    })
  );

  controller.handleMapSelection(sampleCluster({ id: "a" }), "program");
  controller.handleMapSelection(sampleCluster({ id: "a" }), "program");
  controller.handleMapSelection(sampleCluster({ id: "b" }), "program");
  controller.handleMapSelection(sampleCluster({ id: "a" }), "history");

  assert.deepEqual(urlWrites, [
    ["a", "push"],
    ["a", "replace"],
    ["b", "push"],
    ["a", "none"]
  ]);
});

test("selected intersection history clear does not push a replacement map entry", async () => {
  installBrowser();
  const { SelectedIntersectionController } = await controllerModule;
  const viewChanges = [];
  const controller = new SelectedIntersectionController(
    controllerDependencies({
      getActiveView: () => "details",
      setView: (view, options) => viewChanges.push([view, options])
    })
  );

  controller.handleMapSelection(null, "history");

  assert.deepEqual(viewChanges, [["map", { history: "none" }]]);
});

async function loadControllerModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/selection/selectedIntersectionController.ts")],
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

function installBrowser() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      isSecureContext: true,
      localStorage: {
        getItem: () => null,
        setItem: () => {}
      },
      setTimeout: (callback) => callback()
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {}
      }
    }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ style: {}, select() {}, remove() {} }),
      body: {
        append() {}
      },
      execCommand: () => true
    }
  });
}

function controllerDependencies(overrides = {}) {
  return {
    elements: fakeElements(),
    panelView: {
      renderEmpty() {},
      render() {},
      renderIncidentDialogHtml: () => "",
      factsheetButtons: () => []
    },
    previewMapView: {
      clear() {},
      render() {}
    },
    map: {
      setSelectedIncidentPoints() {},
      focus() {}
    },
    requestGate: {
      cancel() {},
      start: () => ({ kind: "test", id: 1 }),
      isCurrent: () => true
    },
    getAnalysisResult: () => sampleResult(),
    getAnalysisOptions: () => sampleOptions(),
    getCachedAccidentsForState: () => [],
    hasAccidentStateShard: () => false,
    loadAccidentsForState: async () => [],
    latestBundledFileDate: () => null,
    formatSeverityPercentWithContext: () => "12.3%",
    roadClassSignatureForStreetNames: () => null,
    renderVisibleSimilarView: () => {},
    renderBrowseLists: () => ({ nearbyCount: 0, stateHotspotCount: 0 }),
    getActiveView: () => "map",
    isMobileLayout: () => false,
    setView: () => {},
    setStatus: () => {},
    updateIntersectionSelectionUrl: () => {},
    scheduleMapRefresh: () => {},
    measureStep: (_name, _detail, work) => work(),
    ...overrides
  };
}

function fakeElements() {
  return {
    mapColumn: fakeElement(),
    mapView: fakeElement(),
    selectedAside: fakeElement(),
    selectedPermalinkBtn: fakeElement(),
    selectionDetails: fakeElement(),
    detailsTab: fakeElement(),
    similarTab: fakeElement(),
    incidentDialog: fakeElement(),
    incidentDialogBody: fakeElement(),
    streetViewPanel: fakeElement(),
    streetViewToggle: fakeElement(),
    streetViewToggleText: fakeElement(),
    streetViewBody: fakeElement(),
    streetViewFrame: {
      ...fakeElement(),
      contentWindow: {
        location: {
          replace() {}
        }
      }
    },
    streetViewEmpty: fakeElement()
  };
}

function fakeElement() {
  return {
    hidden: false,
    disabled: false,
    dataset: {},
    classList: {
      add() {},
      toggle() {},
      remove() {}
    },
    addEventListener() {},
    setAttribute() {}
  };
}

function sampleResult() {
  return {
    clusters: [],
    stateSummaries: [],
    stateAccidentSummaries: [],
    regionAccidentSummaries: [],
    filteredAccidentCount: 0,
    years: [2025]
  };
}

function sampleOptions() {
  return {
    clusterRadiusMeters: 50,
    minAccidents: 1,
    years: new Set([2025]),
    roadUserFocus: new Set(),
    stateCode: "all",
    severityPercent: {
      fatalWeight: 3,
      seriousWeight: 1,
      fullSampleAccidents: 1,
      trendYears: 5,
      trendDeadZone: 0.08,
      trendFullSignal: 0.25,
      maxTrendAdjustment: 0.2,
      maxSeverityPercent: 1
    }
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
    streetNames: ["A 1"],
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
