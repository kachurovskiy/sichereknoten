import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { buildStreetLookupBundle } from "./build-streets.mjs";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const assetsDir = path.join(docsDir, "assets");
const sourceDataDir = path.join(root, "data");

await mkdir(assetsDir, { recursive: true });
await cleanGeneratedAssets();
const csvFileList = await csvFiles();
const normalizedDataCsvFileList = chronologicalCsvFiles(csvFileList);
const streetLookupBundle = await buildStreetLookupBundle({ root, sourceDataDir, csvFiles: csvFileList });
const appVersion = await hashAppSources();
const analysisCacheVersion = await hashAnalysisSources();
const dataScriptTags = await writeDataBundle(normalizedDataCsvFileList, streetLookupBundle, analysisCacheVersion);

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
    __SICHERE_KNOTEN_ANALYSIS_CACHE_VERSION__: JSON.stringify(analysisCacheVersion),
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
    `${dataScriptTags.map((fileName) => `    <script src="./assets/${fileName}?v=${appVersion}"></script>`).join("\n")}\n    <script src="./assets/app.js?v=${appVersion}"></script>`
  );

await writeFile(path.join(docsDir, "index.html"), docsHtml);
await writeSiteVersionManifest(appVersion, analysisCacheVersion);
await copyFile(path.join(root, "favicon.svg"), path.join(docsDir, "favicon.svg"));

async function writeDataBundle(files, streetLookup, analysisCacheVersion) {
  const dataVersion = await hashFiles(files, streetLookup);
  const fileMetadata = await sourceFileMetadata(files);
  const defaultAnalysisOptions = await defaultAnalysisOptionsFromHtml(files);
  const reusableAccidentShardFiles = await reusableAccidentShards(dataVersion);
  const accidentShardFiles = reusableAccidentShardFiles ?? (await writeAccidentShards(dataVersion, files, streetLookup));
  const defaultAnalysis =
    (await reusableDefaultAnalysis(dataVersion, analysisCacheVersion, defaultAnalysisOptions)) ??
    (await writeDefaultAnalysis(dataVersion, analysisCacheVersion, accidentShardFiles, defaultAnalysisOptions));

  if (reusableAccidentShardFiles) {
    await removeGeneratedAccidentDataFiles(new Set(reusableAccidentShardFiles.map((file) => file.fileName)));
    console.log(
      `Reused ${reusableAccidentShardFiles.length.toLocaleString("en-US")} normalized accident state shard scripts for data version ${dataVersion}.`
    );
  }
  await removeGeneratedDefaultAnalysisFiles(new Set([defaultAnalysis.fileName]));

  await writeDataManifest(dataVersion, fileMetadata, accidentShardFiles, defaultAnalysis);
  return ["data-manifest.js"];
}

async function writeAccidentShards(dataVersion, files, streetLookup) {
  const legacyChunkFiles = await reusableAccidentChunks(dataVersion);
  if (legacyChunkFiles) {
    return writeAccidentShardsFromLegacyChunks(dataVersion, legacyChunkFiles);
  }

  const parseAccidentCsvFiles = await loadCsvParser();
  globalThis.__SICHERE_KNOTEN_STREETS__ = streetLookup;
  let recordIndex = 0;
  const recordsByState = new Map();

  for (const file of files) {
    const parsed = await parseCsvFile(file, parseAccidentCsvFiles);
    for (const accident of parsed) {
      accident.recordIndex = recordIndex;
      recordIndex += 1;
      const stateRecords = recordsByState.get(accident.stateCode) ?? [];
      stateRecords.push(compactAccidentRecord(accident));
      recordsByState.set(accident.stateCode, stateRecords);
    }
  }

  return writeAccidentShardFiles(dataVersion, recordsByState);
}

