import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { inflateSync } from "node:zlib";

// See STREET_LOOKUP_PIPELINE.md for the build flow diagram and stage notes.
const STREET_LOOKUP_SCHEMA_VERSION = 7;
const NODE_CAPTURE_RADIUS_METERS = 55;
const STREET_MATCH_RADIUS_METERS = 30;
const ROAD_CONTROL_MATCH_RADIUS_METERS = 55;
const ROUNDABOUT_CLUSTER_BUFFER_METERS = 20;
const MAX_STREET_NAMES_PER_ACCIDENT = 4;
const NODE_COORD_SHARD_COUNT = 256;
const NODE_COORD_INITIAL_SHARD_CAPACITY = 1024;
const NODE_COORD_MAX_LOAD_NUMERATOR = 4;
const NODE_COORD_MAX_LOAD_DENOMINATOR = 5;
const GRID_CELL_METERS = 60;
const GRID_CELL_KEY_FACTOR = 10_000_000;
const GRID_CELL_KEY_OFFSET = 1_000_000;
const COORD_PACK_BASE = 10_000_000;
const OSM_ROUNDABOUT_MASK = 1;
const OSM_TRAFFIC_SIGNAL_MASK = 2;
const STREET_DENSE_NODE_WORKER = "street-dense-node-worker";
const DEFAULT_DENSE_NODE_WORKER_BATCH_GROUPS = 32;
const DEFAULT_DENSE_NODE_WORKER_BATCH_BYTES = 4 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8");
const csvDecoder = new TextDecoder("windows-1252");
const germanBaseCollator = new Intl.Collator("de", { sensitivity: "base" });
const degreesToRadians = Math.PI / 180;

if (!isMainThread && workerData?.kind === STREET_DENSE_NODE_WORKER) {
  startDenseNodeWorker(workerData);
}

export async function buildStreetLookupBundle({ root, sourceDataDir, csvFiles }) {
  if (process.env.SICHERE_KNOTEN_SKIP_STREETS === "1") {
    return null;
  }

  const pbfPath = process.env.SICHERE_KNOTEN_PBF
    ? path.resolve(root, process.env.SICHERE_KNOTEN_PBF)
    : path.join(sourceDataDir, "germany-260721.osm.pbf");
  const pbfStats = await optionalStat(pbfPath);
  if (!pbfStats?.isFile()) {
    console.warn(`Street lookup skipped: ${path.relative(root, pbfPath)} not found.`);
    return null;
  }

  const signature = await streetLookupSignature(csvFiles, pbfPath, pbfStats);
  const cachePath = path.join(sourceDataDir, "generated", "street-lookup.json");
  const forceRebuild = process.env.SICHERE_KNOTEN_STREET_FORCE_REBUILD === "1";
  const cached = forceRebuild ? null : await readStreetLookupCache(cachePath, signature);
  if (cached) {
    console.log(`Street lookup loaded from ${path.relative(root, cachePath)}.`);
    return cached;
  }
  if (forceRebuild) {
    console.log("Street lookup cache bypassed by SICHERE_KNOTEN_STREET_FORCE_REBUILD=1.");
  }

  const source = await readAccidentSource(csvFiles);
  if (source.accidents.length === 0) {
    return {
      version: signature,
      names: [],
      roundabouts: [],
      files: source.files.map((file) => ({
        name: file.name,
        indexes: file.indexes,
        osmRoadControlMasks: file.osmRoadControlMasks,
        osmRoundaboutIndexes: file.osmRoundaboutIndexes
      }))
    };
  }

  console.log(`Building street lookup from ${path.relative(root, pbfPath)} for ${source.accidents.length.toLocaleString()} accidents.`);
  const grid = buildAccidentGrid(source.accidents);
  const { completed, roundabouts } = await matchStreetsFromPbf(pbfPath, pbfStats.size, source.accidents, grid);
  const bundle = finalizeStreetLookup(signature, source, roundabouts);
  if (completed) {
    await writeStreetLookupCache(cachePath, bundle);
  } else {
    console.warn("Street lookup PBF scan was limited; generated result was not cached.");
  }
  console.log(
    `Street lookup matched ${matchedAccidentCount(source.accidents).toLocaleString()} accidents to ${bundle.names.length.toLocaleString()} street names.`
  );
  return bundle;
}

async function optionalStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function streetLookupSignature(csvFiles, pbfPath, pbfStats) {
  const hash = createHash("sha256");
  hash.update(`street-schema:${STREET_LOOKUP_SCHEMA_VERSION}\0`);
  hash.update(path.basename(pbfPath));
  hash.update("\0");
  hash.update(String(pbfStats.size));
  hash.update("\0");
  hash.update(pbfStats.mtime.toISOString());
  hash.update("\0");

  for (const file of csvFiles) {
    const fileStats = await stat(file.sourcePath);
    hash.update(file.publicPath);
    hash.update("\0");
    hash.update(String(fileStats.size));
    hash.update("\0");
    hash.update(fileStats.mtime.toISOString());
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function readStreetLookupCache(cachePath, signature) {
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    return cached?.version === signature &&
      Array.isArray(cached.names) &&
      Array.isArray(cached.roundabouts) &&
      Array.isArray(cached.files)
      ? cached
      : null;
  } catch {
    return null;
  }
}

async function writeStreetLookupCache(cachePath, bundle) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(bundle)}\n`);
}

async function readAccidentSource(csvFiles) {
  const files = [];
  const accidents = [];

  for (let fileIndex = 0; fileIndex < csvFiles.length; fileIndex += 1) {
    const file = csvFiles[fileIndex];
    const text = csvDecoder.decode(await readFile(file.sourcePath));
    const lines = text.split(/\r?\n/);
    const headers = parseDelimitedLine(lines.shift() ?? "");
    const indexes = [];
    const osmRoadControlMasks = [];
    const osmRoundaboutIndexes = [];
    let rowIndex = 0;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      rowIndex += 1;
      indexes.push(0);
      osmRoadControlMasks.push(0);
      osmRoundaboutIndexes.push(0);
      const values = parseDelimitedLine(line);
      const lon = parseNumber(readCsvField(headers, values, "XGCSWGS84"));
      const lat = parseNumber(readCsvField(headers, values, "YGCSWGS84"));
      if (lon === null || lat === null || lat < 45 || lat > 56 || lon < 5 || lon > 16) {
        continue;
      }
      const point = projectLonLat(lon, lat);
      accidents.push({
        fileIndex,
        rowIndex,
        lon,
        lat,
        x: point.x,
        y: point.y,
        streetMatches: null,
        osmRoadControlMask: 0,
        osmRoundaboutIndex: 0
      });
    }

    files.push({ name: path.basename(file.publicPath), indexes, osmRoadControlMasks, osmRoundaboutIndexes });
  }

  return { files, accidents };
}

function parseDelimitedLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ";" && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function formatCount(value) {
  return value.toLocaleString("en-US");
}

function formatBytes(value) {
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(2)} MiB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KiB`;
  }
  return `${value} B`;
}

function readCsvField(headers, values, name) {
  const normalized = normalizeFieldName(name);
  const index = headers.findIndex((header) => normalizeFieldName(header) === normalized);
  return index >= 0 ? values[index] : "";
}

