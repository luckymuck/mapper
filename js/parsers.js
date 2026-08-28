/* parsers.js — ingest Google Takeout, photo EXIF, CSV/GPX, and canonical JSON. */
"use strict";

const Parsers = (() => {
  const isPhotoName = n => /\.(jpe?g|heic|heif|png|webp|tiff?)$/i.test(n);

  // ---------- canonical JSON (desktop tool / exports) ----------
  function parseMapperJson(text) {
    let j;
    try { j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch (e) { return null; }
    const out = { points: [], visits: [], manual: [] };
    const toMs = v => {
      if (typeof v === "string" && /^\d+$/.test(v)) { const n = parseInt(v, 10); return n < 1e12 ? n * 1000 : n; }
      if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
      const d = Date.parse(v);
      return isNaN(d) ? null : d;
    };
    // Exports with "Exact timestamps" unchecked write date-only strings.
    const dateOnlyMs = v => (v == null ? null : Date.parse(v));
    if (Array.isArray(j.points)) {
      for (const p of j.points) {
        if (p.lat == null || p.lng == null) continue;
        const ts = p.ts != null ? toMs(p.ts) : dateOnlyMs(p.date);
        if (ts == null) continue;
        out.points.push(Model.point(+p.lat, +p.lng, ts, p.acc || 0, p.src || "json", p.mode));
      }
    }
    if (Array.isArray(j.visits)) {
      for (const v of j.visits) {
        if (v.lat == null || v.lng == null) continue;
        const start = v.start != null ? toMs(v.start) : dateOnlyMs(v.date);
        const end = v.end != null ? toMs(v.end) : dateOnlyMs(v.date);
        if (start == null && end == null) continue;
        out.visits.push(Model.visit(+v.lat, +v.lng, start || 0, end || start || 0, v.placeId, v.addr, v.src || "json"));
      }
    }
    // Recover trip identity for points exported without a src tag (older
    // exports dropped it). If a trip visit in this file covers a point's
    // timestamp, tag the point as belonging to that trip so it is drawn as a
    // dedicated trip line instead of being folded into the downsampled trail.
    for (const v of out.visits) {
      if ((v.src || "json") !== "trip") continue;
      const addr = v.addr || "Trip";
      const tStart = v.start, tEnd = v.end || v.start;
      for (const p of out.points) {
        if ((p.src || "json") === "json" && p.ts >= tStart && p.ts <= tEnd) p.src = "trip:" + addr;
      }
    }
    if (Array.isArray(j.manual)) {
      for (const m of j.manual) {
        if (!m || !m.id) continue;
        out.manual.push({
          id: m.id,
          status: m.status || "add",
          first: m.first ? toMs(m.first) || null : null,
          last: m.last ? toMs(m.last) || null : null,
          count: m.count || null,
        });
      }
    }
    // Exports may contain only the derived "regions" summary (no raw points).
    // Rebuild the visited set from it as manual add-overrides so the saved map
    // loads again.
    if (Array.isArray(j.regions)) {
      for (const r of j.regions) {
        if (!r || !r.id) continue;
        out.manual.push({
          id: r.id,
          status: "add",
          first: r.first ? toMs(r.first) || null : null,
          last: r.last ? toMs(r.last) || null : null,
          count: r.count || null,
        });
      }
    }
    if (!out.points.length && !out.visits.length && !out.manual.length) return null;
    return out;
  }

  // ---------- Google Takeout / Timeline export ----------
  const stripBom = text => (text.charCodeAt(0) === 0xFEFF) ? text.slice(1) : text;

  // Google timestamps come in many shapes: ISO strings, ms, seconds.
  function tsToMs(v) {
    if (v == null) return NaN;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string") {
      const s = v.trim();
      if (/^\d+$/.test(s)) { const n = parseInt(s, 10); return n < 1e12 ? n * 1000 : n; }
      const d = Date.parse(s);
      return isNaN(d) ? NaN : d;
    }
    return NaN;
  }
  const num = v => { const n = (typeof v === "number") ? v : parseFloat(v); return isNaN(n) ? null : n; };
  // latitudeE7 may be a number or numeric string; also accept plain lat/lng degrees.
  const latOf = r => {
    if (r.latitudeE7 != null) { const n = num(r.latitudeE7); return n == null ? null : n / 1e7; }
    if (r.lat != null) return num(r.lat);
    return null;
  };
  const lngOf = r => {
    if (r.longitudeE7 != null) { const n = num(r.longitudeE7); return n == null ? null : n / 1e7; }
    if (r.lng != null || r.lon != null) return num(r.lng != null ? r.lng : r.lon);
    return null;
  };

  function parseGoogleText(text) {
    let j;
    try { j = JSON.parse(stripBom(text)); } catch (e) { return null; }
    if (Array.isArray(j)) {
      const first = j[0];
      // A bare array of timeline objects (Google Maps "Export timeline").
      if (first && typeof first === "object") {
        if (first.placeVisit || first.activitySegment) return parseSemantic(j);
        // On-device "Timeline.json" (iOS) uses { visit | activity } keys.
        if (first.visit || first.activity) return parseIosArray(j);
      }
      return parseGoogleArray(j);
    }
    if (j && Array.isArray(j.locations)) return parseGoogleArray(j.locations);
    if (j && Array.isArray(j.timelineObjects)) return parseSemantic(j.timelineObjects);
    if (j && Array.isArray(j.semanticSegments)) return parseSemanticSegments(j.semanticSegments);
    if (j && Array.isArray(j.records)) return parseGoogleArray(j.records);
    if (j && Array.isArray(j.data) && j.data[0] && typeof j.data[0] === "object" && (j.data[0].latitudeE7 != null || j.data[0].lat != null)) return parseGoogleArray(j.data);
    return null;
  }

  // On-device Timeline export (iOS/Android) — a top-level array of
// { startTime, endTime, visit | activity }. visit is a location object;
// activity is an object or an array of { startTime, endTime, type, location }.
function parseIosArray(arr) {
    const out = { points: [], visits: [] };
    for (const e of arr) {
      if (!e || typeof e !== "object") continue;
      const t0 = tsToMs(e.startTime), t1 = tsToMs(e.endTime);
      const v = e.visit;
      if (v && typeof v === "object") {
        const loc = v.location || v;
        const lat = latOf(loc), lng = lngOf(loc);
        const vs = tsToMs(v.startTime) || t0;
        const ve = tsToMs(v.endTime) || t1;
        if (lat != null && !isNaN(vs)) {
          out.visits.push(Model.visit(lat, lng == null ? lat : lng, vs, isNaN(ve) ? vs : ve, loc.placeId || v.placeId, v.name || v.address || "", "google"));
          out.points.push(Model.point(lat, lng == null ? lat : lng, vs, 0, "google"));
        }
        continue;
      }
      const acts = Array.isArray(e.activity) ? e.activity : (e.activity && typeof e.activity === "object" ? [e.activity] : []);
      for (const a of acts) {
        if (!a || typeof a !== "object") continue;
        const as = tsToMs(a.startTime) || t0;
        const ae = tsToMs(a.endTime) || t1;
        const mode = a.type || a.activityType;
        const loc = a.location || {};
        const lat = latOf(loc), lng = lngOf(loc);
        if (lat != null && !isNaN(as)) out.points.push(Model.point(lat, lng == null ? lat : lng, as, 0, "google", mode));
        if (a.endLocation) {
          const el = a.endLocation, eLat = latOf(el), eLng = lngOf(el);
          if (eLat != null && !isNaN(ae)) out.points.push(Model.point(eLat, eLng == null ? eLat : eLng, isNaN(ae) ? as : ae, 0, "google", mode));
        }
      }
    }
    return out;
  }

  // Record-style points: Location History.json / records.json.
  function parseGoogleArray(arr) {
    const out = { points: [], visits: [] };
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      if (r.placeVisit || r.activitySegment) {           // mixed timeline objects
        const s = parseSemantic([r]);
        out.points.push(...s.points); out.visits.push(...s.visits);
        continue;
      }
      const lat = latOf(r), lng = lngOf(r);
      if (lat == null || lng == null) continue;
      let ts = tsToMs(r.timestampMs != null ? r.timestampMs : r.timestamp);
      if (isNaN(ts)) ts = tsToMs(r.timeMs);
      if (isNaN(ts)) continue;
      const acc = num(r.accuracyMeters) || num(r.accuracy) || 0;
      out.points.push(Model.point(lat, lng, ts, acc, "google"));
    }
    return out;
  }

  // Timeline objects: place visits + activity segments.
  // Takeout puts timestamps in duration.startTimestampMs; the Maps Timeline
  // export puts startTimestamp/endTimestamp at the top level. Support both.
  function parseSemantic(timelineObjects) {
    const out = { points: [], visits: [] };
    for (const obj of timelineObjects) {
      if (!obj || typeof obj !== "object") continue;
      const t0 = tsToMs(obj.startTimestampMs != null ? obj.startTimestampMs : obj.startTimestamp);
      const t1 = tsToMs(obj.endTimestampMs != null ? obj.endTimestampMs : obj.endTimestamp);
      const pv = obj.placeVisit;
      if (pv) {
        const loc = pv.location || {};
        const dur = pv.duration || {};
        const start = tsToMs(dur.startTimestampMs != null ? dur.startTimestampMs : t0);
        const end = tsToMs(dur.endTimestampMs != null ? dur.endTimestampMs : (isNaN(t1) ? NaN : t1));
        const lat = latOf(loc), lng = lngOf(loc);
        if (!isNaN(start) && lat != null) {
          out.visits.push(Model.visit(
            lat, lng == null ? lat : lng,
            start, isNaN(end) ? start : end,
            loc.placeId, loc.address || loc.name || "", "google"));
        }
        continue;
      }
      const seg = obj.activitySegment;
      if (seg) {
        const dur = seg.duration || {};
        const start = tsToMs(dur.startTimestampMs != null ? dur.startTimestampMs : t0);
        const end = tsToMs(dur.endTimestampMs != null ? dur.endTimestampMs : (isNaN(t1) ? NaN : t1));
        if (isNaN(start)) continue;
        const mode = seg.activityType || seg.activityTypeName;
        const pushLoc = (key, ts) => {
          const l = seg[key] || {};
          const lat = latOf(l), lng = lngOf(l);
          if (lat != null) out.points.push(Model.point(lat, lng == null ? lat : lng, ts, 0, "google", mode));
        };
        pushLoc("startLocation", start);
        pushLoc("endLocation", isNaN(end) ? start : end);
        const wp = seg.waypointPath && seg.waypointPath.waypoints;
        if (Array.isArray(wp)) {
          const n = wp.length;
          for (let i = 0; i < n; i++) {
            const w = wp[i];
            const lat = w && latOf(w), lng = w && lngOf(w);
            if (lat == null) continue;
            const frac = n > 1 ? i / (n - 1) : 0;
            const ts = start + Math.round((isNaN(end) ? start : end) - start) * frac;
            out.points.push(Model.point(lat, lng == null ? lat : lng, ts, 0, "google", mode));
          }
        }
      }
    }
    return out;
  }

  // Parse a Google location string like "37.8168015°, -122.2634391°".
  function parseLatLng(str) {
    if (str == null) return null;
    const m = String(str).match(/-?\d+\.?\d*/g);
    if (!m || m.length < 2) return null;
    const lat = parseFloat(m[0]), lng = parseFloat(m[1]);
    return (isNaN(lat) || isNaN(lng)) ? null : [lat, lng];
  }

  // Google Maps "Export timeline" — { semanticSegments: [...] } with points
  // given as "lat°, lng°" strings inside timelinePath / activity / placeVisit.
  function parseSemanticSegments(segments) {
    const out = { points: [], visits: [] };
    for (const seg of segments) {
      if (!seg || typeof seg !== "object") continue;
      const start = tsToMs(seg.startTime);
      const end = tsToMs(seg.endTime);

      const act = seg.activity;
      const mode = (act && (act.activityType || act.type)) || undefined;
      if (Array.isArray(seg.timelinePath)) {
        for (const tp of seg.timelinePath) {
          const ll = parseLatLng(tp.point);
          const t = tsToMs(tp.time);
          if (ll && !isNaN(t)) out.points.push(Model.point(ll[0], ll[1], t, 0, "google", mode));
        }
      }

      const pv = seg.placeVisit;
      if (pv) {
        const loc = pv.location || {};
        const dur = pv.duration || {};
        const s = tsToMs(dur.startTimestampMs != null ? dur.startTimestampMs : start);
        const e = tsToMs(dur.endTimestampMs != null ? dur.endTimestampMs : end);
        const ll = loc.latLng ? parseLatLng(loc.latLng)
          : (loc.latitudeE7 != null ? [loc.latitudeE7 / 1e7, (loc.longitudeE7 || 0) / 1e7] : null);
        if (ll && !isNaN(s)) {
          out.visits.push(Model.visit(ll[0], ll[1], s, isNaN(e) ? s : e, loc.placeId, loc.address || loc.name || "", "google"));
          out.points.push(Model.point(ll[0], ll[1], s, 0, "google"));
        }
      }

      if (act && !Array.isArray(seg.timelinePath)) {
        const s0 = act.start && parseLatLng(act.start.latLng);
        const s1 = act.end && parseLatLng(act.end.latLng);
        if (s0 && !isNaN(start)) out.points.push(Model.point(s0[0], s0[1], start, 0, "google", mode));
        if (s1 && !isNaN(end)) out.points.push(Model.point(s1[0], s1[1], end, 0, "google", mode));
      }
      if (act && act.parking && act.parking.location) {
        const pl = parseLatLng(act.parking.location.latLng);
        const pt = tsToMs(act.parking.startTime);
        if (pl && !isNaN(pt)) out.points.push(Model.point(pl[0], pl[1], pt, 0, "google"));
      }
    }
    return out;
  }

  async function parseZip(file) {
    const out = { points: [], visits: [], notes: [] };
    const zip = await JSZip.loadAsync(file);
    const files = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const semFiles = files.filter(n => /Semantic Location History\/.*\.json$/i.test(n));
    const recFiles = files.filter(n => /records\.json$/i.test(n));
    const legFiles = files.filter(n => /Location ?History\.json$/i.test(n));
    const targets = [...semFiles, ...recFiles, ...legFiles];
    for (const name of targets) {
      try {
        const text = await zip.files[name].async("string");
        const r = parseGoogleText(text);
        if (r && (r.points.length || r.visits.length)) {
          out.points.push(...r.points); out.visits.push(...r.visits);
        } else {
          out.notes.push(`No location records in "${name}".`);
        }
      } catch (e) { console.warn("skip", name, e.message); }
    }
    if (!targets.length && !files.filter(n => isSuppFile(n)).length) out.notes.push("No Google Location History files found in the zip.");
    const suppInZip = files.filter(n => isSuppFile(n));
    if (suppInZip.length > 0) {
      const pts = [];
      for (const name of suppInZip) {
        try {
          const text = await zip.files[name].async("string");
          const p = parseSupplementalMetaFile(text);
          if (p) pts.push(p);
        } catch (e) { console.warn("skip", name, e.message); }
      }
      if (pts.length === 1) {
        out.points.push(pts[0]);
      } else if (pts.length > 1) {
        pts.sort((a, b) => a.ts - b.ts);
        out.supplemental = { points: pts, count: pts.length, defaultName: "Photo trip" };
      }
    }
    return out;
  }

  // ---------- photos (EXIF) ----------
  // Best available "date taken" for a photo: EXIF DateTimeOriginal, CreateDate,
  // ModifyDate, then GPS date/time. Returns ms epoch or null.
  function photoTimestamp(meta) {
    if (!meta) return null;
    const cands = [];
    const push = v => {
      if (v == null) return;
      if (typeof v === "object" && v.getTime) { const t = v.getTime(); if (!isNaN(t)) cands.push(t); }
      else if (typeof v === "string" || typeof v === "number") { const t = Date.parse(v); if (!isNaN(t)) cands.push(t); }
    };
    push(meta.DateTimeOriginal);
    push(meta.CreateDate);
    push(meta.ModifyDate);
    // GPS date is stored as "YYYY:MM:DD" plus a UTC time array [h, m, s].
    const gps = meta.gps || meta;
    if (gps.GPSDateStamp) {
      const m = String(gps.GPSDateStamp).match(/(\d{4}):(\d{2}):(\d{2})/);
      if (m) {
        const gt = gps.GPSTimeStamp;
        let ms;
        if (Array.isArray(gt) && gt.length >= 3 && gt.every(x => typeof x === "number" || /^\d+(\.\d+)?$/.test(String(x)))) {
          ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +gt[0], +gt[1], +gt[2]);
        } else {
          ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        }
        if (!isNaN(ms)) cands.push(ms);
      }
    }
    cands.sort((a, b) => a - b);
    return cands.length ? cands[0] : null;
  }

  async function parsePhoto(file) {
    const buf = await file.arrayBuffer();
    let meta;
    try {
      meta = await exifr.parse(buf, { tiff: false, ifd0: false, exif: true, gps: true, xmp: false, iptc: false, makerNote: false });
    } catch (e) {
      return null;
    }
    if (!meta || typeof meta.latitude !== "number" || typeof meta.longitude !== "number") return null;
    const ts = photoTimestamp(meta) || Date.now();
    const acc = (meta.gps && meta.gps.GPSHPositioningError) || 0;
    return Model.point(meta.latitude, meta.longitude, ts, acc, "photo:" + file.name);
  }

  // ---------- supplemental metadata JSON (Google Takeout photo metadata) ----------
  function parseSupplementalMetaFile(text) {
    try {
      const j = JSON.parse(text);
      const lat = j.geoData && j.geoData.latitude;
      const lng = j.geoData && j.geoData.longitude;
      if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
      const tsRaw = (j.photoTakenTime && j.photoTakenTime.timestamp) || (j.creationTime && j.creationTime.timestamp);
      if (tsRaw == null) return null;
      const ts = Number(tsRaw) * 1000;
      if (isNaN(ts)) return null;
      return Model.point(lat, lng, ts, 0, "supplemental");
    } catch (e) {
      return null;
    }
  }
  const suppRe = /supplemental-metadata\.json$/i;
  function isSuppFile(name) { return suppRe.test(name); }
  function deriveDefaultTripName(files) {
    if (files.length > 0) {
      const f = files[0];
      if (f.webkitRelativePath) {
        const parts = f.webkitRelativePath.split("/");
        if (parts.length > 1) return parts[parts.length - 2];
      }
      const m = f.name.match(/^(.+?)\.supplemental-metadata\.json$/i);
      if (m) return m[1].replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    }
    return "Photo trip";
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const out = { points: [], visits: [] };
    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return out;
    let delim = ",";
    if (lines[0].includes(";")) delim = ";";
    else if (lines[0].includes("\t")) delim = "\t";
    const rows = lines.map(l => l.split(delim));
    const header = rows[0].map(h => h.trim().toLowerCase());
    const ci = keys => { for (const k of keys) { const i = header.indexOf(k); if (i >= 0) return i; } return -1; };
    const latI = ci(["lat", "latitude", "lat_wgs84", "latwgs84"]);
    const lngI = ci(["lng", "lon", "long", "longitude", "lng_wgs84", "lon_wgs84"]);
    const tsI = ci(["timestamp", "time", "datetime", "date", "ts", "unix", "epoch", "local_time", "utc_time", "timestamp_ms"]);
    if (latI < 0 || lngI < 0) return out;
    const toMs = v => {
      v = (v || "").trim();
      if (!v) return null;
      const num = Number(v);
      if (!isNaN(num) && /^[\d.]+$/.test(v)) {
        if (num > 1e12) return num;        // ms epoch
        if (num > 1e9) return num * 1000;  // s epoch
        return num * 1000;
      }
      const d = Date.parse(v);
      return isNaN(d) ? null : d;
    };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const lat = parseFloat(r[latI]);
      const lng = parseFloat(r[lngI]);
      if (isNaN(lat) || isNaN(lng)) continue;
      const ts = tsI >= 0 ? toMs(r[tsI]) : null;
      out.points.push(Model.point(lat, lng, ts == null ? Date.now() : ts, 0, "csv"));
    }
    return out;
  }

  // ---------- GPX ----------
  function parseGPX(text) {
    const out = { points: [], visits: [] };
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const nodes = doc.querySelectorAll("trkpt, rtept, wpt");
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute("lat"));
      const lon = parseFloat(n.getAttribute("lon"));
      if (isNaN(lat) || isNaN(lon)) continue;
      const t = n.getElementsByTagName("time")[0];
      const ts = t && t.textContent ? Date.parse(t.textContent) : NaN;
      out.points.push(Model.point(lat, lon, isNaN(ts) ? Date.now() : ts, 0, "gpx"));
    }
    return out;
  }

  // ---------- orchestrator ----------
  async function parseFiles(fileList, onProgress) {
    const out = { points: [], visits: [], manual: [], notes: [] };
    const files = Array.from(fileList);
    const suppFiles = files.filter(f => isSuppFile(f.name));
    const otherFiles = files.filter(f => !isSuppFile(f.name));
    if (suppFiles.length > 0) {
      const pts = [];
      for (let i = 0; i < suppFiles.length; i++) {
        const file = suppFiles[i];
        onProgress && onProgress(i + 1, files.length, file.name);
        try {
          const text = await file.text();
          const p = parseSupplementalMetaFile(text);
          if (p) pts.push(p);
        } catch (e) {
          out.notes.push(`Failed to read "${file.name}".`);
        }
      }
      if (pts.length === 1) {
        out.points.push(pts[0]);
      } else if (pts.length > 1) {
        pts.sort((a, b) => a.ts - b.ts);
        out.supplemental = { points: pts, count: pts.length, defaultName: deriveDefaultTripName(suppFiles) };
      }
    }
    for (let i = 0; i < otherFiles.length; i++) {
      const file = otherFiles[i];
      onProgress && onProgress(suppFiles.length + i + 1, files.length, file.name);
      let r = null;
      try {
        const name = file.name.toLowerCase();
        if (name.endsWith(".zip")) {
          r = await parseZip(file);
        } else if (isPhotoName(name) || (file.type || "").startsWith("image/")) {
          const p = await parsePhoto(file);
          if (p) r = { points: [p], visits: [] };
          else out.notes.push(`"${file.name}" has no GPS data (photo or stripped EXIF).`);
        } else {
          const text = await file.text();
          if (name.endsWith(".json")) {
            const mj = parseMapperJson(text);
            if (mj) {
              r = mj;
            } else {
              const g = parseGoogleText(text);
              if (g && (g.points.length || g.visits.length)) {
                r = g;
              } else if (g) {
                out.notes.push(`Parsed "${file.name}" as JSON but found no location records in a known format.`);
              } else {
                out.notes.push(`Could not read "${file.name}" as JSON.`);
              }
            }
          } else if (name.endsWith(".csv")) {
            r = parseCSV(text);
            if (!r.points.length) out.notes.push(`No lat/lng/time columns found in "${file.name}".`);
          } else if (name.endsWith(".gpx")) {
            r = parseGPX(text);
            if (!r.points.length) out.notes.push(`No track points found in "${file.name}".`);
          } else {
            r = parseMapperJson(text) || parseGoogleText(text);
            if (!r) out.notes.push(`Unrecognized file type: "${file.name}".`);
          }
        }
      } catch (e) {
        console.warn("Failed to parse", file.name, e);
        out.notes.push(`Failed to read "${file.name}".`);
      }
      if (r) {
        out.points.push(...(r.points || []));
        out.visits.push(...(r.visits || []));
        if (r.manual) out.manual.push(...r.manual);
        if (r.supplemental) {
          if (!out.supplemental) {
            out.supplemental = r.supplemental;
          } else {
            out.supplemental.points.push(...r.supplemental.points);
            out.supplemental.count += r.supplemental.count;
          }
        }
      }
    }
    if (out.supplemental && out.supplemental.points.length === 1) {
      out.points.push(out.supplemental.points[0]);
      out.supplemental = null;
    } else if (out.supplemental) {
      out.supplemental.points.sort((a, b) => a.ts - b.ts);
    }
    return out;
  }

  return { parseFiles, parseGoogleText, parseMapperJson, parseCSV, parseGPX, parsePhoto, photoTimestamp, parseSupplementalMetaFile };
})();
