/* ui.js — Leaflet map, layers, legend, busy overlay.
 * Layer contents are cached and reused; toggles only add/remove the group.
 */
"use strict";

const UI = (() => {
  let map;
  const groups = {};
  const baseLayers = {};
  const BASE = {
    // CARTO's public basemaps now require an API key, so light/dark use Esri's
    // free, keyless canvas basemaps instead.
    light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    osm: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    "esri-sat": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  };
  const ATTRIB = {
    light: '&copy; Esri, OpenStreetMap contributors',
    dark: '&copy; Esri, OpenStreetMap contributors',
    osm: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    esri: '&copy; Esri, OpenStreetMap contributors',
    "esri-sat": '&copy; Esri, Maxar, Earthstar Geographics',
  };
  let lastOutline = null, lastHeat = null;
  const trail = { layers: [], mid: [], t: [] };
  const trips = { layers: [], mid: [], t: [] };
  // Auto-fallback: if a tile provider is unreachable (blocked network, like the
  // CDNs some setups cannot reach), switch ONCE to the next working provider
  // instead of leaving a blank/black background. If that provider also fails,
  // stop (no cascade/spam) and show the bundled offline world overlay.
  const FALLBACK_CHAIN = ["light", "osm", "esri", "dark", "esri-sat"];
  const FALLBACK_GRACE_MS = 10000;
  let fallbackCb = null;
  const fallbackTimers = {};
  let autoFellBack = false;
  let offlineLayer = null;
  let offlineOn = false;

  function clearFallbackTimer(key) {
    if (fallbackTimers[key]) { clearTimeout(fallbackTimers[key]); delete fallbackTimers[key]; }
  }
  function tryFallback(fromKey) {
    if (!fallbackCb) return;
    clearFallbackTimer(fromKey);
    let next = null;
    if (!autoFellBack) {
      autoFellBack = true;
      const i = FALLBACK_CHAIN.indexOf(fromKey);
      next = FALLBACK_CHAIN[i + 1] || null;
    }
    fallbackCb(fromKey, next);
  }
  function resetAutoFallback() { autoFellBack = false; }
  function setFallbackHandler(fn) { fallbackCb = fn; }

  // Bundled offline background: a minimal land/sea map + graticule built from
  // the already-loaded world countries data, shown only when no tile provider
  // can be reached. Rendered lazily into a low pane so it never covers regions.
  function buildOfflineMap() {
    const opts = { pane: "offline", interactive: false };
    const l = L.layerGroup();
    if (window.CountriesGeoJSON) {
      L.geoJSON(window.CountriesGeoJSON, Object.assign({}, opts, {
        style: { color: "rgba(255,255,255,0.14)", weight: 0.7, fillColor: "rgba(70,88,118,0.55)", fillOpacity: 0.6 },
      })).addTo(l);
    }
    const lines = [];
    for (let lat = -90; lat <= 90; lat += 30) if (lat !== 0) lines.push([[lat, -180], [lat, 180]]);
    for (let lng = -180; lng <= 180; lng += 30) if (lng !== 0) lines.push([[-90, lng], [90, lng]]);
    L.polyline(lines, Object.assign({}, opts, { color: "rgba(255,255,255,0.05)", weight: 1 })).addTo(l);
    return l;
  }
  function showOfflineMap(on) {
    if (offlineOn === on) return;
    offlineOn = on;
    if (on) {
      if (!offlineLayer) offlineLayer = buildOfflineMap();
      if (!map.hasLayer(offlineLayer)) map.addLayer(offlineLayer);
    } else if (offlineLayer && map.hasLayer(offlineLayer)) {
      map.removeLayer(offlineLayer);
    }
  }

  function init() {
    map = L.map("map", { worldCopyJump: true }).setView([20, 0], 2);
    // Custom pane below the overlay pane: offline background sits above tiles
    // but beneath regions/trail/visits so it never intercepts clicks.
    map.createPane("offline").style.zIndex = 300;
    addBase("light");
    for (const k of ["regions", "heat", "trail", "trips", "visits", "points", "places", "draw"]) {
      groups[k] = L.layerGroup().addTo(map);
    }
    L.control.scale({ imperial: false }).addTo(map);
  }

  function addBase(key) {
    if (baseLayers[key]) { baseLayers[key].bringToBack(); return; }
    const opts = {
      maxZoom: 19,
      crossOrigin: "anonymous",
      attribution: ATTRIB[key] || "&copy; OpenStreetMap contributors",
    };
    const layer = L.tileLayer(BASE[key], opts);
    let loaded = 0, errors = 0;
    layer.on("tileload", () => {
      loaded++;
      clearFallbackTimer(key);
      // recovery: tiles are arriving again, drop the offline overlay
      showOfflineMap(false);
    });
    layer.on("tileerror", () => {
      errors++;
      if (loaded === 0 && errors >= 3) tryFallback(key);
    });
    // If no tile has loaded within the grace period the provider is likely
    // blocked outright; fall back (bounded) rather than leaving a black map.
    fallbackTimers[key] = setTimeout(() => { if (loaded === 0) tryFallback(key); }, FALLBACK_GRACE_MS);
    baseLayers[key] = layer;
    layer.addTo(map);
  }
  function setBasemap(key, opts = {}) {
    if (opts.manual) resetAutoFallback();
    for (const k of Object.keys(baseLayers)) {
      if (k !== key) { map.removeLayer(baseLayers[k]); clearFallbackTimer(k); }
    }
    addBase(key);
  }

  // Disable/enable Leaflet's shift-drag box zoom. In edit mode it is disabled
  // so a shift-click multi-selects regions instead of zooming in on the map.
  function setBoxZoom(on) {
    if (!map.boxZoom) return;
    if (on) map.boxZoom.enable();
    else map.boxZoom.disable();
  }

  function clear() {
    for (const k of Object.keys(groups)) groups[k].clearLayers();
    lastOutline = null; lastHeat = null;
    trail.layers = []; trail.mid = []; trail.t = [];
    trips.layers = []; trips.mid = []; trips.t = [];
  }

  // Show/hide a cached layer group without rebuilding its contents.
  function showGroup(name, on) {
    const g = groups[name];
    if (!g) return;
    const added = map.hasLayer(g);
    if (on && !added) map.addLayer(g);
    else if (!on && added) map.removeLayer(g);
  }

  // Check if a GeoJSON coordinate array (ring or line) has any lng near ±180°.
  function coordsNearAntimeridian(coords) {
    for (const c of coords) {
      if (Array.isArray(c[0])) { if (coordsNearAntimeridian(c)) return true; }
      else if (Math.abs(c[0]) > 160) return true;
    }
    return false;
  }
  // Shift every lng in a coordinate array by offset.
  function shiftCoords(coords, offset) {
    return coords.map(c => Array.isArray(c[0]) ? shiftCoords(c, offset) : [c[0] + offset, c[1]]);
  }
  // Duplicate features whose geometry touches ±180° into ±360° shifted copies.
  // Checks the ENTIRE geometry (all polygons of a MultiPolygon), so features
  // whose seam-crossing part isn't the first polygon (e.g. USA/Alaska, Russia,
  // Fiji, Aleutian counties) still wrap correctly.
  function antimeridianWrapGeoJSON(gj) {
    const extra = [];
    for (const f of gj.features) {
      const geom = f.geometry;
      if (!geom || !geom.coordinates) continue;
      if (coordsNearAntimeridian(geom.coordinates)) {
        for (const shift of [-360, 360]) {
          extra.push({ type: "Feature", properties: f.properties,
            geometry: { type: geom.type, coordinates: shiftCoords(geom.coordinates, shift) } });
        }
      }
    }
    if (!extra.length) return gj;
    return { type: "FeatureCollection", features: gj.features.concat(extra) };
  }

  // styleFn(feature, ctx) -> L path style
  // opts: { edit, drawTrip, onToggle(id), onSelect(id, addToSel), onLayer(id, layer) }
  function renderRegions(geojson, styleFn, opts = {}) {
    groups.regions.clearLayers();
    if (!geojson) return null;
    // Add ±360° shifted copies of any features whose coordinates cross the
    // antimeridian, so they appear on both sides of the map like the trail.
    const wrapped = antimeridianWrapGeoJSON(geojson);
    const layer = L.geoJSON(wrapped, {
      style: f => styleFn(f) || {},
      onEachFeature(f, l) {
        const p = f.properties;
        const s = p._stat;
        opts.onLayer && opts.onLayer(p.id, l);
        const lvl = { county: "County", state: "State / Province", country: "Country" }[p.level] || "Region";
        const head = `<b>${lvl} · ${escapeHtml(p.name || "?")}</b>` +
          (p.country && p.country !== p.name ? `<br><i>${escapeHtml(p.country)}</i>` : "");
        if (opts.edit && !opts.drawTrip) {
          // left-click: select (current) + toggle; shift-click: multi-select only;
          // right-click: select (current) to edit dates in the panel.
          l.on("click", e => {
            const shift = !!(e.originalEvent && e.originalEvent.shiftKey);
            if (shift) { opts.onSelect && opts.onSelect(p.id, true); }
            else { opts.onSelect && opts.onSelect(p.id, false); opts.onToggle && opts.onToggle(p.id); }
          });
          l.on("contextmenu", e => {
            e.originalEvent.preventDefault();
            opts.onSelect && opts.onSelect(p.id, false);
          });
          return;
        }
        if (opts.edit && opts.drawTrip) {
          // during drawing, clicks anywhere on the map add a stop
          return;
        }
        const body = s
          ? `Points: ${s.count.toLocaleString()}<br>First: ${Model.fmtDate(s.first)}<br>Last: ${Model.fmtDate(s.last)}<br>Est. time: ${Model.fmtDur(s.dwell)}`
          : `<i>Not visited</i>`;
        const tip = document.createElement("div");
        tip.className = "region-tip";
        tip.innerHTML = head + `<br>${body}`;
        l.bindPopup(tip, { maxWidth: 280 });
      },
    });
    layer.addTo(groups.regions);
    return layer;
  }

  // Register a map-click handler (used for drawing trips). Returns an off fn.
  function onMapClick(fn) {
    map.on("click", fn);
    return () => map.off("click", fn);
  }

  // ---- draw-a-trip helpers ----
  let drawLine = null;
  function showDrawBar(on) {
    document.getElementById("draw-bar").classList.toggle("hidden", !on);
    if (on) updateDrawCount(0);
  }
  function updateDrawCount(n) {
    document.getElementById("draw-count").textContent = n;
  }
  function addDrawPoint(latlng) {
    L.circleMarker([latlng.lat, latlng.lng], { radius: 5, color: "#fff", weight: 1, fillColor: "#ff8800", fillOpacity: 1 }).addTo(groups.draw);
    const pts = [];
    for (const l of groups.draw.getLayers()) if (l instanceof L.CircleMarker) pts.push(l.getLatLng());
    if (drawLine) { groups.draw.removeLayer(drawLine); drawLine = null; }
    if (pts.length >= 2) drawLine = L.polyline(pts, { color: "#ff8800", weight: 2, opacity: 0.9, interactive: false }).addTo(groups.draw);
    updateDrawCount(pts.length);
  }
  function clearDraw() {
    groups.draw.clearLayers();
    drawLine = null;
  }

  function setHeat(heat) {
    if (heat === lastHeat) return;
    lastHeat = heat;
    groups.heat.clearLayers();
    if (heat) {
      L.imageOverlay(heat.url, heat.bounds, { opacity: 0.8, interactive: false }).addTo(groups.heat);
    }
  }

  // Add antimeridian-split polylines for one contiguous, time-ordered point run
  // to a layer group. Records {layer, mid(ts), t(fraction)} for later recoloring.
  // interactive:false so these lines never intercept clicks meant for regions.
  function addTrailRun(group, store, pts, t) {
    const mid = pts[Math.floor((pts.length - 1) / 2)].ts;
    for (const seg of Model.antimeridianSegments(pts)) {
      const layer = L.polyline(seg, { weight: 2.2, opacity: 0.85, color: "#888", interactive: false }).addTo(group);
      store.layers.push(layer); store.mid.push(mid); store.t.push(t);
      // If any point is near ±180°, add shifted copies for visual wrapping.
      const near = seg.some(p => Math.abs(p[1]) > 160);
      if (near) {
        for (const shift of [-360, 360]) {
          const shifted = seg.map(p => [p[0], p[1] + shift]);
          const sl = L.polyline(shifted, { weight: 2.2, opacity: 0.85, color: "#888", interactive: false }).addTo(group);
          store.layers.push(sl); store.mid.push(mid); store.t.push(t);
        }
      }
    }
  }

  // Recolor an already-built set of polylines for the current metric.
  function recolorLines(store, metric, domain, singleColor) {
    const now = Date.now();
    for (let i = 0; i < store.layers.length; i++) {
      const color = metric === "rainbow"
        ? Color.rampColor(Color.RAINBOW, store.t[i])
        : metric === "single" ? Color.brightenHex(singleColor, -0.25)
        : Color.colorFor(metric === "count" ? "recency" : metric, store.mid[i], domain, now);
      store.layers[i].setStyle({ color, weight: metric === "rainbow" ? 2.6 : 2.2, opacity: 0.85 });
    }
  }

  // Build the main history trail polylines once (rebuild), recolor cheaply later.
  // The trail breaks at large time gaps (separate trips / sessions) so unrelated
  // points are never connected, and caps each polyline at ~167 points.
  function setTrail(sampled, metric, domain, rebuild, singleColor) {
    if (rebuild) {
      groups.trail.clearLayers();
      trail.layers = []; trail.mid = []; trail.t = [];
      if (sampled && sampled.length >= 2) {
        const GAP_MS = 48 * 3600 * 1000; // 48 hours
        const MAX_PTS = 167;
        let segStart = 0;
        for (let i = 1; i < sampled.length; i++) {
          const gap = sampled[i].ts - sampled[i - 1].ts;
          const tooFar = gap > GAP_MS;
          const segFull = (i - segStart) >= MAX_PTS;
          if (tooFar || segFull) {
            if (i - segStart >= 2) addTrailRun(groups.trail, trail, sampled.slice(segStart, i), Math.min(1, segStart / sampled.length));
            segStart = i;
          }
        }
        if (sampled.length - segStart >= 2) addTrailRun(groups.trail, trail, sampled.slice(segStart), Math.min(1, segStart / sampled.length));
      }
    }
    recolorLines(trail, metric, domain, singleColor);
  }

  // Build user-created trip / drawn-trip lines as their own polylines (one per
  // trip group). These are independent of the downsampled trail, so they never
  // disappear when other data is appended or when the trail is downsampled.
  function setTrips(tripGroups, metric, domain, rebuild, singleColor) {
    if (rebuild) {
      groups.trips.clearLayers();
      trips.layers = []; trips.mid = []; trips.t = [];
      const span = Math.max(1, (domain.maxTs || 0) - (domain.minTs || 0));
      for (const grp of tripGroups) {
        if (!grp || grp.length < 2) continue;
        const midTs = grp[Math.floor((grp.length - 1) / 2)].ts;
        const t = Math.max(0, Math.min(1, (midTs - (domain.minTs || 0)) / span));
        addTrailRun(groups.trips, trips, grp, t);
      }
    }
    recolorLines(trips, metric, domain, singleColor);
  }

  function renderVisits(visits, metric, domain, singleColor) {
    groups.visits.clearLayers();
    if (!visits || !visits.length) return;
    const now = Date.now();
    for (const v of visits) {
      const c = metric === "rainbow"
        ? Color.rampColor(Color.RAINBOW, Color.rainbowT(v.end || v.start, domain.minTs, domain.maxTs))
        : metric === "single" ? Color.brightenHex(singleColor, -0.15)
        : Color.colorFor(metric === "count" ? "recency" : metric,
            (metric === "recency" || metric === "count") ? (v.end || v.start) : (v.end - v.start), domain, now);
      L.circleMarker([v.lat, v.lng], {
        radius: 5, color: "#000", weight: 1, fillColor: c, fillOpacity: 0.9,
      }).bindPopup(
        `<b>${escapeHtml(v.addr || "Visit")}</b><br>${Model.fmtDate(v.start)} → ${Model.fmtDate(v.end)}<br>${Model.fmtDur(v.end - v.start)}`
      ).addTo(groups.visits);
    }
  }

  function fitBounds(points) {
    if (!points.length) return;
    const bb = Model.bbox(points);
    map.fitBounds([[bb.minLat, bb.minLng], [bb.maxLat, bb.maxLng]], { padding: [30, 30], maxZoom: 14 });
  }
  function mapCenter() {
    const c = map.getCenter();
    return [c.lat, c.lng];
  }
  function getZoom() {
    return map.getZoom();
  }
  function getTrailCoords() {
    const all = [];
    for (const l of groups.trail.getLayers()) {
      const c = l.getLatLngs();
      if (c && c.length) all.push(c.map(p => [p.lat, p.lng]));
    }
    return all;
  }
  function getTripCoords() {
    const all = [];
    for (const l of groups.trips.getLayers()) {
      const c = l.getLatLngs();
      if (c && c.length) all.push(c.map(p => [p.lat, p.lng]));
    }
    return all;
  }

  // Render clickable point markers (edit mode, for a selected region's points).
  // Each marker calls onSelect(point) when clicked.
  function setPointMarkers(points, onSelect, onMove) {
    groups.points.clearLayers();
    if (!points) return;
    // L.circleMarker does not support draggable; use an L.marker with a CSS
    // circle so points can be dragged to relocate.
    const icon = L.divIcon({ className: "point-marker-ic", html: '<div class="point-marker"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
    for (const p of points) {
      const m = L.marker([p.lat, p.lng], { icon, draggable: true });
      m.on("click", () => onSelect(p));
      m.on("dragend", () => { const ll = m.getLatLng(); onMove && onMove(p, ll.lat, ll.lng); });
      m.addTo(groups.points);
    }
  }

  // Render the "all places" layer: markers sized by visit count, colored by
  // category (home = green, work = blue, other = orange).
  function setPlaces(places) {
    groups.places.clearLayers();
    if (!places || !places.length) return;
    const colors = { home: "#39c46e", work: "#4f9dff", other: "#ff8f4f" };
    for (const p of places) {
      const r = Math.min(4 + Math.log2(p.visits + 1) * 1.6, 14);
      const m = L.circleMarker([p.lat, p.lng], {
        radius: r, color: "#0b0d11", weight: 1, fillColor: colors[p.category] || colors.other, fillOpacity: 0.85,
      });
      const hrs = (p.dwell || 0) / 3600000;
      m.bindPopup(
        `<b>${escapeHtml(p.name || "Place")}</b><br>${escapeHtml(p.addr || "")}<br>` +
        `${p.visits} visit${p.visits === 1 ? "" : "s"} · ${hrs >= 1 ? hrs.toFixed(0) + " h total" : Math.round(hrs * 60) + " min total"}`
      );
      m.addTo(groups.places);
    }
  }

  const CONTINENT_CENTERS = {
    "North America": [40, -100],
    "South America": [-16, -60],
    "Europe": [52, 10],
    "Asia": [40, 95],
    "Africa": [5, 20],
    "Oceania": [-25, 140],
    "Antarctica": [-85, 0],
  };
  // Center the map on a continent while keeping all the data visible.
  function centerOnContinent(continent, points) {
    const center = CONTINENT_CENTERS[continent];
    if (!center || !points.length) return;
    const bb = Model.bbox(points);
    const bounds = [[bb.minLat, bb.minLng], [bb.maxLat, bb.maxLng]];
    let zoom = 3;
    try { zoom = map.getBoundsZoom(bounds, { padding: [30, 30] }); } catch (e) { /* keep default */ }
    zoom = Math.max(1, Math.min(10, zoom));
    map.setView(center, zoom, { animate: false });
  }

  function fitGeojson(gj) {
    if (!gj || !gj.features.length) return;
    const b = L.geoJSON(gj).getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 10 });
  }

  function updateLegend(metric, domain, singleColor) {
    const el = document.getElementById("legend");
    if (!el) return;
    const info = Color.legend(metric, domain, Date.now(), singleColor);
    if (!info.title) { el.classList.add("hidden"); return; }
    el.innerHTML = `<h3>${info.title}</h3>${info.html}<div class="ticks"><span>${escapeHtml(info.note || "")}</span></div>`;
    el.classList.remove("hidden");
  }

  function setBusy(text) {
    const el = document.getElementById("busy");
    const t = document.getElementById("busy-text");
    if (text) { t.textContent = text; el.classList.remove("hidden"); }
    else el.classList.add("hidden");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  return { init, setBasemap, setFallbackHandler, showOfflineMap, resetAutoFallback, setBoxZoom, clear, showGroup, renderRegions, setHeat, setTrail, setTrips, renderVisits, setPointMarkers, setPlaces, fitBounds, fitGeojson, centerOnContinent, mapCenter, getZoom, getTrailCoords, getTripCoords, onMapClick, showDrawBar, updateDrawCount, addDrawPoint, clearDraw, updateLegend, setBusy, escapeHtml, groups };
})();