function normalizeFieldName(name) {
  return String(name).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-") {
    return null;
  }
  const parsed = Number.parseFloat(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAccidentGrid(accidents) {
  const cells = new Map();
  const accidentXs = new Float64Array(accidents.length);
  const accidentYs = new Float64Array(accidents.length);
  for (let index = 0; index < accidents.length; index += 1) {
    const accident = accidents[index];
    accidentXs[index] = accident.x;
    accidentYs[index] = accident.y;
    const key = gridCellKey(Math.floor(accident.x / GRID_CELL_METERS), Math.floor(accident.y / GRID_CELL_METERS));
    let cell = cells.get(key);
    if (!cell) {
      cell = [];
      cells.set(key, cell);
    }
    cell.push(index);
  }

  const cellKeys = Array.from(cells.keys()).sort((a, b) => a - b);
  const cellOffsets = new Uint32Array(cellKeys.length + 1);
  let totalIndexes = 0;
  for (let index = 0; index < cellKeys.length; index += 1) {
    totalIndexes += cells.get(cellKeys[index]).length;
    cellOffsets[index + 1] = totalIndexes;
  }

  const cellAccidentIndexes = new Uint32Array(totalIndexes);
  const cellLookup = new Map();
  let writeIndex = 0;
  for (let cellIndex = 0; cellIndex < cellKeys.length; cellIndex += 1) {
    const key = cellKeys[cellIndex];
    cellLookup.set(key, cellIndex);
    for (const accidentIndex of cells.get(key)) {
      cellAccidentIndexes[writeIndex] = accidentIndex;
      writeIndex += 1;
    }
  }

  return {
    accidents,
    accidentXs,
    accidentYs,
    cellKeys: Float64Array.from(cellKeys),
    cellOffsets,
    cellAccidentIndexes,
    cellLookup
  };
}

function createNodeCoordStore() {
  return {
    size: 0,
    shards: Array.from({ length: NODE_COORD_SHARD_COUNT }, () => createNodeCoordHashShard(NODE_COORD_INITIAL_SHARD_CAPACITY))
  };
}

function setNodeCoord(store, nodeId, packedCoord) {
  const shard = store.shards[nodeCoordShard(nodeId)];
  if (nodeCoordShardSet(shard, nodeId, packedCoord)) {
    store.size += 1;
  }
}

function setNodeCoords(store, nodeIds, packedCoords) {
  for (let index = 0; index < nodeIds.length; index += 1) {
    setNodeCoord(store, nodeIds[index], packedCoords[index]);
  }
}

function getNodeCoord(store, nodeId) {
  return nodeCoordShardGet(store.shards[nodeCoordShard(nodeId)], nodeId);
}

function nodeCoordShard(nodeId) {
  return Math.abs(nodeId) % NODE_COORD_SHARD_COUNT;
}

function createNodeCoordHashShard(capacity) {
  return {
    size: 0,
    maxSize: Math.floor((capacity * NODE_COORD_MAX_LOAD_NUMERATOR) / NODE_COORD_MAX_LOAD_DENOMINATOR),
    keys: new Float64Array(capacity),
    values: new Float64Array(capacity),
    used: new Uint8Array(capacity)
  };
}

function nodeCoordShardSet(shard, nodeId, packedCoord) {
  if (shard.size >= shard.maxSize) {
    growNodeCoordShard(shard);
  }
  const slot = nodeCoordSlot(shard, nodeId);
  if (shard.used[slot]) {
    shard.values[slot] = packedCoord;
    return false;
  }
  shard.used[slot] = 1;
  shard.keys[slot] = nodeId;
  shard.values[slot] = packedCoord;
  shard.size += 1;
  return true;
}

function nodeCoordShardGet(shard, nodeId) {
  const mask = shard.keys.length - 1;
  let slot = nodeCoordHash(nodeId) & mask;
  while (shard.used[slot]) {
    if (shard.keys[slot] === nodeId) {
      return shard.values[slot];
    }
    slot = (slot + 1) & mask;
  }
  return undefined;
}

function nodeCoordSlot(shard, nodeId) {
  const mask = shard.keys.length - 1;
  let slot = nodeCoordHash(nodeId) & mask;
  while (shard.used[slot] && shard.keys[slot] !== nodeId) {
    slot = (slot + 1) & mask;
  }
  return slot;
}

function growNodeCoordShard(shard) {
  const oldKeys = shard.keys;
  const oldValues = shard.values;
  const oldUsed = shard.used;
  const capacity = oldKeys.length * 2;
  shard.keys = new Float64Array(capacity);
  shard.values = new Float64Array(capacity);
  shard.used = new Uint8Array(capacity);
  shard.maxSize = Math.floor((capacity * NODE_COORD_MAX_LOAD_NUMERATOR) / NODE_COORD_MAX_LOAD_DENOMINATOR);
  shard.size = 0;

  for (let index = 0; index < oldKeys.length; index += 1) {
    if (oldUsed[index]) {
      nodeCoordShardSet(shard, oldKeys[index], oldValues[index]);
    }
  }
}

function nodeCoordHash(nodeId) {
  let value = Math.trunc(nodeId % 4_294_967_291);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function createDenseNodeProcessor(accidentGrid, nodeCoords, roundaboutCollector) {
  const workerCount = denseNodeWorkerCount();
  if (workerCount <= 0) {
    return {
      async process(buffer, blockContext) {
        try {
          processDenseNodes(buffer, blockContext, accidentGrid, nodeCoords, null, roundaboutCollector);
        } catch {
          // Some historical PBF writers contain dense-node payloads this minimal reader cannot use.
        }
      },
      async drain() {},
      async close() {}
    };
  }

  const maxBatchGroups = denseNodeWorkerBatchGroups();
  const maxBatchBytes = denseNodeWorkerBatchBytes();
  console.log(
    `Street lookup dense-node workers: ${workerCount.toLocaleString("en-US")}, batch ${maxBatchGroups.toLocaleString("en-US")} groups / ${formatBytes(maxBatchBytes)} (set SICHERE_KNOTEN_STREET_WORKERS=0 to disable).`
  );
  const pool = new DenseNodeWorkerPool(workerCount, sharedAccidentGridForWorkers(accidentGrid));
  const pending = new Set();
  const maxPending = workerCount * 2;
  let batchGroups = [];
  let batchBytes = 0;

  async function waitForOne() {
    const settled = await Promise.race(pending);
    if (!settled.ok) {
      throw settled.error;
    }
  }

  async function flushBatch() {
    if (batchGroups.length === 0) {
      return;
    }
    while (pending.size >= maxPending) {
      await waitForOne();
    }

    const groups = batchGroups;
    batchGroups = [];
    batchBytes = 0;
    const task = pool.run({ groups });
    const tracked = task
      .then((result) => {
        applyDenseNodeWorkerResult(result, accidentGrid, nodeCoords, roundaboutCollector);
        return { ok: true };
      })
      .catch((error) => ({ ok: false, error }))
      .finally(() => {
        pending.delete(tracked);
      });
    pending.add(tracked);
  }

  async function drain() {
    await flushBatch();
    while (pending.size > 0) {
      await waitForOne();
    }
  }

  return {
    async process(buffer, blockContext) {
      const taskBuffer = copyToArrayBuffer(buffer);
      batchGroups.push({ buffer: taskBuffer, blockContext });
      batchBytes += taskBuffer.byteLength;
      if (batchGroups.length >= maxBatchGroups || batchBytes >= maxBatchBytes) {
        await flushBatch();
      }
    },
    drain,
    async close() {
      try {
        await drain();
      } finally {
        await pool.close();
      }
    }
  };
}

function denseNodeWorkerCount() {
  const raw = process.env.SICHERE_KNOTEN_STREET_WORKERS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return Math.min(4, Math.max(1, availableParallelism() - 1));
}

function denseNodeWorkerBatchGroups() {
  const raw = process.env.SICHERE_KNOTEN_STREET_WORKER_BATCH_GROUPS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_DENSE_NODE_WORKER_BATCH_GROUPS;
  }
  return DEFAULT_DENSE_NODE_WORKER_BATCH_GROUPS;
}

function denseNodeWorkerBatchBytes() {
  const raw = process.env.SICHERE_KNOTEN_STREET_WORKER_BATCH_BYTES;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1024, parsed) : DEFAULT_DENSE_NODE_WORKER_BATCH_BYTES;
  }
  return DEFAULT_DENSE_NODE_WORKER_BATCH_BYTES;
}

