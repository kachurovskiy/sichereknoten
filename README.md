# Sichere Knoten

Visit https://kachurovskiy.com/sichereknoten/ to explore dangerous intersections from German accident data.

## Use

```powershell
npm install
npm run build
npm run serve:docs
```

Open `docs/index.html` from the build output, serve the built app locally with `npm run serve:docs`, or publish the `docs/` folder with GitHub Pages. Use `npm run serve:docs` locally for complete OpenStreetMap basemap tiles.

The app supports:

- accident CSV files from `data/csv`, normalized at build time into `docs/assets/accidents-*.js`
- municipality source workbook from `data/AuszugGV2QAktuell.xlsx`, generated into `src/municipalities.ts`
- map view with local canvas rendering and an OpenStreetMap basemap
- Bundesland summaries and top intersection tables
- CSV export of analyzed intersection clusters with Fatal %

The app automatically loads the compressed normalized data scripts in `docs/assets`. Source data files live under `data/` and are not required in the deployed `docs/` folder. Raw SHP/DBF Unfallatlas downloads are not required in the repository because the bundled CSV files already contain the accident coordinates and attributes used by the browser analysis.

The map draws grayscale OpenStreetMap tiles behind the accident markers and loads only the visible tiles for the current viewport. OpenStreetMap tiles require a browser `Referer` header, so direct `file://` use may show partial or blocked tiles; use `npm run serve:docs` or GitHub Pages for complete tiles.

For direct `file://` use, the build writes compressed normalized data scripts in `docs/assets/accidents-*.js`. Re-run `npm run build` after changing files in `data/csv`.

After the first successful load, parsed records are cached in IndexedDB under the generated data version, so normal refreshes skip CSV parsing. Analysis results are also cached per data version, app build, and analysis settings, so reloads with the same controls skip the clustering stage. The cache invalidates automatically after `npm run build` changes the data version or app build fingerprint.

## Data Sources and License

The application code is released under the [MIT License](LICENSE).

Bundled input data is reused from these public sources:

- Accident locations: [Unfallatlas](https://unfallatlas.statistikportal.de/) / Statistische Aemter des Bundes und der Laender. Dataset URI: <https://data.gov.de/suche/daten/unfallatlas>.

The source data is reused under [Datenlizenz Deutschland - Namensnennung - Version 2.0](https://www.govdata.de/dl-de/by-2-0) (`dl-de/by-2-0`). This app processes and modifies the source data by parsing records, clustering accident points, and producing derived Fatal % analysis. The analysis is project-generated, not an official publication by the data providers.

See [DATA_PROCESSING.md](DATA_PROCESSING.md) for the build-time data bundling, parser mappings, clustering, and Fatal % logic.
