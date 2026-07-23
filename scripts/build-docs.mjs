import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { buildStreetLookupBundle } from "./build-streets.mjs";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const assetsDir = path.join(docsDir, "assets");
const sourceDataDir = path.join(root, "data");
const NORMALIZED_ACCIDENT_CHUNK_SIZE = 100000;

await mkdir(assetsDir, { recursive: true });
await cleanGeneratedAssets();
const csvFileList = await csvFiles();
const normalizedDataCsvFileList = chronologicalCsvFiles(csvFileList);
const streetLookupBundle = await buildStreetLookupBundle({ root, sourceDataDir, csvFiles: csvFileList });
const dataScriptTags = await writeDataBundle(normalizedDataCsvFileList, streetLookupBundle);
const appVersion = await hashAppSources();

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  outfile: path.join(assetsDir, "app.js"),
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: {
    __SICHERE_KNOTEN_APP_VERSION__: JSON.stringify(appVersion),
    __SICHERE_KNOTEN_ANALYSIS_WORKER_URL__: JSON.stringify(`./assets/analysis-worker.js?v=${appVersion}`)
  }
});

await build({
  entryPoints: [path.join(root, "src/analysisWorker.ts")],
  bundle: true,
  outfile: path.join(assetsDir, "analysis-worker.js"),
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none"
});

const sourceHtml = await readFile(path.join(root, "index.html"), "utf8");
const docsHtml = sourceHtml
  .replace("  </head>", `    <link rel="stylesheet" href="./assets/app.css?v=${appVersion}" />\n  </head>`)
  .replace(
    '    <script type="module" src="/src/main.ts"></script>',
    `${dataScriptTags.map((fileName) => `    <script src="./assets/${fileName}"></script>`).join("\n")}\n    <script src="./assets/app.js?v=${appVersion}"></script>`
  );

await writeFile(path.join(docsDir, "index.html"), docsHtml);
await copyFile(path.join(root, "favicon.svg"), path.join(docsDir, "favicon.svg"));

async function writeDataBundle(files, streetLookup) {
  const dataVersion = await hashFiles(files, streetLookup);
  const fileMetadata = await sourceFileMetadata(files);
  const reusableAccidentChunkFiles = await reusableAccidentChunks(dataVersion);
  const accidentChunkFiles = reusableAccidentChunkFiles ?? (await writeAccidentChunks(dataVersion, files, streetLookup));

  if (reusableAccidentChunkFiles) {
    await removeGeneratedAccidentChunks(new Set(reusableAccidentChunkFiles));
    console.log(
      `Reused ${reusableAccidentChunkFiles.length.toLocaleString("en-US")} normalized accident chunk scripts for data version ${dataVersion}.`
    );
  }

  await writeDataManifest(dataVersion, fileMetadata, accidentChunkFiles);
  return ["data-manifest.js"];
}

async function writeAccidentChunks(dataVersion, files, streetLookup) {
  const parseAccidentCsvFiles = await loadCsvParser();
  globalThis.__SICHERE_KNOTEN_STREETS__ = streetLookup;
  let accidentChunkIndex = 1;
  let pendingRecords = [];
  const accidentChunkFiles = [];

  for (const file of files) {
    const parsed = await parseCsvFile(file, parseAccidentCsvFiles);
    for (const accident of parsed) {
      pendingRecords.push(compactAccidentRecord(accident));
      if (pendingRecords.length >= NORMALIZED_ACCIDENT_CHUNK_SIZE) {
        accidentChunkFiles.push(await writeAccidentChunk(dataVersion, accidentChunkIndex, pendingRecords));
        accidentChunkIndex += 1;
        pendingRecords = [];
      }
    }
  }

  if (pendingRecords.length > 0) {
    accidentChunkFiles.push(await writeAccidentChunk(dataVersion, accidentChunkIndex, pendingRecords));
  }

  await removeGeneratedAccidentChunks(new Set(accidentChunkFiles));
  return accidentChunkFiles;
}

async function writeDataManifest(dataVersion, fileMetadata, accidentChunkFiles) {
  await writeFile(
    path.join(assetsDir, "data-manifest.js"),
    `globalThis.__SICHERE_KNOTEN_DATA__={version:${JSON.stringify(dataVersion)},files:${JSON.stringify(
      fileMetadata
    )},accidentChunkFiles:${JSON.stringify(accidentChunkFiles)},accidentChunks:[]};\n`
  );
}

async function cleanGeneratedAssets() {
  const entries = await readdir(assetsDir);
  await Promise.all(
    entries
      .filter((entry) => isGeneratedAsset(entry))
      .map((entry) => rm(path.join(assetsDir, entry), { force: true }))
  );
}

function isGeneratedAsset(fileName) {
  return (
    fileName === "app.js" ||
    fileName === "app.css" ||
    fileName === "analysis-worker.js" ||
    fileName === "csv-parser-worker.js" ||
    fileName === "streets.js" ||
    /^data-\d+\.js$/.test(fileName)
  );
}

async function reusableAccidentChunks(dataVersion) {
  const manifest = await readExistingDataManifest();
  if (!manifest || manifest.version !== dataVersion || !Array.isArray(manifest.accidentChunkFiles)) {
    return null;
  }
  if (manifest.accidentChunkFiles.length === 0) {
    return null;
  }

  const chunkFiles = [];
  for (const fileName of manifest.accidentChunkFiles) {
    if (typeof fileName !== "string" || !/^accidents-\d+\.js$/.test(fileName)) {
      return null;
    }
    if (!(await fileExists(path.join(assetsDir, fileName)))) {
      return null;
    }
    chunkFiles.push(fileName);
  }

  return chunkFiles;
}