function sharedAccidentGridForWorkers(accidentGrid) {
  return {
    accidentXs: sharedTypedArray(Float64Array, accidentGrid.accidentXs),
    accidentYs: sharedTypedArray(Float64Array, accidentGrid.accidentYs),
    cellKeys: sharedTypedArray(Float64Array, accidentGrid.cellKeys),
    cellOffsets: sharedTypedArray(Uint32Array, accidentGrid.cellOffsets),
    cellAccidentIndexes: sharedTypedArray(Uint32Array, accidentGrid.cellAccidentIndexes)
  };
}

function sharedTypedArray(TypedArray, source) {
  const shared = new SharedArrayBuffer(source.byteLength);
  const copy = new TypedArray(shared);
  copy.set(source);
  return copy;
}

function hydrateAccidentGridLookup(accidentGrid) {
  if (accidentGrid.cellLookup) {
    return accidentGrid;
  }
  const cellLookup = new Map();
  for (let index = 0; index < accidentGrid.cellKeys.length; index += 1) {
    cellLookup.set(accidentGrid.cellKeys[index], index);
  }
  return { ...accidentGrid, cellLookup };
}

function copyToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function applyDenseNodeWorkerResult(result, accidentGrid, nodeCoords, roundaboutCollector) {
  const nodeIds = result.nodeIds;
  const packedCoords = result.packedCoords;
  setNodeCoords(nodeCoords, nodeIds, packedCoords);

  const roadControlAccidentIndexes = result.roadControlAccidentIndexes;
  const roadControlMasks = result.roadControlMasks;
  for (let index = 0; index < roadControlAccidentIndexes.length; index += 1) {
    accidentGrid.accidents[roadControlAccidentIndexes[index]].osmRoadControlMask |= roadControlMasks[index];
  }

  const miniRoundaboutIds = result.miniRoundaboutIds;
  const miniRoundaboutLons = result.miniRoundaboutLons;
  const miniRoundaboutLats = result.miniRoundaboutLats;
  for (let index = 0; index < miniRoundaboutIds.length; index += 1) {
    addMiniRoundabout(roundaboutCollector, miniRoundaboutIds[index], miniRoundaboutLons[index], miniRoundaboutLats[index]);
  }
}

class DenseNodeWorkerPool {
  constructor(workerCount, accidentGrid) {
    this.idleWorkers = [];
    this.queuedTasks = [];
    this.runningTasks = new Map();
    this.nextTaskId = 1;
    this.workers = Array.from({ length: workerCount }, () => this.createWorker(accidentGrid));
  }

  createWorker(accidentGrid) {
    const worker = new Worker(new URL(import.meta.url), {
      type: "module",
      workerData: {
        kind: STREET_DENSE_NODE_WORKER,
        accidentGrid
      }
    });
    worker.on("message", (message) => this.finishTask(worker, message));
    worker.on("error", (error) => this.failWorker(worker, error));
    worker.on("exit", (code) => {
      if (code !== 0) {
        this.failWorker(worker, new Error(`Dense-node worker exited with code ${code}.`));
      }
    });
    this.idleWorkers.push(worker);
    return worker;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queuedTasks.push({
        id: this.nextTaskId,
        task,
        resolve,
        reject
      });
      this.nextTaskId += 1;
      this.pump();
    });
  }

  pump() {
    while (this.idleWorkers.length > 0 && this.queuedTasks.length > 0) {
      const worker = this.idleWorkers.pop();
      const entry = this.queuedTasks.shift();
      this.runningTasks.set(entry.id, { ...entry, worker });
      const transferList = entry.task.groups.map((group) => group.buffer);
      worker.postMessage(
        {
          id: entry.id,
          groups: entry.task.groups
        },
        transferList
      );
    }
  }

  finishTask(worker, message) {
    const entry = this.runningTasks.get(message.id);
    if (!entry) {
      return;
    }
    this.runningTasks.delete(message.id);
    this.idleWorkers.push(worker);
    if (message.error) {
      entry.reject(new Error(message.error));
    } else {
      entry.resolve(message.result);
    }
    this.pump();
  }

  failWorker(worker, error) {
    for (const [taskId, entry] of this.runningTasks) {
      if (entry.worker === worker) {
        this.runningTasks.delete(taskId);
        entry.reject(error);
      }
    }
    for (const entry of this.queuedTasks.splice(0)) {
      entry.reject(error);
    }
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

function startDenseNodeWorker(data) {
  const accidentGrid = hydrateAccidentGridLookup(data.accidentGrid);
  parentPort.on("message", (message) => {
    const collector = {
      nodeIds: [],
      packedCoords: [],
      roadControlAccidentIndexes: [],
      roadControlMasks: [],
      miniRoundaboutIds: [],
      miniRoundaboutLons: [],
      miniRoundaboutLats: []
    };

    try {
      for (const group of message.groups) {
        try {
          processDenseNodes(Buffer.from(group.buffer), group.blockContext, accidentGrid, null, collector);
        } catch {
        }
      }
      const nodeIds = Float64Array.from(collector.nodeIds);
      const packedCoords = Float64Array.from(collector.packedCoords);
      const roadControlAccidentIndexes = Uint32Array.from(collector.roadControlAccidentIndexes);
      const roadControlMasks = Uint8Array.from(collector.roadControlMasks);
      const miniRoundaboutIds = Float64Array.from(collector.miniRoundaboutIds);
      const miniRoundaboutLons = Float64Array.from(collector.miniRoundaboutLons);
      const miniRoundaboutLats = Float64Array.from(collector.miniRoundaboutLats);
      parentPort.postMessage(
        {
          id: message.id,
          result: {
            nodeIds,
            packedCoords,
            roadControlAccidentIndexes,
            roadControlMasks,
            miniRoundaboutIds,
            miniRoundaboutLons,
            miniRoundaboutLats
          }
        },
        [
          nodeIds.buffer,
          packedCoords.buffer,
          roadControlAccidentIndexes.buffer,
          roadControlMasks.buffer,
          miniRoundaboutIds.buffer,
          miniRoundaboutLons.buffer,
          miniRoundaboutLats.buffer
        ]
      );
    } catch {
      parentPort.postMessage({
        id: message.id,
        result: {
          nodeIds: new Float64Array(0),
          packedCoords: new Float64Array(0),
          roadControlAccidentIndexes: new Uint32Array(0),
          roadControlMasks: new Uint8Array(0),
          miniRoundaboutIds: new Float64Array(0),
          miniRoundaboutLons: new Float64Array(0),
          miniRoundaboutLats: new Float64Array(0)
        }
      });
    }
  });
}

function createRoundaboutCollector() {
  return {
    ways: [],
    miniRoundabouts: [],
    miniRoundaboutNodeIds: new Set()
  };
}

function addMiniRoundabout(collector, nodeId, lon, lat) {
  if (!collector || collector.miniRoundaboutNodeIds.has(nodeId)) {
    return;
  }
  collector.miniRoundaboutNodeIds.add(nodeId);
  collector.miniRoundabouts.push({ nodeId, lon, lat });
}

function addRoundaboutWay(collector, wayId, nodeIds) {
  if (!collector || nodeIds.length < 2) {
    return;
  }
  collector.ways.push({
    id: wayId || collector.ways.length + 1,
    nodeIds
  });
}

async function resolveAndApplyRoundaboutsFromPbf(pbfPath, fileSize, accidents, accidentGrid, roundaboutCollector) {
  const requiredNodeIds = roundaboutNodeIdSet(roundaboutCollector.ways);
  const resolvedNodeCoords =
    requiredNodeIds.size > 0 ? await readRoundaboutNodeCoordsFromPbf(pbfPath, fileSize, requiredNodeIds) : new Map();
  const roundabouts = buildRoundaboutGeometries(roundaboutCollector, resolvedNodeCoords);
  return applyRoundaboutMatches(accidents, accidentGrid, roundabouts);
}

function roundaboutNodeIdSet(ways) {
  const nodeIds = new Set();
  for (const way of ways) {
    for (const nodeId of way.nodeIds) {
      nodeIds.add(nodeId);
    }
  }
  return nodeIds;
}

async function readRoundaboutNodeCoordsFromPbf(pbfPath, fileSize, requiredNodeIds) {
  console.log(
    `Resolving ${formatCount(requiredNodeIds.size)} roundabout way nodes from ${path.basename(pbfPath)} for geometry-centered clustering.`
  );
  const remainingNodeIds = new Set(requiredNodeIds);
  const nodeCoords = new Map();
  const file = await open(pbfPath, "r");
  let position = 0;
  let lastProgressTime = Date.now();

  try {
    while (position < fileSize && remainingNodeIds.size > 0) {
      const headerSizeBuffer = await readExactly(file, position, 4);
      position += 4;
      const headerSize = headerSizeBuffer.readUInt32BE(0);
      const header = parseBlobHeader(await readExactly(file, position, headerSize));
      position += headerSize;
      const blobBuffer = await readExactly(file, position, header.datasize);
      position += header.datasize;

      if (header.type === "OSMData") {
        processPrimitiveBlockForRoundaboutCoords(blobData(blobBuffer), remainingNodeIds, nodeCoords);
      }

      if (Date.now() - lastProgressTime > 5000) {
        lastProgressTime = Date.now();
        console.log(
          `Roundabout geometry ${formatCount(nodeCoords.size)} / ${formatCount(requiredNodeIds.size)} nodes resolved.`
        );
      }
    }
  } finally {
    await file.close();
  }

  if (remainingNodeIds.size > 0) {
    console.warn(`Roundabout geometry skipped ${formatCount(remainingNodeIds.size)} unresolved way nodes.`);
  }
  return nodeCoords;
}

function processPrimitiveBlockForRoundaboutCoords(buffer, requiredNodeIds, nodeCoords) {
  const state = { pos: 0 };
  const groups = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      groups.push(readBytes(buffer, state));
    } else if (field === 17 && wire === 0) {
      granularity = readVarint(buffer, state);
    } else if (field === 19 && wire === 0) {
      latOffset = readVarint(buffer, state);
    } else if (field === 20 && wire === 0) {
      lonOffset = readVarint(buffer, state);
    } else {
      skipField(buffer, state, wire);
    }
  }

  const blockContext = { granularity, latOffset, lonOffset };
  for (const group of groups) {
    processPrimitiveGroupForRoundaboutCoords(group, blockContext, requiredNodeIds, nodeCoords);
  }
}

