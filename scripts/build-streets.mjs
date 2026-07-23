import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const STREET_LOOKUP_SCHEMA_VERSION = 4;
const NODE_CAPTURE_RADIUS_METERS = 55;
const STREET_MATCH_RADIUS_METERS = 55;
const MAX_STREET_NAMES_PER_ACCIDENT = 4;
const NODE_COORD_SHARD_COUNT = 256;
const GRID_CELL_METERS = 60;
const COORD_PACK_BASE = 10_000_000;
const textDecoder = new TextDecoder("utf-8");
const csvDecoder = new TextDecoder("windows-1252");
const degreesToRadians = Math.PI / 180;

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
  const cached = await readStreetLookupCache(cachePath, signature);
  if (cached) {
    console.log(`Street lookup loaded from ${path.relative(root, cachePath)}.`);
    return cached;
  }

  const source = await readAccidentSource(csvFiles);
  if (source.accidents.length === 0) {
    return {
      version: signature,
      names: [],
      files: source.files.map((file) => ({ name: file.name, indexes: file.indexes }))
    };
  }

  console.log(`Building street lookup from ${path.relative(root, pbfPath)} for ${source.accidents.length.toLocaleString()} accidents.`);
  const grid = buildAccidentGrid(source.accidents);
  const completed = await matchStreetsFromPbf(pbfPath, pbfStats.size, source.accidents, grid);
  const bundle = finalizeStreetLookup(signature, source);
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
    return cached?.version === signature && Array.isArray(cached.names) && Array.isArray(cached.files) ? cached : null;
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
    let rowIndex = 0;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      rowIndex += 1;
      indexes.push(0);
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
        streetMatches: null
      });
    }

    files.push({ name: path.basename(file.publicPath), indexes });
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
  for (let index = 0; index < accidents.length; index += 1) {
    const accident = accidents[index];
    const key = gridKey(Math.floor(accident.x / GRID_CELL_METERS), Math.floor(accident.y / GRID_CELL_METERS));
    let cell = cells.get(key);
    if (!cell) {
      cell = [];
      cells.set(key, cell);
    }
    cell.push(index);
  }
  return { cells, accidents };
}

function createNodeCoordStore() {
  return {
    size: 0,
    shards: Array.from({ length: NODE_COORD_SHARD_COUNT }, () => new Map())
  };
}

function setNodeCoord(store, nodeId, packedCoord) {
  const shard = store.shards[nodeCoordShard(nodeId)];
  if (!shard.has(nodeId)) {
    store.size += 1;
  }
  shard.set(nodeId, packedCoord);
}

function getNodeCoord(store, nodeId) {
  return store.shards[nodeCoordShard(nodeId)].get(nodeId);
}

function nodeCoordShard(nodeId) {
  return Math.abs(nodeId) % NODE_COORD_SHARD_COUNT;
}

