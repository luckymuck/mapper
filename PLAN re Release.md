# Plan: Vendor + release zip + GitHub Pages deploy

## Deliverable 1 — `tools/make-release.js` (vendor + build release zip)

A single Node script that produces a self-contained, shareable release. It does
**not** modify the dev `index.html` (dev keeps using the CDN); only `release/`
is vendored.

**Step 1 — Vendor CDN libs into `release/lib/`**
Download these (Node `fetch`, with non-trivial-size checks + clear failure if
offline):
- `lib/leaflet.js`, `lib/leaflet.css` — `unpkg.com/leaflet@1.9.4/dist/…`
- `lib/images/*` — `layers.png`, `layers-2x.png`, `marker-icon.png`,
  `marker-icon-2x.png`, `marker-shadow.png` (so `leaflet.css`'s relative
  `images/` URLs resolve)
- `lib/jszip.min.js` — `unpkg.com/jszip@3.10.1/dist/jszip.min.js`
- `lib/exifr.full.umd.js` — `unpkg.com/exifr@7.1.3/dist/full.umd.js`
- `lib/rbush.min.js` — `unpkg.com/rbush@3.0.1/rbush.min.js`

Flags: `--skip-download` (reuse existing `release/lib/` if network is
unavailable), `--no-zip`.

**Step 2 — Build `release/`**
- Copy `release/index.html` = main `index.html` with these rewrites:
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` → `lib/leaflet.css`
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` → `lib/leaflet.js`
  - `https://unpkg.com/jszip@3.10.1/dist/jszip.min.js` → `lib/jszip.min.js`
  - `https://unpkg.com/exifr@7.1.3/dist/full.umd.js` → `lib/exifr.full.umd.js`
  - `https://unpkg.com/rbush@3.0.1/rbush.min.js` → `lib/rbush.min.js`
- Copy `css/`, `js/`, `data/` (the ~17 MB boundary data) into `release/`.
- Write `release/README.txt`: "Unzip, open `index.html`. Internet needed only
  for basemap tiles, geocoding, and optional online county boundaries."
- **Assertions:** every `lib/*` exists and is non-trivial; `release/index.html`
  contains **no** `unpkg.com` references; required files present.

**Step 3 — Zip**
- Zip `release/` → `mapper-release.zip` in the app root using **JSZip**
  (already present at `tools/e2e/node_modules/jszip` — pure Node, no new deps;
  ~17 MB → ~5–8 MB compressed).

Result: `mapper-release.zip` = fully self-contained app (loads with zero
internet; only tiles/geocoding/online-boundaries need a connection).

## Deliverable 2 — Deploy to GitHub Pages

Prereqs: GitHub account, `git`, `gh` CLI (or browser). Public repo required for
free Pages.

1. **Create public repo:** `gh repo create mapper --public` (or via GitHub web
   UI).
2. **Build the release:** `node tools/make-release.js`.
3. **Put release on a `gh-pages` orphan branch** (keeps the site separate from
   dev files):
   ```
   git init
   git checkout --orphan gh-pages
   # copy release/* into the branch root
   git add . && git commit -m "release"
   git remote add origin https://github.com/<user>/mapper.git
   git push -u origin gh-pages
   ```
4. **Enable Pages** on `gh-pages` / root:
   - `gh api repos/<user>/mapper/pages -X POST -f source[branch]=gh-pages -f source[path]=/`
   - (or Settings → Pages → Deploy from branch → `gh-pages` / root)
5. **URL:** `https://<user>.github.io/mapper/`
6. **Updates:** re-run `make-release.js`, replace branch content, commit, push.

**Optional helper:** `tools/deploy-pages.ps1` that automates steps 2–3 (run
script, refresh `gh-pages` branch with `release/` contents, push). Confirm if
this is wanted.

**GitHub Pages gotchas:** free tier = public repo; the app already works over
`https://` (static site, tiles/geocoding fine); repo ~17 MB is well under the
1 GB cap; first deploy takes ~1 minute.

## Verification
- Open `release/index.html` locally and confirm it loads with no `unpkg.com`
  network requests (headless check via the existing Playwright setup).
- Confirm the dev app + e2e are unaffected (dev `index.html` stays on CDN).
- After deploy: load the GitHub Pages URL and confirm tiles/regions/trail
  render.

## Open decisions
1. **Release-only vendoring** (dev stays on CDN — recommended, low risk) vs
   **vendoring in place** (rewrite the main `index.html` so the dev folder is
   also self-contained). Which is preferred?
2. Want the `tools/deploy-pages.ps1` helper, or manual git steps only?