function processPrimitiveGroupForRoundaboutCoords(buffer, blockContext, requiredNodeIds, nodeCoords) {
  const state = { pos: 0 };
  while (state.pos < buffer.length && requiredNodeIds.size > 0) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      processDenseNodesForRoundaboutCoords(readBytes(buffer, state), blockContext, requiredNodeIds, nodeCoords);
    } else {
      skipField(buffer, state, wire);
    }
  }
}

function processDenseNodesForRoundaboutCoords(buffer, blockContext, requiredNodeIds, nodeCoords) {
  const state = { pos: 0 };
  const ids = [];
  const lats = [];
  const lons = [];

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1) {
      readPackedValues(buffer, state, wire, true, ids);
    } else if (field === 8) {
      readPackedValues(buffer, state, wire, true, lats);
    } else if (field === 9) {
      readPackedValues(buffer, state, wire, true, lons);
    } else if (wire === 3 || wire === 6) {
      return;
    } else {
      skipField(buffer, state, wire);
    }
  }

  let id = 0;
  let rawLat = 0;
  let rawLon = 0;
  const count = Math.min(ids.length, lats.length, lons.length);
  for (let index = 0; index < count && requiredNodeIds.size > 0; index += 1) {
    id += ids[index];
    rawLat += lats[index];
    rawLon += lons[index];
    if (!requiredNodeIds.has(id)) {
      continue;
    }
    const lat = (blockContext.latOffset + blockContext.granularity * rawLat) * 1e-9;
    const lon = (blockContext.lonOffset + blockContext.granularity * rawLon) * 1e-9;
    nodeCoords.set(id, packCoord(lat, lon));
    requiredNodeIds.delete(id);
  }
}

function buildRoundaboutGeometries(roundaboutCollector, resolvedNodeCoords) {
  const miniRoundabouts = roundaboutCollector.miniRoundabouts.map((roundabout) => {
    const x = projectX(roundabout.lon, roundabout.lat);
    const y = projectY(roundabout.lat);
    return {
      sourceId: `mini:${roundabout.nodeId}`,
      lon: roundabout.lon,
      lat: roundabout.lat,
      x,
      y,
      radiusMeters: 0,
      matchRadiusMeters: ROUNDABOUT_CLUSTER_BUFFER_METERS
    };
  });

  const wayRoundabouts = buildRoundaboutWayComponentGeometries(roundaboutCollector.ways, resolvedNodeCoords);
  const roundabouts = [...wayRoundabouts, ...miniRoundabouts];
  console.log(`Resolved ${formatCount(roundabouts.length)} roundabout geometries near accident data.`);
  return roundabouts;
}

