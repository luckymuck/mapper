/* geo.js — geospatial engine.
 * Grid aggregation, spatial index + point-in-polygon classification,
 * dwell estimation, 50 km reachability mask, outline tracing, heat-canvas.
 */
"use strict";

const Geo = (() => {
  const R = 6371.0088; // earth radius km
  const DEG = Math.PI / 180;

  function haversineKm(aLat, aLng, bLat, bLng) {
    const dLat = (bLat - aLat) * DEG;
    const dLng = (bLng - aLng) * DEG;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    const h = s1 * s1 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ---------- point-in-polygon (even-odd across all rings) ----------
  function ptInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const latI = ring[i][1], lngI = ring[i][0];   // GeoJSON ring coords: [lng, lat]
      const latJ = ring[j][1], lngJ = ring[j][0];
      const spansLat = (latI > lat) !== (latJ > lat);
      if (spansLat) {
        const xInt = lngI + (lngJ - lngI) * (lat - latI) / (latJ - latI);
        if (lng < xInt) inside = !inside;
      }
    }
    return inside;
  }
  function featureContains(feature, lat, lng) {
    const g = feature.geometry;
    if (!g) return false;
    if (g.type === "Polygon") {
      let inside = false;
      for (const ring of g.coordinates) if (ptInRing(lat, lng, ring)) inside = !inside;
      return inside;
    }
    if (g.type === "MultiPolygon") {
      let inside = false;
      for (const poly of g.coordinates)
        for (const ring of poly) if (ptInRing(lat, lng, ring)) inside = !inside;
      return inside;
    }
    return false;
  }

  // ---------- spatial index (rbush over bboxes) ----------
  const RBushCtor = window.rbush || window.RBush || (typeof RBush !== "undefined" ? RBush : null);
  function makeIndex(features) {
    const idx = new RBushCtor(9);
    const items = [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const bb = featureBBox(f);
      if (!bb) continue;
      items.push({ minX: bb.minLng, minY: bb.minLat, maxX: bb.maxLng, maxY: bb.maxLat, i });
    }
    idx.load(items);
    return idx;
  }
  function featureBBox(f) {
    const g = f.geometry;
    if (!g) return null;
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    const walk = (coords) => {
      if (typeof coords[0] === "number") {
        const [lng, lat] = coords;
        if (lng < minX) minX = lng; if (lng > maxX) maxX = lng;
        if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
      } else for (const c of coords) walk(c);
    };
    walk(g.coordinates);
    if (minX > maxX) return null;
    return { minLat: minY, maxLat: maxY, minLng: minX, maxLng: maxX };
  }
  function matchPoint(index, features, lat, lng) {
    const eps = 1e-9;
    const hits = index.search({ minX: lng - eps, minY: lat - eps, maxX: lng + eps, maxY: lat + eps });
    const out = new Set();
    for (const h of hits) if (featureContains(features[h.i], lat, lng)) out.add(features[h.i].id);
    return out;
  }

  // ---------- grid helpers ----------
  function cellParams(bbox, cellKm) {
    const dLat = cellKm / 111.0;
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const dLng = cellKm / (111.0 * Math.max(0.2, Math.cos(midLat * DEG)));
    return { dLat, dLng, midLat };
  }
  function cellOf(lat, lng, bbox, dLat, dLng) {
    const r = Math.floor((bbox.maxLat - lat) / dLat);
    const c = Math.floor((lng - bbox.minLng) / dLng);
    return [r, c];
  }
  function cellCenter(r, c, bbox, dLat, dLng) {
    return {
      lat: bbox.maxLat - (r + 0.5) * dLat,
      lng: bbox.minLng + (c + 0.5) * dLng,
    };
  }

  // Aggregate sorted points into occupancy grid. Returns Map "r|c" -> stats.
  function occupancyGrid(sortedPoints, bbox, cellKm) {
    const { dLat, dLng } = cellParams(bbox, cellKm);
    const map = new Map();
    let prevKey = null, prevTs = 0;
    const GAP = 30 * 60 * 1000;
    for (const p of sortedPoints) {
      const [r, c] = cellOf(p.lat, p.lng, bbox, dLat, dLng);
      const key = r + "|" + c;
      let cell = map.get(key);
      if (!cell) {
        const ct = cellCenter(r, c, bbox, dLat, dLng);
        cell = { lat: ct.lat, lng: ct.lng, count: 0, first: p.ts, last: p.ts, dwell: 0 };
        map.set(key, cell);
      } else {
        if (p.ts < cell.first) cell.first = p.ts;
        if (p.ts > cell.last) cell.last = p.ts;
      }
      if (prevKey === key && p.ts - prevTs < GAP) cell.dwell += p.ts - prevTs;
      cell.count++;
      prevKey = key; prevTs = p.ts;
    }
    return map;
  }

  // ---------- region classification / stats ----------
  // Returns Promise<Map featureId -> {count, first, last, dwell}>.
  // Chunked with event-loop yields so the UI stays responsive on large sets;
  // opts.onProgress(frac) is called as work proceeds.
  async function classifyPoints(points, features, index, opts = {}) {
    const sorted = Model.sortPoints(points);
    const stats = new Map();
    const get = (id) => {
      let s = stats.get(id);
      if (!s) { s = { count: 0, first: Infinity, last: -Infinity, dwell: 0 }; stats.set(id, s); }
      return s;
    };
    const yieldNow = () => new Promise(r => setTimeout(r, 0));
    const onProgress = opts.onProgress;

    const maxExact = opts.maxExact != null ? opts.maxExact : 60000;
    const chunkSize = opts.chunkSize || 20000;
    const GAP = 30 * 60 * 1000;
    if (sorted.length <= maxExact) {
      // Exact per-point classification with dwell continuity.
      let prevSet = null, prevTs = 0;
      const total = sorted.length;
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const p = sorted[i];
          const hits = matchPoint(index, features, p.lat, p.lng);
          for (const id of hits) {
            const s = get(id);
            s.count++;
            if (p.ts < s.first) s.first = p.ts;
            if (p.ts > s.last) s.last = p.ts;
          }
          if (prevSet && prevSet.size) {
            const gap = p.ts - prevTs;
            if (gap >= 0 && gap < GAP) for (const id of hits) if (prevSet.has(id)) stats.get(id).dwell += gap;
          }
          prevSet = hits; prevTs = p.ts;
        }
        if (end < total) {
          await yieldNow();
          if (onProgress) onProgress(end / total);
        }
      }
    } else {
      // Large datasets: classify grid-cell representatives.
      const bbox = Model.bbox(sorted);
      const cells = occupancyGrid(sorted, bbox, opts.cellKm || 1);
      const reps = [];
      cells.forEach((c, key) => reps.push({ key, lat: c.lat, lng: c.lng, count: c.count, first: c.first, last: c.last, dwell: c.dwell }));
      for (let i = 0; i < reps.length; i++) {
        const rep = reps[i];
        const hits = matchPoint(index, features, rep.lat, rep.lng);
        for (const id of hits) {
          const s = get(id);
          s.count += rep.count;
          if (rep.first < s.first) s.first = rep.first;
          if (rep.last > s.last) s.last = rep.last;
          s.dwell += rep.dwell;
        }
        if (i % 1000 === 0) {
          await yieldNow();
          if (onProgress) onProgress(i / reps.length);
        }
      }
    }
    // prune empty
    for (const [k, v] of stats) if (!v.count) stats.delete(k);
    if (onProgress) onProgress(1);
    return stats;
  }

  // ---------- 50 km reachability mask ----------
  const MAX_MASK = 5e6;
  function reachMask(points, radiusKm, resKm) {
    const bb = Model.bbox(points);
    const midLat = (bb.minLat + bb.maxLat) / 2;
    const padDeg = (radiusKm * 1.05) / 111.0;
    const lngPadDeg = (radiusKm * 1.05) / (111.0 * Math.max(0.2, Math.cos(midLat * DEG)));
    const latMin = bb.minLat - padDeg, latMax = bb.maxLat + padDeg;
    const lngMin = bb.minLng - lngPadDeg, lngMax = bb.maxLng + lngPadDeg;
    const dLat = resKm / 111.0;
    const dLng = resKm / (111.0 * Math.max(0.2, Math.cos(midLat * DEG)));
    let cols = Math.max(1, Math.ceil((lngMax - lngMin) / dLng));
    let rows = Math.max(1, Math.ceil((latMax - latMin) / dLat));
    if (cols * rows > MAX_MASK) {
      // bump resolution up to keep the mask manageable
      const k = Math.sqrt((cols * rows) / MAX_MASK);
      return reachMask(points, radiusKm, resKm * k);
    }
    const n = cols * rows;
    const within = new Uint8Array(n);
    const recency = new Float64Array(n);
    const dwell = new Float64Array(n);
    const count = new Float64Array(n);

    // occupancy at mask resolution (points already sorted by time)
    const sorted = Model.sortPoints(points);
    const cellR = radiusKm / resKm;
    const cidx = (r, c) => r * cols + c;

    const occ = occupancyGrid(sorted, { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax }, resKm);
    const RC = Math.ceil(cellR);
    for (const [, cell] of occ) {
      const [r, c] = cellOf(cell.lat, cell.lng, { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax }, dLat, dLng);
      const r0 = Math.max(0, r - RC), r1 = Math.min(rows - 1, r + RC);
      const c0 = Math.max(0, c - RC), c1 = Math.min(cols - 1, c + RC);
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          const lat = latMax - (rr + 0.5) * dLat;
          const lng = lngMin + (cc + 0.5) * dLng;
          if (haversineKm(cell.lat, cell.lng, lat, lng) > radiusKm) continue;
          const i = cidx(rr, cc);
          within[i] = 1;
          if (cell.last > recency[i]) recency[i] = cell.last;
          dwell[i] += cell.dwell;
          count[i] += cell.count;
        }
      }
    }
    return { cols, rows, latMin, latMax, lngMin, lngMax, dLat, dLng, within, recency, dwell, count };
  }

  // ---------- outline tracing (marching-squares style) ----------
  function outlineRings(mask) {
    const { cols, rows, within, latMin, lngMin, latMax, dLat, dLng } = mask;
    const inCell = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols) ? within[r * cols + c] : 0;
    const vkey = (r, c) => r * (cols + 1) + c;
    const edges = [];
    const adj = new Map();
    const addEdge = (r1, c1, r2, c2) => {
      const id = edges.length;
      edges.push([r1, c1, r2, c2]);
      const k1 = vkey(r1, c1), k2 = vkey(r2, c2);
      if (!adj.has(k1)) adj.set(k1, []);
      if (!adj.has(k2)) adj.set(k2, []);
      adj.get(k1).push(id); adj.get(k2).push(id);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!within[r * cols + c]) continue;
        if (!inCell(r - 1, c)) addEdge(r, c, r, c + 1);
        if (!inCell(r + 1, c)) addEdge(r + 1, c, r + 1, c + 1);
        if (!inCell(r, c - 1)) addEdge(r, c, r + 1, c);
        if (!inCell(r, c + 1)) addEdge(r, c + 1, r + 1, c + 1);
      }
    }
    const used = new Array(edges.length).fill(false);
    const rings = [];
    const toLat = (r) => latMax - r * dLat;
    const toLng = (c) => lngMin + c * dLng;

    for (let start = 0; start < edges.length; start++) {
      if (used[start]) continue;
      const ring = [];
      let cur = start, dir = 1;
      let guard = 0;
      while (!used[cur] && guard++ < edges.length * 2 + 2) {
        used[cur] = true;
        const [r1, c1, r2, c2] = edges[cur];
        const fr = dir === 1 ? r1 : r2, fc = dir === 1 ? c1 : c2;
        const tr = dir === 1 ? r2 : r1, tc = dir === 1 ? c2 : c1;
        ring.push(toLat(fr), toLng(fc));
        const idr = tr - fr, idc = tc - fc;
        const opts = adj.get(vkey(tr, tc)) || [];
        let best = -1, bestScore = -Infinity;
        for (const oid of opts) {
          if (oid === cur || used[oid]) continue;
          const [or1, oc1, or2, oc2] = edges[oid];
          const startsAt = (or1 === tr && oc1 === tc);
          const otr = startsAt ? or2 : or1, otc = startsAt ? oc2 : oc1;
          const odr = otr - tr, odc = otc - tc;
          const cross = idr * odc - idc * odr;
          if (cross > bestScore) { bestScore = cross; best = oid; }
        }
        if (best < 0) break;
        const [br1, bc1] = edges[best];
        cur = best;
        dir = (br1 === tr && bc1 === tc) ? 1 : -1;
      }
      if (ring.length >= 8) {
        ring.push(ring[0], ring[1]);
        const poly = [];
        for (let i = 0; i < ring.length; i += 2) poly.push([ring[i], ring[i + 1]]);
        rings.push(poly);
      }
    }
    return rings;
  }

  // Douglas-Peucker simplification for rings (lon/lat).
  function simplifyRing(ring, tol) {
    if (ring.length < 6) return ring;
    const d = (a, b) => haversineKm(ring[a][0], ring[a][1], ring[b][0], ring[b][1]);
    function dp(lo, hi, out) {
      let maxD = 0, idx = -1;
      for (let i = lo + 1; i < hi; i++) {
        // perpendicular distance from point i to segment (lo,hi)
        const p = ring[i], a = ring[lo], b = ring[hi];
        const seg = d(lo, hi);
        if (seg === 0) continue;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (seg * seg)));
        const px = a[0] + t * (b[0] - a[0]);
        const py = a[1] + t * (b[1] - a[1]);
        const dist = haversineKm(p[0], p[1], px, py);
        if (dist > maxD) { maxD = dist; idx = i; }
      }
      if (maxD > tol && idx !== -1) {
        dp(lo, idx, out);
        dp(idx, hi, out);
      } else {
        out.push(ring[hi]);
      }
    }
    const out = [ring[0]];
    dp(0, ring.length - 1, out);
    return out;
  }

  // Build GeoJSON MultiLineString for the reachable-area outline.
  function outlineGeoJSON(mask, tolKm = 0.5) {
    const rings = outlineRings(mask).map(r => simplifyRing(r, tolKm));
    return {
      type: "FeatureCollection",
      features: rings.map(coords => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords.map(([la, lo]) => [lo, la]) } })),
    };
  }

  // Iterative Douglas-Peucker for an open polyline of point objects {lat,lng}.
  // tolDeg is the perpendicular tolerance in degrees (~111 km/deg). Keeps the
  // first and last points and retains path shape, dropping collinear points.
  function simplifyLine(points, tolDeg) {
    const n = points.length;
    if (n < 3) return points;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = points[a].lng, ay = points[a].lat, bx = points[b].lng, by = points[b].lat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const px = points[i].lng, py = points[i].lat;
        let d;
        if (len2 === 0) d = Math.hypot(px - ax, py - ay);
        else {
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolDeg && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  // ---------- heat canvas (Web-Mercator correct) ----------
  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)); }
  function invMerc(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG; }

  function heatCanvas(mask, metric, domain, maxDim = 640) {
    const { cols, rows, within, recency, dwell, count, latMin, latMax, lngMin, lngMax, dLat, dLng } = mask;
    const yTop = mercY(latMax), yBot = mercY(latMin);
    const aspect = Math.abs(lngMax - lngMin) / Math.max(1e-9, (yBot - yTop)); // width/height
    let W, H;
    if (aspect >= 1) { W = maxDim; H = Math.max(120, Math.round(maxDim / aspect)); }
    else { H = maxDim; W = Math.max(120, Math.round(maxDim * aspect)); }
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const data = img.data;
    const now = Date.now();
    const n = cols * rows;

    for (let py = 0; py < H; py++) {
      const y = yTop + ((py + 0.5) / H) * (yBot - yTop);
      const lat = invMerc(y);
      const rr = Math.floor((latMax - lat) / dLat);
      if (rr < 0 || rr >= rows) continue;
      for (let px = 0; px < W; px++) {
        const lng = lngMin + ((px + 0.5) / W) * (lngMax - lngMin);
        const cc = Math.floor((lng - lngMin) / dLng);
        if (cc < 0 || cc >= cols) continue;
        const i = rr * cols + cc;
        if (!within[i]) continue;
        let color;
        switch (metric) {
          case "dwell": color = Color.colorFor("dwell", dwell[i], domain, now); break;
          case "count": color = Color.colorFor("count", count[i], domain, now); break;
          case "rainbow": color = Color.colorFor("rainbow", recency[i] || domain.maxTs, domain, now); break;
          default: color = Color.colorFor("recency", recency[i], domain, now);
        }
        const m = Color.hexToRgba(color, 0.62);
        const o = (py * W + px) * 4;
        data[o] = m[0]; data[o + 1] = m[1]; data[o + 2] = m[2]; data[o + 3] = m[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return {
      url: canvas.toDataURL("image/png"),
      bounds: [[latMin, lngMin], [latMax, lngMax]],
      width: W, height: H,
    };
  }

  // Estimate total dwell (ms) for a sorted point set (summary figure).
  function totalDwell(sortedPoints) {
    const GAP = 30 * 60 * 1000;
    let total = 0;
    for (let i = 1; i < sortedPoints.length; i++) {
      const g = sortedPoints[i].ts - sortedPoints[i - 1].ts;
      if (g > 0 && g < GAP) total += g;
    }
    return total;
  }

  return {
    haversineKm, ptInRing, featureContains, makeIndex, matchPoint,
    cellParams, cellOf, cellCenter, occupancyGrid, classifyPoints,
    reachMask, outlineGeoJSON, heatCanvas, simplifyRing, simplifyLine, totalDwell,
  };
})();

// small helper for color strings -> rgba bytes (used by heat canvas)
Color.hexToRgba = function (css, alpha) {
  const m = css.match(/\d+(\.\d+)?/g).map(Number);
  return [m[0], m[1], m[2], Math.round(alpha * 255)];
};
