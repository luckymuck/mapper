# Mapper — Location History Visualizer

A privacy-first web app that turns your location history (Google, Apple, or photos)
into a map, highlighting everywhere you've been:

- **Visited regions** — every country, state/province, and (for the US) county you've set foot in
- **Reachable area** — a highlight of all areas within a chosen radius (default 50 km) of where you've been
- **Recency coloring** — how recently you were last at each place
- **Duration coloring** — estimated time spent in each area
- **Rainbow history** — the whole timeline painted as a rainbow (oldest → newest)

Everything runs **entirely in your browser**. Your files never leave your device.

## Quick start

Just open `index.html` in a browser (double-click works — no server needed), or
serve the folder with any static file server.

> **Map tiles:** the default basemap is CARTO, which works when opened straight
> from disk. The OpenStreetMap option requires a valid HTTP Referer and will
> show a 403 tile block when opened via `file://` — use it when the app is
> served over HTTP (e.g. `python -m http.server` or any static host). Esri
> street/satellite are also available.

1. **Drop your data** onto the upload zone (or click it):
   - Google Takeout — a `.zip` or the extracted `.json` files
   - Google Photos supplemental-metadata.json files (single → point; batch → trip dialog)
   - A `.mapper.json` file produced by the desktop tool
   - `CSV` / `GPX`
   - Photo files (JPEG/HEIC) that still contain GPS metadata
2. **Load demo data** to see it all instantly with a synthetic world traveler. The map
   automatically centers on the **continent where you have the most points**. Path
   lines are split at the antimeridian so they stay on the same world copy as the
   region outlines — USA→East Asia draws the short way (across the Pacific), and
   zooming into Japan/China shows both the line and the coloured region together.
3. **Add points…** lets you type a list of places or coordinates (one per line) with an
   optional date — e.g. `Los Angeles, California, USA 8/15/2026`, `15 Aug 2026`,
   `8/15/26`, `34.0522, -118.2437 2026-08-15`. Place names are looked up online via
   OpenStreetMap Nominatim (the text is sent to that service).
3. Use the sidebar to change **region level** (Country / State / County),
   **color metric** (Last visited / Time spent / Visit count / Rainbow by date),
   the **reach radius**, and toggle layers.
4. **Multiple files**: dragging in more files adds them to the current map
   (deduplicated); **Clear** starts over.
5. **Show all region outlines** draws every country / every subdivision of visited
   countries as context underneath the colored regions. Unselected regions are
   shown as **lines only** (no shading).
6. **Edit mode** (its own switch, below Layers): all countries are shown; click an
   unvisited country to **load its subdivisions** (a spinner appears while they
   load), then click a specific state/county to add it. Click a visited region to
   remove it, **right-click to edit its dates in the sidebar panel** (with Prev/Next
   to step through regions), **Shift-click** to multi-select for bulk date edits,
   **shift all dates by N days**, or set a date range for a whole country. Regions
   you add **stay visible after edit mode is turned off**. Analysis results are
   cached, so a single edit, metric change, or layer toggle doesn't re-analyze
   your data. **Draw trip…** lets you click points on the map to trace a route
   (dates auto-filled between a start/end), and **Add trip…** builds a trip from a
   list of places with dates spread across it — both add a trip visit so the trip
   counts toward time-spent.
7. **Export…** opens a privacy dialog — choose exactly which data leaves your
   machine (default: visited regions + summary stats only, no raw positions).
   Exported `.mapper.json` files can be **re-imported** to restore the saved
   visited set (regions become manual additions).
8. The points stat shows **shown / total** (e.g. `1,000 / 1,794`) whenever the
   200k cap or a filter reduces what's displayed.

## Supported data sources

| Source | Where | What's parsed |
|---|---|---|
| Google Takeout | `Location History.json` (legacy), `records.json`, `Semantic Location History/**/*.json`, or the whole `.zip` | track points + `placeVisit`/`activitySegment` visits |
| Google Maps "Export timeline" | `Timeline-GoogleAccount-*.json` (`.timelineObjects` or `.semanticSegments` arrays, points as `"lat°, lng°"` strings) | track points + visits |
| Apple | extracted iOS backup (`routined.sqlite` etc.) via the desktop tool | visit records (start/end times) |
| Photos | any JPEG/HEIC with EXIF GPS | one point per photo |
| Generic | CSV (`lat,lng,timestamp`) and GPX (`trkpt`) | track points |

Canonical internal model: **points** `{lat, lng, ts, acc}` and **visits**
`{lat, lng, start, end}`. `placeVisit` durations from Google make the
"time spent" estimate accurate; otherwise it is estimated from point intervals.

## How the visualizations work

- **Regions**: points are classified against admin-boundary polygons using an
  `rbush` bounding-box index + ray-cast point-in-polygon (even-odd across holes).
  Large histories (>60k points) are aggregated onto a ~1 km grid and the grid
  representatives are classified for speed.