function buildRoundaboutWayComponentGeometries(wayEntries, resolvedNodeCoords) {
  const ways = [];
  for (const way of wayEntries) {
    const points = [];
    for (const nodeId of way.nodeIds) {
      const packed = resolvedNodeCoords.get(nodeId);
      if (packed !== undefined) {
        points.push({ nodeId, ...unpackPackedCoordPoint(packed) });
      }
    }
    if (points.length >= 2) {
      ways.push({ id: way.id, points });
    }
  }

  if (ways.length === 0) {
    return [];
  }

  const parent = Array.from({ length: ways.length }, (_value, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  const wayByNodeId = new Map();
  for (let wayIndex = 0; wayIndex < ways.length; wayIndex += 1) {
    for (const point of ways[wayIndex].points) {
      const previousWayIndex = wayByNodeId.get(point.nodeId);
      if (previousWayIndex === undefined) {
        wayByNodeId.set(point.nodeId, wayIndex);
      } else {
        union(wayIndex, previousWayIndex);
      }
    }
  }

  const groups = new Map();
  for (let wayIndex = 0; wayIndex < ways.length; wayIndex += 1) {
    const root = find(wayIndex);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(ways[wayIndex]);
  }

  const roundabouts = [];
  for (const group of groups.values()) {
    const geometry = roundaboutGeometryForWayGroup(group);
    if (geometry) {
      roundabouts.push(geometry);
    }
  }
  return roundabouts.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
}

function roundaboutGeometryForWayGroup(ways) {
  const pointByNodeId = new Map();
  const wayIds = [];
  for (const way of ways) {
    wayIds.push(way.id);
    for (const point of way.points) {
      pointByNodeId.set(point.nodeId, point);
    }
  }

  const points = Array.from(pointByNodeId.values());
  if (points.length < 3) {
    return null;
  }

  const centerX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const centerY = points.reduce((total, point) => total + point.y, 0) / points.length;
  const lat = centerY / 110540;
  const lon = centerX / (111320 * Math.cos(lat * degreesToRadians));
  const radiusMeters = Math.max(...points.map((point) => Math.sqrt(squaredDistance(centerX, centerY, point.x, point.y))));
  if (!Number.isFinite(radiusMeters)) {
    return null;
  }

  wayIds.sort((a, b) => a - b);
  return {
    sourceId: `way:${wayIds.join("+")}`,
    lon,
    lat,
    x: centerX,
    y: centerY,
    radiusMeters,
    matchRadiusMeters: radiusMeters + ROUNDABOUT_CLUSTER_BUFFER_METERS
  };
}

function applyRoundaboutMatches(accidents, accidentGrid, roundabouts) {
  if (roundabouts.length === 0) {
    return [];
  }

  const bestMatches = new Array(accidents.length);
  for (let roundaboutIndex = 0; roundaboutIndex < roundabouts.length; roundaboutIndex += 1) {
    const roundabout = roundabouts[roundaboutIndex];
    forEachAccidentIndexInBounds(
      accidentGrid,
      roundabout.x - roundabout.matchRadiusMeters,
      roundabout.y - roundabout.matchRadiusMeters,
      roundabout.x + roundabout.matchRadiusMeters,
      roundabout.y + roundabout.matchRadiusMeters,
      (accidentIndex) => {
        const distance = Math.sqrt(
          squaredDistance(roundabout.x, roundabout.y, accidentGrid.accidentXs[accidentIndex], accidentGrid.accidentYs[accidentIndex])
        );
        if (distance <= roundabout.matchRadiusMeters) {
          const score = Math.max(0, distance - roundabout.radiusMeters);
          const previous = bestMatches[accidentIndex];
          if (!previous || score < previous.score || (score === previous.score && distance < previous.distance)) {
            bestMatches[accidentIndex] = { roundaboutIndex, score, distance };
          }
        }
        return true;
      }
    );
  }

  const compactRoundabouts = [];
  const compactIndexByRoundaboutIndex = new Map();
  for (let accidentIndex = 0; accidentIndex < accidents.length; accidentIndex += 1) {
    const match = bestMatches[accidentIndex];
    if (!match) {
      continue;
    }
    let compactIndex = compactIndexByRoundaboutIndex.get(match.roundaboutIndex);
    if (compactIndex === undefined) {
      compactIndex = compactRoundabouts.length + 1;
      compactIndexByRoundaboutIndex.set(match.roundaboutIndex, compactIndex);
      compactRoundabouts.push(roundabouts[match.roundaboutIndex]);
    }
    accidents[accidentIndex].osmRoundaboutIndex = compactIndex;
    accidents[accidentIndex].osmRoadControlMask |= OSM_ROUNDABOUT_MASK;
  }

  console.log(`Street lookup assigned ${formatCount(compactRoundabouts.length)} roundabouts to nearby accident rows.`);
  return compactRoundabouts;
}

async function matchStreetsFromPbf(pbfPath, fileSize, accidents, accidentGrid) {
  const file = await open(pbfPath, "r");
  const nodeCoords = createNodeCoordStore();
  const roundaboutCollector = createRoundaboutCollector();
  const denseNodeProcessor = createDenseNodeProcessor(accidentGrid, nodeCoords, roundaboutCollector);
  let position = 0;
  let blobIndex = 0;
  let lastProgressTime = Date.now();
  const maxBlobs = Number(process.env.SICHERE_KNOTEN_STREET_MAX_BLOBS || 0);

  try {
    while (position < fileSize) {
      const headerSizeBuffer = await readExactly(file, position, 4);
      position += 4;
      const headerSize = headerSizeBuffer.readUInt32BE(0);
      const headerBuffer = await readExactly(file, position, headerSize);
      const header = parseBlobHeader(headerBuffer);
      position += headerSize;
      const blobBuffer = await readExactly(file, position, header.datasize);
      position += header.datasize;
      blobIndex += 1;

      if (header.type === "OSMData") {
        const data = blobData(blobBuffer);
        await processPrimitiveBlock(data, accidents, accidentGrid, nodeCoords, denseNodeProcessor, roundaboutCollector);
      }

      if (Date.now() - lastProgressTime > 5000) {
        lastProgressTime = Date.now();
        const percent = Math.round((position / fileSize) * 1000) / 10;
        console.log(
          `Street lookup ${percent}%: ${nodeCoords.size.toLocaleString()} nearby road nodes, ${matchedAccidentCount(accidents).toLocaleString()} matched accidents.`
        );
      }

      if (maxBlobs > 0 && blobIndex >= maxBlobs) {
        break;
      }
    }
  } finally {
    await denseNodeProcessor.close();
    await file.close();
  }

  const completed = position >= fileSize;
  const roundabouts = completed
    ? await resolveAndApplyRoundaboutsFromPbf(pbfPath, fileSize, accidents, accidentGrid, roundaboutCollector)
    : [];
  return { completed, roundabouts };
}

async function readExactly(file, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error("Unexpected end of PBF file.");
  }
  return buffer;
}

function parseBlobHeader(buffer) {
  const state = { pos: 0 };
  let type = "";
  let datasize = 0;
  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      type = textDecoder.decode(readBytes(buffer, state));
    } else if (field === 3 && wire === 0) {
      datasize = readVarint(buffer, state);
    } else {
      skipField(buffer, state, wire);
    }
  }
  return { type, datasize };
}

function blobData(buffer) {
  const state = { pos: 0 };
  let raw = null;
  let zlibData = null;
  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      raw = readBytes(buffer, state);
    } else if (field === 3 && wire === 2) {
      zlibData = readBytes(buffer, state);
    } else {
      skipField(buffer, state, wire);
    }
  }
  if (raw) {
    return raw;
  }
  if (zlibData) {
    return inflateSync(zlibData);
  }
  throw new Error("Unsupported OSM PBF blob compression.");
}

async function processPrimitiveBlock(buffer, accidents, accidentGrid, nodeCoords, denseNodeProcessor, roundaboutCollector) {
  const state = { pos: 0 };
  let strings = [];
  const groups = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      strings = parseStringTable(readBytes(buffer, state));
    } else if (field === 2 && wire === 2) {
      groups.push(readBytes(buffer, state));
    } else if (field === 17 && wire === 0) {
      granularity = readVarint(buffer, state);
    } else if (field === 19 && wire === 0) {
      latOffset = readVarint(buffer, state);
    } else if (field === 20 && wire === 0) {
      lonOffset = readVarint(buffer, state);
    } else {
      skipField(buffer, state, wire);
    }
  }

  const blockContext = {
    strings,
    roadControl: denseNodeRoadControlContext(strings),
    way: wayStringContext(strings),
    granularity,
    latOffset,
    lonOffset
  };
  for (const group of groups) {
    await processPrimitiveGroup(group, blockContext, accidents, accidentGrid, nodeCoords, denseNodeProcessor, roundaboutCollector);
  }
}

