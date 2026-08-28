/* geocode.js — parse user-entered point lines and look up places online.
 * Accepts lines like "Los Angeles, California, USA 8/15/2026" (or 8/15/26,
 * 15 Aug 2026, ISO dates) and explicit "lat, lng" coordinates, DMS format
 * like 25°04'50.0"N 121°13'37.3"E, or place names.
 *
 * Previously looked up locations are cached in localStorage so repeated
 * searches avoid the Nominatim API.
 *
 * When Nominatim can't find a place, the geocoder progressively simplifies
 * the query (strip plus-codes, street numbers, non-Latin script, then try
 * city+country, then country only) to maximise hit rate.
 */
"use strict";

const GeoCode = (() => {
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // ---- geocode cache (localStorage) ----
  const CACHE_KEY = "mapper_geocode_cache";
  const CACHE_MAX = 2000;
  let geoCache = null;
  function loadCache() {
    if (geoCache) return geoCache;
    try { geoCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { geoCache = {}; }
    return geoCache;
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(geoCache)); } catch (e) { /* quota exceeded — trim oldest */ }
  }
  function cacheGet(key) {
    const c = loadCache();
    if (c[key]) return c[key];
    return null;
  }
  function cacheSet(key, val) {
    const c = loadCache();
    c[key] = val;
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      for (let i = 0; i < keys.length - CACHE_MAX; i++) delete c[keys[i]];
    }
    saveCache();
  }

  // ---- text cleaning helpers ----

  // Strip Google Plus / Open Location codes: "QF2R+93", "6HMJ+94", etc.
  function stripPlusCodes(s) {
    return s.replace(/\b[A-Z0-9]{4}\+[A-Z0-9]{2,8}\b/g, "").replace(/,\s*,/g, ",").replace(/^\s*,|,\s*$/g, "").trim();
  }

  // Strip postal/zip codes (standalone digits or "10200", "94128").
  function stripPostalCodes(s) {
    return s.replace(/\b\d{4,6}\b/g, "").replace(/,\s*,/g, ",").replace(/^\s*,|,\s*$/g, "").trim();
  }

  // Strip leading house/street numbers: "387 Sukhumvit Rd" → "Sukhumvit Rd".
  function stripStreetNumbers(s) {
    return s.replace(/^\d+[,\s]+/, "").trim();
  }

  // If the string has both Latin and non-Latin (e.g. Thai, Chinese, Arabic)
  // characters, return the Latin-only subset.
  function latinOnly(s) {
    const latin = s.replace(/[^\x00-\x7F]+/g, " ").replace(/\s{2,}/g, " ").trim();
    // Only use it if it left meaningful content (at least 3 chars / 1 word).
    if (latin.length >= 3 && /\b\w{2,}\b/.test(latin)) return latin;
    return null;
  }

  // ---- Nominatim fetch (error-safe) ----
  async function nominatim(query) {
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query);
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) return null;
      return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), display: j[0].display_name || query };
    } catch (e) {
      return null;
    }
  }

  // ---- progressive geocode with fallbacks ----
  async function geocode(place) {
    // 1. Check cache first.
    const key = place.toLowerCase().trim();
    const cached = cacheGet(key);
    if (cached) return cached;

    // 2. Build a list of progressively simpler queries.
    let clean = stripPlusCodes(place);
    const queries = [clean];

    // Strip postal codes.
    const noPostal = stripPostalCodes(clean);
    if (noPostal !== clean) queries.push(noPostal);

    // Try Latin-only if mixed script.
    const lat = latinOnly(clean);
    if (lat && lat !== clean) queries.push(lat);
    const latNoPostal = lat ? stripPostalCodes(lat) : null;
    if (latNoPostal && latNoPostal !== lat && !queries.includes(latNoPostal)) queries.push(latNoPostal);

    // Strip street numbers.
    const noStreet = stripStreetNumbers(clean);
    if (noStreet !== clean && !queries.includes(noStreet)) queries.push(noStreet);

    // Try "city, country" — take the last two comma-separated parts.
    const parts = clean.split(/,\s*/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const short = parts.slice(-2).join(", ");
      if (!queries.includes(short)) queries.push(short);
    }

    // Try just the last part (often the country).
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (last.length >= 3 && !queries.includes(last)) queries.push(last);
    }

    // 3. Try each query, return the first hit.
    for (const q of queries) {
      if (!q || q.length < 2) continue;
      const result = await nominatim(q);
      if (result) {
        cacheSet(key, result);
        return result;
      }
    }
    return null;
  }

  // Extract a date from a line. Returns {ms, match} or null.
  function extractDate(line) {
    const builds = [
      { re: /(\d{4})-(\d{1,2})-(\d{1,2})/, kind: "iso" },
      { re: /(?<![\d])(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?![\d])/, kind: "md" },
      { re: /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/, kind: "dmy" },
      { re: /([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/, kind: "mdy" },
    ];
    const toMs = (b, m) => {
      let y, mo, d;
      if (b.kind === "md") { y = +m[3]; if (y < 100) y += 2000; mo = +m[1] - 1; d = +m[2]; }
      else if (b.kind === "dmy") { mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo == null) return NaN; y = +m[3]; d = +m[1]; }
      else if (b.kind === "mdy") { mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; if (mo == null) return NaN; y = +m[3]; d = +m[2]; }
      else { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
      return Date.UTC(y, mo, d);
    };
    for (const b of builds) {
      const m = line.match(new RegExp(b.re.source + "$"));
      if (m) { const ms = toMs(b, m); if (!isNaN(ms)) return { ms, match: m[0] }; }
    }
    for (const b of builds) {
      const m = line.match(b.re);
      if (m) { const ms = toMs(b, m); if (!isNaN(ms)) return { ms, match: m[0] }; }
    }
    return null;
  }

  // DMS string like "25°04'50.0"N" → decimal degrees. Returns null on failure.
  function dmsToDecimal(dms) {
    const m = dms.match(/(\d+(?:\.\d+)?)\s*[°]\s*(\d+(?:\.\d+)?)\s*[''′]\s*(\d+(?:\.\d+)?)\s*[""″]?\s*([NSEW])/i);
    if (!m) return null;
    let deg = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
    if (m[4].toUpperCase() === "S" || m[4].toUpperCase() === "W") deg = -deg;
    return deg;
  }

  // "lat, lng" (or "lat; lng", "lat lng") → {lat, lng} or null.
  // Also handles DMS format like 25°04'50.0"N 121°13'37.3"E
  function parseCoords(txt) {
    const dmsRe = /\d+(?:\.\d+)?\s*[°]\s*\d+(?:\.\d+)?\s*[''′]\s*\d+(?:\.\d+)?\s*[""″]?\s*[NSEW]/i;
    const dmsMatches = txt.match(new RegExp(dmsRe.source, "gi"));
    if (dmsMatches && dmsMatches.length >= 2) {
      const lat = dmsToDecimal(dmsMatches[0]);
      const lng = dmsToDecimal(dmsMatches[1]);
      if (lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
    const m = txt.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    return null;
  }

  // Parse one user line. Returns {lat,lng,ts,display,geocoded} or null.
  async function parseEntry(line, geocoder = geocode) {
    const dt = extractDate(line);
    const place = dt ? line.replace(dt.match, "").replace(/[,\s]+$/, "").trim() : line.trim();
    if (!place) return null;
    const ts = dt ? dt.ms : Date.now();
    const coords = parseCoords(place);
    if (coords) return { lat: coords.lat, lng: coords.lng, ts, display: place, geocoded: false };
    const g = await geocoder(place);
    if (!g) return null;
    return { lat: g.lat, lng: g.lng, ts, display: g.display || place, geocoded: true };
  }

  return { extractDate, parseCoords, geocode, parseEntry, dmsToDecimal, stripPlusCodes, latinOnly };
})();