- **Reachable area (50 km)**: a raster mask of "within radius of any occupied
  cell" computed with geodesic (haversine) distances, painted with a rasterized
  circle per occupied cell. Shown as a colored heat canvas (Web-Mercator-correct)
  plus a simplified vector outline (marching-squares tracing + Douglas-Peucker).
- **Recency / duration / count / rainbow**: per-region and per-cell metrics are
  mapped through color ramps (log scales). The heat grid and region choropleth
  share the selected metric. The rainbow sweeps hue 0→330 across the timeline.

## Admin boundary data

- **Countries**: Natural Earth (via `datasets/geo-countries`), bundled offline, all countries, ~2.8 MB.
- **States/provinces**: Natural Earth 10m admin-1, bundled offline, ~7.8 MB, every country.
- **Counties**: US counties bundled offline (~2.2 MB), plus **ADM2 (county-level)
  data bundled for Canada, UK, Australia, Germany, France, and Japan** (~3.6 MB,
  from geoBoundaries) — Canada shows census divisions rather than just provinces.
  For other countries the app falls back per country to state/province, then to
  country level, and labels each region with the level actually shown. Real county
  polygons for other countries can be fetched on demand from
  [geoBoundaries](https://www.geoboundaries.org/) (CC BY 4.0) by enabling
  **Online boundary detail** — note this shares the list of countries you've
  visited with a third-party CORS proxy. Online lookups are time-boxed and run in
  the background, so the map always renders immediately with offline data
  (states) and upgrades to real counties as they arrive.

Boundaries are pre-simplified by `tools/build-data.js` and inlined as classic JS
scripts (`data/*.js`) so the app works from disk with no network dependency for the
core features.

## Desktop tool (`desktop/mapper_tool.py`)

Python 3 (stdlib only; `pip install exifread` for photos) for the cases the
browser can't handle — Apple backups, huge archives, big photo libraries:

```
python desktop/mapper_tool.py apple   <backup-dir>  -o out.json
python desktop/mapper_tool.py takeout <takeout.zip> -o out.json
python desktop/mapper_tool.py photos  <photo-dir>   -o out.json
python desktop/mapper_tool.py merge   a.json b.json -o out.json
```

The output `mapper.json` drags straight into the web app. Apple backups must be
extracted first (iMazing, iBackup Viewer, or `libimobiledevice`); the tool
auto-detects the visit tables in `*.sqlite` files.

- **Edit mode** lets you correct or add missing data: click any region to toggle it
  into/out of the visited set, right-click to override first/last visit dates. Manual
  edits sit on top of auto-detection, are shown per-region, and can be included in
  exports (`.mapper.json` gains a `manual` section that re-imports).
- **Export** produces a sanitized `.mapper.json` (with granular toggles: raw points,
  exact vs date-only timestamps, coordinate precision, addresses, visits, manual
  edits), a `.geojson` of the rendered overlays (visited regions + reachable area),
  and a settings `.json`. Unchecked categories are omitted entirely.

## Project layout

```
index.html            single-page app
css/style.css         dark UI
js/
  model.js            canonical point/visit model
  color.js            ramps incl. rainbow, legend
  geo.js              spatial index, grids, reach mask, outline, heat canvas
  geocode.js          date/coordinate parsing + Nominatim place lookup
  export.js           privacy-filtered export + manual (edit-mode) overrides
  boundaries.js       bundled + on-demand boundary providers, level fallback
  parsers.js          Google / photos / CSV / GPX ingestion
  ui.js               Leaflet map, layers, legend
  main.js             orchestration, demo data, event wiring
data/                 prebuilt boundary bundles (regenerated by tools/build-data.js)
desktop/              mapper_tool.py (Apple backups, batch jobs)
tools/
  build-data.js       download + simplify boundary data (one-time)
  smoke-test.js       headless core-pipeline checks (node tools/smoke-test.js)
  e2e/                playwright-based browser test (node e2e/e2e.js)
```

## Development

```bash
node tools/build-data.js   # rebuild data/*.js boundary bundles (needs network)
node tools/smoke-test.js   # core algorithm checks
cd tools/e2e && node e2e.js # full browser test via installed Edge
```

## Attribution

- Map tiles © OpenStreetMap contributors, CARTO.
- Country boundaries: Natural Earth / `datasets/geo-countries`.
- States/provinces: Natural Earth admin-1 (10m).
- US counties: US Census via `us-atlas`.
- Non-US county (online): [geoBoundaries](https://www.geoboundaries.org/) — CC BY 4.0.

## Known limitations

- Very large histories (>~1M points) are downsampled/filtered; the "time spent"
  figure for raw track points is an estimate (gaps >30 min are treated as travel).
  Classification runs in chunks with a live progress % and the UI stays responsive;
  histories above ~25k points use fast grid-cell aggregation instead of per-point
  testing.
- Photo EXIF requires the original camera files; social-media uploads usually strip GPS.
- County-level polygons outside the US aren't bundled; those countries automatically
  fall back to state/province (and then country) level, with real counties available
  via the opt-in online lookup.