function parseStringTable(buffer) {
  const state = { pos: 0 };
  const strings = [];
  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      strings.push(textDecoder.decode(readBytes(buffer, state)));
    } else {
      skipField(buffer, state, wire);
    }
  }
  return strings;
}

async function processPrimitiveGroup(buffer, blockContext, accidents, accidentGrid, nodeCoords, denseNodeProcessor, roundaboutCollector) {
  const state = { pos: 0 };
  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      await denseNodeProcessor.process(readBytes(buffer, state), denseNodeBlockContext(blockContext));
    } else if (field === 3 && wire === 2) {
      const wayBuffer = readBytes(buffer, state);
      await denseNodeProcessor.drain();
      try {
        processWay(wayBuffer, blockContext, accidents, accidentGrid, nodeCoords, roundaboutCollector);
      } catch {
        // Ignore a malformed way and continue matching the rest of the PBF.
      }
    } else {
      skipField(buffer, state, wire);
    }
  }
}

function denseNodeBlockContext(blockContext) {
  return {
    roadControl: blockContext.roadControl,
    granularity: blockContext.granularity,
    latOffset: blockContext.latOffset,
    lonOffset: blockContext.lonOffset
  };
}

function processDenseNodes(buffer, blockContext, accidentGrid, nodeCoords, collector = null, roundaboutCollector = null) {
  const state = { pos: 0 };
  const ids = [];
  const lats = [];
  const lons = [];
  const keysVals = [];

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1) {
      readPackedValues(buffer, state, wire, true, ids);
    } else if (field === 8) {
      readPackedValues(buffer, state, wire, true, lats);
    } else if (field === 9) {
      readPackedValues(buffer, state, wire, true, lons);
    } else if (field === 10) {
      readPackedValues(buffer, state, wire, false, keysVals);
    } else if (wire === 3 || wire === 6) {
      return;
    } else {
      skipField(buffer, state, wire);
    }
  }

  let id = 0;
  let rawLat = 0;
  let rawLon = 0;
  let keysValsIndex = 0;
  const count = Math.min(ids.length, lats.length, lons.length);
  for (let index = 0; index < count; index += 1) {
    id += ids[index];
    rawLat += lats[index];
    rawLon += lons[index];
    const lat = (blockContext.latOffset + blockContext.granularity * rawLat) * 1e-9;
    const lon = (blockContext.lonOffset + blockContext.granularity * rawLon) * 1e-9;
    const roadControlMask = roadControlMaskForDenseNode(keysVals, keysValsIndex, blockContext.roadControl);
    keysValsIndex = skipDenseNodeTags(keysVals, keysValsIndex);
    const x = projectX(lon, lat);
    const y = projectY(lat);
    if (isPointNearAccidentXY(accidentGrid, x, y)) {
      const packedCoord = packCoord(lat, lon);
      if (collector) {
        collector.nodeIds.push(id);
        collector.packedCoords.push(packedCoord);
      } else {
        setNodeCoord(nodeCoords, id, packedCoord);
      }
    }
    if (roadControlMask & OSM_TRAFFIC_SIGNAL_MASK) {
      if (collector) {
        collectPointRoadControlMatches(x, y, OSM_TRAFFIC_SIGNAL_MASK, accidentGrid, collector.roadControlAccidentIndexes, collector.roadControlMasks);
      } else {
        matchPointRoadControlToAccidentsXY(x, y, OSM_TRAFFIC_SIGNAL_MASK, accidentGrid);
      }
    }
    if (roadControlMask & OSM_ROUNDABOUT_MASK) {
      if (collector) {
        collector.miniRoundaboutIds.push(id);
        collector.miniRoundaboutLons.push(lon);
        collector.miniRoundaboutLats.push(lat);
      } else {
        addMiniRoundabout(roundaboutCollector, id, lon, lat);
      }
    }
  }
}

function processWay(buffer, blockContext, accidents, accidentGrid, nodeCoords, roundaboutCollector) {
  const state = { pos: 0 };
  let wayId = 0;
  const keys = [];
  const vals = [];
  const refParts = [];

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      wayId = readVarint(buffer, state);
    } else if (field === 2) {
      readPackedValues(buffer, state, wire, false, keys);
    } else if (field === 3) {
      readPackedValues(buffer, state, wire, false, vals);
    } else if (field === 8) {
      if (wire === 2) {
        refParts.push({ kind: "packed", buffer: readBytes(buffer, state) });
      } else if (wire === 0) {
        refParts.push({ kind: "single", delta: zigZagDecode(readVarint(buffer, state)) });
      } else {
        skipField(buffer, state, wire);
      }
    } else {
      skipField(buffer, state, wire);
    }
  }

  const metadata = osmMetadataForWay(keys, vals, blockContext);
  if ((!metadata.streetName && !metadata.roadControlMask) || refParts.length === 0) {
    return;
  }

  processWayRefs(refParts, metadata, accidents, accidentGrid, nodeCoords, roundaboutCollector, wayId);
}

function processWayRefs(refParts, metadata, accidents, accidentGrid, nodeCoords, roundaboutCollector, wayId) {
  let previousNodeId = 0;
  let hasPreviousPoint = false;
  let previousX = 0;
  let previousY = 0;
  const roundaboutNodeIds = metadata.roadControlMask & OSM_ROUNDABOUT_MASK ? [] : null;

  function scanDelta(delta) {
    const nodeId = previousNodeId + delta;
    if (roundaboutNodeIds) {
      roundaboutNodeIds.push(nodeId);
    }
    const packed = getNodeCoord(nodeCoords, nodeId);
    if (packed !== undefined) {
      const point = unpackPackedCoordPoint(packed);
      if (hasPreviousPoint) {
        if (metadata.streetName) {
          matchSegmentToAccidentsXY(previousX, previousY, point.x, point.y, metadata.streetName, accidents, accidentGrid);
        }
      }
      previousX = point.x;
      previousY = point.y;
      hasPreviousPoint = true;
    } else {
      hasPreviousPoint = false;
    }
    previousNodeId = nodeId;
  }

  for (const part of refParts) {
    if (part.kind === "single") {
      scanDelta(part.delta);
    } else {
      const state = { pos: 0 };
      while (state.pos < part.buffer.length) {
        scanDelta(zigZagDecode(readVarint(part.buffer, state)));
      }
    }
  }

  if (roundaboutNodeIds?.length >= 2) {
    addRoundaboutWay(roundaboutCollector, wayId, roundaboutNodeIds);
  }
}

