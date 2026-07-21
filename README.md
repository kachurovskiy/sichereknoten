# Sichere Knoten

Visit https://kachurovskiy.com/sichereknoten/ to explore dangerous intersections - from German accident and Bundesstrassen traffic data.

## Use

```powershell
npm install
npm run build
npm run serve:docs
```

Open `docs/index.html` from the build output, serve the built app locally with `npm run serve:docs`, or publish the `docs/` folder with GitHub Pages. No Vite server is needed for the built app unless you use the OpenStreetMap basemap locally.

The app supports:

- accident CSV files from `docs/data/csv`
- `docs/data/Bundesstrassen-2021.xlsx`
- map view with local canvas rendering and an optional OpenStreetMap basemap
- Bundesland summaries and top intersection tables
- CSV export of ranked clusters

The app automatically loads the bundled CSV and XLSX files from `docs/data`. Raw SHP/DBF Unfallatlas downloads are not required in the repository because the bundled CSV files already contain the accident coordinates and attributes used by the browser analysis.

The `OSM` basemap is enabled by default, draws grayscale OpenStreetMap tiles behind the accident markers, and loads only the visible tiles for the current viewport. OpenStreetMap tiles require a browser `Referer` header, so direct `file://` use may show partial or blocked tiles; use `npm run serve:docs` or GitHub Pages for complete tiles. Turn off `OSM` to keep the map fully offline.

For direct `file://` use, the build also writes compressed data scripts in `docs/assets/data-*.js`. Re-run `npm run build` after changing files in `docs/data`.

After the first successful load, parsed records are cached in IndexedDB under the generated data version, so normal refreshes skip CSV/XLSX parsing. Ranked analysis results are also cached per data version, app build, and analysis settings, so reloads with the same controls skip the clustering stage. The cache invalidates automatically after `npm run build` changes the data version or app build fingerprint.

## Data Sources and License

The application code is released under the [MIT License](LICENSE).

Bundled input data is reused from these public sources:

- Accident locations: [Unfallatlas](https://unfallatlas.statistikportal.de/) / Statistische Aemter des Bundes und der Laender. Dataset URI: <https://data.gov.de/suche/daten/unfallatlas>.
- Traffic counts: [BASt manual traffic counts](https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/Manuelle-Zaehlung.html), currently bundled as `docs/data/Bundesstrassen-2021.xlsx`.

The source data is reused under [Datenlizenz Deutschland - Namensnennung - Version 2.0](https://www.govdata.de/dl-de/by-2-0) (`dl-de/by-2-0`). This app processes and modifies the source data by parsing records, clustering accident points, matching traffic count stations, calculating scores, and producing derived rankings. The rankings are therefore project-generated analysis, not an official publication by the data providers.

See [DATA_PROCESSING.md](DATA_PROCESSING.md) for the build-time data bundling, parser mappings, clustering, traffic matching, and scoring logic.
