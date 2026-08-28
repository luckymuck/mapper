/* boundaries.js — admin boundary provider with per-country level fallback.
 * Countries and global states/provinces are bundled offline (data/*.js).
 * US counties are bundled; other countries' counties can be fetched from
 * geoBoundaries at runtime when the user opts in. When a finer level is not
 * available for a country, its features fall back to the next coarser level
 * (county -> state -> country), tracked in the returned `levelUsed` map.
 */
"use strict";

const Boundaries = (() => {
  const cache = new Map(); // "ISO3-ADM2" -> features (success only)
  const fetching = new Set(); // countries with an in-flight online ADM2 fetch
  const lastErrorAt = new Map(); // iso -> ms of the last failed fetch (for retry)
  const fetchedById = new Map(); // id -> feature for online-fetched (geoBoundaries) subdivisions
  // How long to wait after a failed online ADM2 fetch before retrying, so a
  // transient network blip doesn't pin a country to its state fallback.
  const RETRY_MS = 60000;

  function normCountry(f) {
    const p = f.properties || {};
    return { id: p.ISO3 || f.id, name: p.name || "Unknown", ISO3: p.ISO3 || "", continent: p.continent || "", level: "country", geometry: f.geometry };
  }
  function normState(f) {
    const p = f.properties || {};
    return { id: f.id != null ? String(f.id) : (p.ISO3 + "-" + p.name).replace(/\s+/g, "_"), name: p.name, ISO3: p.ISO3 || "", level: "state", geometry: f.geometry };
  }
  function normCounty(f) {
    const p = f.properties || {};
    // geoBoundaries ADM2 ships shapeISO as "" (empty), so fall back to a stable
    // unique id: top-level id (bundled data) or ISO3 + shapeID (online data).
    const sid = p.shapeISO || p.iso3166;
    const id = sid || (f.id != null ? String(f.id) : (p.ISO3 && p.shapeID ? p.ISO3 + "-" + p.shapeID : (p.shapeName || p.name || "")));
    return { id, name: p.shapeName || p.name, ISO3: p.ISO3 || p.shapeISO || p.shapeGroup || "", level: "county", geometry: f.geometry };
  }

  // ---- memoized collections ---------------------------------------------
  let _countries = null, _states = null;
  let _statesByISO = null, _countriesByISO = null, _countryIdx = null, _stateISO3s = null;

  function countries() {
    if (!_countries) {
      if (!window.CountriesGeoJSON) throw new Error("Bundled countries data missing");
      _countries = window.CountriesGeoJSON.features.map(normCountry);
    }
    return _countries;
  }
  function continentOf(iso3) {
    const f = countries().find(x => x.ISO3 === iso3);
    return (f && f.continent) || null;
  }
  function globalStates() {
    if (!_states) {
      _states = window.StatesGeoJSON ? window.StatesGeoJSON.features.map(normState) : [];
    }
    return _states;
  }
  function usCounties() {
    if (!window.USCountiesGeoJSON) return [];
    return window.USCountiesGeoJSON.features.map(normCounty);
  }
  function statesByISO() {
    if (!_statesByISO) {
      _statesByISO = new Map();
      for (const f of globalStates()) {
        if (!_statesByISO.has(f.ISO3)) _statesByISO.set(f.ISO3, []);
        _statesByISO.get(f.ISO3).push(f);
      }
    }
    return _statesByISO;
  }
  function countriesByISO() {
    if (!_countriesByISO) {
      _countriesByISO = new Map();
      for (const f of countries()) {
        if (!_countriesByISO.has(f.ISO3)) _countriesByISO.set(f.ISO3, []);
        _countriesByISO.get(f.ISO3).push(f);
      }
    }
    return _countriesByISO;
  }
  // Rough bbox area used to disambiguate ISO3 codes shared by a country and its
  // tiny territories (e.g. FRA = France + Clipperton).
  function bboxArea(f) {
    const g = f.geometry;
    if (!g) return 0;
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    const walk = (c) => {
      if (typeof c[0] === "number") {
        const [x, y] = c;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      } else for (const cc of c) walk(cc);
    };
    walk(g.coordinates);
    if (minX > maxX) return 0;
    const midLat = ((minY + maxY) / 2) * Math.PI / 180;
    return (maxX - minX) * (maxY - minY) * Math.max(0.1, Math.cos(midLat));
  }
  function countryIndex() {
    if (!_countryIdx) {
      _countryIdx = new Map();
      const groups = new Map();
      for (const f of countries()) {
        if (!groups.has(f.ISO3)) groups.set(f.ISO3, []);
        groups.get(f.ISO3).push(f);
      }
      for (const [iso3, feats] of groups) {
        let best = feats[0];
        for (const f of feats) if (bboxArea(f) > bboxArea(best)) best = f;
        _countryIdx.set(iso3, best.name);
      }
    }
    return _countryIdx;
  }
  function stateISO3s() {
    if (!_stateISO3s) _stateISO3s = new Set(statesByISO().keys());
    return _stateISO3s;
  }
  function countryName(iso3) {
    return countryIndex().get(iso3) || iso3;
  }

  let _adm2ByISO = null;
  function adm2Features() {
    if (!window.ADM2GeoJSON) return [];
    return window.ADM2GeoJSON.features.map(normCounty);
  }
  function adm2ByISO() {
    if (!_adm2ByISO) {
      _adm2ByISO = new Map();
      for (const f of adm2Features()) {
        if (!_adm2ByISO.has(f.ISO3)) _adm2ByISO.set(f.ISO3, []);
        _adm2ByISO.get(f.ISO3).push(f);
      }
    }
    return _adm2ByISO;
  }

  // Best available subdivisions for ONE country (used by edit-mode expansion).
  // county: bundled ADM2 -> cached/fetched online ADM2 -> states. state: states.
  async function getSubdivisions(iso3, level, opts = {}) {
    if (level === "state") return statesByISO().get(iso3) || [];
    if (iso3 === "USA") return usCounties();
    const a = adm2ByISO().get(iso3);
    if (a && a.length) return a;
    // An online ADM2 may already be cached (from a previous fetch or expansion);
    // prefer it over the coarser state fallback.
    const cached = cache.get(iso3 + "-ADM2");
    if (cached) return cached;
    if (opts.online) {
      const sub = await fetchGeoBoundaries(iso3, 2);
      if (sub && sub.length) return sub;
    }
    return statesByISO().get(iso3) || [];
  }

  // Map a region id back to its country ISO3 (used so manual edits persist
  // after edit mode is off). Works for country/state/county/ADM2 ids,
  // including subdivisions fetched from geoBoundaries at runtime.
  function iso3ForId(id) {
    const fetched = fetchedById.get(id);
    if (fetched && fetched.ISO3) return fetched.ISO3;
    for (const f of globalStates()) if (f.id === id) return f.ISO3;
    for (const f of countries()) if (f.id === id) return f.ISO3;
    for (const f of usCounties()) if (f.id === id) return f.ISO3;
    for (const f of adm2Features()) if (f.id === id) return f.ISO3;
    return null;
  }

  // Find the full normalized feature for an id (any level).
  function featureForId(id) {
    const fetched = fetchedById.get(id);
    if (fetched) return fetched;
    for (const f of globalStates()) if (f.id === id) return f;
    for (const f of countries()) if (f.id === id) return f;
    for (const f of usCounties()) if (f.id === id) return f;
    for (const f of adm2Features()) if (f.id === id) return f;
    return null;
  }

  function featureBBox(f) {
    const g = f.geometry;
    if (!g) return null;
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    const walk = c => {
      if (typeof c[0] === "number") {
        const [x, y] = c;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      } else for (const cc of c) walk(cc);
    };
    walk(g.coordinates);
    if (minX > maxX) return null;
    return { minLat: minY, maxLat: maxY, minLng: minX, maxLng: maxX };
  }
  function featureCenter(f) {
    const bb = featureBBox(f);
    return bb ? { lat: (bb.minLat + bb.maxLat) / 2, lng: (bb.minLng + bb.maxLng) / 2 } : null;
  }

  // Map county/ADM2 features to the state (ADM1) they fall inside, so county-level
  // edits can be rolled up to state level. State features map to themselves.
  function parentStateMap(fineFeats, stateFeats) {
    const map = new Map();
    const states = stateFeats.map(f => ({ f, bb: featureBBox(f) }));
    for (const fine of fineFeats) {
      if (fine.level === "state") { map.set(fine.id, fine.id); continue; }
      const c = featureCenter(fine);
      if (!c) continue;
      for (const s of states) {
        if (!s.bb) continue;
        if (c.lat < s.bb.minLat || c.lat > s.bb.maxLat || c.lng < s.bb.minLng || c.lng > s.bb.maxLng) continue;
        const polys = s.f.geometry.type === "Polygon" ? [s.f.geometry.coordinates] : s.f.geometry.coordinates;
        for (const poly of polys) {
          if (Geo.ptInRing(c.lat, c.lng, poly[0])) { map.set(fine.id, s.f.id); break; }
        }
        if (map.has(fine.id)) break;
      }
    }
    return map;
  }

  // Direct fetch first; fall back to a CORS proxy for sources that block browsers.
  // Every attempt is time-boxed so a dead/blocked endpoint can never hang the UI.
  // `urls` may be a single URL or an array of mirrors tried in order.
  const FETCH_TIMEOUT = 6000;
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
  }
  async function fetchText(urls, timeoutMs = FETCH_TIMEOUT) {
    const list = Array.isArray(urls) ? urls : [urls];
    for (const url of list) {
      try {
        const r = await withTimeout(fetch(url), timeoutMs);
        if (r.ok) return await r.text();
      } catch (e) { /* fall through */ }
    }
    for (const url of list) {
      try {
        const r = await withTimeout(fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url)), timeoutMs);
        if (r.ok) return await r.text();
      } catch (e) { /* fall through */ }
    }
    return null;
  }

  // ---------- persistent ADM2 cache (IndexedDB) ----------
  // Successful online downloads are stored so counties load instantly on later
  // visits and work offline after the first fetch. Degrades gracefully to the
  // in-memory cache when storage is unavailable (e.g. blocked on some file://
  // setups), never throwing.
  let idbPromise = null;
  function idbOpen() {
    if (idbPromise !== null) return idbPromise;
    idbPromise = new Promise(resolve => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = window.indexedDB.open("mapper-boundaries", 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("adm2")) db.createObjectStore("adm2");
          // v1 stored ADM2 with null ids (empty shapeISO); clear so they are
          // re-fetched with the fixed ids.
          else if (req.oldVersion < 2) db.transaction("adm2", "readwrite").objectStore("adm2").clear();
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return idbPromise;
  }
  async function idbGet(key) {
    const db = await idbOpen();
    if (!db) return undefined;
    try {
      return await new Promise(resolve => {
        const tx = db.transaction("adm2", "readonly");
        const r = tx.objectStore("adm2").get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      });
    } catch (e) { return undefined; }
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    if (!db) return;
    try {
      const tx = db.transaction("adm2", "readwrite");
      tx.objectStore("adm2").put(val, key);
    } catch (e) { /* best effort */ }
  }

  async function fetchGeoBoundaries(iso3, adm) {
    const key = iso3 + "-ADM" + adm;
    if (cache.has(key)) return cache.get(key);
    try {
      // Serve from the persistent cache before touching the network.
      const persisted = await idbGet(key);
      if (persisted) {
        cache.set(key, persisted);
        persisted.forEach(f => fetchedById.set(f.id, f));
        return persisted;
      }
      const apiText = await fetchText("https://www.geoboundaries.org/api/current/gbOpen/" + iso3 + "/ADM" + adm + "/");
      if (!apiText) throw new Error("api unavailable");
      const list = JSON.parse(apiText);
      const item = Array.isArray(list) ? list[0] : list;
      const githubUrl = item && (item.simplifiedGeometryGeoJSON || item.gjDownloadURL);
      if (!githubUrl) throw new Error("no download link");
      // GitHub raw serves the LFS *pointer*, not the geometry, and is often
      // blocked; media.githubusercontent.com serves the real blob with CORS.
      const mediaUrl = githubUrl
        .replace(/^https:\/\/github\.com\//, "https://media.githubusercontent.com/media/")
        .replace(/\/raw\//, "/");
      const gjText = await fetchText([mediaUrl, githubUrl], 30000);
      if (!gjText) throw new Error("geometry unavailable");
      const gj = JSON.parse(gjText);
      const feats = (gj.features || []).map(f => normCounty(Object.assign({}, f, { properties: Object.assign({}, f.properties, { ISO3: iso3 }) })));
      cache.set(key, feats);
      feats.forEach(f => fetchedById.set(f.id, f));
      idbSet(key, feats);
      return feats;
    } catch (e) {
      // Do NOT cache the failure: record when it happened so getFeatures can
      // retry shortly (see RETRY_MS) instead of pinning the country to its
      // state fallback for the whole session.
      lastErrorAt.set(iso3, Date.now());
      console.warn("Subdivision data unavailable for", key, e.message);
      return null;
    } finally {
      fetching.delete(iso3);
    }
  }

  // Run fn over items with limited concurrency (best-effort, never blocks).
  async function runPool(items, limit, fn, onDone) {
    let i = 0;
    const n = Math.min(limit, items.length);
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (i < items.length) {
          const item = items[i++];
          try { await fn(item); } catch (e) { /* best effort */ }
        }
      })());
    }
    await Promise.all(workers);
    if (onDone) onDone();
  }

  // visitedISO3s: array of ISO3 codes with data. opts.online allows network fetches.
  // Returns { features, note, levelUsed } — levelUsed maps ISO3 -> "county"|"state"|"country".
  // Online ADM2 fetches are NON-BLOCKING: the offline result (bundled ADM2 / states)
  // is returned immediately, and any online lookups run in the background with
  // timeouts, then re-render via opts.onDone(). This keeps the map responsive even
  // when the CORS proxy is slow or down.
  async function getFeatures(level, visitedISO3s, opts = {}) {
    const isos = [...new Set((visitedISO3s || []).filter(Boolean))];
    const note = [];
    if (level === "country") {
      return { features: countries(), note, levelUsed: null };
    }
    const feats = [];
    const levelUsed = new Map();
    const byISO = statesByISO();
    const cByISO = countriesByISO();
    const bgFetch = []; // countries to upgrade to ADM2 in the background

    const addStates = iso => { const a = byISO.get(iso); if (a) feats.push(...a); return a && a.length; };
    const addCountry = iso => { const a = cByISO.get(iso); if (a) feats.push(...a); return a && a.length; };

    for (const iso of isos) {
      let used = null;
      if (level === "state") {
        used = addStates(iso) ? "state" : (addCountry(iso) ? "country" : null);
      } else { // county
        if (iso === "USA") {
          feats.push(...usCounties());
          used = "county";
        } else {
          const adm2 = adm2ByISO().get(iso);
          if (adm2 && adm2.length) {
            feats.push(...adm2);
            used = "county";
          } else if (opts.online) {
            const key = iso + "-ADM2";
            const cached = cache.get(key);
            if (cached) {
              feats.push(...cached);
              used = "county";
            } else {
              // Not fetched (or a previous attempt failed): show the offline
              // fallback now and queue an upgrade. Failed fetches are retried
              // after RETRY_MS so a transient network blip never pins a country
              // to its state fallback for the whole session.
              const lastErr = lastErrorAt.get(iso) || 0;
              if (!fetching.has(iso) && (Date.now() - lastErr) > RETRY_MS) {
                fetching.add(iso);
                bgFetch.push(iso);
              }
              used = addStates(iso) ? "state" : (addCountry(iso) ? "country" : null);
            }
          } else {
            used = addStates(iso) ? "state" : (addCountry(iso) ? "country" : null);
          }
        }
      }
      if (used) levelUsed.set(iso, used);
    }

    // Background upgrade: fetch ADM2 for the visited countries lacking bundled
    // data, then notify. All are queued at once (the pool throttles concurrency)
    // and each completion schedules a refresh, so counties appear progressively
    // instead of waiting for the slowest download (e.g. Brazil's ~40 MB file).
    if (bgFetch.length && opts.online) {
      const MAX_ONLINE = 32;
      const limited = bgFetch.slice(0, MAX_ONLINE);
      if (opts.onStart) opts.onStart(limited.length);
      let bgTimer = null;
      const refreshSoon = () => {
        if (bgTimer) clearTimeout(bgTimer);
        bgTimer = setTimeout(() => { bgTimer = null; if (opts.onDone) opts.onDone(); }, 400);
      };
      runPool(limited, 5,
        iso => fetchGeoBoundaries(iso, 2).catch(() => null).then(refreshSoon),
        () => { if (bgTimer) clearTimeout(bgTimer); if (opts.onDone) opts.onDone(); });
    }

    // Summarize fallbacks.
    const names = (arr) => arr.map(i => countryName(i)).join(", ");
    if (level === "county") {
      const toState = [], toCountry = [];
      levelUsed.forEach((lvl, iso) => {
        if (lvl === "state") toState.push(iso);
        else if (lvl === "country") toCountry.push(iso);
      });
      if (toState.length) note.push(`County detail unavailable for ${names(toState)} — showing states. Enable Online boundary detail to fetch counties.`);
      if (toCountry.length) note.push(`County detail unavailable for ${names(toCountry)} — showing country level.`);
    } else if (level === "state") {
      const toCountry = [];
      levelUsed.forEach((lvl, iso) => { if (lvl === "country") toCountry.push(iso); });
      if (toCountry.length) note.push(`No subdivision data for ${names(toCountry)} — showing country level.`);
    }
    return { features: feats, note, levelUsed };
  }

  return { countries, globalStates, usCounties, adm2ByISO, getFeatures, getSubdivisions, iso3ForId, featureForId, parentStateMap, countryName, continentOf };
})();