function osmMetadataForWay(keys, vals, blockContext) {
  const strings = blockContext.strings;
  const context = blockContext.way;
  let highwayIndex = 0;
  let junctionIndex = 0;
  let nameIndex = 0;
  let officialNameIndex = 0;
  let refIndex = 0;

  for (let index = 0; index < keys.length; index += 1) {
    const keyIndex = keys[index];
    const valueIndex = vals[index];
    if (keyIndex === context.highwayKey) {
      highwayIndex = valueIndex;
    } else if (keyIndex === context.junctionKey) {
      junctionIndex = valueIndex;
    } else if (keyIndex === context.nameKey) {
      nameIndex = valueIndex;
    } else if (keyIndex === context.officialNameKey) {
      officialNameIndex = valueIndex;
    } else if (keyIndex === context.refKey) {
      refIndex = valueIndex;
    }
  }

  const hasUsableHighway =
    highwayIndex > 0 && highwayIndex !== context.constructionValue && highwayIndex !== context.proposedValue;
  const roadControlMask = hasUsableHighway && junctionIndex === context.roundaboutValue ? OSM_ROUNDABOUT_MASK : 0;
  if (!hasUsableHighway) {
    return { streetName: null, roadControlMask };
  }
  return { streetName: cleanStreetName(strings[nameIndex] || strings[officialNameIndex] || strings[refIndex]), roadControlMask };
}

function wayStringContext(strings) {
  return {
    highwayKey: strings.indexOf("highway"),
    junctionKey: strings.indexOf("junction"),
    nameKey: strings.indexOf("name"),
    officialNameKey: strings.indexOf("official_name"),
    refKey: strings.indexOf("ref"),
    constructionValue: strings.indexOf("construction"),
    proposedValue: strings.indexOf("proposed"),
    roundaboutValue: strings.indexOf("roundabout")
  };
}

function cleanStreetName(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function isPointNearAccidentXY(accidentGrid, x, y) {
  let found = false;
  forEachAccidentIndexInBounds(
    accidentGrid,
    x - NODE_CAPTURE_RADIUS_METERS,
    y - NODE_CAPTURE_RADIUS_METERS,
    x + NODE_CAPTURE_RADIUS_METERS,
    y + NODE_CAPTURE_RADIUS_METERS,
    (accidentIndex) => {
      if (squaredDistance(x, y, accidentGrid.accidentXs[accidentIndex], accidentGrid.accidentYs[accidentIndex]) <= NODE_CAPTURE_RADIUS_METERS ** 2) {
        found = true;
        return false;
      }
      return true;
    }
  );
  return found;
}

function denseNodeRoadControlContext(strings) {
  return {
    highwayKey: strings.indexOf("highway"),
    crossingKey: strings.indexOf("crossing"),
    trafficSignalsValue: strings.indexOf("traffic_signals"),
    miniRoundaboutValue: strings.indexOf("mini_roundabout")
  };
}

function roadControlMaskForDenseNode(keysVals, startIndex, context) {
  let mask = 0;
  let index = startIndex;
  while (index < keysVals.length) {
    const keyIndex = keysVals[index];
    index += 1;
    if (keyIndex === 0) {
      break;
    }
    const valueIndex = keysVals[index];
    index += 1;
    if (keyIndex === context.highwayKey && valueIndex === context.trafficSignalsValue) {
      mask |= OSM_TRAFFIC_SIGNAL_MASK;
    } else if (keyIndex === context.crossingKey && valueIndex === context.trafficSignalsValue) {
      mask |= OSM_TRAFFIC_SIGNAL_MASK;
    } else if (keyIndex === context.highwayKey && valueIndex === context.miniRoundaboutValue) {
      mask |= OSM_ROUNDABOUT_MASK;
    }
  }
  return mask;
}

function skipDenseNodeTags(keysVals, startIndex) {
  let index = startIndex;
  while (index < keysVals.length) {
    const keyIndex = keysVals[index];
    index += 1;
    if (keyIndex === 0) {
      break;
    }
    index += 1;
  }
  return index;
}

function matchSegmentToAccidentsXY(ax, ay, bx, by, streetName, accidents, accidentGrid) {
  const minX = Math.min(ax, bx) - STREET_MATCH_RADIUS_METERS;
  const minY = Math.min(ay, by) - STREET_MATCH_RADIUS_METERS;
  const maxX = Math.max(ax, bx) + STREET_MATCH_RADIUS_METERS;
  const maxY = Math.max(ay, by) + STREET_MATCH_RADIUS_METERS;
  forEachAccidentIndexInBounds(accidentGrid, minX, minY, maxX, maxY, (accidentIndex) => {
    const accident = accidents[accidentIndex];
    const distance = pointSegmentDistance(accident.x, accident.y, ax, ay, bx, by);
    if (distance <= STREET_MATCH_RADIUS_METERS) {
      if (!accident.streetMatches) {
        accident.streetMatches = new Map();
      }
      const previousDistance = accident.streetMatches.get(streetName);
      if (previousDistance === undefined || distance < previousDistance) {
        accident.streetMatches.set(streetName, distance);
      }
    }
    return true;
  });
}

function matchPointRoadControlToAccidentsXY(x, y, mask, accidentGrid) {
  forEachAccidentIndexInBounds(
    accidentGrid,
    x - ROAD_CONTROL_MATCH_RADIUS_METERS,
    y - ROAD_CONTROL_MATCH_RADIUS_METERS,
    x + ROAD_CONTROL_MATCH_RADIUS_METERS,
    y + ROAD_CONTROL_MATCH_RADIUS_METERS,
    (accidentIndex) => {
      if (squaredDistance(x, y, accidentGrid.accidentXs[accidentIndex], accidentGrid.accidentYs[accidentIndex]) <= ROAD_CONTROL_MATCH_RADIUS_METERS ** 2) {
        accidentGrid.accidents[accidentIndex].osmRoadControlMask |= mask;
      }
      return true;
    }
  );
}

function collectPointRoadControlMatches(x, y, mask, accidentGrid, accidentIndexes, masks) {
  forEachAccidentIndexInBounds(
    accidentGrid,
    x - ROAD_CONTROL_MATCH_RADIUS_METERS,
    y - ROAD_CONTROL_MATCH_RADIUS_METERS,
    x + ROAD_CONTROL_MATCH_RADIUS_METERS,
    y + ROAD_CONTROL_MATCH_RADIUS_METERS,
    (accidentIndex) => {
      if (squaredDistance(x, y, accidentGrid.accidentXs[accidentIndex], accidentGrid.accidentYs[accidentIndex]) <= ROAD_CONTROL_MATCH_RADIUS_METERS ** 2) {
        accidentIndexes.push(accidentIndex);
        masks.push(mask);
      }
      return true;
    }
  );
}

function matchSegmentRoadControlToAccidentsXY(ax, ay, bx, by, mask, accidentGrid) {
  const minX = Math.min(ax, bx) - ROAD_CONTROL_MATCH_RADIUS_METERS;
  const minY = Math.min(ay, by) - ROAD_CONTROL_MATCH_RADIUS_METERS;
  const maxX = Math.max(ax, bx) + ROAD_CONTROL_MATCH_RADIUS_METERS;
  const maxY = Math.max(ay, by) + ROAD_CONTROL_MATCH_RADIUS_METERS;
  forEachAccidentIndexInBounds(accidentGrid, minX, minY, maxX, maxY, (accidentIndex) => {
    const accident = accidentGrid.accidents[accidentIndex];
    const distance = pointSegmentDistance(accident.x, accident.y, ax, ay, bx, by);
    if (distance <= ROAD_CONTROL_MATCH_RADIUS_METERS) {
      accident.osmRoadControlMask |= mask;
    }
    return true;
  });
}

function forEachAccidentIndexInBounds(accidentGrid, minX, minY, maxX, maxY, visit) {
  const minCellX = Math.floor(minX / GRID_CELL_METERS);
  const maxCellX = Math.floor(maxX / GRID_CELL_METERS);
  const minCellY = Math.floor(minY / GRID_CELL_METERS);
  const maxCellY = Math.floor(maxY / GRID_CELL_METERS);

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      const cellIndex = accidentGrid.cellLookup.get(gridCellKey(cellX, cellY));
      if (cellIndex === undefined) {
        continue;
      }
      const start = accidentGrid.cellOffsets[cellIndex];
      const end = accidentGrid.cellOffsets[cellIndex + 1];
      for (let index = start; index < end; index += 1) {
        if (visit(accidentGrid.cellAccidentIndexes[index]) === false) {
          return false;
        }
      }
    }
  }

  return true;
}

