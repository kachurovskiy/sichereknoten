import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const presenterModule = loadPresenterModule();

test("loading title key follows status priority", async () => {
  const { loadingTitleKey } = await presenterModule;

  assert.equal(loadingTitleKey(100, "problem", true), "loading.title.problem");
  assert.equal(loadingTitleKey(100, "idle", true), "loading.title.idle");
  assert.equal(loadingTitleKey(100, "normal", true), "loading.title.noMatches");
  assert.equal(loadingTitleKey(100, "normal", false), "loading.title.ready");
  assert.equal(loadingTitleKey(75, "normal", false), "loading.title.analyze");
  assert.equal(loadingTitleKey(10, "normal", false), "loading.title.result");
  assert.equal(loadingTitleKey(9, "normal", false), "loading.title.bundle");
});

test("loading status presenter renders normalized progress and translated title", async () => {
  const { LoadingStatusPresenter } = await presenterModule;
  const elements = loadingElements();
  const presenter = new LoadingStatusPresenter({
    elements,
    hasNoClusters: () => true,
    onShowSplash: () => {},
    translate: (key) => `translated:${key}`
  });

  presenter.setStatus("Done", 120);

  assert.equal(elements.mapLoadingStatus.textContent, "Done");
  assert.equal(elements.mapLoadingBar.style.width, "100%");
  assert.equal(elements.mapLoadingTitle.textContent, "translated:loading.title.noMatches");
});

test("loading status presenter owns splash busy state", async () => {
  const { LoadingStatusPresenter } = await presenterModule;
  const elements = loadingElements();
  let shown = 0;
  const presenter = new LoadingStatusPresenter({
    elements,
    hasNoClusters: () => false,
    onShowSplash: () => {
      shown += 1;
    },
    translate: (key) => key
  });

  presenter.setBusy(true);
  presenter.setBusy(true);
  presenter.setBusy(false);

  assert.equal(shown, 1);
  assert.equal(elements.splash.hidden, true);
  assert.equal(elements.splash.attributes.get("aria-busy"), "false");
});

async function loadPresenterModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/app/loadingStatusPresenter.ts")],
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

function loadingElements() {
  return {
    splash: fakeElement(),
    mapLoadingTitle: fakeElement(),
    mapLoadingStatus: fakeElement(),
    mapLoadingBar: fakeElement()
  };
}

function fakeElement() {
  return {
    hidden: true,
    textContent: "",
    style: {},
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  };
}
