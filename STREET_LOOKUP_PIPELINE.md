# Street Lookup Build Pipeline

`scripts/build-streets.mjs` builds the temporary OpenStreetMap lookup used by `scripts/build-docs.mjs` while normalizing accident records. The generated lookup is cached locally at `data/generated/street-lookup.json`; it is not shipped to the browser because the normalized accident shards already contain the derived street names and road-control flags.

## Flow

```mermaid
flowchart TD
  A[npm run build] --> B[scripts/build-docs.mjs]
  B --> C[buildStreetLookupBundle]
  C --> D{data/germany-260721.osm.pbf exists?}
  D -- no --> E[Skip street lookup]
  D -- yes --> F[Compute cache signature]
  F --> G{Cache hit and not forced?}
  G -- yes --> H[Read data/generated/street-lookup.json]
  G -- no --> I[Read accident CSV lon/lat rows]
  I --> J[Project accidents to meter coordinates]
  J --> K[Build 60 m accident grid]
  K --> L[Stream OSM PBF blobs]
  L --> M[Parse dense nodes]
  M --> N[Keep nearby node coordinates]
  M --> O[Match nearby traffic signals]
  M --> P1[Collect mini-roundabout centers]
  L --> P2[Parse ways]
  N --> P2
  P2 --> Q[Match named highway segments to nearby accidents]
  P2 --> R[Collect roundabout way refs]
  R --> S[Second PBF pass resolves roundabout way node coordinates]
  P1 --> T[Build roundabout center/radius geometries]
  S --> T
  T --> U[Assign accident rows within radius + 20 m]
  O --> V[Accumulate traffic-light bitmasks]
  Q --> W[Finalize compact lookup]
  U --> W
  V --> W
  W --> X[Cache lookup when full PBF scan completed]
  X --> Y[build-docs writes normalized accident shards]
```

## Stages

| Stage | Main functions | What it does |
| --- | --- | --- |
| Input discovery | `buildStreetLookupBundle`, `streetLookupSignature` | Locates the local PBF, computes the cache key from CSV metadata and PBF metadata, and optionally bypasses the cache with `SICHERE_KNOTEN_STREET_FORCE_REBUILD=1`. |
| Accident index | `readAccidentSource`, `buildAccidentGrid` | Reads valid CSV coordinates, projects them to approximate meters, and stores accident indexes in a compact 60 m grid so OSM nodes and way segments only check nearby accidents. |
| PBF streaming | `matchStreetsFromPbf`, `processPrimitiveBlock`, `processPrimitiveGroup` | Reads the PBF blob by blob. Dense-node groups are processed before ways, because ways only contain node ids and need the nearby node coordinate store first. |
| Dense nodes | `processDenseNodes`, `createDenseNodeProcessor` | Decodes delta-compressed dense node ids and coordinates. Nodes close to accidents are retained in `nodeCoords`; traffic signals are matched directly as point controls; `highway=mini_roundabout` nodes are collected as zero-radius roundabout geometries. Worker threads can parallelize this stage. |
| Ways | `processWay`, `processWayRefs`, `osmMetadataForWay` | Decodes highway metadata and ordered node refs. Segment matching uses only refs whose node coordinates were retained during dense-node processing. `junction=roundabout` ways keep their complete ordered node ids for the geometry pass. |
| Roundabout geometry | `resolveAndApplyRoundaboutsFromPbf`, `buildRoundaboutGeometries`, `applyRoundaboutMatches` | Runs a second PBF node-coordinate pass for collected roundabout ways, combines connected roundabout way pieces, estimates each center/radius, and assigns accidents inside `radiusMeters + 20 m`. Mini roundabouts use radius `0` and therefore a `20 m` match radius. |
| Final bundle | `finalizeStreetLookup`, `topStreetNamesForAccident` | Builds one street-name dictionary, per-row street-name indexes, per-row OSM road-control bitmasks, per-row roundabout geometry indexes, and the compact roundabout center/radius array for build-time normalization. |

## Ordering Rules

The important dependency is:

```text
dense nodes near accidents -> node coordinate store -> way segment matching
```

`processPrimitiveGroup` drains pending dense-node work before processing a way. If dense-node worker processing fails, the build should fail rather than continue with an incomplete node coordinate store.

Way refs may be encoded as packed or unpacked repeated protobuf fields. `processWay` records ref parts in wire order, and `processWayRefs` replays them in that same order so mixed encodings do not change the geometry.

Roundabout ways are not treated as ordinary nearby line-segment feature hits anymore. They first become center/radius geometries, and accident rows only get a roundabout index when they fall within that geometry's radius plus the fixed 20 m buffer.

## Useful Test Flags

```powershell
$env:SICHERE_KNOTEN_STREET_FORCE_REBUILD = "1" # ignore data/generated/street-lookup.json
$env:SICHERE_KNOTEN_STREET_WORKERS = "0"       # run dense-node processing on the main thread
$env:SICHERE_KNOTEN_STREET_MAX_BLOBS = "100"  # stop early for a fast partial scan; result is not cached
npm run build
```

Clear the flags after testing with `Remove-Item Env:SICHERE_KNOTEN_STREET_FORCE_REBUILD`, and similarly for the other variables.
