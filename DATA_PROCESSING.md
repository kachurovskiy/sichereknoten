# Data Processing

This project is a static browser app. There is no backend processing step at runtime; all parsing, clustering, and analysis happens in the browser after the static assets load.

## Source Files

Build-time source inputs live under `data`:

- `data/csv/*.csv`: accident records bundled into the app.
- `data/AuszugGV2QAktuell.xlsx`: Destatis municipality directory extract used to generate `src/municipalities.ts`.
- `data/germany-260721.osm.pbf`: local OpenStreetMap PBF used at build time to derive nearest street names for accident records. The PBF is ignored by Git.

`scripts/build-docs.mjs` discovers CSV source files in `data/csv` and writes compressed normalized accident chunks into `docs/assets`. Existing chunk scripts are reused when the generated data version still matches and all referenced chunk files exist.
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
   - `docs/assets/data-manifest.js`
   - `docs/assets/accidents-1.js`, `accidents-2.js`, etc.
   - `docs/assets/analysis-default-*.bin.gz`.

Each accident data script contains up to 100,000 normalized accident records, compressed with gzip, encoded as base64, and split into 256 KB string chunks. Splitting the bundle across generated scripts keeps each file below GitHub's 100 MB single-file limit and avoids CSV parsing at startup. Regular builds keep existing `accidents-*.js` files when the current manifest version matches the source CSV bytes and generated street lookup version; the slow normalization pass only runs when data changed or chunk files are missing.

The default all-Germany analysis is precomputed at build time. Hosted pages load it as a custom gzip-compressed binary asset with `fetch()` to avoid parsing a very large JavaScript data assignment or JSON payload in Chrome.

When the local PBF exists, `scripts/build-streets.mjs` streams it during build and creates a compact OSM lookup bundle used while normalizing accident records. The bundle uses one global street-name dictionary and per-CSV-row integer street indexes instead of repeating street names for every accident. Rows near multiple named streets store a short integer list so intersection incidents can keep more than one nearby street name. The same lookup stores a small per-row bitmask for nearby OSM road-control tags: `junction=roundabout`/`highway=mini_roundabout` for roundabouts and `highway=traffic_signals`/`crossing=traffic_signals` for traffic lights. A local rebuild cache is written to `data/generated/street-lookup.json` and ignored by Git. The runtime app does not ship or load this lookup because normalized accident chunks already contain the street names and OSM road-control flags needed by the UI.

The build script also computes a SHA-256 based data version from the raw CSV file paths and bytes, plus the generated street lookup version when present. `docs/assets/data-manifest.js` exposes that version as `globalThis.__SICHERE_KNOTEN_DATA__.version`. It separately computes an app build fingerprint from the source files and injects it into `app.js` for analysis-cache invalidation.

`docs/index.html` loads the manifest before `app.js`; the app then lazy-loads accident chunk scripts only after a parsed-cache miss or after a user chooses an analysis setting that cannot use the bundled default analysis. Local development uses `scripts/serve-docs.mjs`, a plain HTTP server for `docs/` on `http://127.0.0.1:5173/`; rerunning it stops the previous server process first. Direct `file://` use is not supported for the bundled default analysis because browsers block `fetch()` access to local gzip assets.

## Runtime Loading

On startup, `src/main.ts` calls `loadBundledData()`.

The app first ensures `docs/assets/data-manifest.js` has populated `globalThis.__SICHERE_KNOTEN_DATA__`, then attempts to load the default analysis from `analysis-default-*.bin.gz` when the current controls match the bundled defaults. When a non-default analysis needs accident records, `readBundledAccidents()` starts loading the listed `accidents-*.js` chunk scripts in parallel, then decodes them in manifest order. Each chunk's base64 strings are decoded, decompressed with `fflate.gunzipSync`, parsed as normalized compact records, and expanded into `AccidentRecord` objects.

There is no runtime CSV fallback. If the generated manifest or accident chunks are missing, run `npm run build`.

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

On startup, `loadBundledData()` checks IndexedDB before loading the accident chunk scripts. If the cached version matches the current data manifest version, the app loads parsed records from IndexedDB and skips normalized chunk loading. If the version does not match, or if the cache is unavailable/corrupt, the app loads the bundled normalized records and writes a new cache after the first render.

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
2. Converts lon/lat to an approximate meter grid with `lonLatToMeterPoint()`.
3. Uses grid buckets sized by the selected cluster radius.
4. For each accident, searches neighboring buckets for the nearest cluster centroid within the radius.
5. Adds the accident to that cluster or creates a new cluster.
6. Updates the cluster centroid and bucket when the centroid moves.
7. Drops clusters below the selected minimum accident count.

The default cluster radius is 60 meters.

## Map Rendering

The map draws visible grayscale OpenStreetMap raster tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` behind the cluster points while showing OpenStreetMap attribution in the map corner. Direct `file://` use cannot send the browser `Referer` header required by the OSM tile usage policy, so tiles may be partial or blocked in that mode; use `npm run dev`, `npm run serve:docs`, or GitHub Pages for complete tiles. Tiles are requested only for the current viewport and retained in a small in-memory browser cache; the app does not prefetch offline tile packs.

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

Each cluster also stores per-year accident counts for the selected analysis years. Years with no accidents in the cluster are treated as zero accident years for trend calculation.

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
- `docs/assets/accidents-*.js` only when data changed or generated chunk files are missing
- the data version in `docs/assets/data-manifest.js`

Do not edit generated files in `docs/assets` by hand. Change source code under `src/` or raw data under `data/csv`, then rebuild. Existing browser caches are invalidated automatically when the generated data version changes.

When `data/AuszugGV2QAktuell.xlsx` changes:

```powershell
npm run generate:municipalities
npm run build
```
