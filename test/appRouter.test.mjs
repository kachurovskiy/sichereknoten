import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const routerModule = loadRouterModule();

test("app router pushes view entries and restores views on browser back", async () => {
  const browser = installBrowser("https://example.test/app");
  const { AppRouter } = await routerModule;
  const elements = fakeRouterElements();
  const changedViews = [];
  const router = new AppRouter(elements, {
    canOpenDetails: () => true,
    setStatus: () => {},
    onViewChanged: (view) => changedViews.push(view),
    scheduleMapRefresh: () => {}
  });

  router.bindEvents();
  router.setView("map", { history: "replace" });
  router.setView("similar");
  router.setView("table");

  assert.equal(browser.historyLength(), 3);
  assert.equal(browser.location.href, "https://example.test/app?view=intersections");
  assert.equal(router.activeView, "table");

  browser.back();

  assert.equal(browser.location.href, "https://example.test/app?view=similar");
  assert.equal(router.activeView, "similar");
  assert.equal(elements.similarView.classList.contains("active"), true);
  assert.equal(elements.tableView.classList.contains("active"), false);
  assert.equal(browser.historyLength(), 3);
  assert.deepEqual(changedViews, ["map", "similar", "table", "similar"]);
});

async function loadRouterModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/appRouter.ts")],
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

function installBrowser(initialHref) {
  const listeners = new Map();
  const location = { href: initialHref };
  const historyEntries = [{ state: null, href: initialHref }];
  let historyIndex = 0;
  const history = {
    get state() {
      return historyEntries[historyIndex].state;
    },
    pushState(state, _title, href) {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ state, href });
      historyIndex = historyEntries.length - 1;
      location.href = href;
    },
    replaceState(state, _title, href) {
      historyEntries[historyIndex] = { state, href };
      location.href = href;
    }
  };
  global.window = {
    location,
    history,
    matchMedia: () => ({
      matches: false,
      addEventListener() {}
    }),
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    }
  };
  global.document = {
    addEventListener() {}
  };
  return {
    location,
    historyLength: () => historyEntries.length,
    back() {
      historyIndex = Math.max(0, historyIndex - 1);
      location.href = historyEntries[historyIndex].href;
      for (const handler of listeners.get("popstate") ?? []) {
        handler({ state: historyEntries[historyIndex].state });
      }
    }
  };
}

function fakeRouterElements() {
  return {
    app: fakeElement(),
    exploreTab: fakeElement(),
    mapTab: fakeElement(),
    detailsTab: fakeElement(),
    moreTab: fakeElement(),
    stateTab: fakeElement(),
    regionTab: fakeElement(),
    similarTab: fakeElement(),
    tableTab: fakeElement(),
    settingsTab: fakeElement(),
    mobileMoreMenu: fakeElement(),
    mobileStateTab: fakeElement(),
    mobileRegionTab: fakeElement(),
    mobileTableTab: fakeElement(),
    mobileSettingsTab: fakeElement(),
    mapView: fakeElement(),
    stateView: fakeElement(),
    regionView: fakeElement(),
    similarView: fakeElement(),
    tableView: fakeElement(),
    settingsView: fakeElement()
  };
}

function fakeElement() {
  const attributes = new Map();
  const classes = new Set();
  return {
    dataset: {},
    hidden: false,
    disabled: false,
    addEventListener() {},
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    toggleAttribute(name, force) {
      if (force) {
        attributes.set(name, "");
      } else {
        attributes.delete(name);
      }
    },
    classList: {
      toggle(name, force) {
        if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      contains(name) {
        return classes.has(name);
      }
    }
  };
}
