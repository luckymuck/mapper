Mapper — self-contained build.

Unzip anywhere and open index.html in a browser. It runs entirely offline.
An internet connection is only needed for:
  - basemap map tiles (Esri / OpenStreetMap)
  - geocoding place names (OpenStreetMap Nominatim)
  - optional online county boundaries for countries outside the bundled set

Requirements:
  - Any OS that runs a modern browser (Windows, macOS, Linux). No install,
    no server, no accounts, no special permissions — just open index.html.
  - A current evergreen browser: Chrome/Edge/Brave/Opera, Firefox, or Safari
    (about last 5 years). The app uses ES2020 features (optional chaining),
    canvas, IndexedDB, fetch, and file input; no build/transpile step.
  - IndexedDB is used to cache online county boundaries (degrades to memory
    if unavailable, e.g. some Safari file:// setups).