async function writeDataManifest(dataVersion, fileMetadata, accidentShardFiles, defaultAnalysis) {
  await writeFile(
    path.join(assetsDir, "data-manifest.js"),
    `globalThis.__SICHERE_KNOTEN_DATA__={version:${JSON.stringify(dataVersion)},files:${JSON.stringify(
      fileMetadata
    )},accidentShardFiles:${JSON.stringify(accidentShardFiles)},accidentShards:[],defaultAnalysisFile:${JSON.stringify(
      defaultAnalysis.fileName
    )},defaultAnalysisMetadata:${JSON.stringify(defaultAnalysis.metadata)},defaultAnalysis:null};\n`
  );
}

async function writeSiteVersionManifest(appVersion, analysisCacheVersion) {
  await writeFile(
    path.join(assetsDir, "site-version.json"),
    `${JSON.stringify({
      appVersion,
      analysisCacheVersion
    })}\n`
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
    fileName === "site-version.json" ||
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

async function reusableAccidentShards(dataVersion) {
  const manifest = await readExistingDataManifest();
  if (!manifest || manifest.version !== dataVersion || !Array.isArray(manifest.accidentShardFiles)) {
    return null;
  }
  if (manifest.accidentShardFiles.length === 0) {
    return null;
  }

  const shardFiles = [];
  for (const entry of manifest.accidentShardFiles) {
    if (!entry || typeof entry.stateCode !== "string" || typeof entry.fileName !== "string" || !/^accidents-state-[\w-]+\.js$/.test(entry.fileName)) {
      return null;
    }
    const expectedFileName = accidentShardFileName(entry.stateCode, dataVersion);
    const existingFilePath = path.join(assetsDir, entry.fileName);
    if (!(await fileExists(existingFilePath))) {
      return null;
    }
    if (entry.fileName !== expectedFileName) {
      const shard = await loadAccidentShard(entry.fileName);
      await writeAccidentShardScript(dataVersion, expectedFileName, { ...shard, id: expectedFileName.replace(/\.js$/i, "") });
    }
    shardFiles.push({
      stateCode: entry.stateCode,
      fileName: expectedFileName,
      recordCount: Number(entry.recordCount) || 0
    });
  }

  return shardFiles.sort((a, b) => a.stateCode.localeCompare(b.stateCode));
}

async function reusableDefaultAnalysis(dataVersion, analysisCacheVersion, options) {
  const manifest = await readExistingDataManifest();
  const fileName = manifest?.defaultAnalysisFile;
  const metadata = manifest?.defaultAnalysisMetadata;
  if (
    !manifest ||
    manifest.version !== dataVersion ||
    typeof fileName !== "string" ||
    !/^analysis-default-[\w-]+\.js$/.test(fileName) ||
    !defaultAnalysisMetadataMatches(metadata, dataVersion, analysisCacheVersion, options)
  ) {
    return null;
  }
  if (!(await fileExists(path.join(assetsDir, fileName)))) {
    return null;
  }

  console.log(`Reused bundled default analysis for data version ${dataVersion}.`);
  return { fileName, metadata };
}

async function writeDefaultAnalysis(dataVersion, analysisCacheVersion, accidentShardFiles, options) {
  const analyzeDangerousIntersections = await loadAnalysisModule();
  const accidents = await loadNormalizedAccidentsFromShards(accidentShardFiles);
  const result = compactAnalysisResult(analyzeDangerousIntersections(accidents, options));
  const metadata = {
    dataVersion,
    analysisCacheVersion,
    options: serializeAnalysisOptionsForBundle(options)
  };
  const bytes = Buffer.from(JSON.stringify(result));
  const compressed = gzipSync(bytes, { level: 9 });
  const fileName = defaultAnalysisFileName(dataVersion, analysisCacheVersion);
  const bundle = {
    id: "analysis-default",
    encoding: "gzip-base64-json-v1",
    metadata,
    clusterCount: result.clusters.length,
    filteredAccidentCount: result.filteredAccidentCount,
    size: bytes.byteLength,
    compressedSize: compressed.byteLength,
    chunks: chunkString(compressed.toString("base64"), 256 * 1024)
  };
  const script = `globalThis.__SICHERE_KNOTEN_DATA__=globalThis.__SICHERE_KNOTEN_DATA__||{version:${JSON.stringify(
    dataVersion
  )},files:[],accidentShards:[]};globalThis.__SICHERE_KNOTEN_DATA__.defaultAnalysis=${JSON.stringify(bundle)};\n`;
  await writeFile(path.join(assetsDir, fileName), script);
  console.log(`Wrote ${fileName} with ${result.clusters.length.toLocaleString("en-US")} default intersection clusters.`);
  return { fileName, metadata };
}

function defaultAnalysisFileName(dataVersion, analysisCacheVersion) {
  return `analysis-default-${dataVersion}-${analysisCacheVersion}.js`;
}

function defaultAnalysisMetadataMatches(metadata, dataVersion, analysisCacheVersion, options) {
  return (
    metadata &&
    metadata.dataVersion === dataVersion &&
    metadata.analysisCacheVersion === analysisCacheVersion &&
    JSON.stringify(metadata.options) === JSON.stringify(serializeAnalysisOptionsForBundle(options))
  );
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

async function writeAccidentShardsFromLegacyChunks(dataVersion, accidentChunkFiles) {
  const recordsByState = new Map();
  let recordCount = 0;
  for (const fileName of accidentChunkFiles) {
    const chunk = await loadLegacyAccidentChunk(fileName);
    const compactRecords = JSON.parse(gunzipSync(Buffer.from(chunk.chunks.join(""), "base64")).toString("utf8"));
    for (const record of compactRecords) {
      const accident = accidentFromCompactRecord(record, recordCount);
      recordCount += 1;
      const stateRecords = recordsByState.get(accident.stateCode) ?? [];
      stateRecords.push(compactAccidentRecord(accident));
      recordsByState.set(accident.stateCode, stateRecords);
    }
  }
  console.log(`Loaded ${recordCount.toLocaleString("en-US")} legacy normalized accident records for state sharding.`);
  return writeAccidentShardFiles(dataVersion, recordsByState);
}

async function writeAccidentShardFiles(dataVersion, recordsByState) {
  const shardFiles = [];
  for (const [stateCode, records] of Array.from(recordsByState.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    shardFiles.push(await writeAccidentShard(dataVersion, stateCode, records));
  }

  await removeGeneratedAccidentDataFiles(new Set(shardFiles.map((file) => file.fileName)));
  return shardFiles;
}

async function loadNormalizedAccidentsFromShards(accidentShardFiles) {
  const accidents = [];
  for (const entry of accidentShardFiles) {
    const shard = await loadAccidentShard(entry.fileName);
    const compactRecords = JSON.parse(gunzipSync(Buffer.from(shard.chunks.join(""), "base64")).toString("utf8"));
    for (const record of compactRecords) {
      accidents.push(accidentFromCompactRecord(record, accidents.length));
    }
  }
  accidents.sort((a, b) => (a.recordIndex ?? 0) - (b.recordIndex ?? 0));
  console.log(`Loaded ${accidents.length.toLocaleString("en-US")} normalized accident records for default analysis.`);
  return accidents;
}

async function loadLegacyAccidentChunk(fileName) {
  const script = await readFile(path.join(assetsDir, fileName), "utf8");
  const sandbox = { globalThis: {} };
  runInNewContext(script, sandbox, { timeout: 1000 });
  const chunk = sandbox.globalThis.__SICHERE_KNOTEN_DATA__?.accidentChunks?.[0];
  if (!chunk?.chunks) {
    throw new Error(`Could not load normalized accident chunk ${fileName}.`);
  }
  return chunk;
}

async function loadAccidentShard(fileName) {
  const script = await readFile(path.join(assetsDir, fileName), "utf8");
  const sandbox = { globalThis: {} };
  runInNewContext(script, sandbox, { timeout: 1000 });
  const shard = sandbox.globalThis.__SICHERE_KNOTEN_DATA__?.accidentShards?.[0];
  if (!shard?.chunks) {
    throw new Error(`Could not load normalized accident shard ${fileName}.`);
  }
  return shard;
}

async function removeGeneratedAccidentDataFiles(keep = new Set()) {
  const entries = await readdir(assetsDir);
  await Promise.all(
    entries
      .filter((entry) => (/^accidents-\d+\.js$/.test(entry) || /^accidents-state-[\w-]+\.js$/.test(entry)) && !keep.has(entry))
      .map((entry) => rm(path.join(assetsDir, entry), { force: true }))
  );
}

async function removeGeneratedDefaultAnalysisFiles(keep = new Set()) {
  const entries = await readdir(assetsDir);
  await Promise.all(
    entries
      .filter((entry) => (entry === "analysis-default.js" || /^analysis-default-[\w-]+\.js$/.test(entry)) && !keep.has(entry))
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

async function loadAnalysisModule() {
  const result = await build({
    entryPoints: [path.join(root, "src/analysis.ts")],
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
  return module.analyzeDangerousIntersections;
}

async function parseCsvFile(file, parseAccidentCsvFiles) {
  const bytes = await readFile(file.sourcePath);
  const sourceFile = new File([bytes], path.basename(file.publicPath), { type: file.type });
  const accidents = await parseAccidentCsvFiles([sourceFile], () => {});
  console.log(`Parsed ${accidents.length.toLocaleString("en-US")} accident records from ${file.publicPath}.`);
  return accidents;
}

async function defaultAnalysisOptionsFromHtml(files) {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const trendDeadZonePercent = numericInputDefault(html, "severityTrendDeadZone");
  const trendFullSignalPercent = Math.max(trendDeadZonePercent + 0.1, numericInputDefault(html, "severityTrendFullSignal"));
  return {
    clusterRadiusMeters: numericInputDefault(html, "clusterRadiusOut"),
    minAccidents: numericInputDefault(html, "minAccidents"),
    years: new Set(defaultAnalysisYears(files)),
    roadUserFocus: new Set(),
    stateCode: "all",
    severityPercent: {
      fatalWeight: numericInputDefault(html, "fatalWeight"),
      seriousWeight: numericInputDefault(html, "seriousWeight"),
      fullSampleAccidents: numericInputDefault(html, "severityFullSample"),
      trendYears: numericInputDefault(html, "severityTrendYears"),
      trendDeadZone: trendDeadZonePercent / 100,
      trendFullSignal: trendFullSignalPercent / 100,
      maxTrendAdjustment: numericInputDefault(html, "severityMaxTrendAdjustment") / 100,
      maxSeverityPercent: numericInputDefault(html, "severityMaxPercent") / 100
    }
  };
}

function defaultAnalysisYears(files) {
  const years = new Set();
  for (const file of files) {
    const label = `${file.publicPath} ${path.basename(file.publicPath)}`;
    for (const match of label.matchAll(/(20\d{2})/g)) {
      years.add(Number(match[1]));
    }
  }
  return Array.from(years).sort((a, b) => a - b);
}

function numericInputDefault(html, id) {
  const pattern = new RegExp(`<input\\b[^>]*id=["']${id}["'][^>]*>`, "i");
  const input = pattern.exec(html)?.[0];
  const value = input ? /\bvalue=["']([^"']+)["']/i.exec(input)?.[1] : null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Could not read default value for #${id}.`);
  }
  return number;
}

async function writeAccidentShard(dataVersion, stateCode, records) {
  const bytes = Buffer.from(JSON.stringify(records));
  const compressed = gzipSync(bytes, { level: 9 });
  const scriptFileName = accidentShardFileName(stateCode, dataVersion);
  const shard = {
    id: scriptFileName.replace(/\.js$/i, ""),
    stateCode,
    encoding: "gzip-base64-json-compact-v2",
    recordCount: records.length,
    size: bytes.byteLength,
    compressedSize: compressed.byteLength,
    chunks: chunkString(compressed.toString("base64"), 256 * 1024)
  };
  await writeAccidentShardScript(dataVersion, scriptFileName, shard);
  console.log(`Wrote ${scriptFileName} with ${records.length.toLocaleString("en-US")} normalized accident records.`);
  return {
    stateCode,
    fileName: scriptFileName,
    recordCount: records.length
  };
}

async function writeAccidentShardScript(dataVersion, scriptFileName, shard) {
  const script = `globalThis.__SICHERE_KNOTEN_DATA__=globalThis.__SICHERE_KNOTEN_DATA__||{version:${JSON.stringify(dataVersion)},files:[],accidentShards:[]};globalThis.__SICHERE_KNOTEN_DATA__.accidentShards=globalThis.__SICHERE_KNOTEN_DATA__.accidentShards||[];globalThis.__SICHERE_KNOTEN_DATA__.accidentShards.push(${JSON.stringify(shard)});\n`;
  await writeFile(path.join(assetsDir, scriptFileName), script);
}

function accidentShardFileName(stateCode, dataVersion) {
  const normalizedStateCode = String(stateCode || "unknown")
    .toLowerCase()
    .replace(/[^\w-]+/g, "-");
  return `accidents-state-${normalizedStateCode}-${dataVersion}.js`;
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
    accident.involvesOther,
    accident.recordIndex ?? null
  ];
}

function accidentFromCompactRecord(record, recordIndex) {
  const streetNames = record[3];
  const stateCode = record[4];
  const normalizedRecordIndex = typeof record[32] === "number" ? record[32] : recordIndex;
  return {
    id: record[0],
    recordIndex: normalizedRecordIndex,
    serialNumber: record[1],
    source: record[2],
    sourceType: "csv",
    streetName: streetNames[0] ?? null,
    streetNames,
    stateCode,
    stateName: stateNameFromCode(stateCode),
    administrativeRegionCode: record[5],
    districtCode: record[6],
    municipalityCode: record[7],
    administrativeRegionName: record[8],
    districtName: record[9],
    municipalityName: record[10],
    year: record[11],
    month: record[12],
    day: record[13],
    hour: record[14],
    weekday: record[15],
    category: record[16],
    accidentKind: record[17],
    accidentType: record[18],
    lightCondition: record[19],
    roadSurface: record[20],
    plausibilityLevel: record[21],
    linRefX: record[22],
    linRefY: record[23],
    lon: record[24],
    lat: record[25],
    involvesBike: record[26],
    involvesPedestrian: record[27],
    involvesMotorcycle: record[28],
    involvesCar: record[29],
    involvesTruck: record[30],
    involvesOther: record[31]
  };
}

function compactAnalysisResult(result) {
  return {
    ...result,
    clusters: result.clusters.map(compactAnalysisCluster),
    stateSummaries: result.stateSummaries.map((summary) => ({
      ...summary,
      topCluster: summary.topCluster ? compactAnalysisCluster(summary.topCluster) : null
    }))
  };
}

function compactAnalysisCluster(cluster) {
  const { accidentKeys: _accidentKeys, ...compact } = cluster;
  return compact;
}

function serializeAnalysisOptionsForBundle(options) {
  return {
    ...options,
    years: Array.from(options.years).sort((a, b) => a - b),
    roadUserFocus: Array.from(options.roadUserFocus).sort(),
    severityPercent: { ...options.severityPercent }
  };
}

function stateNameFromCode(code) {
  const names = {
    "01": "Schleswig-Holstein",
    "02": "Hamburg",
    "03": "Niedersachsen",
    "04": "Bremen",
    "05": "Nordrhein-Westfalen",
    "06": "Hessen",
    "07": "Rheinland-Pfalz",
    "08": "Baden-Wuerttemberg",
    "09": "Bayern",
    "10": "Saarland",
    "11": "Berlin",
    "12": "Brandenburg",
    "13": "Mecklenburg-Vorpommern",
    "14": "Sachsen",
    "15": "Sachsen-Anhalt",
    "16": "Thueringen"
  };
  return names[code] ?? `Bundesland ${code}`;
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

async function hashAnalysisSources() {
  const files = [
    path.join(root, "src/analysis.ts"),
    path.join(root, "src/analysisRunner.ts"),
    path.join(root, "src/analysisWorker.ts"),
    path.join(root, "src/analysisWorkerProtocol.ts"),
    path.join(root, "src/cache.ts"),
    path.join(root, "src/geo.ts"),
    path.join(root, "src/roadUsers.ts"),
    path.join(root, "src/types.ts")
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
