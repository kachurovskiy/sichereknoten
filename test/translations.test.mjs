import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const translationsModule = loadTsModule("src/translations.ts");
const loadingFactsModule = loadTsModule("src/loadingFacts.ts");

test("English and German translation keys match", async () => {
  const { TRANSLATIONS } = await translationsModule;
  const enKeys = Object.keys(TRANSLATIONS.en).sort();
  const deKeys = Object.keys(TRANSLATIONS.de).sort();

  assert.deepEqual(deKeys, enKeys);
});

test("loading facts provide text for every supported locale", async () => {
  const { TRANSLATIONS } = await translationsModule;
  const { DEFAULT_LOADING_FACT_META, LOADING_FACTS } = await loadingFactsModule;
  const locales = Object.keys(TRANSLATIONS).sort();

  assert.deepEqual(Object.keys(DEFAULT_LOADING_FACT_META).sort(), locales);
  for (const fact of LOADING_FACTS) {
    assert.deepEqual(Object.keys(fact.text).sort(), locales);
    if (fact.meta) {
      assert.deepEqual(Object.keys(fact.meta).sort(), locales);
    }
  }
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