async function readExistingDataManifest() {
  try {
    const script = await readFile(path.join(assetsDir, "data-manifest.js"), "utf8");
    const sandbox = { globalThis: {} };
    runInNewContext(script, sandbox, { timeout: 1000 });
    const manifest = sandbox.globalThis.__SICHERE_KNOTEN_DATA__;
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null;
  }
}

async function removeGeneratedAccidentChunks(keep = new Set()) {
  const entries = await readdir(assetsDir);
  await Promise.all(
    entries
      .filter((entry) => /^accidents-\d+\.js$/.test(entry) && !keep.has(entry))
      .map((entry) => rm(path.join(assetsDir, entry), { force: true }))
  );
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function sourceFileMetadata(files) {
  const metadata = [];
  for (const file of files) {
    const sourceStats = await stat(file.sourcePath);
    metadata.push({
      path: file.publicPath,
      name: path.basename(file.publicPath),
      type: file.type,
      size: sourceStats.size,
      modifiedTime: sourceStats.mtime.toISOString()
    });
  }
  return metadata;
}

async function loadCsvParser() {
  const result = await build({
    entryPoints: [path.join(root, "src/parsers/csv.ts")],
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
  const module = await import(moduleUrl);
  return module.parseAccidentCsvFiles;
}

async function parseCsvFile(file, parseAccidentCsvFiles) {
  const bytes = await readFile(file.sourcePath);
  const sourceFile = new File([bytes], path.basename(file.publicPath), { type: file.type });
  const accidents = await parseAccidentCsvFiles([sourceFile], () => {});
  console.log(`Parsed ${accidents.length.toLocaleString("en-US")} accident records from ${file.publicPath}.`);
  return accidents;
}

async function writeAccidentChunk(dataVersion, index, records) {
  const bytes = Buffer.from(JSON.stringify(records));
  const compressed = gzipSync(bytes, { level: 9 });
  const scriptFileName = `accidents-${index}.js`;
  const chunk = {
    id: `accidents-${index}`,
    encoding: "gzip-base64-json-compact-v1",
    recordCount: records.length,
    size: bytes.byteLength,
    compressedSize: compressed.byteLength,
    chunks: chunkString(compressed.toString("base64"), 256 * 1024)
  };
  const script = `globalThis.__SICHERE_KNOTEN_DATA__=globalThis.__SICHERE_KNOTEN_DATA__||{version:${JSON.stringify(dataVersion)},files:[],accidentChunks:[]};globalThis.__SICHERE_KNOTEN_DATA__.accidentChunks=globalThis.__SICHERE_KNOTEN_DATA__.accidentChunks||[];globalThis.__SICHERE_KNOTEN_DATA__.accidentChunks.push(${JSON.stringify(chunk)});\n`;
  await writeFile(path.join(assetsDir, scriptFileName), script);
  console.log(`Wrote ${scriptFileName} with ${records.length.toLocaleString("en-US")} normalized accident records.`);
  return scriptFileName;
}

function compactAccidentRecord(accident) {
  return [
    accident.id,
    accident.serialNumber,
    accident.source,
    accident.streetNames,
    accident.stateCode,
    accident.administrativeRegionCode,
    accident.districtCode,
    accident.municipalityCode,
    accident.administrativeRegionName,
    accident.districtName,
    accident.municipalityName,
    accident.year,
    accident.month,
    accident.day,
    accident.hour,
    accident.weekday,
    accident.category,
    accident.accidentKind,
    accident.accidentType,
    accident.lightCondition,
    accident.roadSurface,
    accident.plausibilityLevel,
    accident.linRefX,
    accident.linRefY,
    accident.lon,
    accident.lat,
    accident.involvesBike,
    accident.involvesPedestrian,
    accident.involvesMotorcycle,
    accident.involvesCar,
    accident.involvesTruck,
    accident.involvesOther
  ];
}

async function hashFiles(files, streetLookup) {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.sourcePath);
    hash.update(file.publicPath);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  if (streetLookup) {
    hash.update("streets");
    hash.update("\0");
    hash.update(streetLookup.version);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function hashAppSources() {
  const files = [
    ...(await sourceFiles(path.join(root, "src"))),
    path.join(root, "index.html"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
    path.join(root, "scripts/build-docs.mjs"),
    path.join(root, "scripts/build-streets.mjs")
  ].sort();
  const hash = createHash("sha256");

  for (const file of files) {
    const bytes = await readFile(file);
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function csvFiles() {
  const csvDir = path.join(sourceDataDir, "csv");
  const entries = await readdir(csvDir);
  const files = [];

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".csv")) {
      continue;
    }
    const sourcePath = path.join(csvDir, entry);
    if (!(await stat(sourcePath)).isFile()) {
      continue;
    }
    files.push({
      sourcePath,
      publicPath: `data/csv/${entry}`,
      type: "text/csv"
    });
  }

  return files;
}

function chronologicalCsvFiles(files) {
  return [...files].sort((a, b) => compareCsvFileNames(a.publicPath, b.publicPath));
}

function compareCsvFileNames(a, b) {
  return csvFileYear(a) - csvFileYear(b) || a.localeCompare(b);
}

function csvFileYear(name) {
  const match = /20\d{2}/.exec(name);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}