function finalizeStreetLookup(version, source, roundabouts) {
  const accidentStreetNames = new Array(source.accidents.length);
  const nameSet = new Set();

  for (let index = 0; index < source.accidents.length; index += 1) {
    const names = topStreetNamesForAccident(source.accidents[index]);
    accidentStreetNames[index] = names;
    for (const name of names) {
      nameSet.add(name);
    }
  }

  const names = Array.from(nameSet).sort((a, b) => germanBaseCollator.compare(a, b));
  const indexesByName = new Map(names.map((name, index) => [name, index + 1]));

  for (let index = 0; index < source.accidents.length; index += 1) {
    const accident = source.accidents[index];
    const streetNames = accidentStreetNames[index];
    source.files[accident.fileIndex].osmRoundaboutIndexes[accident.rowIndex - 1] = accident.osmRoundaboutIndex;
    if (streetNames.length === 0) {
      source.files[accident.fileIndex].osmRoadControlMasks[accident.rowIndex - 1] = accident.osmRoadControlMask;
      continue;
    }
    const streetIndexes = new Array(streetNames.length);
    for (let streetIndex = 0; streetIndex < streetNames.length; streetIndex += 1) {
      streetIndexes[streetIndex] = indexesByName.get(streetNames[streetIndex]) ?? 0;
    }
    source.files[accident.fileIndex].indexes[accident.rowIndex - 1] =
      streetIndexes.length === 1 ? streetIndexes[0] : streetIndexes;
    source.files[accident.fileIndex].osmRoadControlMasks[accident.rowIndex - 1] = accident.osmRoadControlMask;
  }

  return {
    version,
    names,
    roundabouts: roundabouts.map(compactRoundaboutGeometry),
    files: source.files.map((file) => ({
      name: file.name,
      indexes: file.indexes,
      osmRoadControlMasks: file.osmRoadControlMasks,
      osmRoundaboutIndexes: file.osmRoundaboutIndexes
    }))
  };
}

function compactRoundaboutGeometry(roundabout) {
  return {
    lon: round(roundabout.lon, 7),
    lat: round(roundabout.lat, 7),
    radiusMeters: Math.round(roundabout.radiusMeters),
    matchRadiusMeters: Math.round(roundabout.matchRadiusMeters)
  };
}

function topStreetNamesForAccident(accident) {
  if (!accident.streetMatches) {
    return [];
  }
  if (accident.streetMatches.size === 1) {
    return [accident.streetMatches.keys().next().value];
  }

  const names = [];
  const distances = [];
  for (const [name, distance] of accident.streetMatches) {
    let insertAt = names.length;
    while (insertAt > 0 && compareStreetMatch(name, distance, names[insertAt - 1], distances[insertAt - 1]) < 0) {
      insertAt -= 1;
    }
    if (insertAt < MAX_STREET_NAMES_PER_ACCIDENT) {
      const end = Math.min(names.length, MAX_STREET_NAMES_PER_ACCIDENT - 1);
      for (let index = end; index > insertAt; index -= 1) {
        names[index] = names[index - 1];
        distances[index] = distances[index - 1];
      }
      names[insertAt] = name;
      distances[insertAt] = distance;
      if (names.length > MAX_STREET_NAMES_PER_ACCIDENT) {
        names.length = MAX_STREET_NAMES_PER_ACCIDENT;
        distances.length = MAX_STREET_NAMES_PER_ACCIDENT;
      }
    }
  }
  return names;
}

function compareStreetMatch(nameA, distanceA, nameB, distanceB) {
  return distanceA - distanceB || germanBaseCollator.compare(nameA, nameB);
}

function matchedAccidentCount(accidents) {
  return accidents.reduce((count, accident) => count + (accident.streetMatches?.size ? 1 : 0), 0);
}

function readPackedValues(buffer, state, wire, signed, output) {
  if (wire === 2) {
    const packed = readBytes(buffer, state);
    const packedState = { pos: 0 };
    while (packedState.pos < packed.length) {
      const value = readVarint(packed, packedState);
      output.push(signed ? zigZagDecode(value) : value);
    }
  } else if (wire === 0) {
    const value = readVarint(buffer, state);
    output.push(signed ? zigZagDecode(value) : value);
  } else {
    skipField(buffer, state, wire);
  }
}

function readBytes(buffer, state) {
  const length = readVarint(buffer, state);
  const start = state.pos;
  state.pos += length;
  return buffer.subarray(start, start + length);
}

function readVarint(buffer, state) {
  let result = 0;
  let factor = 1;
  while (state.pos < buffer.length) {
    const byte = buffer[state.pos];
    state.pos += 1;
    result += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) {
      return result;
    }
    factor *= 128;
  }
  throw new Error("Invalid varint in OSM PBF.");
}

function zigZagDecode(value) {
  return value % 2 === 1 ? -((value + 1) / 2) : value / 2;
}

function skipField(buffer, state, wire) {
  if (wire === 0) {
    readVarint(buffer, state);
  } else if (wire === 1) {
    state.pos += 8;
  } else if (wire === 2) {
    const length = readVarint(buffer, state);
    state.pos += length;
  } else if (wire === 5) {
    state.pos += 4;
  } else if (wire === 3) {
    while (state.pos < buffer.length) {
      const tag = readVarint(buffer, state);
      const nestedWire = tag & 7;
      if (nestedWire === 4) {
        return;
      }
      skipField(buffer, state, nestedWire);
    }
  } else if (wire === 4) {
    return;
  } else {
    throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }
}

function packCoord(lat, lon) {
  return Math.round(lat * 100000) * COORD_PACK_BASE + Math.round(lon * 100000);
}

function unpackPackedCoordPoint(packed) {
  const latE5 = Math.floor(packed / COORD_PACK_BASE);
  const lonE5 = packed - latE5 * COORD_PACK_BASE;
  const lat = latE5 / 100000;
  const lon = lonE5 / 100000;
  return {
    lat,
    lon,
    x: projectX(lon, lat),
    y: projectY(lat)
  };
}

function projectLonLat(lon, lat) {
  return {
    x: projectX(lon, lat),
    y: projectY(lat)
  };
}

function projectX(lon, lat) {
  return lon * 111320 * Math.cos(lat * degreesToRadians);
}

function projectY(lat) {
  return lat * 110540;
}

function gridCellKey(cellX, cellY) {
  return (cellX + GRID_CELL_KEY_OFFSET) * GRID_CELL_KEY_FACTOR + cellY + GRID_CELL_KEY_OFFSET;
}

function squaredDistance(ax, ay, bx, by) {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.sqrt(squaredDistance(px, py, ax, ay));
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.sqrt(squaredDistance(px, py, x, y));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