async function matchStreetsFromPbf(pbfPath, fileSize, accidents, accidentGrid) {
  const file = await open(pbfPath, "r");
  const nodeCoords = createNodeCoordStore();
  let position = 0;
  let blobIndex = 0;
  let lastProgressTime = Date.now();
  const maxBlobs = Number(process.env.SICHERE_KNOTEN_STREET_MAX_BLOBS || 0);

  try {
    while (position < fileSize) {
      const headerSizeBuffer = await readExactly(file, position, 4);
      position += 4;
      const headerSize = headerSizeBuffer.readUInt32BE(0);
      const header = parseBlobHeader(await readExactly(file, position, headerSize));
      position += headerSize;
      const blobBuffer = await readExactly(file, position, header.datasize);
      position += header.datasize;
      blobIndex += 1;

      if (header.type === "OSMData") {
        processPrimitiveBlock(blobData(blobBuffer), accidents, accidentGrid, nodeCoords);
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
    await file.close();
  }
  return position >= fileSize;
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

function processPrimitiveBlock(buffer, accidents, accidentGrid, nodeCoords) {
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

  const blockContext = { strings, granularity, latOffset, lonOffset };
  for (const group of groups) {
    processPrimitiveGroup(group, blockContext, accidents, accidentGrid, nodeCoords);
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

function processPrimitiveGroup(buffer, blockContext, accidents, accidentGrid, nodeCoords) {
  const state = { pos: 0 };
  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      try {
        processDenseNodes(readBytes(buffer, state), blockContext, accidentGrid, nodeCoords);
      } catch {
        // Some historical PBF writers contain dense-node payloads this minimal reader cannot use.
      }
    } else if (field === 3 && wire === 2) {
      try {
        processWay(readBytes(buffer, state), blockContext.strings, accidents, accidentGrid, nodeCoords);
      } catch {
        // Ignore a malformed way and continue matching the rest of the PBF.
      }
    } else {
      skipField(buffer, state, wire);
    }
  }
}

function processDenseNodes(buffer, blockContext, accidentGrid, nodeCoords) {
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
    } else if (field >= 10 && ids.length > 0 && lats.length > 0 && lons.length > 0) {
      state.pos = buffer.length;
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
  for (let index = 0; index < count; index += 1) {
    id += ids[index];
    rawLat += lats[index];
    rawLon += lons[index];
    const lat = (blockContext.latOffset + blockContext.granularity * rawLat) * 1e-9;
    const lon = (blockContext.lonOffset + blockContext.granularity * rawLon) * 1e-9;
    if (isNearAccident(accidentGrid, lon, lat)) {
      setNodeCoord(nodeCoords, id, packCoord(lat, lon));
    }
  }
}

function processWay(buffer, strings, accidents, accidentGrid, nodeCoords) {
  const state = { pos: 0 };
  const keys = [];
  const vals = [];
  const refs = [];

  while (state.pos < buffer.length) {
    const tag = readVarint(buffer, state);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2) {
      readPackedValues(buffer, state, wire, false, keys);
    } else if (field === 3) {
      readPackedValues(buffer, state, wire, false, vals);
    } else if (field === 8) {
      readPackedValues(buffer, state, wire, true, refs);
    } else {
      skipField(buffer, state, wire);
    }
  }

  const streetName = streetNameForWay(keys, vals, strings);
  if (!streetName || refs.length < 2) {
    return;
  }

  let previousNodeId = 0;
  let previousPoint = null;
  for (const delta of refs) {
    const nodeId = previousNodeId + delta;
    const packed = getNodeCoord(nodeCoords, nodeId);
    const currentPoint = packed === undefined ? null : projectPackedCoord(packed);
    if (previousPoint && currentPoint) {
      matchSegmentToAccidents(previousPoint, currentPoint, streetName, accidents, accidentGrid);
    }
    previousNodeId = nodeId;
    previousPoint = currentPoint;
  }
}

function streetNameForWay(keys, vals, strings) {
  let highway = "";
  let name = "";
  let officialName = "";
  let ref = "";

  for (let index = 0; index < keys.length; index += 1) {
    const key = strings[keys[index]];
    const value = strings[vals[index]];
    if (key === "highway") {
      highway = value;
    } else if (key === "name") {
      name = value;
    } else if (key === "official_name") {
      officialName = value;
    } else if (key === "ref") {
      ref = value;
    }
  }

  if (!highway || highway === "construction" || highway === "proposed") {
    return null;
  }
  return cleanStreetName(name || officialName || ref);
}

function cleanStreetName(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function isNearAccident(accidentGrid, lon, lat) {
  const point = projectLonLat(lon, lat);
  const nearby = accidentIndexesInBounds(
    accidentGrid,
    point.x - NODE_CAPTURE_RADIUS_METERS,
    point.y - NODE_CAPTURE_RADIUS_METERS,
    point.x + NODE_CAPTURE_RADIUS_METERS,
    point.y + NODE_CAPTURE_RADIUS_METERS
  );
  for (const accidentIndex of nearby) {
    const accident = accidentGrid.accidents[accidentIndex];
    if (squaredDistance(point.x, point.y, accident.x, accident.y) <= NODE_CAPTURE_RADIUS_METERS ** 2) {
      return true;
    }
  }
  return false;
}

function matchSegmentToAccidents(a, b, streetName, accidents, accidentGrid) {
  const minX = Math.min(a.x, b.x) - STREET_MATCH_RADIUS_METERS;
  const minY = Math.min(a.y, b.y) - STREET_MATCH_RADIUS_METERS;
  const maxX = Math.max(a.x, b.x) + STREET_MATCH_RADIUS_METERS;
  const maxY = Math.max(a.y, b.y) + STREET_MATCH_RADIUS_METERS;
  const nearby = accidentIndexesInBounds(accidentGrid, minX, minY, maxX, maxY);

  for (const accidentIndex of nearby) {
    const accident = accidents[accidentIndex];
    const distance = pointSegmentDistance(accident.x, accident.y, a.x, a.y, b.x, b.y);
    if (distance <= STREET_MATCH_RADIUS_METERS) {
      if (!accident.streetMatches) {
        accident.streetMatches = new Map();
      }
      const previousDistance = accident.streetMatches.get(streetName);
      if (previousDistance === undefined || distance < previousDistance) {
        accident.streetMatches.set(streetName, distance);
      }
    }
  }
}

function accidentIndexesInBounds(accidentGrid, minX, minY, maxX, maxY) {
  const minCellX = Math.floor(minX / GRID_CELL_METERS);
  const maxCellX = Math.floor(maxX / GRID_CELL_METERS);
  const minCellY = Math.floor(minY / GRID_CELL_METERS);
  const maxCellY = Math.floor(maxY / GRID_CELL_METERS);
  const indexes = [];

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      const cell = accidentGrid.cells.get(gridKey(cellX, cellY));
      if (cell) {
        indexes.push(...cell);
      }
    }
  }

  return indexes;
}

function finalizeStreetLookup(version, source) {
  const names = Array.from(new Set(source.accidents.flatMap((accident) => streetNamesForAccident(accident)))).sort((a, b) =>
    a.localeCompare(b, "de", { sensitivity: "base" })
  );
  const indexesByName = new Map(names.map((name, index) => [name, index + 1]));

  for (const accident of source.accidents) {
    const streetIndexes = streetNamesForAccident(accident)
      .map((name) => indexesByName.get(name) ?? 0)
      .filter((index) => index > 0);
    if (streetIndexes.length === 0) {
      continue;
    }
    source.files[accident.fileIndex].indexes[accident.rowIndex - 1] =
      streetIndexes.length === 1 ? streetIndexes[0] : streetIndexes;
  }

  return {
    version,
    names,
    files: source.files.map((file) => ({ name: file.name, indexes: file.indexes }))
  };
}

function streetNamesForAccident(accident) {
  if (!accident.streetMatches) {
    return [];
  }
  return Array.from(accident.streetMatches.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "de", { sensitivity: "base" }))
    .slice(0, MAX_STREET_NAMES_PER_ACCIDENT)
    .map(([name]) => name);
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

function projectPackedCoord(packed) {
  const latE5 = Math.floor(packed / COORD_PACK_BASE);
  const lonE5 = packed - latE5 * COORD_PACK_BASE;
  const lat = latE5 / 100000;
  const lon = lonE5 / 100000;
  return projectLonLat(lon, lat);
}

function projectLonLat(lon, lat) {
  return {
    x: lon * 111320 * Math.cos(lat * degreesToRadians),
    y: lat * 110540
  };
}

function gridKey(cellX, cellY) {
  return `${cellX}:${cellY}`;
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
