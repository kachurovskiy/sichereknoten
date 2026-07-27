import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const urlStateModule = loadUrlStateModule();

test("intersection URL selection parses coordinates and rounded zoom", async () => {
  const { readIntersectionUrlSelection } = await urlStateModule;

  assert.deepEqual(readIntersectionUrlSelection("?lat=50.987654&lon=7.123456&z=12.6"), {
    lat: 50.987654,
    lon: 7.123456,
    zoomLevel: 13
  });
});

test("intersection URL selection rejects missing or out-of-range coordinates", async () => {
  const { readIntersectionUrlSelection } = await urlStateModule;

  assert.equal(readIntersectionUrlSelection("?lat=91&lon=7.1&z=12"), null);
  assert.equal(readIntersectionUrlSelection("?lat=50.9&lon=181&z=12"), null);
  assert.equal(readIntersectionUrlSelection("?lon=7.1&z=12"), null);
});

test("intersection URL selection ignores invalid zoom while keeping valid coordinates", async () => {
  const { readIntersectionUrlSelection } = await urlStateModule;

  assert.deepEqual(readIntersectionUrlSelection("?lat=50.9&lon=7.1&z=20"), {
    lat: 50.9,
    lon: 7.1,
    zoomLevel: null
  });
});

test("intersection URL href writes rounded coordinates and preserves unrelated params", async () => {
  const { intersectionSelectionHref } = await urlStateModule;
  const href = intersectionSelectionHref("https://example.test/app?view=details&lat=0", { lat: 50.9876543, lon: 7.1234567 }, 14);

  assert.equal(href, "https://example.test/app?view=details&lat=50.98765&lon=7.12346&z=14");
});

test("intersection URL href returns null when selection params are unchanged", async () => {
  const { intersectionSelectionHref } = await urlStateModule;

  assert.equal(
    intersectionSelectionHref("https://example.test/app?lat=50.98765&lon=7.12346&z=14", { lat: 50.9876543, lon: 7.1234567 }, 14),
    null
  );
});

async function loadUrlStateModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/intersectionUrlState.ts")],
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
