/* tools/make-release.js — build a self-contained release zip.
 *
 * The dev folder is already fully vendored in place (index.html references
 * lib/leaflet.js etc., and lib/ holds every dependency). So the release is
 * built by copying the vendored app into release/ and zipping it — no CDN
 * needed (unpkg is unreachable on some networks, which is exactly why the app
 * was vendored).
 *
 * Run:  node tools/make-release.js [--skip-download] [--no-zip]
 *
 *   --skip-download  reuse an existing release/lib/ instead of re-vendoring
 *   --no-zip         build release/ but skip writing mapper-release.zip
 *
 * Produces:
 *   release/index.html   (index.html with any CDN refs rewritten to lib/)
 *   release/lib/**        vendored libraries (copied from the root lib/)
 *   release/css, js, data
 *   release/README.txt
 *   mapper-release.zip    (release/ compressed via JSZip)
 *
 * Only basemap tiles, geocoding, and optional online county boundaries need a
 * network connection; everything else loads from disk.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");

const REQUIREMENTS = [
  { file: "lib/leaflet.js", minBytes: 100000 },      // ~147 KB
  { file: "lib/leaflet.css", minBytes: 1000 },
  { file: "lib/jszip.min.js", minBytes: 60000 },
  { file: "lib/exifr.full.umd.js", minBytes: 60000 },
  { file: "lib/rbush.min.js", minBytes: 1000 },
];
const IMAGES = ["layers.png", "layers-2x.png", "marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"];

// CDN -> local rewrites (no-ops for the vendored index.html, kept so the script
// still works if the dev html were ever pointed back at a CDN).
const REWRITES = [
  ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "lib/leaflet.css"],
  ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "lib/leaflet.js"],
  ["https://unpkg.com/jszip@3.10.1/dist/jszip.min.js", "lib/jszip.min.js"],
  ["https://unpkg.com/exifr@7.1.3/dist/full.umd.js", "lib/exifr.full.umd.js"],
  ["https://unpkg.com/rbush@3.0.1/rbush.min.js", "lib/rbush.min.js"],
];

function main() {
  const args = process.argv.slice(2);
  const skipDownload = args.includes("--skip-download");
  const noZip = args.includes("--no-zip");

  fs.mkdirSync(RELEASE, { recursive: true });

  // ---- Step 1: vendor libs ----
  const releaseLib = path.join(RELEASE, "lib");
  if (skipDownload && fs.existsSync(releaseLib)) {
    console.log("--skip-download: reusing existing release/lib/");
  } else {
    const rootLib = path.join(ROOT, "lib");
    if (fs.existsSync(path.join(rootLib, "leaflet.js"))) {
      console.log("Copying vendored root lib/ -> release/lib/");
      fs.rmSync(releaseLib, { recursive: true, force: true });
      fs.cpSync(rootLib, releaseLib, { recursive: true });
    } else {
      console.error("Root lib/ is missing its vendored libraries (needed because unpkg is blocked).");
      process.exit(1);
    }
  }
  // Ensure the leaflet images referenced by leaflet.css are present.
  fs.mkdirSync(path.join(releaseLib, "images"), { recursive: true });
  for (const img of IMAGES) {
    const src = path.join(releaseLib, "images", img);
    if (!fs.existsSync(src)) throw new Error("missing lib/images/" + img);
  }

  // ---- Step 2: build release/ ----
  // index.html with CDN references rewritten (already local, so usually a no-op).
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  let outHtml = html;
  for (const [from, to] of REWRITES) outHtml = outHtml.split(from).join(to);
  fs.writeFileSync(path.join(RELEASE, "index.html"), outHtml);

  for (const dir of ["css", "js", "data"]) {
    const from = path.join(ROOT, dir), to = path.join(RELEASE, dir);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }

fs.writeFileSync(path.join(RELEASE, "README.txt"),
  "Mapper — self-contained build.\n\n" +
  "Unzip anywhere and open index.html in a browser. It runs entirely offline.\n" +
  "An internet connection is only needed for:\n" +
  "  - basemap map tiles (Esri / OpenStreetMap)\n" +
  "  - geocoding place names (OpenStreetMap Nominatim)\n" +
  "  - optional online county boundaries for countries outside the bundled set\n\n" +
  "Requirements:\n" +
  "  - Any OS that runs a modern browser (Windows, macOS, Linux). No install,\n" +
  "    no server, no accounts, no special permissions — just open index.html.\n" +
  "  - A current evergreen browser: Chrome/Edge/Brave/Opera, Firefox, or Safari\n" +
  "    (about last 5 years). The app uses ES2020 features (optional chaining),\n" +
  "    canvas, IndexedDB, fetch, and file input; no build/transpile step.\n" +
  "  - IndexedDB is used to cache online county boundaries (degrades to memory\n" +
  "    if unavailable, e.g. some Safari file:// setups).\n");

  // ---- Assertions ----
  const errors = [];
  for (const { file, minBytes } of REQUIREMENTS) {
    const p = path.join(RELEASE, file);
    if (!fs.existsSync(p)) { errors.push("missing " + file); continue; }
    const size = fs.statSync(p).size;
    if (size < minBytes) errors.push(file + " too small (" + size + " bytes)");
  }
  const relHtml = fs.readFileSync(path.join(RELEASE, "index.html"), "utf8");
  if (/unpkg\.com/.test(relHtml)) errors.push("release/index.html still references unpkg.com");
  for (const f of ["index.html", "css/style.css", "js/main.js", "data/countries.js", "lib/leaflet.js"]) {
    if (!fs.existsSync(path.join(RELEASE, f))) errors.push("missing " + f);
  }
  if (errors.length) {
    console.error("Release assertions failed:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("release/ built OK (no unpkg references, all libs present).");

  // ---- Step 3: zip ----
  if (noZip) { console.log("--no-zip: skipping zip."); return; }
  const JSZip = require(path.join(ROOT, "tools", "e2e", "node_modules", "jszip"));
  const zip = new JSZip();
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else zip.file(rel.replace(/\\/g, "/"), fs.readFileSync(full));
    }
  };
  walk(RELEASE, "");

  const out = path.join(ROOT, "mapper-release.zip");
  zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } })
    .then(buf => { fs.writeFileSync(out, buf); console.log("Wrote", out, "(" + (buf.length / 1024 / 1024).toFixed(2) + " MB)"); })
    .catch(e => { console.error("zip failed:", e); process.exit(1); });
}

main();
