# Data Processing

This project is a static browser app. There is no backend processing step at runtime; all parsing, clustering, and analysis happens in the browser after the static assets load.

## Source Files

Build-time source inputs live under `data`:

- `data/csv/*.csv`: accident records bundled into the app.
- `data/AuszugGV2QAktuell.xlsx`: Destatis municipality directory extract used to generate `src/municipalities.ts`.
- `data/germany-260721.osm.pbf`: local OpenStreetMap PBF used at build time to derive nearest street names for accident records. The PBF is ignored by Git.

`scripts/build-docs.mjs` discovers CSV source files in `data/csv` and writes compressed normalized accident state shards into `docs/assets`. Existing shard files are reused when the generated data version still matches and all referenced shard files exist.
`scripts/generate-municipalities.mjs` reads `data/AuszugGV2QAktuell.xlsx` and writes the compact lookup source used at runtime.
Raw SHP/DBF Unfallatlas downloads are intentionally excluded from the repository: the DBF files are very large, are not loaded by the current app, and would duplicate the same accident records already represented by the CSV inputs.

## Source Acknowledgements And License

The bundled source data comes from:

- Accident locations: [Unfallatlas](https://unfallatlas.statistikportal.de/) / Statistische Aemter des Bundes und der Laender. Dataset URI: <https://data.gov.de/suche/daten/unfallatlas>.

The source data is reused under [Datenlizenz Deutschland - Namensnennung - Version 2.0](https://www.govdata.de/dl-de/by-2-0) (`dl-de/by-2-0`). The app changes the source data by parsing CSV files, filtering records, clustering accident points, and calculating derived analysis measures. Any exported table or screenshot from the app should retain this source note or an equivalent attribution.

## Build Script

`npm run build` runs:

```powershell
tsc --noEmit && node scripts/build-docs.mjs
```

`scripts/build-docs.mjs` does three things:

1. Removes known generated non-data files from `docs/assets`.
2. Builds `src/main.ts` into `docs/assets/app.js` with esbuild as a classic IIFE script for GitHub Pages and the local docs server.
3. Creates or reuses offline data assets:
   - `docs/assets/data-manifest.json`
   - `docs/assets/accidents-state-01-*.bin.gz`, `accidents-state-02-*.bin.gz`, etc.
   - `docs/assets/analysis-default-*.bin.gz`.

Each accident state shard is a custom binary `AccidentRecord[]` payload compressed with gzip. The binary layout keeps repeated source names, street names, and administrative codes/names in a per-shard string dictionary, stores small integers as varints, stores WGS84 coordinates as Float64 values, and stores LINREF coordinates at centimeter precision. Regular builds keep existing `accidents-state-*.bin.gz` files when the current manifest version matches the source CSV bytes, generated street lookup version, and binary codec source files; the slow normalization pass only runs when data or the generated format changes, or shard files are missing.

The default all-Germany analysis is precomputed at build time. Hosted pages load it as a custom gzip-compressed binary asset with `fetch()` to avoid parsing a very large JavaScript data assignment or JSON payload in Chrome.

When the local PBF exists, `scripts/build-streets.mjs` streams it during build and creates a compact OSM lookup bundle used while normalizing accident records. The bundle uses one global street-name dictionary and per-CSV-row integer street indexes instead of repeating street names for every accident. Rows near multiple named streets store a short integer list so intersection incidents can keep more than one nearby street name. The same lookup stores a small per-row bitmask for nearby OSM road-control tags: `highway=traffic_signals`/`crossing=traffic_signals` for traffic lights, plus a per-row roundabout geometry index for rows matched to `junction=roundabout` ways or `highway=mini_roundabout` nodes. Way roundabouts are converted into approximate center/radius geometries and match accidents inside `radius + 20 m`; mini roundabouts use radius `0` and therefore a `20 m` match radius. A local rebuild cache is written to `data/generated/street-lookup.json` and ignored by Git. The runtime app does not ship or load this lookup because normalized accident shards already contain the street names, OSM road-control flags, and roundabout geometry metadata needed by the UI.

See `STREET_LOOKUP_PIPELINE.md` for the street lookup flow diagram, stage table, and test flags.

The build script also computes a SHA-256 based data version from the raw CSV file paths and bytes, the generated street lookup version when present, and the source files that define the binary data format. `docs/assets/data-manifest.json` exposes that version and the generated asset list. It separately computes an app build fingerprint from the source files and injects it into `app.js` for analysis-cache invalidation.

`docs/index.html` loads `app.js`; the app fetches the manifest first, then lazy-loads accident state shard files only after a parsed-cache miss or after a user chooses an analysis setting that cannot use the bundled default analysis. Local development uses `scripts/serve-docs.mjs`, a plain HTTP server for `docs/` on `http://127.0.0.1:5173/`; rerunning it stops the previous server process first. Direct `file://` use is not supported because browsers block `fetch()` access to local gzip assets.

## Runtime Loading

On startup, `src/main.ts` calls `loadBundledData()`.

The app first fetches `docs/assets/data-manifest.json`, then attempts to load the default analysis from `analysis-default-*.bin.gz` when the current controls match the bundled defaults. When a non-default analysis needs accident records, `readBundledAccidents()` starts fetching the listed `accidents-state-*.bin.gz` files in parallel, then decodes them in manifest order. Each shard is decompressed with `fflate.gunzipSync` and decoded by `src/accidentRecordsBinary.ts` into `AccidentRecord` objects.

There is no runtime CSV fallback. If the generated manifest or accident state shards are missing, run `npm run build`.

## Browser Caches

Implemented in `src/cache.ts`.

After the first successful parse, the app stores parsed `AccidentRecord[]` in IndexedDB:

- database: `sichere-knoten-cache`
- object stores: `meta`, `chunks`, and `analysis`
- active metadata key: `active`
- accident chunk size: 25,000 records

The cache metadata stores:

- data version
- accident chunk count
- accident record count
- creation timestamp

On startup, `loadBundledData()` checks IndexedDB before loading accident state shard files. If the cached version matches the current data manifest version, the app loads parsed records from IndexedDB and skips normalized shard loading. If the version does not match, or if the cache is unavailable/corrupt, the app loads the bundled normalized records and writes a new cache after the first render.

After analysis succeeds for bundled data, the app also stores the resulting `AnalysisResult` in the `analysis` object store. That cache key includes:

- raw data version
- app build fingerprint
- cluster radius
- minimum accident count
- selected years
- selected Bundesland

On later page loads with the same data, app build, and analysis settings, `runAnalysis()` restores that result and skips the expensive clustering stage. Changing any analysis control creates a different cache key. Changing source data or rebuilding app code invalidates the relevant cached analysis automatically.

The cache is an optimization only. The app still works when IndexedDB is blocked, full, or cleared by the browser.

## Accident CSV Parsing

Implemented in:

- `src/parsers/csv.ts`
- `src/parsers/common.ts`

CSV parsing behavior:

- Reads each CSV as a stream.
- Decodes using `windows-1252`.
- Uses semicolon-delimited rows with quote handling.
- Reports progress every 10,000 records.
- Accepts records only when `XGCSWGS84` and `YGCSWGS84` are valid lon/lat coordinates inside a Germany-sized bounding box.

Mapped accident fields:

- `UIDENTSTLAE` or `UIDENTSTLA`: source accident id.
- `ULAND`: Bundesland code.
- `UJAHR`, `UMONAT`, `USTUNDE`, `UWOCHENTAG`: time fields. The bundled files do not expose a separate day-of-month column; when the source accident id encodes a valid `YYMMDD` date, the day is derived from `UIDENTSTLAE`/`UIDENTSTLA` and validated against year, month, and weekday.
- `UKATEGORIE`: injury severity category.
- `UART`, `UTYP1`: accident classification fields.
- `IstRad`, `IstFuss`, `IstKrad`, `IstPKW`, `IstGkfz`: participant flags.
- `XGCSWGS84`, `YGCSWGS84`: longitude and latitude.
- `streetName`: primary nearest named OSM highway resolved from the generated build-time street lookup when available.
- `streetNames`: all nearby named OSM highways retained for the accident, usually one street and up to a few streets at intersections.
- `osmRoundabout`, `osmTrafficSignal`: nullable booleans derived from the build-time OSM lookup. `null` means the normalized bundle was built without this OSM metadata.
- `osmRoundaboutId`, `osmRoundaboutLon`, `osmRoundaboutLat`, `osmRoundaboutRadiusMeters`, `osmRoundaboutMatchRadiusMeters`: nullable geometry metadata for accidents assigned to a specific OSM roundabout.

Injury outcomes from `UKATEGORIE`:

- `1`: fatal accident
- `2`: serious-injury accident
- `3`: light-injury accident
- anything else: other or unknown outcome

## Intersection Inference

Implemented in `src/analysis.ts`.

The app does not derive real road-topology intersections from a road network. It infers dangerous intersections as spatial clusters of accident points.

The clustering algorithm:

1. Filters accidents by selected years and Bundesland.
2. Groups accidents with roundabout geometry by OSM roundabout id.
3. Promotes a roundabout group to a fixed-center intersection only when it has at least `max(2, selected minimum accident count)` accidents after the current filters.
4. Places promoted roundabout intersections at the OSM roundabout center and stores the OSM radius plus the `20 m` match buffer.
5. Removes promoted roundabout accidents from the normal clustering pass.
6. Converts remaining lon/lat points to an approximate meter grid with `lonLatToMeterPoint()`.
7. Uses grid buckets sized by the selected cluster radius.
8. For each remaining accident, searches neighboring buckets for the nearest cluster centroid within the radius.
9. Adds the accident to that cluster or creates a new cluster.
10. Updates the cluster centroid and bucket when the centroid moves.
11. Drops clusters below the selected minimum accident count.

Roundabout accidents whose geometry-centered group is below the selected minimum remain eligible for normal clustering, but their roundabout flag is ignored in that normal cluster. This prevents a nearby fallback centroid from being marked as a roundabout when the actual roundabout-centered intersection no longer meets the minimum accident requirement. Traffic-light metadata is still counted normally.

The default cluster radius is 60 meters.

## Map Rendering

The map draws visible grayscale OpenStreetMap raster tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` behind the cluster points while showing OpenStreetMap attribution in the map corner. Use `npm run dev`, `npm run serve:docs`, or GitHub Pages so browsers can fetch data assets and send the `Referer` header expected by the OSM tile usage policy. Tiles are requested only for the current viewport and retained in a small in-memory browser cache; the app does not prefetch offline tile packs.

Accident clusters are drawn as map-projected points. All visible clusters are rendered; the map renderer does not drop low-metric clusters as a display optimization. Marker color, size, transparency, draw order, and click tie-breaking use Fatal % as the core metric, with accident count used only as a secondary tie-break and volume cue. This keeps city-level hotspots readable while separating severe locations from merely large intersections. Higher Fatal % clusters are drawn later so stronger points remain visible when dots overlap. For responsiveness, projected cluster coordinates are cached and pan/zoom redraws are throttled to animation frames.

## Fatal %

Each cluster stores:

- accident count
- fatal count
- serious injury count
- light injury count
- vulnerable user count
- distinct street names seen in the cluster's accident records
- Fatal %

Fatal %:

```text
(fatal * fatal weight + serious * serious weight) / total
```

Default weights:

- fatal weight: `1`
- serious weight: `0.5`

For clusters below the full-sample accident count in the selected scope, the app applies a progressive sample-size discount:

```text
discount = total / full sample accidents
```

At the full-sample accident count or higher, the discount is 1.0. The default full-sample accident count is `10`.

The Accident trend also adjusts Fatal % by how strongly accidents are rising or falling:

```text
trend signal = clamp((abs(relative trend) - trend dead zone) / (full trend signal - trend dead zone), 0, 1)
trend factor = 1 + trend signal * max trend adjustment for rising trends
trend factor = 1 - trend signal * max trend adjustment for falling trends
Fatal % = ((fatal * fatal weight + serious * serious weight) / total) * discount * trend factor
```

Default trend settings:

- trend dead zone: `5%` per year
- full trend signal: `15%` per year
- max trend adjustment: `15%`
- metric cap: `100%`

All Fatal % parameters are available in Settings. The result is capped by the metric cap and displayed as a percentage. This avoids treating high-incident, high-traffic intersections as automatically worst when reliable traffic volume data is not available, while strongly reducing the influence of very small samples.

## Accident Trend

Each cluster also stores per-year accident counts and fatal/serious/light breakdowns for the selected analysis years. Years with no accidents in the cluster are treated as zero accident years for trend calculation.

The falling/stable/rising label is based on a linear trend over the selected years. The slope is measured in accidents per year. A relative slope within +/-8% per year is labelled `stable`; larger positive slopes are `rising`, and larger negative slopes are `falling`.

## Bundesland Summaries

After clusters are analyzed, summaries are grouped by cluster Bundesland:

- total accident count
- cluster count
- Fatal %
- top cluster in that Bundesland

The state summary table is sorted by Fatal %.

## Updating Data

When files in `data/csv` change:

```powershell
npm run build
```

This regenerates:

- `docs/index.html`
- `docs/assets/app.js`
- `docs/assets/app.css`
- `docs/assets/accidents-state-*.bin.gz` only when data changed, the binary format changed, or generated shard files are missing
- the data version in `docs/assets/data-manifest.json`

Do not edit generated files in `docs/assets` by hand. Change source code under `src/` or raw data under `data/csv`, then rebuild. Existing browser caches are invalidated automatically when the generated data version changes.

When `data/AuszugGV2QAktuell.xlsx` changes:

```powershell
npm run generate:municipalities
npm run build
```
