# Data Processing

This project is a static browser app. There is no backend processing step at runtime; all parsing, clustering, traffic matching, and scoring happens in the browser after the static assets load.

## Source Files

Default inputs live under `docs/data`:

- `docs/data/csv/*.csv`: accident records used by the app by default.
- `docs/data/Bundesstrassen-2021.xlsx`: traffic count workbook.

The default CSV list is defined in `src/main.ts` as `BUNDLED_CSV_FILES`. The traffic workbook path is `BUNDLED_TRAFFIC_FILE`.
Raw SHP/DBF Unfallatlas downloads are intentionally excluded from `docs/data`: the DBF files are very large, are not loaded by the current app, and would duplicate the same accident records already represented by the CSV inputs.

## Source Acknowledgements and License

The bundled source data comes from these public sources:

- Accident locations: [Unfallatlas](https://unfallatlas.statistikportal.de/) / Statistische Aemter des Bundes und der Laender. Dataset URI: <https://data.gov.de/suche/daten/unfallatlas>.
- Traffic counts: [BASt manual traffic counts](https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/Manuelle-Zaehlung.html), represented in this project by `docs/data/Bundesstrassen-2021.xlsx`.

The source data is reused under [Datenlizenz Deutschland - Namensnennung - Version 2.0](https://www.govdata.de/dl-de/by-2-0) (`dl-de/by-2-0`). The app changes the source data by parsing CSV/XLSX files, filtering records, clustering accident points, matching traffic count points, and calculating derived scores and rankings. Any exported table or screenshot from the app should retain this source note or an equivalent attribution.

## Build Script

`npm run build` runs:

```powershell
tsc --noEmit && node scripts/build-docs.mjs
```

`scripts/build-docs.mjs` does three things:

1. Clears and recreates `docs/assets`.
2. Builds `src/main.ts` into `docs/assets/app.js` with esbuild as a classic IIFE script so `docs/index.html` can be opened directly without Vite.
3. Creates offline data scripts:
   - `docs/assets/data-manifest.js`
   - `docs/assets/data-1.js`, `data-2.js`, etc.

Each data script contains one source file from `docs/data`, compressed with gzip, encoded as base64, and split into 256 KB string chunks. Splitting the bundle one file per script keeps each generated file below GitHub's 100 MB single-file limit.

The build script also computes a SHA-256 based data version from the raw CSV/XLSX file paths and bytes. `docs/assets/data-manifest.js` exposes that version as `globalThis.__SICHERE_KNOTEN_DATA__.version`. It separately computes an app build fingerprint from the source files and injects it into `app.js` for analysis-cache invalidation.

`docs/index.html` loads the data scripts before `app.js`, so direct `file://` usage works in Chrome and Firefox without `fetch()` access to local CSV/XLSX files.

## Runtime Loading

On startup, `src/main.ts` calls `loadBundledData()`.

For each required data file, `readBundledBlob()` first checks `globalThis.__SICHERE_KNOTEN_DATA__`, which is populated by the generated data scripts. If found, it:

1. Joins the base64 chunks.
2. Decodes them to bytes.
3. Decompresses gzip with `fflate.gunzipSync`.
4. Wraps the result in a `Blob`/`File`.

If the embedded bundle is not present, the app falls back to `fetch()`/XHR from `docs/data`. That fallback is useful on a static web host, but many browsers block it from `file://`.

CSV files are decompressed and parsed sequentially to reduce peak memory use.

## Browser Caches

Implemented in `src/cache.ts`.

After the first successful parse, the app stores parsed `AccidentRecord[]` and `TrafficPoint[]` in IndexedDB:

- database: `sichere-knoten-cache`
- object stores: `meta`, `chunks`, and `analysis`
- active metadata key: `active`
- accident chunk size: 25,000 records
- traffic chunk size: 5,000 records

The cache metadata stores:

- data version
- accident chunk count
- traffic chunk count
- accident record count
- traffic point count
- creation timestamp

On startup, `loadBundledData()` checks IndexedDB before reading the compressed data scripts. If the cached version matches the current data manifest version, the app loads parsed records from IndexedDB and skips CSV/XLSX parsing. If the version does not match, or if the cache is unavailable/corrupt, the app parses the bundled raw data and writes a new cache.

After analysis succeeds for bundled data, the app also stores the resulting `AnalysisResult` in the `analysis` object store. That cache key includes:

- raw data version
- app build fingerprint
- cluster radius
- traffic match radius
- minimum accident count
- selected years
- selected Bundesland
- score mode

On later page loads with the same data, app build, and analysis settings, `runAnalysis()` restores that result and skips the expensive clustering/ranking stage. Changing any analysis control creates a different cache key. Changing source data or rebuilding app code invalidates the relevant cached analysis automatically.

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
- `UJAHR`, `UMONAT`, `USTUNDE`, `UWOCHENTAG`: time fields.
- `UKATEGORIE`: injury severity category.
- `UART`, `UTYP1`: accident classification fields.
- `IstRad`, `IstFuss`, `IstKrad`, `IstPKW`, `IstGkfz`: participant flags.
- `XGCSWGS84`, `YGCSWGS84`: longitude and latitude.

Severity weights from `UKATEGORIE`:

- `1`: 12 points
- `2`: 5 points
- `3`: 2 points
- anything else: 1 point

## Traffic Workbook Parsing

Implemented in `src/parsers/traffic.ts`.

The workbook is parsed directly as XLSX ZIP/XML using `fflate`; there is no SheetJS dependency.

Parsing steps:

1. Unzip the workbook in memory.
2. Read `xl/workbook.xml` and `xl/_rels/workbook.xml.rels`.
3. Select the `Zeilenformat` worksheet when present.
4. Read `xl/sharedStrings.xml`.
5. Treat row 1 as field names.
6. Convert rows into traffic count points.

Mapped traffic fields:

- `Str`: road label.
- `TKZST`: counting-station number.
- `Land`: Bundesland code.
- `Anfang`, `Ende`: count-section endpoints.
- `DTV`: average daily traffic.
- `DTVSV`: heavy traffic count.
- `X_Koordinate`, `Y_Koordinate`: ETRS 1989 UTM Zone 32N coordinates.

Coordinates are converted to WGS84 lon/lat in `src/geo.ts` with `utm32ToWgs84()`.

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

## Traffic Matching

Each final accident cluster is matched to the nearest traffic count point within the selected traffic match radius.

Matching details:

- Traffic points are indexed with `GeoGridIndex`.
- Candidate distances use haversine meters.
- The closest point within the radius is attached as `trafficMatch`.
- The default match radius is 300 meters.

If no traffic point is found, the cluster can still be ranked by absolute severity. Traffic-adjusted ranking falls back to absolute severity for unmatched clusters.

## Map Rendering

The static app does not download online map tiles, so it remains usable from `docs/index.html` and GitHub Pages without a map server.

Accident clusters are drawn as map-projected points. All visible clusters are rendered; the map renderer does not drop low-scoring clusters as a display optimization. Marker color emphasizes crash severity concentration: severity points per accident, serious-injury share, and especially fatal crashes. Marker size and transparency still use total harm/volume, with a continuously blended national-to-visible score scale as the user zooms. This keeps city-level hotspots readable without a hard visual-mode switch while separating severe clusters from merely large intersections. Higher-priority clusters are drawn later so stronger points remain visible when dots overlap. For responsiveness, projected cluster coordinates are cached and pan/zoom redraws are throttled to animation frames.

When the `Traffic` toggle is enabled, the map also draws the matched traffic count stations as subtle gray reference dots. These traffic points are visual context only and are not a road-network backdrop.

## Scoring

Each cluster stores:

- accident count
- fatal count
- serious injury count
- light injury count
- vulnerable user count
- severity points
- traffic match
- absolute score
- exposure score

Absolute score:

```text
severityPoints + accidentCount * 0.35 + vulnerableCount * 0.25
```

Exposure score, when a matched traffic point has `DTV > 0`:

```text
severityPoints * 10000 / DTV
```

The UI rank mode chooses either:

- `Weighted severity`: absolute score
- `Traffic-adjusted risk`: exposure score when available, otherwise absolute score

## Accident-Per-Vehicle Trend

Each cluster also stores per-year accident counts for the selected analysis years. Years with no accidents in the cluster are treated as zero accident years for trend calculation.

When a cluster has a matched traffic point with `DTV > 0`, the app estimates yearly exposure as:

```text
DTV * days_in_year
```

The yearly rate shown in the selected-intersection panel is:

```text
accidents * 1,000,000 / estimated_yearly_vehicles
```

The falling/stable/rising label is based on a linear trend over the selected years. The slope is measured in accidents per 1 million vehicles per year. A relative slope within +/-8% per year is labelled `stable`; larger positive slopes are `rising`, and larger negative slopes are `falling`.

The current traffic workbook is `Bundesstrassen-2021.xlsx`, so the selected-intersection chart uses the matched 2021 DTV as a flat traffic reference line across all selected accident years. If future traffic workbooks add annual DTV values, this is the place to extend the traffic series.

## Bundesland Summaries

After clusters are ranked, summaries are grouped by cluster Bundesland:

- total accident count
- cluster count
- total severity points
- percentage of clusters with traffic matches
- top-ranked cluster in that Bundesland

The state summary table is sorted by total severity points.

## Updating Data

When files in `docs/data` change:

```powershell
npm run build
```

This regenerates:

- `docs/index.html`
- `docs/assets/app.js`
- `docs/assets/app.css`
- `docs/assets/data-*.js`
- the data version in `docs/assets/data-manifest.js`

Do not edit generated files in `docs/assets` by hand. Change source code under `src/` or raw data under `docs/data`, then rebuild. Existing browser caches are invalidated automatically when the generated data version changes.
