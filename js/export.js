/* export.js — privacy-controlled export + manual (edit-mode) overrides.
 * Pure functions so they can be unit-tested headlessly.
 */
"use strict";

const Export = (() => {
  // Round coordinates to `precision` decimals.
  function round(v, p) {
    const f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  // Build the sanitized canonical data file. Any unchecked category is simply
  // omitted, so nothing a user doesn't want shared ever leaves the device.
  // opts: { includePoints, includeVisits, includeRegions, includeManual,
  //         includeTimestamps, includeAddresses, precision }
  function buildSanitizedData({ points, visits, manual, regions }, opts) {
    const o = opts || {};
    const precision = (o.precision != null ? o.precision : 6);
    const out = { generated: new Date().toISOString(), version: 1 };

    if (o.includePoints && points && points.length) {
      out.points = points.map(p => {
        const pt = { lat: round(p.lat, precision), lng: round(p.lng, precision) };
        if (o.includeTimestamps) pt.ts = p.ts;
        else pt.date = Model.fmtDate(p.ts);
        if (p.acc) pt.acc = p.acc;
        // Preserve the source tag so trip/draw points keep their identity on
        // re-import and are drawn as dedicated trip lines (not downsampled).
        if (p.src) pt.src = p.src;
        // Preserve travel mode for later distance-by-mode / coloring features.
        if (p.mode) pt.mode = p.mode;
        return pt;
      });
    }
    if (o.includeVisits && visits && visits.length) {
      out.visits = visits.map(v => {
        const vt = { lat: round(v.lat, precision), lng: round(v.lng, precision), src: v.src || "unknown" };
        if (o.includeTimestamps) {
          vt.start = v.start;
          vt.end = v.end;
        } else {
          vt.date = Model.fmtDate(v.end || v.start);
        }
        if (o.includeAddresses) {
          if (v.placeId) vt.placeId = v.placeId;
          if (v.addr) vt.addr = v.addr;
        }
        return vt;
      });
    }
    if (o.includeRegions && regions && regions.length) {
      out.regions = regions.map(r => ({
        id: r.id,
        name: r.name,
        level: r.level,
        country: r.country,
        count: r.count,
        first: o.includeTimestamps ? r.first : Model.fmtDate(r.first),
        last: o.includeTimestamps ? r.last : Model.fmtDate(r.last),
        dwellMs: Math.round(r.dwell),
      }));
    }
    if (o.includeManual && manual && manual.size) {
      out.manual = [...manual.entries()].map(([id, m]) => ({
        id,
        status: m.status,
        first: m.first || null,
        last: m.last || null,
        count: m.count || null,
      }));
    }
    return out;
  }

  // Is a value a usable epoch ms? (finite and within Date's range)
  function validDate(v) {
    return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
  }

  // Apply manual edit-mode overrides on top of auto-detected stats.
  // stats: Map<id, {count, first, last, dwell}>. Returns a new Map.
  // Dates are coerced to usable ms so a bad value can never corrupt the map.
  function applyManualOverrides(stats, manual, now) {
    const out = new Map(stats);
    for (const [id, o] of manual) {
      if (!o) continue;
      if (o.status === "remove") {
        out.delete(id);
      } else if (o.status === "add") {
        out.set(id, {
          count: Number(o.count) || 1,
          first: validDate(o.first) ? o.first : now,
          last: validDate(o.last) ? o.last : now,
          dwell: 0,
        });
      } else if (o.status === "dates") {
        const s = out.get(id);
        if (s) {
          if (validDate(o.first)) s.first = o.first;
          if (validDate(o.last)) s.last = o.last;
        }
      }
    }
    return out;
  }

  // Combine visited regions + reachable-area outline into one FeatureCollection.
  function buildOverlays(regionsFC, outlineFC) {
    const features = [];
    if (regionsFC) {
      for (const f of regionsFC.features) {
        if (!f.properties._stat) continue;
        features.push({ type: "Feature", properties: Object.assign({ layer: "regions" }, f.properties), geometry: f.geometry });
      }
    }
    if (outlineFC) {
      for (const f of outlineFC.features) {
        features.push({ type: "Feature", properties: Object.assign({ layer: "reach" }, f.properties), geometry: f.geometry });
      }
    }
    return { type: "FeatureCollection", features };
  }

  // Merge imported manual overrides into an existing override Map. Imported
  // entries win per id; returns the number of ids newly added/overwritten.
  function mergeManual(existing, imported) {
    let changed = 0;
    for (const [id, m] of imported) {
      if (!m) continue;
      existing.set(id, { status: m.status, first: m.first, last: m.last, count: m.count });
      changed++;
    }
    return changed;
  }

  // Build a KML document (Google Earth) from track points + visits.
  function buildKML(points, visits) {
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const coord = (lat, lng) => `${lng},${lat}`;
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>Mapper export</name>\n';
    if (points && points.length) {
      out += '<Placemark>\n<name>Track</name>\n<LineString>\n<altitudeMode>clampToGround</altitudeMode>\n<coordinates>\n';
      for (const p of points) out += coord(p.lat, p.lng) + " 0\n";
      out += '</coordinates>\n</LineString>\n</Placemark>\n';
    }
    if (visits) {
      visits.forEach((v, i) => {
        const when = v.start ? new Date(v.start).toISOString() : "";
        out += '<Placemark>\n<name>' + esc(v.addr || ("Visit " + (i + 1))) + '</name>\n';
        if (when) out += '<TimeStamp><when>' + when + '</when></TimeStamp>\n';
        out += '<Point><coordinates>' + coord(v.lat, v.lng) + '</coordinates></Point>\n</Placemark>\n';
      });
    }
    out += '</Document>\n</kml>\n';
    return out;
  }

  function download(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function downloadJson(filename, obj) {
    download(filename, new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  }

  return { buildSanitizedData, applyManualOverrides, buildOverlays, mergeManual, buildKML, download, downloadJson };
})();
