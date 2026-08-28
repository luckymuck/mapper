/* model.js — canonical data model and helpers.
 *
 * Canonical track point:  { lat, lng, ts (ms epoch), acc (meters), src }
 * Canonical visit:        { lat, lng, start (ms), end (ms), placeId, addr, src }
 */
"use strict";

const Model = {
  // ---- time helpers -------------------------------------------------------
  fmtDate(ts) {
    if (!ts) return "–";
    const t = typeof ts === "number" ? ts : Date.parse(ts);
    if (!isFinite(t)) return "–";
    const d = new Date(t);
    if (isNaN(d.getTime())) return "–";
    return d.toISOString().slice(0, 10);
  },
  fmtDur(ms) {
    if (ms == null || isNaN(ms)) return "–";
    if (ms < 0) ms = 0;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  },

  // ---- point/visit creation ----------------------------------------------
  point(lat, lng, ts, acc, src, mode) {
    const p = { lat, lng, ts: Math.round(ts), acc: acc || 0, src: src || "unknown" };
    if (mode) p.mode = mode;
    return p;
  },
  visit(lat, lng, start, end, placeId, addr, src) {
    return { lat, lng, start: Math.round(start), end: Math.round(end || start), placeId: placeId || null, addr: addr || "", src: src || "unknown" };
  },

  // Sort points by time (stable, in place copy).
  sortPoints(points) {
    return points.slice().sort((a, b) => a.ts - b.ts);
  },

  // Filter points by date range + accuracy + cap. Mutates nothing.
  filterPoints(points, opts = {}) {
    let out = points;
    const acc = opts.maxAccuracy;
    if (acc > 0) out = out.filter(p => p.acc > 0 ? p.acc <= acc : true);
    const from = opts.from;   // ms
    const to = opts.to;       // ms
    if (from) out = out.filter(p => p.ts >= from);
    if (to) out = out.filter(p => p.ts <= to);
    return out;
  },

  // Deterministic downsampling by index (keeps temporal spread).
  sample(points, max) {
    if (points.length <= max) return points;
    const step = points.length / max;
    const out = new Array(max);
    for (let i = 0; i < max; i++) out[i] = points[Math.min(points.length - 1, Math.floor(i * step))];
    return out;
  },

  // Dedupe points (by lat/lng/ts) or visits (by lat/lng/start) so appended
  // files don't double-count.
  dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const p of items) {
      const t = p.ts != null ? p.ts : (p.start != null ? p.start : 0);
      const k = p.lat.toFixed(6) + "," + p.lng.toFixed(6) + "," + t;
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
    return out;
  },

  // Evenly spread n timestamps between start and end (inclusive). Used to
  // auto-date the stops of a trip.
  interpolateDates(n, start, end) {
    const out = [];
    const s = start != null ? start : Date.now();
    const e = end != null ? end : s;
    if (n <= 1) { out.push(s); return out; }
    if (e <= s) { for (let i = 0; i < n; i++) out.push(s); return out; }
    for (let i = 0; i < n; i++) out.push(Math.round(s + (e - s) * (i / (n - 1))));
    return out;
  },

  // Split an ordered point list at the antimeridian so every returned segment
  // stays within ±180° and consecutive points take the shortest route. Lines and
  // region outlines then live on the SAME world copy. Returns [[lat,lng],...][].
  antimeridianSegments(points) {
    const segments = [];
    let cur = null;
    const startNew = () => { cur = []; segments.push(cur); };
    for (let i = 0; i < points.length; i++) {
      if (!cur) startNew();
      const p = points[i];
      if (i > 0) {
        const a = points[i - 1].lng, b = p.lng;
        const d = b - a;
        if (d > 180) {
          // westbound: cross at -180, continue at +180
          const bEff = b - 360;
          const f = (-180 - a) / (bEff - a);
          const lat = points[i - 1].lat + (p.lat - points[i - 1].lat) * f;
          cur.push([lat, -180]);
          startNew();
          cur.push([lat, 180]);
        } else if (d < -180) {
          // eastbound: cross at +180, continue at -180
          const bEff = b + 360;
          const f = (180 - a) / (bEff - a);
          const lat = points[i - 1].lat + (p.lat - points[i - 1].lat) * f;
          cur.push([lat, 180]);
          startNew();
          cur.push([lat, -180]);
        }
      }
      cur.push([p.lat, p.lng]);
    }
    return segments.filter(s => s.length >= 2);
  },

  // Bounding box helper {minLat,maxLat,minLng,maxLng}
  bbox(points) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return { minLat, maxLat, minLng, maxLng };
  },

  // Date-range summary + source list for the sidebar.
  summarize(points, visits) {
    const srcs = new Set();
    points.forEach(p => srcs.add(p.src));
    visits.forEach(v => srcs.add(v.src));
    let min = Infinity, max = -Infinity;
    points.forEach(p => { if (p.ts < min) min = p.ts; if (p.ts > max) max = p.ts; });
    visits.forEach(v => { if (v.start < min) min = v.start; if (v.end > max) max = v.end; });
    return {
      nPoints: points.length,
      nVisits: visits.length,
      sources: [...srcs].join(", ") || "–",
      range: isFinite(min) ? Model.fmtDate(min) + " → " + Model.fmtDate(max) : "–",
    };
  }
};
