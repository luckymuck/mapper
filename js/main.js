/* main.js — application orchestration. */
"use strict";

const App = (() => {
  const DAY = 86400000;
  // Below this many points we classify every point exactly; above it we use
  // fast grid-cell representatives so large histories don't stall the UI.
  const MAX_EXACT = 25000;
  const state = {
    rawPoints: [],
    rawVisits: [],
    points: [],
    visits: [],
    countryStats: null,
    hasFitted: false,
    currentRegions: null,
    lastOutline: null,
    regionSummaries: [],
    autoStats: null,
    visitedIds: new Set(),
    manual: { overrides: new Map() },
    // caches (recomputed only when their inputs change)
    dataKey: null,
    sorted: null,
    domain: null,
    classKey: null,
    features: null,
    baseStats: null,
    statsFeats: null,
    levelNote: [],
    maskKey: null,
    maskCache: null,
    heatKey: null,
    heatCache: null,
    trailKey: null,
    trailSampled: [],
    trailBuiltKey: null,
    tripGroups: [],
    regionLayer: null,
    regionLayers: new Map(),
    regionProps: new Map(),
    regionKey: null,
    regionMetric: null,
    visitsKey: null,
    lastDomainKey: null,
    expanded: new Set(),
    lastDomain: null,
    lastNote: "",
    currentStats: null,
    currentRegionId: null,
    selectedIds: new Set(),
    selectedPoint: null,
    regionPoints: [],
    drawTrip: null,
    editMode: false,
    lastEdit: false,
    lastDrawTrip: false,
    undoStack: [],
    redoStack: [],
    dayKeys: [],
    dayKeysKey: null,
    places: [],
    placesKey: null,
    statsCache: null,
    statsKey: null,
    debug: { classify: 0, mask: 0, heat: 0 },
  };
  let renderTimer = null;

  // ---------- config ----------
  function readConfig() {
    const num = id => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? 0 : v; };
    // Date browser mode controls the effective date filter.
    const dbMode = (document.querySelector('input[name="db-mode"]:checked') || {}).value || "range";
    let from = 0, to = 0;
    if (dbMode === "day") {
      const day = document.getElementById("f-day").value;
      if (day) { from = new Date(day + "T00:00:00").getTime(); to = new Date(day + "T23:59:59").getTime(); }
    } else if (dbMode === "year") {
      const y = parseInt(document.getElementById("f-year").value, 10);
      if (y) { from = Date.UTC(y, 0, 1); to = Date.UTC(y, 11, 31, 23, 59, 59); }
    } else {
      const fr = document.getElementById("f-from").value;
      const t = document.getElementById("f-to").value;
      if (fr) from = new Date(fr + "T00:00:00").getTime();
      if (t) to = new Date(t + "T23:59:59").getTime();
    }
    return {
      level: document.getElementById("c-level").value,
      metric: document.getElementById("c-metric").value,
      singleColor: document.getElementById("c-single-color").value,
      res: Math.max(1, num("c-res")),
      accuracy: Math.max(0, num("f-accuracy")),
      trailMax: Math.max(1, num("c-trail-max")) || 50000,
      from, to,
      layers: {
        regions: document.getElementById("l-regions").checked,
        heat: document.getElementById("l-heat").checked,
        trail: document.getElementById("l-trail").checked,
        visits: document.getElementById("l-visits").checked,
        places: document.getElementById("l-places").checked,
      },
      online: document.getElementById("c-online").checked,
      outlines: document.getElementById("l-outlines").checked,
      edit: state.editMode,
    };
  }

  // ---------- data loading ----------
  async function loadData(points, visits, opts = {}) {
    if (opts.append) {
      state.rawPoints = Model.dedupe([...state.rawPoints, ...points]);
      state.rawVisits = Model.dedupe([...state.rawVisits, ...visits]);
    } else {
      state.rawPoints = points;
      state.rawVisits = visits;
    }
    if (opts.fit !== false) state.hasFitted = false;
    await render();
  }

  function clearData() {
    pushUndo();
    state.rawPoints = []; state.rawVisits = []; state.points = []; state.visits = [];
    state.countryStats = null; state.currentRegions = null; state.lastOutline = null;
    state.regionSummaries = []; state.autoStats = null; state.visitedIds = new Set();
    state.manual.overrides.clear();
    state.dataKey = null; state.sorted = null; state.classKey = null; state.features = null;
    state.baseStats = null; state.statsFeats = null; state.maskKey = null; state.maskCache = null;
    state.heatKey = null; state.heatCache = null; state.trailKey = null; state.trailSampled = [];
    state.trailBuiltKey = null; state.tripGroups = [];
    state.regionLayer = null; state.regionLayers = new Map(); state.regionProps = new Map();
    state.regionKey = null; state.visitsKey = null; state.lastDomainKey = null;
    state.expanded = new Set();
    state.currentStats = null; state.currentRegionId = null; state.selectedIds.clear();
    state.selectedPoint = null; state.regionPoints = [];
    state.dayKeys = []; state.dayKeysKey = null; state.places = []; state.placesKey = null;
    state.statsCache = null; state.statsKey = null;
    if (state.drawTrip) stopDrawTrip(false);
    state.hasFitted = false;
    UI.clear();
    updatePointPanel();
    updateClearLogVisibility();
    for (const k of ["regions", "heat", "trail", "visits", "places"]) UI.showGroup(k, true);
    document.getElementById("summary").classList.add("hidden");
    document.getElementById("legend").classList.add("hidden");
    setStatus("Cleared. Drop files to begin.", false);
    render(); // rebuild region outlines when edit mode is on (no data)
  }

  // In edit mode the user can add a region in any country; countries are
  // expanded lazily (see expandCountry) so their subdivisions load only when
  // needed.

  // ---------- main render pipeline (cached stages) ----------
  // render() serializes calls (no overlapping async runs) and always clears the
  // busy overlay, even on error.
  let rendering = false, renderQueued = false;
  async function render() {
    if (rendering) { renderQueued = true; return; }
    rendering = true;
    try {
      await renderInner();
    } catch (e) {
      console.error(e);
      setStatus("Error: " + e.message, true);
    } finally {
      rendering = false;
      if (renderQueued) { renderQueued = false; setTimeout(render, 0); }
      UI.setBusy(null);
    }
  }
  async function renderInner() {
    const hasManual = state.manual.overrides.size > 0;
    // Allow edit mode to render region outlines even with no data, so the user
    // can click a country to load its subdivisions and add regions manually.
    if (!state.rawPoints.length && !state.rawVisits.length && !hasManual && !state.editMode) return;
    const cfg = readConfig();

    // Stage 1: filtered + sorted points (cheap unless data/filters change).
    const dataKey = `${state.rawPoints.length}|${state.rawVisits.length}|${cfg.accuracy}|${cfg.from}|${cfg.to}`;
    if (dataKey !== state.dataKey) {
      UI.setBusy("Preparing points…");
      let points = Model.filterPoints(state.rawPoints, { maxAccuracy: cfg.accuracy, from: cfg.from, to: cfg.to });
      let visits = state.rawVisits.filter(v => (v.end || v.start) >= cfg.from && (v.start || v.end) <= (cfg.to || Infinity));
      state.points = points;
      state.visits = visits;
      state.sorted = points.length ? Model.sortPoints(points) : [];
      state.dataKey = dataKey;
      state.classKey = null; state.maskKey = null; state.heatKey = null; state.trailKey = null;
      state.domain = null; state.visitsKey = null; state.expanded = new Set(); state.lastNote = "";
    }
    // Day-with-data index for the Date browser. Built from ALL raw data (not the
// filtered set) so the year list never collapses as the date filter changes.
    const rawKey = `${state.rawPoints.length}|${state.rawVisits.length}`;
    if (state.dayKeysKey !== rawKey) {
      state.dayKeysKey = rawKey;
      const keys = new Set();
      for (const p of state.rawPoints) keys.add(Model.fmtDate(p.ts));
      for (const v of state.rawVisits) { keys.add(Model.fmtDate(v.start)); keys.add(Model.fmtDate(v.end)); }
      state.dayKeys = [...keys].sort();
      const dayEl = document.getElementById("f-day");
      if (dayEl && !dayEl.value && state.dayKeys.length) dayEl.value = state.dayKeys[state.dayKeys.length - 1];
      populateYears();
    }
    const sorted = state.sorted;
    const noPoints = sorted.length === 0;
    if (noPoints && !hasManual && !state.editMode) {
      UI.clear();
      setStatus("No points match the current filters.", true);
      UI.setBusy(null);
      return;
    }

    let minTs = Infinity, maxTs = -Infinity;
    if (!noPoints) {
      minTs = sorted[0].ts; maxTs = sorted[sorted.length - 1].ts;
    } else {
      state.manual.overrides.forEach(o => {
        if (o.first && o.first < minTs) minTs = o.first;
        if (o.last && o.last > maxTs) maxTs = o.last;
      });
      if (!isFinite(minTs)) minTs = Date.now();
      if (!isFinite(maxTs)) maxTs = Date.now();
    }
    state.domain = { minTs, maxTs };

    // Stage 2: classification (cached). Edit mode shows all countries plus the
    // subdivisions of expanded countries; unexpanded countries are loaded on
    // demand when clicked (see expandCountry).
    const manualISO3s = () => {
      const s = new Set();
      state.manual.overrides.forEach((v, id) => {
        const iso = Boundaries.iso3ForId(id);
        if (iso) s.add(iso);
      });
      return s;
    };
    const expandedSig = [...state.expanded].sort().join(",");
    const classKey = `${cfg.level}|${cfg.online}|${cfg.edit}|${expandedSig}|${dataKey}`;
    if (classKey !== state.classKey) {
      const countryFeats = Boundaries.countries();
      let cStats = new Map();
      if (!noPoints) {
        UI.setBusy("Classifying countries…");
        cStats = await Geo.classifyPoints(sorted, countryFeats, Geo.makeIndex(countryFeats), {
          maxExact: MAX_EXACT,
          onProgress: frac => UI.setBusy("Classifying countries… " + Math.round(frac * 100) + "%"),
        });
      }
      state.countryStats = cStats;
      // Countries in the data + any countries the user has manually added a
      // region to (so those edits stay visible after edit mode is turned off).
      const visitedISO3 = [...new Set([...cStats.keys(), ...manualISO3s()])];
      for (const i of visitedISO3) state.expanded.add(i);

      let feats, baseStats;
      if (cfg.level === "country") {
        feats = countryFeats;
        baseStats = cStats;
        // Roll finer-level manual edits up to country level (county→country and
        // state→country): a country is visited iff any of its states/counties is
        // in the finer-level in-set after edits. Countries without subdivision
        // data (microstates) fall back to their own auto stats.
        if (state.manual.overrides.size && visitedISO3.length) {
          UI.setBusy("Rolling up edits…");
          const stateRes = await Boundaries.getFeatures("state", visitedISO3, {});
          const stateFeats = stateRes.features;
          const stateFinal = Export.applyManualOverrides(await computeStateFinal(sorted, stateFeats), state.manual.overrides, Date.now());
          baseStats = rollStatesToCountries(stateFinal, cStats, visitedISO3, stateFeats);
        }
        state.levelNote = [];
      } else {
        UI.setBusy("Loading boundaries…");
        await new Promise(r => setTimeout(r, 0));
        const res = await Boundaries.getFeatures(cfg.level, visitedISO3, {
          online: cfg.online,
          onStart: n => setStatus(`Fetching online county boundaries for ${n} countr${n === 1 ? "y" : "ies"} in the background…`, false),
          onDone: () => {
            // Background ADM2 upgrades land in the cache after this branch ran;
            // invalidate so the next render reloads features from the cache.
            state.classKey = null;
            clearTimeout(renderTimer); renderTimer = setTimeout(render, 300);
          },
        });
        state.statsFeats = res.features;
        state.levelNote = res.note;
        feats = res.features.slice();
        if (cfg.edit) {
          // All countries become clickable; already-expanded countries have
          // their subdivisions included.
          feats = countryFeats.concat(feats);
          const extra = [...state.expanded].filter(i => !visitedISO3.includes(i));
          for (const iso of extra) {
            // Best available subdivisions for the expanded country — bundled
            // ADM2, else a previously fetched online ADM2, else its states.
            const sub = await Boundaries.getSubdivisions(iso, cfg.level, { online: cfg.online });
            if (sub && sub.length) feats.push(...sub);
          }
        }
        if (noPoints) {
          baseStats = new Map();
        } else if (cfg.level === "state") {
          // State auto stats + county-level edits rolled up (e.g. removing every
          // Illinois county un-highlights Illinois; adding an Iowa county
          // highlights Iowa).
          UI.setBusy("Classifying states…");
          baseStats = await computeStateFinal(sorted, state.statsFeats);
        } else {
          // County view: shade each visited country at its finest available
          // level. getFeatures already falls back county -> state -> country
          // per country, so classifying all of statsFeats shades counties where
          // they exist, otherwise the state fallback, otherwise the country
          // polygon (microstates). Edit mode does not change this — the same
          // stats shade the regions whether or not edit mode is on.
          UI.setBusy("Classifying regions…");
          const regionFeats = state.statsFeats;
          baseStats = await Geo.classifyPoints(sorted, regionFeats, Geo.makeIndex(regionFeats), {
            maxExact: MAX_EXACT,
            onProgress: frac => UI.setBusy("Classifying regions… " + Math.round(frac * 100) + "%"),
          });
        }
      }
      state.features = feats;
      state.baseStats = baseStats;
      state.classKey = classKey;
      state.heatKey = null;
      state.regionKey = null;
      state.debug.classify++;
      // The region set changed (level/edit/data): reset any region/point
      // selection and its markers so nothing stale lingers. A selection is
      // kept only when its region still exists in the new set (background
      // ADM2 upgrades re-render without the user changing level/edit/data,
      // and should not clear an in-progress edit selection).
      const keepSel = state.currentRegionId && state.features.some(f => f.id === state.currentRegionId);
      if (!keepSel) state.currentRegionId = null;
      // Preserve the selected point across a background re-render (e.g. an
      // online ADM2 upgrade) so an in-progress point edit isn't lost.
      const keepPt = keepSel && state.selectedPoint;
      state.selectedPoint = null;
      state.regionPoints = [];
      UI.setPointMarkers([]);
      updateEditPanel();
      updatePointPanel();
      if (keepSel) {
        showRegionPoints(state.currentRegionId);
        if (keepPt) selectPoint(keepPt);
      }
    }
    const feats = state.features;
    const baseStats = state.baseStats;

    // Manual overrides + display domain.
    const stats = Export.applyManualOverrides(baseStats, state.manual.overrides, Date.now());
    state.currentStats = stats;
    state.visitedIds = new Set(stats.keys());
    let maxCount = 1, maxDwell = 1;
    stats.forEach(s => { if (s.count > maxCount) maxCount = s.count; if (s.dwell > maxDwell) maxDwell = s.dwell; });
    const domain = { minTs, maxTs, maxCount, maxDwell };
    const domainKey = `${maxCount}|${maxDwell}`;
    state.lastDomainKey = domainKey;
    state.lastDomain = domain;

    // Stage 3: mask (needed by heat canvas). Cached by res/data.
    const maskKey = `${cfg.res}|${dataKey}`;
    if (maskKey !== state.maskKey) {
      state.maskCache = null;
      if (!noPoints) {
        UI.setBusy("Computing heatmap…");
        await new Promise(r => setTimeout(r, 0));
        state.maskCache = { mask: Geo.reachMask(sorted, 50, cfg.res) };
        state.debug.mask++;
      }
      state.maskKey = maskKey;
      state.heatKey = null;
    }

    // Stage 4: heat canvas (cached by mask + metric + domain).
    const heatKey = `${maskKey}|${cfg.metric}|${domainKey}`;
    let heat = null;
    if (cfg.layers.heat && state.maskCache) {
      if (heatKey !== state.heatKey) {
        UI.setBusy("Rendering heat grid…");
        heat = Geo.heatCanvas(state.maskCache.mask, cfg.metric, domain);
        state.heatCache = heat;
        state.heatKey = heatKey;
        state.debug.heat++;
      } else {
        heat = state.heatCache;
      }
    }

    // Stage 5: trail sample + trip groups (cached by data). Trip/draw points are
    // drawn as their own polylines (see state.tripGroups) rather than merged
    // into the downsampled trail, so they can never be dropped by sampling or
    // interleaved away when more data is appended.
    if (state.trailKey !== dataKey) {
      const isTrip = p => (p.src || "").startsWith("trip:") || (p.src || "").startsWith("draw:");
      const base = sorted.filter(p => !isTrip(p));
      // Sample to the configurable cap, then simplify (Douglas-Peucker) so the
      // budget is spent on path shape rather than collinear points.
      let sample = Model.sample(base, cfg.trailMax).slice();
      sample = Geo.simplifyLine(sample, 0.0003); // ~33 m perpendicular tolerance
      // Keep manually-added single points visible in the trail.
      for (const p of sorted) {
        if ((p.src || "").startsWith("manual:") && !sample.includes(p)) sample.push(p);
      }
      sample.sort((a, b) => a.ts - b.ts);
      state.trailSampled = sample;
      state.tripGroups = groupTrips(sorted);
      state.trailKey = dataKey;
    }

    // ---- Display (cheap; rebuilds only when the region set changes) ----
    const includeAll = cfg.outlines || cfg.edit;
    // Non-edit mode renders every feature of VISITED countries (filled where a
    // stat exists, outlines otherwise) — see computeAllowedISOs.
    const allowedISOs = cfg.edit ? null : computeAllowedISOs(feats, stats);
    const gj = buildRegionGeoJSON(feats, stats, includeAll, allowedISOs);
    state.currentRegions = gj;
    state.regionSummaries = regionSummaries(feats, stats);

    const regionKey = `${cfg.level}|${cfg.online}|${cfg.outlines}|${cfg.edit}|${cfg.layers.regions}|${dataKey}|${state.classKey}|${!!state.drawTrip}`;
    if (regionKey !== state.regionKey) {
      if (cfg.layers.regions) {
        state.regionLayers = new Map();
        state.regionProps = new Map(gj.features.map(f => [f.properties.id, f.properties]));
        state.regionLayer = UI.renderRegions(gj, f => regionStyle(f, cfg.metric, domain, cfg.edit, cfg.singleColor), {
          edit: cfg.edit,
          drawTrip: !!state.drawTrip,
          onToggle: toggleManual,
          onSelect: selectRegion,
          onLayer: (id, layer) => state.regionLayers.set(id, layer),
        });
        state.regionMetric = cfg.metric;
      } else {
        state.regionLayer = null;
      }
      state.regionKey = regionKey;
    } else if (state.regionLayer && (cfg.metric !== state.regionMetric || cfg.edit !== state.lastEdit || !!state.drawTrip !== state.lastDrawTrip || (cfg.metric === "single" && cfg.singleColor !== state.lastSingleColor))) {
      state.regionLayer.setStyle(f => regionStyle(f, cfg.metric, domain, cfg.edit, cfg.singleColor));
      state.regionMetric = cfg.metric;
      state.lastEdit = cfg.edit;
      state.lastDrawTrip = !!state.drawTrip;
      state.lastSingleColor = cfg.singleColor;
    }
    UI.showGroup("regions", cfg.layers.regions && !!state.regionLayer);

    UI.setHeat(heat);
    UI.showGroup("heat", cfg.layers.heat && !!heat);

    if (cfg.layers.trail) {
      const rebuildTrail = state.trailBuiltKey !== state.trailKey;
      if (state.trailSampled.length >= 2) UI.setTrail(state.trailSampled, cfg.metric, domain, rebuildTrail, cfg.singleColor);
      UI.setTrips(state.tripGroups, cfg.metric, domain, rebuildTrail, cfg.singleColor);
      state.trailBuiltKey = state.trailKey;
    }
    UI.showGroup("trail", cfg.layers.trail);
    UI.showGroup("trips", cfg.layers.trail);

    if (cfg.layers.visits && state.visits.length) {
      const vk = `${dataKey}|${cfg.metric}`;
      if (vk !== state.visitsKey) {
        UI.renderVisits(state.visits, cfg.metric, domain, cfg.singleColor);
        state.visitsKey = vk;
      }
    }
    UI.showGroup("visits", cfg.layers.visits);

    // All-places layer (cached by data).
    if (cfg.layers.places) {
      if (state.placesKey !== dataKey || (state.places.length === 0 && state.sorted.length)) {
        state.places = buildPlaces(state.sorted, state.visits);
        state.placesKey = dataKey;
      }
      UI.setPlaces(state.places);
    } else {
      UI.setPlaces(null);
    }
    UI.showGroup("places", cfg.layers.places);

    // Date browser stats (distance + distance-by-mode) for the current selection.
    const dbStats = document.getElementById("db-stats");
    if (dbStats) {
      if (state.points.length) {
        if (state.statsKey !== dataKey) { state.statsKey = dataKey; state.statsCache = computeTrailStats(state.points); }
        const st = state.statsCache;
        const modeLines = Object.keys(st.byMode).sort().map(m =>
          `<span class="db-mode">${UI.escapeHtml(modeName(m))}: ${(st.byMode[m]).toFixed(1)} km</span>`).join(" · ");
        dbStats.innerHTML = `<span class="db-total">Distance: ${st.total.toFixed(1)} km</span>` + (modeLines ? `<br>${modeLines}` : "");
        dbStats.classList.remove("hidden");
      } else {
        dbStats.classList.add("hidden");
      }
    }

    UI.updateLegend(cfg.metric, domain, cfg.singleColor);
    updateSummary(state.points, state.visits);

    if (!state.hasFitted) {
      if (!noPoints) {
        const continent = mostPointsContinent();
        if (continent) UI.centerOnContinent(continent, sorted);
        else UI.fitBounds(sorted);
      } else if (state.currentRegions.features.length) {
        UI.fitGeojson(state.currentRegions);
      }
      state.hasFitted = true;
    }
    // Only surface the level-note when it actually changes, so user-action status
    // messages (e.g. "Loaded 15 subdivisions for Chile") aren't clobbered by a
    // re-render of the same note.
    const noteTxt = state.levelNote.join(" ");
    if (noteTxt && noteTxt !== state.lastNote) {
      state.lastNote = noteTxt;
      setStatus(noteTxt, false);
    } else if (!noteTxt) {
      state.lastNote = "";
    }
    UI.setBusy(null);
  }

  // Group trip/draw points (time-ordered input) into separate trip lines.
  // A new group starts whenever the source changes or the time gap between
  // consecutive trip points exceeds TRIP_GAP_MS (distinct trips / sessions).
  const TRIP_GAP_MS = 30 * 86400000;
  function groupTrips(sorted) {
    const groups = [];
    let cur = null, curSrc = null, prevTs = null;
    for (const p of sorted) {
      const src = p.src || "";
      const isTrip = src.startsWith("trip:") || src.startsWith("draw:");
      if (!isTrip) continue;
      const newGroup = !cur || src !== curSrc || (prevTs != null && p.ts - prevTs > TRIP_GAP_MS);
      if (newGroup) { cur = [p]; groups.push(cur); curSrc = src; }
      else cur.push(p);
      prevTs = p.ts;
    }
    return groups.filter(g => g.length >= 2);
  }

  // Countries to render in non-edit mode: those with a visible stat at this
  // level, plus auto-visited countries (so a visited country without county
  // data still shows its outlines) unless explicitly removed, plus manually
  // added countries.
  function computeAllowedISOs(feats, stats) {
    const s = new Set();
    feats.forEach(f => { if (stats.has(f.id)) s.add(f.ISO3); });
    if (state.countryStats) {
      for (const iso of state.countryStats.keys()) {
        const o = state.manual.overrides.get(iso);
        if (o && o.status === "remove") continue;
        s.add(iso);
      }
    }
    state.manual.overrides.forEach((v, id) => {
      if (v.status === "remove") return;
      const iso = Boundaries.iso3ForId(id);
      if (iso) s.add(iso);
    });
    return s;
  }

  function buildRegionGeoJSON(feats, stats, includeAll, allowedISOs) {
    const features = [];
    for (const f of feats) {
      if (includeAll && allowedISOs && !allowedISOs.has(f.ISO3)) continue;
      const s = stats.get(f.id);
      if (!s && !includeAll) continue;
      features.push({
        type: "Feature",
        properties: { id: f.id, name: f.name, level: f.level, country: Boundaries.countryName(f.ISO3), _stat: s || null },
        geometry: f.geometry,
      });
    }
    return { type: "FeatureCollection", features };
  }

  function regionSummaries(feats, stats) {
    const arr = [];
    for (const f of feats) {
      const s = stats.get(f.id);
      if (!s) continue;
      arr.push({ id: f.id, name: f.name, level: f.level, country: Boundaries.countryName(f.ISO3), count: s.count, first: s.first, last: s.last, dwell: s.dwell });
    }
    return arr;
  }

  // The continent where the user has the most points (from per-country stats).
  function mostPointsContinent() {
    const counts = new Map();
    state.countryStats.forEach((st, iso) => {
      const c = Boundaries.continentOf(iso);
      if (c) counts.set(c, (counts.get(c) || 0) + st.count);
    });
    let best = null, bestN = -1;
    counts.forEach((n, c) => { if (n > bestN) { bestN = n; best = c; } });
    return best;
  }

  // ---------- Date browser: distance stats + year index ----------
  const MODE_NAMES = {
    WALKING: "Walk", RUNNING: "Run", CYCLING: "Cycle", IN_PASSENGER_VEHICLE: "Drive",
    IN_VEHICLE: "Drive", MOTORCYCLING: "Motorcycle", IN_BUS: "Bus", IN_SUBWAY: "Subway",
    IN_TRAIN: "Train", IN_TRAM: "Tram", IN_FERRY: "Ferry", FLYING: "Flight",
    SKIING: "Ski", SAILING: "Sail", UNKNOWN_ACTIVITY_TYPE: "Move",
  };
  function modeName(m) { return MODE_NAMES[m] || (m ? m.replace(/_/g, " ").toLowerCase() : "Unknown"); }

  // Distance (km) and distance-by-mode for a set of points. Each segment is
  // attributed to the mode of its start point.
  function computeTrailStats(points) {
    const sorted = Model.sortPoints(points);
    const byMode = {};
    let total = 0;
    for (let i = 1; i < sorted.length; i++) {
      const d = Geo.haversineKm(sorted[i - 1].lat, sorted[i - 1].lng, sorted[i].lat, sorted[i].lng);
      const m = sorted[i - 1].mode || "unknown";
      byMode[m] = (byMode[m] || 0) + d;
      total += d;
    }
    return { total, byMode };
  }

  // Populate the year dropdown from the day-with-data index.
  function populateYears() {
    const sel = document.getElementById("f-year");
    if (!sel) return;
    const years = [...new Set(state.dayKeys.map(k => k.slice(0, 4)))].sort();
    const cur = sel.value;
    sel.innerHTML = years.length ? "" : '<option value="">–</option>';
    for (const y of years) {
      const o = document.createElement("option");
      o.value = y; o.textContent = y;
      sel.appendChild(o);
    }
    if (years.includes(cur)) sel.value = cur;
  }

  // ---------- All places layer ----------
  // Aggregate visits + dwell-detected stops into places (merge within ~100 m),
  // sized by visit count, categorized Home / Work / Other.
  function buildPlaces(sortedPoints, visits) {
    const places = [];
    const MERGE_KM = 0.1, STOP_KM = 0.1, STOP_MS = 10 * 60 * 1000;
    const add = (lat, lng, start, end, name, addr) => {
      let p = null, best = MERGE_KM;
      for (const pl of places) {
        const d = Geo.haversineKm(pl.lat, pl.lng, lat, lng);
        if (d <= best) { best = d; p = pl; }
      }
      if (!p) { p = { lat, lng, count: 0, visits: 0, first: Infinity, last: -Infinity, dwell: 0, name: name || "", addr: addr || "" }; places.push(p); }
      p.count++;
      p.visits++;
      if (start < p.first) p.first = start;
      if (end > p.last) p.last = end;
      if (end > start) p.dwell += end - start;
      if (!p.name && name) p.name = name;
      if (!p.addr && addr) p.addr = addr;
    };
    // 1. Visits (Google place visits) become places.
    for (const v of visits) add(v.lat, v.lng, v.start, v.end, v.addr, v.addr);
    // 2. Dwell-detected stops (for data without visits): consecutive points
    //    that stay within ~100 m for >10 min form a place at their mean.
    if (sortedPoints.length) {
      let run = [sortedPoints[0]];
      for (let i = 1; i <= sortedPoints.length; i++) {
        const p = i < sortedPoints.length ? sortedPoints[i] : null;
        const prev = run[run.length - 1];
        const far = !p || Geo.haversineKm(prev.lat, prev.lng, p.lat, p.lng) > STOP_KM;
        if (far) {
          if (run.length >= 3 && (run[run.length - 1].ts - run[0].ts) >= STOP_MS) {
            const lat = run.reduce((a, q) => a + q.lat, 0) / run.length;
            const lng = run.reduce((a, q) => a + q.lng, 0) / run.length;
            add(lat, lng, run[0].ts, run[run.length - 1].ts, "", "");
          }
          if (p) run = [p]; else break;
        } else {
          run.push(p);
        }
      }
    }
    // Categorize: majority of visit start hours overnight => Home; daytime => Work.
    const hour = ts => new Date(ts).getUTCHours();
    for (const p of places) {
      p.category = "other";
    }
    for (const v of visits) {
      const pl = places.find(x => Geo.haversineKm(x.lat, x.lng, v.lat, v.lng) <= MERGE_KM);
      if (!pl) continue;
      const h = hour(v.start);
      if (h >= 20 || h < 7) pl.home = (pl.home || 0) + 1;
      else if (h >= 8 && h < 17) pl.work = (pl.work || 0) + 1;
    }
    for (const p of places) {
      const hv = p.home || 0, wv = p.work || 0;
      if (hv > wv && hv >= 2) p.category = "home";
      else if (wv > hv && wv >= 2) p.category = "work";
      else p.category = "other";
    }
    places.sort((a, b) => b.visits - a.visits);
    return places;
  }

  // Outline colour adapts to the basemap so unselected regions stay visible:
  // dark lines on light maps, white lines on dark maps.
  function outlineColor() {
    const bm = document.getElementById("c-basemap").value;
    return (bm === "dark" || bm === "esri-sat") ? "rgba(255,255,255,0.9)" : "rgba(30,40,60,0.85)";
  }

  // Edit mode looks the same as the normal map: visited regions are shaded by
  // the metric, unvisited regions get a contrasting outline only. Unvisited
  // edit-mode paths carry the "region-hit" class so their interior stays
  // clickable even though the fill is off (pointer-events override in CSS).
  // Current/selected regions get a gold highlight outline.
  function regionStyle(feature, metric, domain, edit, singleColor) {
    const id = feature.properties.id;
    const highlight = edit && (id === state.currentRegionId || state.selectedIds.has(id));
    const s = feature.properties._stat;
    if (!s) {
      const base = edit
        ? { color: outlineColor(), weight: 0.9, fill: false, className: "region-hit" }
        : { color: outlineColor(), weight: 0.7, fill: false };
      return highlight ? Object.assign({}, base, { color: "#ffd400", weight: 2.6 }) : base;
    }
    const val = metric === "dwell" ? s.dwell : metric === "count" ? s.count : s.last;
    const color = metric === "single" ? singleColor : Color.colorFor(metric, val, domain);
    const base = { color: outlineColor(), weight: 0.7, fill: true, fillColor: color, fillOpacity: 0.8 };
    return highlight ? Object.assign({}, base, { color: "#ffd400", weight: 2.6 }) : base;
  }

  // Restyle just the given region ids (selection/current changes).
  function restyleRegionsByIds(ids) {
    if (!state.regionLayer) return;
    const cfg = readConfig();
    const domain = state.lastDomain || { minTs: 1, maxTs: Date.now(), maxCount: 1, maxDwell: 1 };
    for (const id of ids) {
      const layer = state.regionLayers && state.regionLayers.get(id);
      if (!layer) continue;
      const props = state.regionProps.get(id);
      const st = state.currentStats && state.currentStats.get(id);
      layer.setStyle(regionStyle({ properties: Object.assign({}, props, { id, _stat: st || null }) }, cfg.metric, domain, cfg.edit, cfg.singleColor));
    }
  }

  // Re-apply region styling (used when the basemap changes the outline contrast).
  function restyleRegions() {
    if (!state.regionLayer) return;
    const cfg = readConfig();
    const domain = state.lastDomain || { minTs: 1, maxTs: Date.now(), maxCount: 1, maxDwell: 1 };
    state.regionLayer.setStyle(f => regionStyle(f, cfg.metric, domain, cfg.edit, cfg.singleColor));
  }

  // ---------- edit mode (lightweight: no re-analysis, restyle only) ----------
  // Roll county-level manual edits up to the state level: a state is visited iff
  // any of its counties (or ADM2 units) is in the county-level in-set. This makes
  // e.g. "remove every Illinois county" un-highlight Illinois, and "add an Iowa
  // county" highlight Iowa, when viewing at state level.
  async function applyCountyRollup(sorted, stateFeats) {
    const overrideISOs = new Set();
    state.manual.overrides.forEach((o, id) => {
      const f = Boundaries.featureForId(id);
      if (f && f.level === "county" && f.ISO3) overrideISOs.add(f.ISO3);
    });
    if (!overrideISOs.size) return null;
    const fineAll = [];
    for (const iso of overrideISOs) {
      const fine = await Boundaries.getSubdivisions(iso, "county", { online: false });
      if (fine && fine.length) fineAll.push(...fine);
    }
    if (!fineAll.length) return null;
    const fineAuto = await Geo.classifyPoints(sorted, fineAll, Geo.makeIndex(fineAll), { maxExact: MAX_EXACT });
    const fineFinal = Export.applyManualOverrides(fineAuto, state.manual.overrides, Date.now());
    const parent = Boundaries.parentStateMap(fineAll, stateFeats);
    const rollup = new Map();
    fineFinal.forEach((st, fid) => {
      const sid = parent.get(fid);
      if (!sid) return;
      let s = rollup.get(sid);
      if (!s) { s = { count: 0, first: Infinity, last: -Infinity, dwell: 0 }; rollup.set(sid, s); }
      s.count += st.count;
      if (isFinite(st.first) && st.first < s.first) s.first = st.first;
      if (isFinite(st.last) && st.last > s.last) s.last = st.last;
    });
    const affected = new Set();
    for (const iso of overrideISOs) stateFeats.forEach(f => { if (f.ISO3 === iso) affected.add(f.id); });
    return { rollup, affected };
  }

  // State-level final stats: state auto classification + county-level edits
  // rolled up. Direct state-level overrides are applied by the caller.
  async function computeStateFinal(sorted, stateFeats) {
    let stats = new Map();
    if (sorted.length) stats = await Geo.classifyPoints(sorted, stateFeats, Geo.makeIndex(stateFeats), { maxExact: MAX_EXACT });
    const roll = await applyCountyRollup(sorted, stateFeats);
    if (roll) {
      for (const sid of roll.affected) {
        const r = roll.rollup.get(sid);
        if (r && r.count > 0) stats.set(sid, r);
        else stats.delete(sid);
      }
    }
    return stats;
  }

  // Roll the state-level in-set up to countries. Countries that have subdivision
  // features but no visited ones are dropped; countries without subdivision data
  // (microstates) fall back to their own auto country stats.
  function rollStatesToCountries(stateStats, cStats, visitedISO3, stateFeats) {
    const out = new Map();
    const isoById = new Map();
    stateFeats.forEach(f => isoById.set(f.id, f.ISO3));
    stateStats.forEach((st, sid) => {
      const iso = isoById.get(sid) || Boundaries.iso3ForId(sid);
      if (!iso) return;
      let s = out.get(iso);
      if (!s) { s = { count: 0, first: Infinity, last: -Infinity, dwell: 0 }; out.set(iso, s); }
      s.count += st.count;
      if (isFinite(st.first) && st.first < s.first) s.first = st.first;
      if (isFinite(st.last) && st.last > s.last) s.last = st.last;
    });
    const stateISOs = new Set(stateFeats.map(f => f.ISO3));
    for (const iso of visitedISO3) {
      if (!stateISOs.has(iso) && cStats.has(iso)) out.set(iso, cStats.get(iso));
    }
    return out;
  }
  function applyEdit(changedIds) {
    if (!state.baseStats) return;
    const cfg = readConfig();
    const stats = Export.applyManualOverrides(state.baseStats, state.manual.overrides, Date.now());
    state.currentStats = stats;
    state.visitedIds = new Set(stats.keys());
    let maxCount = 1, maxDwell = 1;
    stats.forEach(s => { if (s.count > maxCount) maxCount = s.count; if (s.dwell > maxDwell) maxDwell = s.dwell; });
    const base = state.domain || { minTs: Date.now() - 1, maxTs: Date.now() };
    const domain = { minTs: base.minTs, maxTs: base.maxTs, maxCount, maxDwell };
    const domainKey = `${maxCount}|${maxDwell}`;

    const includeAll = cfg.outlines || cfg.edit;
    const allowedISOs = cfg.edit ? null : computeAllowedISOs(state.features, stats);
    state.currentRegions = buildRegionGeoJSON(state.features, stats, includeAll, allowedISOs);
    state.regionSummaries = regionSummaries(state.features, stats);
    updateSummary(state.points, state.visits);
    UI.updateLegend(cfg.metric, domain, cfg.singleColor);

    if (state.regionLayer) {
      if (domainKey !== state.lastDomainKey) {
        state.regionLayer.setStyle(f => regionStyle(f, cfg.metric, domain, cfg.edit, cfg.singleColor));
      } else if (changedIds) {
        for (const id of changedIds) {
          const layer = state.regionLayers.get(id);
          if (layer) {
            const props = state.regionProps.get(id);
            const st = stats.get(id);
            layer.setStyle(regionStyle({ properties: Object.assign({}, props, { _stat: st || null }) }, cfg.metric, domain, cfg.edit, cfg.singleColor));
          }
        }
      }
    }
    if (cfg.layers.heat && state.maskCache && domainKey !== state.lastDomainKey) {
      state.heatCache = Geo.heatCanvas(state.maskCache.mask, cfg.metric, domain);
      UI.setHeat(state.heatCache);
    }
    state.lastDomainKey = domainKey;
  }

  function toggleManual(id) {
    // While drawing a trip, map clicks add stops only — never edit regions.
    if (state.drawTrip) return;
    // In edit mode, clicking an unexpanded country loads its subdivisions so
    // the user can add a specific state/county from a new country.
    if (readConfig().edit) {
      const f = state.features && state.features.find(x => x.id === id);
      if (f && f.level === "country" && !state.visitedIds.has(id) && !state.expanded.has(f.ISO3)) {
        expandCountry(f.ISO3);
        return;
      }
    }
    const visited = state.visitedIds.has(id);
    const o = state.manual.overrides.get(id);
    pushUndo();
    if (visited) {
      if (o && o.status === "add") state.manual.overrides.delete(id);
      else state.manual.overrides.set(id, { status: "remove" });
    } else {
      state.manual.overrides.set(id, { status: "add" });
    }
    setStatus(`Manual edits: ${state.manual.overrides.size} region(s).`, false);
    applyEdit([id]);
    updateEditPanel();
  }

  // Load a country's subdivisions on demand (edit mode). Prefers county/ADM2
  // data (bundled, then cached or fetched online) over the coarser state
  // fallback, so clicking a country shows the counties the user can add.
  async function expandCountry(iso3) {
    if (state.expanded.has(iso3)) return;
    const cfg = readConfig();
    UI.setBusy("Loading boundaries…");
    let sub = [];
    try {
      sub = await Boundaries.getSubdivisions(iso3, cfg.level, { online: cfg.online });
    } catch (e) { console.warn("expand failed", iso3, e); sub = []; }
    UI.setBusy(null);
    if (sub && sub.length) {
      state.expanded.add(iso3);
      state.classKey = null;
      await render();
      setStatus(`Loaded ${sub.length} subdivisions for ${Boundaries.countryName(iso3)} — click one to add it.`, false);
    } else {
      setStatus(`No subdivision data for ${Boundaries.countryName(iso3)} — adding the country itself.`, false);
      state.manual.overrides.set(iso3, { status: "add" });
      applyEdit([iso3]);
    }
  }

  function editDates(id, first, last) {
    const o = state.manual.overrides.get(id);
    const auto = state.baseStats && state.baseStats.get(id);
    const entry = { status: o ? o.status : (auto ? "dates" : "add") };
    if (first) entry.first = first;
    if (last) entry.last = last;
    if (o && o.count) entry.count = o.count;
    pushUndo();
    state.manual.overrides.set(id, entry);
    setStatus(`Manual edits: ${state.manual.overrides.size} region(s).`, false);
    applyEdit([id]);
    updateEditPanel();
  }

  function resetEdits() {
    if (!state.manual.overrides.size) return;
    pushUndo();
    const prev = [...state.manual.overrides.keys()];
    state.manual.overrides.clear();
    state.currentRegionId = null;
    state.selectedIds.clear();
    clearPointSelection();
    setStatus("Manual edits cleared.", false);
    applyEdit(prev);
    updateEditPanel();
  }

  // ---------- edit-mode selection + region details panel ----------
  function selectRegion(id, addToSelection) {
    if (state.drawTrip) return;
    const old = state.currentRegionId;
    if (addToSelection) {
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      state.currentRegionId = id;
    } else {
      state.currentRegionId = id;
    }
    const restyle = [old, id];
    if (addToSelection) restyle.push(id);
    updateEditPanel();
    restyleRegionsByIds([...new Set(restyle)]);
    showRegionPoints(state.currentRegionId);
  }

  function editPanelDate(id) {
    const st = state.currentStats && state.currentStats.get(id);
    return { first: st && st.first, last: st && st.last };
  }

  function updateEditPanel() {
    const id = state.currentRegionId;
    const selCount = state.selectedIds.size;
    const visited = state.visitedIds ? [...state.visitedIds] : [];
    const idx = id ? visited.indexOf(id) : -1;
    document.getElementById("rd-name").textContent = id ? (state.regionProps.get(id) || {}).name || id : "–";
    document.getElementById("rd-where").textContent = id ? (Boundaries.iso3ForId(id) ? Boundaries.countryName(Boundaries.iso3ForId(id)) : "") : "";
    const d = editPanelDate(id);
    document.getElementById("rd-first").value = d.first ? new Date(d.first).toISOString().slice(0, 10) : "";
    document.getElementById("rd-last").value = d.last ? new Date(d.last).toISOString().slice(0, 10) : "";
    document.getElementById("rd-current").textContent = (d.first || d.last)
      ? `Current: ${Model.fmtDate(d.first)} → ${Model.fmtDate(d.last)}`
      : "Not visited";
    document.getElementById("rd-sel").textContent = selCount ? `${selCount} region(s) selected` : (id ? "1 region" : "No region selected");
    document.getElementById("rd-status").textContent = `Manual edits: ${state.manual.overrides.size} region(s).`;
    document.getElementById("rd-prev").disabled = idx <= 0;
    document.getElementById("rd-next").disabled = idx < 0 || idx >= visited.length - 1;
  }

  // ---------- point selection (edit mode: remove / edit a specific point) ----------
  const MAX_POINT_MARKERS = 3000;

  // Show clickable markers for every point inside the selected region.
  function showRegionPoints(id) {
    state.selectedPoint = null;
    state.regionPoints = [];
    if (!id || !readConfig().edit) { UI.setPointMarkers([]); updatePointPanel(); return; }
    const f = state.features && state.features.find(x => x.id === id);
    if (!f || !f.geometry) { UI.setPointMarkers([]); updatePointPanel(); return; }
    // bbox pre-filter, then exact point-in-polygon.
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    const walk = (coords) => {
      if (typeof coords[0] === "number") {
        const [lng, lat] = coords;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      } else for (const c of coords) walk(c);
    };
    walk(f.geometry.coordinates);
    const inside = state.sorted.filter(p =>
      p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng &&
      Geo.featureContains(f, p.lat, p.lng));
    state.regionPoints = inside.slice(0, MAX_POINT_MARKERS);
    UI.setPointMarkers(state.regionPoints, selectPoint, movePoint);
    updatePointPanel();
  }

  function selectPoint(p) {
    state.selectedPoint = p;
    updatePointPanel();
  }

  function updatePointPanel() {
    const block = document.getElementById("point-block");
    const p = state.selectedPoint;
    if (!p) { block.classList.add("hidden"); return; }
    block.classList.remove("hidden");
    document.getElementById("pt-info").textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} · ${Model.fmtDate(p.ts)}`;
    document.getElementById("pt-date").value = Model.fmtDate(p.ts);
    document.getElementById("pt-lat").value = p.lat;
    document.getElementById("pt-lng").value = p.lng;
  }

  function clearPointSelection() {
    state.selectedPoint = null;
    state.regionPoints = [];
    UI.setPointMarkers([]);
    updatePointPanel();
  }

  // Reflect the current edit-mode state on the "Edit" card button.
  function updateEditButton() {
    const btn = document.getElementById("btn-edit-mode");
    if (!btn) return;
    btn.classList.toggle("active", state.editMode);
    btn.setAttribute("aria-pressed", String(state.editMode));
  }

  // Invalidate caches and re-render after mutating raw point data.
  async function refreshData() {
    state.dataKey = null;
    state.classKey = null;
    state.maskKey = null;
    state.heatKey = null;
    state.trailKey = null;
    await render();
  }

  // ---------- undo / redo (Ctrl-Z / Ctrl-Y) ----------
  const UNDO_LIMIT = 30;
  // Snapshot the mutable data needed to restore an action. Arrays are shallow-
  // copied; point objects are only ever replaced (never mutated) so snapshots
  // stay valid.
  function takeSnapshot() {
    return {
      points: state.rawPoints.slice(),
      visits: state.rawVisits.slice(),
      manual: new Map(state.manual.overrides),
    };
  }
  function restoreSnapshot(snap) {
    state.rawPoints = snap.points;
    state.rawVisits = snap.visits;
    state.manual.overrides = snap.manual;
    state.selectedPoint = null;
    state.selectedIds.clear();
    state.currentRegionId = null;
    refreshData();
  }
  // Record the current state as an undo point (call before an action).
  function pushUndo() {
    state.undoStack.push(takeSnapshot());
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    state.redoStack = [];
  }
  function undo() {
    const snap = state.undoStack.pop();
    if (!snap) { setStatus("Nothing to undo.", false); return; }
    state.redoStack.push(takeSnapshot());
    restoreSnapshot(snap);
    setStatus(`Undo — ${state.undoStack.length} step${state.undoStack.length === 1 ? "" : "s"} left.`, false);
  }
  function redo() {
    const snap = state.redoStack.pop();
    if (!snap) { setStatus("Nothing to redo.", false); return; }
    state.undoStack.push(takeSnapshot());
    restoreSnapshot(snap);
    setStatus(`Redo — ${state.redoStack.length} step${state.redoStack.length === 1 ? "" : "s"} left.`, false);
  }

  function savePoint() {
    const p = state.selectedPoint;
    if (!p) return;
    const idx = state.rawPoints.indexOf(p);
    if (idx === -1) return;
    const dateV = document.getElementById("pt-date").value;
    const latV = parseFloat(document.getElementById("pt-lat").value);
    const lngV = parseFloat(document.getElementById("pt-lng").value);
    const np = Model.point(p.lat, p.lng, p.ts, p.acc, p.src, p.mode);
    if (dateV) np.ts = new Date(dateV + "T00:00:00Z").getTime();
    if (!isNaN(latV)) np.lat = latV;
    if (!isNaN(lngV)) np.lng = lngV;
    if (np.ts === p.ts && np.lat === p.lat && np.lng === p.lng) return;
    pushUndo();
    state.rawPoints[idx] = np;
    state.selectedPoint = np;
    setStatus("Point updated.", false);
    refreshData();
  }

  // Relocate a point by dragging its marker on the map (undoable).
  function movePoint(p, lat, lng) {
    if (!p || (p.lat === lat && p.lng === lng)) return;
    const idx = state.rawPoints.indexOf(p);
    if (idx === -1) return;
    pushUndo();
    const np = Model.point(lat, lng, p.ts, p.acc, p.src, p.mode);
    state.rawPoints[idx] = np;
    state.selectedPoint = np;
    setStatus("Point moved.", false);
    refreshData();
  }

  function removePoint() {
    const p = state.selectedPoint;
    if (!p) return;
    pushUndo();
    state.rawPoints = state.rawPoints.filter(x => x !== p);
    state.selectedPoint = null;
    setStatus("Point removed.", false);
    refreshData();
  }

  function prevNextRegion(delta) {
    const visited = state.visitedIds ? [...state.visitedIds] : [];
    if (!visited.length) return;
    let idx = state.currentRegionId ? visited.indexOf(state.currentRegionId) : -1;
    idx = (idx === -1 ? 0 : idx + delta);
    idx = Math.max(0, Math.min(visited.length - 1, idx));
    selectRegion(visited[idx], false);
  }

  function clearDates(id) {
    const o = state.manual.overrides.get(id);
    if (!o) return;
    pushUndo();
    if (o.status === "dates") state.manual.overrides.delete(id);
    else state.manual.overrides.set(id, { status: o.status, count: o.count || null });
    setStatus(`Manual edits: ${state.manual.overrides.size} region(s).`, false);
    applyEdit([id]);
    updateEditPanel();
  }

  function bulkSetDates(ids, first, last) {
    if (!ids.length) return;
    pushUndo();
    for (const id of ids) {
      const o = state.manual.overrides.get(id);
      const auto = state.baseStats && state.baseStats.get(id);
      const entry = { status: o ? o.status : (auto ? "dates" : "add") };
      if (first) entry.first = first;
      if (last) entry.last = last;
      if (o && o.count) entry.count = o.count;
      state.manual.overrides.set(id, entry);
    }
    setStatus(`Manual edits: ${state.manual.overrides.size} region(s).`, false);
    applyEdit(ids);
    updateEditPanel();
  }

  function targetIds() {
    return state.selectedIds.size ? [...state.selectedIds] : (state.currentRegionId ? [state.currentRegionId] : []);
  }

  function shiftAllDates(days) {
    const ms = days * 86400000;
    if (!ms) return;
    const ids = state.visitedIds ? [...state.visitedIds] : [];
    const changed = [];
    pushUndo();
    for (const id of ids) {
      const st = state.currentStats && state.currentStats.get(id);
      if (!st) continue;
      const o = state.manual.overrides.get(id);
      const auto = state.baseStats && state.baseStats.get(id);
      const entry = { status: o ? o.status : (auto ? "dates" : "add") };
      if (st.first) entry.first = st.first + ms;
      if (st.last) entry.last = st.last + ms;
      if (o && o.count) entry.count = o.count;
      state.manual.overrides.set(id, entry);
      changed.push(id);
    }
    if (changed.length) {
      setStatus(`Shifted dates of ${changed.length} region(s) by ${days} days.`, false);
      applyEdit(changed);
      updateEditPanel();
    }
  }

  function setDatesForCountry() {
    const id = state.currentRegionId;
    if (!id) return;
    const iso = Boundaries.iso3ForId(id);
    if (!iso) { setStatus("Unknown country for the current region.", true); return; }
    const firstV = document.getElementById("rd-first").value;
    const lastV = document.getElementById("rd-last").value;
    const first = firstV ? new Date(firstV + "T00:00:00Z").getTime() : null;
    const last = lastV ? new Date(lastV + "T00:00:00Z").getTime() : null;
    const ids = (state.visitedIds ? [...state.visitedIds] : []).filter(x => Boundaries.iso3ForId(x) === iso);
    if (!ids.length) { setStatus("No in-set regions found for " + Boundaries.countryName(iso) + ".", true); return; }
    bulkSetDates(ids, first, last);
  }

  // ---------- export ----------
  function openExport() {
    document.getElementById("export-modal").classList.remove("hidden");
  }
  function closeExport() {
    document.getElementById("export-modal").classList.add("hidden");
  }

  function exportOptions() {
    return {
      includeRegions: document.getElementById("x-regions").checked,
      includePoints: document.getElementById("x-points").checked,
      includeVisits: document.getElementById("x-visits").checked,
      includeManual: document.getElementById("x-manual").checked,
      includeTimestamps: document.getElementById("x-times").checked,
      includeAddresses: document.getElementById("x-addresses").checked,
      precision: parseInt(document.getElementById("x-precision").value, 10) || 6,
    };
  }

  function exportDataFile() {
    const data = Export.buildSanitizedData(
      { points: state.points, visits: state.visits, manual: state.manual.overrides, regions: state.regionSummaries },
      exportOptions());
    Export.downloadJson("mapper-export.json", data);
  }

  function exportOverlays() {
    const gj = Export.buildOverlays(state.currentRegions, null);
    if (!gj.features.length) { setStatus("Nothing to export yet.", true); return; }
    Export.downloadJson("mapper-overlays.geojson", gj);
  }

  function exportKML() {
    const kml = Export.buildKML(state.points, state.visits);
    Export.download("mapper.kml", new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }));
  }

  function exportSettings() {
    Export.downloadJson("mapper-settings.json", { generated: new Date().toISOString(), app: "Mapper", config: readConfig() });
  }

  function updateSummary(points, visits) {
    const s = Model.summarize(points, visits);
    const total = state.rawPoints.length;
    const shown = s.nPoints;
    const el = document.getElementById("stat-points");
    if (shown < total) {
      el.textContent = shown.toLocaleString() + " / " + total.toLocaleString();
      el.title = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} points (filtered).`;
    } else {
      el.textContent = s.nPoints.toLocaleString();
      el.title = "";
    }
    document.getElementById("stat-visits").textContent = s.nVisits.toLocaleString();
    document.getElementById("stat-sources").textContent = s.sources;
    document.getElementById("stat-range").textContent = s.range;
    document.getElementById("summary").classList.remove("hidden");
  }

  function setStatus(msg, isError) {
    const el = document.getElementById("status");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), isError ? 8000 : 4000);
    // Append notable messages to the persistent import log.
    if (msg && /(Added|Loaded|trip|points|error|Failed|Found|Stops)/i.test(msg)) {
      const log = document.getElementById("import-log");
      if (log) {
        const entry = document.createElement("div");
        entry.className = "log-entry " + (isError ? "log-err" : "log-ok");
        const ts = new Date().toLocaleTimeString();
        entry.textContent = ts + " — " + msg;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        updateClearLogVisibility();
      }
    }
  }

  // Show "Clear log" only when the import log has entries.
  function updateClearLogVisibility() {
    const log = document.getElementById("import-log");
    const btn = document.getElementById("btn-clear-log");
    if (!log || !btn) return;
    btn.classList.toggle("hidden", log.children.length === 0);
  }

  // ---------- demo data ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function demoData() {
    const rng = mulberry32(20260704);
    const cities = [
      { n: "San Francisco, US", iso: "USA", lat: 37.7749, lng: -122.4194 },
      { n: "Seattle, US", iso: "USA", lat: 47.6062, lng: -122.3321 },
      { n: "Mexico City, MX", iso: "MEX", lat: 19.4326, lng: -99.1332 },
      { n: "London, UK", iso: "GBR", lat: 51.5074, lng: -0.1278 },
      { n: "Amsterdam, NL", iso: "NLD", lat: 52.3676, lng: 4.9041 },
      { n: "Paris, FR", iso: "FRA", lat: 48.8566, lng: 2.3522 },
      { n: "Berlin, DE", iso: "DEU", lat: 52.5200, lng: 13.4050 },
      { n: "Cairo, EG", iso: "EGY", lat: 30.0444, lng: 31.2357 },
      { n: "Singapore, SG", iso: "SGP", lat: 1.3521, lng: 103.8198 },
      { n: "Tokyo, JP", iso: "JPN", lat: 35.6762, lng: 139.6503 },
      { n: "Sydney, AU", iso: "AUS", lat: -33.8688, lng: 151.2093 },
      { n: "Cape Town, ZA", iso: "ZAF", lat: -33.9249, lng: 18.4241 },
      { n: "Rio de Janeiro, BR", iso: "BRA", lat: -22.9068, lng: -43.1729 },
    ];
    const points = [], visits = [];
    let t = Date.now() - 3 * 365 * DAY + 10 * DAY;
    const passes = 2;
    for (let pass = 0; pass < passes; pass++) {
      const order = cities.slice().sort(() => rng() - 0.5);
      for (let i = 0; i < order.length; i++) {
        const city = order[i];
        const durDays = 1 + Math.round(rng() * 6);
        const arr = t;
        const N = 26;
        for (let k = 0; k < N; k++) {
          points.push(Model.point(
            city.lat + (rng() - 0.5) * 0.12,
            city.lng + (rng() - 0.5) * 0.16,
            Math.round(arr + (k / N) * durDays * DAY),
            4 + Math.round(rng() * 40), "google"));
        }
        visits.push(Model.visit(city.lat, city.lng, arr, arr + durDays * DAY, null, city.n, "google"));
        t = arr + durDays * DAY;
        const next = order[(i + 1) % order.length];
        const flightH = 6 + Math.round(rng() * 6);
        const P = 42;
        // Shortest longitude route (so flights cross the Pacific, not Europe/Asia),
        // wrapped back into ±180 so region classification still works.
        const dLng = ((next.lng - city.lng + 540) % 360) - 180;
        for (let k = 0; k <= P; k++) {
          const f = k / P;
          const lat = city.lat + (next.lat - city.lat) * f + Math.sin(f * Math.PI) * (rng() - 0.5) * 6 + (rng() - 0.5) * 0.3;
          const rawLng = city.lng + dLng * f + Math.sin(f * Math.PI) * (rng() - 0.5) * 6 + (rng() - 0.5) * 0.3;
          const lng = ((rawLng + 540) % 360) - 180;
          points.push(Model.point(lat, lng, Math.round(t + f * flightH * 3600000), 30 + Math.round(rng() * 300), "google"));
        }
        t += flightH * 3600000;
        if (i === order.length - 1) t += 5 * DAY;
      }
    }
    pushUndo();
    loadData(points, visits);
  }

  // ---------- add a typed list of points (places or coordinates + optional dates) ----------
  async function onAddPoints() {
    const input = document.getElementById("add-input");
    const lines = input.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setStatus("Enter at least one place or coordinates.", true); return; }
    UI.setBusy("Looking up places…");
    const added = [], found = [], errors = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      document.getElementById("busy-text").textContent = `Looking up place ${i + 1}/${lines.length}…`;
      try {
        const entry = await GeoCode.parseEntry(line);
        if (entry) {
          added.push(Model.point(entry.lat, entry.lng, entry.ts, 0, "manual:" + entry.display));
          found.push(`#${i + 1} ${entry.display}`);
        } else errors.push(`#${i + 1} Could not locate: "${line}"`);
        // be polite to Nominatim (~1 req/s)
        if (entry && entry.geocoded && i < lines.length - 1) await new Promise(r => setTimeout(r, 1100));
      } catch (e) {
        errors.push(`#${i + 1} Error: "${line}"`);
      }
    }
    UI.setBusy(null);
    document.getElementById("add-modal").classList.add("hidden");
    input.value = "";
    if (added.length) { pushUndo(); await loadData(added, [], { append: true, fit: false }); }
    const parts = [];
    if (found.length) parts.push(`Found: ${found.join(", ")}`);
    if (errors.length) parts.push(`Failed: ${errors.join("; ")}`);
    const msg = added.length ? `Added ${added.length} point${added.length === 1 ? "" : "s"}.` : "No points added.";
    setStatus(parts.length ? msg + " " + parts.join(" | ") : msg, errors.length > 0);
  }

  // ---------- add a trip (list of stops + dates) ----------
  async function onAddTrip() {
    const name = document.getElementById("trip-name").value.trim();
    const startV = document.getElementById("trip-start").value;
    const endV = document.getElementById("trip-end").value;
    const start = startV ? new Date(startV + "T00:00:00Z").getTime() : null;
    const end = endV ? new Date(endV + "T00:00:00Z").getTime() : null;
    const lines = document.getElementById("trip-input").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setStatus("List at least one stop.", true); return; }
    UI.setBusy("Looking up stops…");
    const stops = [], fixed = [], errors = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      document.getElementById("busy-text").textContent = `Looking up stop ${i + 1}/${lines.length}…`;
      try {
        const dt = GeoCode.extractDate(line);
        const entry = await GeoCode.parseEntry(line);
        if (entry) {
          stops.push({ lat: entry.lat, lng: entry.lng, display: entry.display, ownDate: dt ? dt.ms : null });
          if (dt) fixed.push(i);
        } else errors.push(`Could not locate: "${line}"`);
        if (entry && entry.geocoded && i < lines.length - 1) await new Promise(r => setTimeout(r, 1100));
      } catch (e) { errors.push(`Error: "${line}"`); }
    }
    UI.setBusy(null);
    document.getElementById("trip-modal").classList.add("hidden");
    if (!stops.length) { setStatus("No stops could be located.", errors.length > 0); return; }
    // dates: explicit per-line dates win; otherwise spread evenly between start and end
    const dates = Model.interpolateDates(stops.length, start, end);
    const points = [];
    let minTs = Infinity, maxTs = -Infinity;
    stops.forEach((s, i) => {
      const ts = s.ownDate != null ? s.ownDate : dates[i];
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
      points.push(Model.point(s.lat, s.lng, ts, 0, "trip:" + (name || "Trip")));
    });
    if (!isFinite(minTs)) { minTs = Date.now(); maxTs = Date.now(); }
    // midpoint of the stops
    const midLat = stops.reduce((a, s) => a + s.lat, 0) / stops.length;
    const midLng = stops.reduce((a, s) => a + s.lng, 0) / stops.length;
    const visit = Model.visit(midLat, midLng, minTs, maxTs, null, name || "Trip", "trip");
    pushUndo();
    await loadData(points, [visit], { append: true, fit: false });
    const found = stops.map((s, i) => `#${i + 1} ${s.display}`).join(", ");
    const parts = [`Stops found: ${found}`];
    if (errors.length) parts.push(`Failed: ${errors.join("; ")}`);
    setStatus(`Added trip "${name || "Trip"}": ${points.length} stops. ${parts.join(" | ")}`, errors.length > 0);
    document.getElementById("trip-input").value = "";
    document.getElementById("trip-name").value = "";
  }

  // ---------- draw a trip on the map ----------
  let mapClickOff = null;
  function startDrawTrip() {
    // Drawing needs edit mode on (regions become non-interactive); enable it
    // silently if needed, without forcing the "how to edit" sidebar open.
    if (!state.editMode) {
      state.editMode = true;
      updateEditButton();
      UI.setBoxZoom(false);
    }
    clearPointSelection();
    state.drawTrip = { pts: [] };
    UI.showDrawBar(true);
    UI.clearDraw();
    mapClickOff = UI.onMapClick(e => {
      if (!state.drawTrip) return;
      state.drawTrip.pts.push([e.latlng.lat, e.latlng.lng]);
      UI.addDrawPoint(e.latlng);
    });
    // Preserve the current view while drawing (skip the auto-fit this render
    // would otherwise run when hasFitted is still false).
    state.hasFitted = true;
    render(); // regions become non-interactive while drawing
  }
  function stopDrawTrip(commit) {
    const dt = state.drawTrip;
    state.drawTrip = null;
    if (mapClickOff) { mapClickOff(); mapClickOff = null; }
    UI.showDrawBar(false);
    UI.clearDraw();
    if (commit && dt && dt.pts.length) {
      const startV = document.getElementById("draw-start").value;
      const endV = document.getElementById("draw-end").value;
      const start = startV ? new Date(startV + "T00:00:00Z").getTime() : null;
      const end = endV ? new Date(endV + "T00:00:00Z").getTime() : null;
      const dates = Model.interpolateDates(dt.pts.length, start, end);
      const points = dt.pts.map((p, i) => Model.point(p[0], p[1], dates[i], 0, "trip:draw"));
      const midLat = dt.pts.reduce((a, p) => a + p[0], 0) / dt.pts.length;
      const midLng = dt.pts.reduce((a, p) => a + p[1], 0) / dt.pts.length;
      const visit = Model.visit(midLat, midLng, dates[0], dates[dates.length - 1], null, "Drawn trip", "trip");
      pushUndo();
      loadData(points, [visit], { append: true, fit: false });
      setStatus(`Added drawn trip with ${points.length} stops.`, false);
    }
    render(); // regions interactive again
  }

  function showSupplementalDialog(count, defaultName) {
    return new Promise(resolve => {
      const modal = document.getElementById("supp-modal");
      const countEl = document.getElementById("supp-count");
      const tripOpts = document.getElementById("supp-trip-opts");
      const nameInput = document.getElementById("supp-trip-name");
      const radios = modal.querySelectorAll("input[name=supp-mode]");
      countEl.textContent = count;
      nameInput.value = defaultName || "Photo trip";
      tripOpts.classList.add("hidden");
      radios.forEach(r => { r.checked = r.value === "points"; });
      const onRadioChange = () => {
        const isTrip = modal.querySelector("input[name=supp-mode]:checked").value === "trip";
        tripOpts.classList.toggle("hidden", !isTrip);
      };
      radios.forEach(r => r.addEventListener("change", onRadioChange));
      const cleanup = () => {
        radios.forEach(r => r.removeEventListener("change", onRadioChange));
        document.getElementById("supp-ok").removeEventListener("click", onOk);
        document.getElementById("supp-cancel").removeEventListener("click", onCancel);
        modal.classList.add("hidden");
      };
      const onOk = () => {
        const mode = modal.querySelector("input[name=supp-mode]:checked").value;
        cleanup();
        resolve({ mode, name: mode === "trip" ? (nameInput.value.trim() || "Photo trip") : null });
      };
      const onCancel = () => { cleanup(); resolve(null); };
      document.getElementById("supp-ok").addEventListener("click", onOk);
      document.getElementById("supp-cancel").addEventListener("click", onCancel);
      modal.classList.remove("hidden");
    });
  }

  // ---------- wiring ----------
  function init() {
    UI.init();
    const dz = document.getElementById("dropzone");
    const input = document.getElementById("file-input");
    const open = () => input.click();
    dz.addEventListener("click", open);
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", e => {
      e.preventDefault();
      dz.classList.remove("drag");
      handleFiles(e.dataTransfer.files);
    });
    input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });

    async function handleFiles(files) {
      pushUndo();
      UI.setBusy("Parsing files…");
      try {
        const r = await Parsers.parseFiles(files, (i, n, name) => {
          document.getElementById("busy-text").textContent = "Parsing " + name + " (" + i + "/" + n + ")…";
        });
        UI.setBusy(null);
        if (!r.points.length && !r.visits.length && !r.manual.length && !r.supplemental) {
          setStatus((r.notes && r.notes.length ? r.notes.join(" ") : "No location data found in those files."), true);
          return;
        }
        if (r.notes && r.notes.length) setStatus(r.notes.join(" "), true);
        if (r.manual && r.manual.length) {
          const merged = Export.mergeManual(state.manual.overrides, new Map(r.manual.map(m => [m.id, { status: m.status, first: m.first, last: m.last, count: m.count }])));
          setStatus(`Merged ${merged} manual edit${merged === 1 ? "" : "s"} from import.`, false);
        }
        if (r.supplemental && r.supplemental.points.length > 1) {
          const choice = await showSupplementalDialog(r.supplemental.count, r.supplemental.defaultName);
          if (!choice) {
            r.supplemental = null;
          } else if (choice.mode === "points") {
            r.points.push(...r.supplemental.points);
            r.supplemental = null;
          } else {
            // Create as a trip: tag the points so they render as a dedicated
            // trip line (otherwise they'd be treated as generic trail points).
            const pts = r.supplemental.points;
            const tripSrc = "trip:" + (choice.name || "Trip");
            for (const p of pts) p.src = tripSrc;
            r.points.push(...pts);
            const start = pts[0].ts, end = pts[pts.length - 1].ts;
            const midLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
            const midLng = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
            r.visits.push(Model.visit(midLat, midLng, start, end, null, choice.name, "supplemental"));
            r.supplemental = null;
          }
        }
        await loadData(r.points, r.visits, { append: true, fit: false });
      } catch (e) {
        console.error(e);
        setStatus("Failed: " + e.message, true);
      } finally {
        UI.setBusy(null);
      }
    }

    document.getElementById("btn-demo").addEventListener("click", demoData);
    document.getElementById("btn-clear").addEventListener("click", clearData);
    document.getElementById("btn-export").addEventListener("click", openExport);
    document.getElementById("x-close").addEventListener("click", closeExport);
    document.getElementById("x-data").addEventListener("click", exportDataFile);
    document.getElementById("x-overlays").addEventListener("click", exportOverlays);
    document.getElementById("x-kml").addEventListener("click", exportKML);
    document.getElementById("x-settings").addEventListener("click", exportSettings);
    document.getElementById("btn-reset-edits").addEventListener("click", resetEdits);

    document.getElementById("btn-about").addEventListener("click", () => document.getElementById("about-modal").classList.remove("hidden"));
    document.getElementById("about-close").addEventListener("click", () => document.getElementById("about-modal").classList.add("hidden"));

    document.getElementById("btn-add-points").addEventListener("click", () => {
      document.getElementById("add-modal").classList.remove("hidden");
    });
    document.getElementById("add-cancel").addEventListener("click", () => {
      document.getElementById("add-modal").classList.add("hidden");
    });
    document.getElementById("add-submit").addEventListener("click", onAddPoints);
    document.getElementById("add-input").addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onAddPoints(); }
    });

    document.getElementById("btn-add-trip").addEventListener("click", () => {
      document.getElementById("trip-modal").classList.remove("hidden");
    });
    document.getElementById("trip-cancel").addEventListener("click", () => {
      document.getElementById("trip-modal").classList.add("hidden");
    });
    document.getElementById("trip-submit").addEventListener("click", onAddTrip);
    document.getElementById("trip-input").addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onAddTrip(); }
    });

    // edit-mode region details panel + bulk tools
    const $ = id => document.getElementById(id);
    $("rd-save").addEventListener("click", () => {
      const id = state.currentRegionId; if (!id) return;
      const firstV = $("rd-first").value, lastV = $("rd-last").value;
      editDates(id, firstV ? new Date(firstV + "T00:00:00Z").getTime() : null,
                lastV ? new Date(lastV + "T00:00:00Z").getTime() : null);
      updateEditPanel();
    });
    $("rd-clear").addEventListener("click", () => { const id = state.currentRegionId; if (id) clearDates(id); });
    $("rd-toggle").addEventListener("click", () => { const id = state.currentRegionId; if (id) toggleManual(id); });
    $("rd-prev").addEventListener("click", () => prevNextRegion(-1));
    $("rd-next").addEventListener("click", () => prevNextRegion(1));
    $("rd-bapply").addEventListener("click", () => {
      const ids = targetIds(); if (!ids.length) return;
      const firstV = $("rd-bfirst").value, lastV = $("rd-blast").value;
      bulkSetDates(ids, firstV ? new Date(firstV + "T00:00:00Z").getTime() : null,
                   lastV ? new Date(lastV + "T00:00:00Z").getTime() : null);
    });
    $("rd-bclear").addEventListener("click", () => { targetIds().forEach(clearDates); });
    $("rd-shift-apply").addEventListener("click", () => shiftAllDates(parseInt($("rd-shift").value, 10) || 0));
    $("rd-country").addEventListener("click", setDatesForCountry);
    $("btn-draw-trip").addEventListener("click", startDrawTrip);
    $("draw-finish").addEventListener("click", () => stopDrawTrip(true));
    $("draw-cancel").addEventListener("click", () => stopDrawTrip(false));
    $("pt-save").addEventListener("click", savePoint);
    $("pt-remove").addEventListener("click", removePoint);

    document.getElementById("c-basemap").addEventListener("change", e => {
      UI.setBasemap(e.target.value, { manual: true });
      UI.showOfflineMap(false);
      restyleRegions();
    });

    // If the active tile provider is unreachable (blocked network), switch to
    // the next provider once automatically; if that fails too, fall back to the
    // bundled offline world overlay instead of a bare dark map. Never cascades
    // through every provider (which just spams status messages).
    const BASEMAP_LABEL = { light: "Esri light", dark: "Esri dark", osm: "OpenStreetMap", esri: "Esri World", "esri-sat": "Esri Satellite" };
    UI.setFallbackHandler((from, to) => {
      const sel = document.getElementById("c-basemap");
      if (to && sel && sel.value === to) return;
      if (to && sel) {
        sel.value = to;
        UI.setBasemap(to, { manual: false });
        restyleRegions();
        setStatus(`Map tiles from ${BASEMAP_LABEL[from] || from} could not be loaded — switched to ${BASEMAP_LABEL[to] || to}.`, false);
      } else {
        UI.showOfflineMap(true);
        setStatus("Map tiles are unavailable — showing the bundled offline background. Check your connection or choose a different basemap.", false);
      }
    });

    function setEditMode(on) {
      state.editMode = !!on;
      updateEditButton();
      UI.setBoxZoom(!state.editMode); // disable shift-drag zoom while editing
      document.getElementById("edit-sidebar").classList.toggle("hidden", !state.editMode);
      if (!state.editMode) { stopDrawTrip(false); clearPointSelection(); state.currentRegionId = null; }
      if (state.editMode) {
        state.currentRegionId = null;
        updateEditPanel();
        setStatus("Edit mode: click a region to add/remove it, right-click to edit dates in the panel.", false);
      }
      render();
    }
    document.getElementById("btn-edit-mode").addEventListener("click", () => setEditMode(!state.editMode));

    const refresh = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); };
    for (const id of ["c-level", "c-metric", "c-res", "c-trail-max", "f-from", "f-to", "f-day", "f-year", "f-accuracy",
      "l-regions", "l-heat", "l-trail", "l-visits", "l-places", "c-online", "l-outlines"]) {
      document.getElementById(id).addEventListener("change", refresh);
      document.getElementById(id).addEventListener("input", refresh);
    }
    // Date browser: mode switching + day navigation.
    const syncDateBrowser = () => {
      const mode = (document.querySelector('input[name="db-mode"]:checked') || {}).value || "range";
      document.getElementById("db-range").classList.toggle("hidden", mode !== "range");
      document.getElementById("db-day").classList.toggle("hidden", mode !== "day");
      document.getElementById("db-year").classList.toggle("hidden", mode !== "year");
    };
    document.querySelectorAll('input[name="db-mode"]').forEach(r => r.addEventListener("change", () => { syncDateBrowser(); refresh(); }));
    const shiftDay = (delta) => {
      const el = document.getElementById("f-day");
      const d = el.value || state.dayKeys[0] || "";
      if (!d) return;
      const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + delta);
      el.value = t.toISOString().slice(0, 10);
      refresh();
    };
    const shiftData = (dir) => {
      if (!state.dayKeys.length) return;
      const cur = document.getElementById("f-day").value;
      const keys = state.dayKeys;
      let target = cur;
      if (dir > 0) { for (const k of keys) if (k > cur) { target = k; break; } if (target === cur) target = keys[keys.length - 1]; }
      else { for (let i = keys.length - 1; i >= 0; i--) if (keys[i] < cur) { target = keys[i]; break; } if (target === cur) target = keys[0]; }
      document.getElementById("f-day").value = target;
      refresh();
    };
    document.getElementById("db-prev").addEventListener("click", () => shiftDay(-1));
    document.getElementById("db-next").addEventListener("click", () => shiftDay(1));
    document.getElementById("db-prev-data").addEventListener("click", () => shiftData(-1));
    document.getElementById("db-next-data").addEventListener("click", () => shiftData(1));
    // Choosing a day or year switches the Date browser into that mode.
    const pickMode = v => { const r = document.querySelector('input[name="db-mode"][value="' + v + '"]'); if (r) r.checked = true; syncDateBrowser(); };
    document.getElementById("f-day").addEventListener("change", () => pickMode("day"));
    document.getElementById("f-year").addEventListener("change", () => pickMode("year"));
    syncDateBrowser();
    const metricSel = document.getElementById("c-metric");
    const colorPicker = document.getElementById("c-single-color");
    const toggleColorPicker = () => { colorPicker.classList.toggle("hidden", metricSel.value !== "single"); };
    metricSel.addEventListener("change", toggleColorPicker);
    colorPicker.addEventListener("input", refresh);
    toggleColorPicker();
    $("btn-clear-log").addEventListener("click", () => { const log = $("import-log"); if (log) log.innerHTML = ""; updateClearLogVisibility(); });
    updateClearLogVisibility();

    // Ctrl-Z / Ctrl-Y undo-redo (skip while typing in inputs).
    document.addEventListener("keydown", e => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = String(e.key).toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });
  }

  return { init, loadData, demoData, __debug: () => state.debug, __toggleRegion: toggleManual, __visited: () => [...state.visitedIds], __expanded: () => [...state.expanded], __expand: expandCountry, __regions: () => state.regionSummaries, __subIds: iso => state.features.filter(f => f.ISO3 === iso && f.level !== "country").map(f => f.id), __continent: () => mostPointsContinent(), __center: () => UI.mapCenter(), __zoom: () => UI.getZoom(), __trail: () => UI.getTrailCoords(), __trips: () => UI.getTripCoords(), __manual: () => [...state.manual.overrides.keys()], __edit: () => state.editMode, __select: id => selectRegion(id, false), __regionPoints: () => state.regionPoints.length, __selectPoint: i => { if (state.regionPoints[i]) selectPoint(state.regionPoints[i]); }, __selectedPoint: () => state.selectedPoint, __removePoint: i => { const p = state.regionPoints[i]; if (p) { pushUndo(); state.rawPoints = state.rawPoints.filter(x => x !== p); state.selectedPoint = null; refreshData(); } }, __undo: undo, __redo: redo, __places: () => state.places.length, __placesLayers: () => UI.groups.places.getLayers().length, __placesOnMap: () => { const g = UI.groups.places; return !!g._map; } };
})();

window.App = App;
document.addEventListener("DOMContentLoaded", App.init);
