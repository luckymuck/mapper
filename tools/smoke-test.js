/* tools/smoke-test.js — headless sanity checks for the core pipeline. */
"use strict";
const fs = require("fs");
const path = require("path");

const load = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// --- stubs ---
global.window = global;
const fakeCtx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
};
global.document = { createElement: () => ({ getContext: () => fakeCtx, toDataURL: () => "data:image/png;base64,x", width: 0, height: 0 }) };

// rbush
const rbush = require("./rbush.min.js");
global.rbush = rbush;

// app modules (concatenated so shared consts are in one script scope)
eval([
  load("js/model.js"),
  load("js/color.js"),
  load("js/geo.js"),
  load("js/geocode.js"),
  load("js/export.js"),
  load("data/countries.js"),
  load("data/states.js"),
  load("data/us-counties.js"),
  load("data/adm2.js"),
  load("js/boundaries.js"),
  load("js/parsers.js"),
  "global.Model=Model;global.Color=Color;global.Geo=Geo;global.GeoCode=GeoCode;global.Export=Export;global.Parsers=Parsers;global.Boundaries=Boundaries;global.StatesGeoJSON=StatesGeoJSON;",
].join("\n"));

(async () => {
const feats = global.CountriesGeoJSON.features.map(f => ({ id: f.properties.ISO3, name: f.properties.name, geometry: f.geometry }));
const index = Geo.makeIndex(feats);

// synthetic world-traveler points
const DAY = 86400000;
const spots = [
  [37.77, -122.42, "USA"], [47.6, -122.33, "USA"], [40.71, -74.0, "USA"],
  [51.5, -0.13, "GBR"], [48.85, 2.35, "FRA"], [52.52, 13.4, "DEU"],
  [35.68, 139.69, "JPN"], [-33.87, 151.2, "AUS"], [-33.92, 18.42, "ZAF"],
  [-22.9, -43.17, "BRA"], [19.43, -99.13, "MEX"], [30.04, 31.23, "EGY"],
  [1.35, 103.8, "SGP"], [52.37, 4.9, "NLD"], [55.75, 37.61, "RUS"],
];
const pts = [];
let ts = Date.now() - 2 * 365 * DAY;
for (const [lat, lng, iso] of spots) {
  for (let k = 0; k < 30; k++) {
    pts.push(Model.point(lat + (Math.random() - 0.5) * 0.15, lng + (Math.random() - 0.5) * 0.15, ts + k * 3600000, 10, "google"));
  }
  ts += 9 * DAY;
  const [nlat, nlng] = [lat, lng];
  for (let k = 0; k <= 40; k++) {
    const f = k / 40;
    pts.push(Model.point(nlat + (nlat - lat) * 0 + (Math.random() - 0.5) * 4, nlng + (nlng - lng) * 0 + (Math.random() - 0.5) * 4, ts + f * 6 * 3600000, 60, "google"));
  }
  ts += 6 * 3600000 + 3 * DAY;
}

const stats = await Geo.classifyPoints(pts, feats, index, { maxExact: 50000 });
const visited = [...stats.keys()].sort();
console.log("visited countries:", visited.length, visited.join(","));
const expect = ["USA", "GBR", "FRA", "DEU", "JPN", "AUS", "ZAF", "BRA", "MEX", "EGY", "SGP", "NLD", "RUS"];
const missing = expect.filter(e => !visited.includes(e));
if (missing.length) { console.error("MISSING:", missing.join(",")); process.exit(1); }

const st = stats.get("USA");
if (st.count < 60 || !st.first || st.last <= st.first) { console.error("bad USA stats", st); process.exit(1); }
console.log("USA stats ok:", st.count, "points, first", new Date(st.first).toISOString(), "last", new Date(st.last).toISOString());

// grid-representative path (large datasets) still finds the same countries
const gstats = await Geo.classifyPoints(pts, feats, index, { maxExact: 10 });
const gmissing = expect.filter(e => !gstats.has(e));
console.log("grid-path visited:", gstats.size, "missing:", gmissing.length ? gmissing.join(",") : "none");
if (gmissing.length) { console.error("grid path missing countries:", gmissing.join(",")); process.exit(1); }

// reach mask + outline
const mask = Geo.reachMask(pts, 50, 5);
const nWithin = mask.within.reduce((a, b) => a + b, 0);
console.log("reach mask:", mask.cols + "x" + mask.rows, "cells within:", nWithin);
if (nWithin <= 0) { console.error("no reachable cells"); process.exit(1); }

const outline = Geo.outlineGeoJSON(mask, 0.5);
console.log("outline rings:", outline.features.length);
if (!outline.features.length) { console.error("no outline"); process.exit(1); }

// heat canvas (stubbed)
const domain = { minTs: pts[0].ts, maxTs: pts[pts.length - 1].ts, maxDwell: 1e8, maxCount: 1e4 };
const heat = Geo.heatCanvas(mask, "rainbow", domain, 256);
if (!heat.url.startsWith("data:image/png")) { console.error("heat canvas bad"); process.exit(1); }
console.log("heat canvas ok:", heat.width + "x" + heat.height);

// colors
const c1 = Color.colorFor("recency", Date.now() - 1000, {}, Date.now());
const c2 = Color.colorFor("recency", Date.now() - 500 * DAY, {}, Date.now());
const c3 = Color.colorFor("rainbow", 1000, { minTs: 0, maxTs: 2000 }, Date.now());
console.log("colors:", c1, "|", c2, "|", c3);

// google parsers
const legacy = JSON.stringify([{ timestampMs: "1600000000000", latitudeE7: 377749000, longitudeE7: -1224194000, accuracy: 20 }]);
const sem = JSON.stringify({ timelineObjects: [
  { placeVisit: { location: { latitudeE7: 377749000, longitudeE7: -1224194000, placeId: "x", address: "SF" }, duration: { startTimestampMs: "1600000000000", endTimestampMs: "1600003600000" } } },
  { activitySegment: { startLocation: { latitudeE7: 377749000, longitudeE7: -1224194000 }, endLocation: { latitudeE7: 376639000, longitudeE7: -1224070000 }, duration: { startTimestampMs: "1600003600000", endTimestampMs: "1600007200000" } } },
] });
const r1 = Parsers.parseGoogleText(legacy);
const r2 = Parsers.parseGoogleText(sem);
console.log("legacy parsed points:", r1.points.length, "semantic visits:", r2.visits.length, "semantic pts:", r2.points.length);
if (r1.points.length !== 1 || r2.visits.length !== 1) { console.error("parser failure"); process.exit(1); }

// CSV
const csv = "latitude,longitude,timestamp\n40.7,-74.0,2021-01-01T00:00:00Z\n48.85,2.35,2021-01-02T00:00:00Z\n";
const r3 = Parsers.parseCSV(csv);
console.log("csv parsed points:", r3.points.length, "first ts:", new Date(r3.points[0].ts).toISOString());
if (r3.points.length !== 2) { console.error("csv failure"); process.exit(1); }

// global states bundle classification
const stFeats = global.StatesGeoJSON.features.map(f => ({ id: f.id, name: f.properties.name, ISO3: f.properties.ISO3, geometry: f.geometry }));
const stIdx = Geo.makeIndex(stFeats);
const sfStates = Geo.matchPoint(stIdx, stFeats, 37.77, -122.42);
console.log("SF state matches:", [...sfStates].map(id => stFeats.find(f => f.id === id).name));
if (![...sfStates].some(id => /california/i.test(stFeats.find(f => f.id === id).name))) { console.error("SF not in California"); process.exit(1); }
const frState = Geo.matchPoint(stIdx, stFeats, 48.85, 2.35);
console.log("Paris state matches:", [...frState].map(id => stFeats.find(f => f.id === id).name).join(", "));
if (![...frState].length) { console.error("Paris state not found"); process.exit(1); }

// --- newer Google formats ---
// 1) Google Maps "Export timeline" — bare array of timeline objects with
//    TOP-LEVEL startTimestamp/endTimestamp (no duration wrapper)
const mapsExport = JSON.stringify([
  { startTimestamp: "2024-01-01T08:00:00.000Z", endTimestamp: "2024-01-01T10:00:00.000Z",
    placeVisit: { location: { latitudeE7: 485200000, longitudeE7: 24000000, placeId: "x", name: "Kyiv" }, visitConfidence: "HIGH" } },
  { startTimestamp: "2024-01-01T10:00:00.000Z", endTimestamp: "2024-01-01T11:00:00.000Z",
    activitySegment: { startLocation: { latitudeE7: 485200000, longitudeE7: 24000000 }, endLocation: { latitudeE7: 505000000, longitudeE7: 303200000 } } },
]);
const rMaps = Parsers.parseGoogleText(mapsExport);
console.log("maps-export format: visits", rMaps.visits.length, "pts", rMaps.points.length, "visit ts", new Date(rMaps.visits[0].start).toISOString());
if (rMaps.visits.length !== 1 || rMaps.points.length !== 2) { console.error("maps-export parse failure"); process.exit(1); }

// 2) UTF-8 BOM + string latitudeE7 + ISO timestamp (new records.json style)
const bomRec = "\uFEFF" + JSON.stringify([
  { timestamp: "2024-02-01T12:00:00Z", latitudeE7: "377749000", longitudeE7: "-1224194000", accuracyMeters: 12 },
  { timestamp: "1641024000", latitudeE7: 485200000, longitudeE7: 24000000, accuracyMeters: 20 },
]);
const rBom = Parsers.parseGoogleText(bomRec);
console.log("BOM+string records:", rBom.points.length, "pts, first ts", new Date(rBom.points[0].ts).toISOString(), "second ts", new Date(rBom.points[1].ts).toISOString());
if (rBom.points.length !== 2 || rBom.points[1].ts !== 1641024000000) { console.error("BOM/string/seconds parse failure"); process.exit(1); }

// 3) canonical mapper JSON with numeric seconds timestamps
const mj = Parsers.parseMapperJson(JSON.stringify({ points: [{ lat: 40.7, lng: -74.0, ts: 1600000000, src: "test" }], visits: [{ lat: 48.85, lng: 2.35, start: 1600000000, end: 1600003600 }] }));
console.log("mapper.json:", mj.points.length, "pts", mj.visits.length, "visits, ts", new Date(mj.visits[0].start).toISOString());
if (!mj || mj.visits[0].start !== 1600000000000) { console.error("mapper.json seconds failure"); process.exit(1); }

// 4) Google Maps "Export timeline" semanticSegments format (user's file shape)
const segFormat = JSON.stringify({
  semanticSegments: [
    {
      startTime: "2024-11-15T17:00:00.000-08:00",
      endTime: "2024-11-15T19:00:00.000-08:00",
      timelinePath: [
        { point: "37.8168015°, -122.2634391°", time: "2024-11-15T17:29:00.000-08:00" },
        { point: "37.9159883°, -122.3076212°", time: "2024-11-15T18:04:00.000-08:00" },
      ],
    },
    {
      startTime: "2024-11-15T17:29:19.000-08:00",
      endTime: "2024-11-15T18:04:29.000-08:00",
      activity: {
        start: { latLng: "37.8168015°, -122.2634391°" },
        end: { latLng: "37.9159883°, -122.3076212°" },
        parking: { location: { latLng: "37.9144529°, -122.3095843°" }, startTime: "2024-11-15T18:03:46.000-08:00" },
      },
    },
    {
      startTime: "2024-11-16T09:00:00.000-08:00",
      endTime: "2024-11-16T11:00:00.000-08:00",
      placeVisit: { location: { latLng: "37.7749°, -122.4194°", placeId: "p", name: "SF" }, duration: { startTimestampMs: "1731766800000", endTimestampMs: "1731774000000" } },
    },
  ],
});
const rSeg = Parsers.parseGoogleText(segFormat);
console.log("semanticSegments: pts", rSeg.points.length, "visits", rSeg.visits.length);
if (rSeg.points.length < 4 || rSeg.visits.length !== 1) { console.error("semanticSegments parse failure"); process.exit(1); }
const p0 = rSeg.points[0];
if (Math.abs(p0.lat - 37.8168015) > 1e-6 || Math.abs(p0.lng - (-122.2634391)) > 1e-6) { console.error("semanticSegments lat/lng wrong", p0); process.exit(1); }
if (rSeg.visits[0].start !== 1731766800000 || rSeg.visits[0].name !== undefined && rSeg.visits[0].addr !== "SF") { console.error("semanticSegments visit wrong"); process.exit(1); }

// --- per-format fixtures (tools/fixtures/*) ---
{
  const fix = n => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
  // records.json / location-history.json (legacy Locations array)
  const rec = Parsers.parseGoogleText(fix("records.json"));
  const lh = Parsers.parseGoogleText(fix("location-history.json"));
  console.log("fixture records:", rec.points.length, "pts | location-history:", lh.points.length, "pts");
  if (rec.points.length !== 2 || lh.points.length !== 2) { console.error("records/location-history fixture failure"); process.exit(1); }
  // timeline-objects.json (timelineObjects with placeVisit + activitySegment)
  const tobj = Parsers.parseGoogleText(fix("timeline-objects.json"));
  console.log("fixture timeline-objects: visits", tobj.visits.length, "pts", tobj.points.length, "modes", JSON.stringify(tobj.points.map(p => p.mode)));
  if (tobj.visits.length !== 1 || tobj.points.length !== 2) { console.error("timeline-objects fixture failure"); process.exit(1); }
  if (tobj.points[0].mode !== "WALKING" || tobj.points[1].mode !== "WALKING") { console.error("activityType not captured"); process.exit(1); }
  // timeline-semantic.json (semanticSegments)
  const tsem = Parsers.parseGoogleText(fix("timeline-semantic.json"));
  console.log("fixture timeline-semantic: pts", tsem.points.length, "visits", tsem.visits.length, "mode0", tsem.points[0].mode);
  if (tsem.points.length < 3 || tsem.visits.length !== 1 || tsem.points[0].mode !== "IN_BUS") { console.error("timeline-semantic fixture failure"); process.exit(1); }
  // timeline-ios.json (array with visit|activity)
  const tios = Parsers.parseGoogleText(fix("timeline-ios.json"));
  console.log("fixture timeline-ios: visits", tios.visits.length, "pts", tios.points.length, "mode1", tios.points[1].mode);
  if (tios.visits.length !== 1 || tios.points.length !== 2 || tios.points[1].mode !== "CYCLING") { console.error("timeline-ios fixture failure"); process.exit(1); }
  // timeline-array.json (bare array of placeVisit/activitySegment)
  const tarr = Parsers.parseGoogleText(fix("timeline-array.json"));
  console.log("fixture timeline-array: visits", tarr.visits.length, "pts", tarr.points.length, "mode1", tarr.points[1].mode);
  if (tarr.visits.length !== 1 || tarr.points.length !== 2 || tarr.points[1].mode !== "IN_TRAIN") { console.error("timeline-array fixture failure"); process.exit(1); }
  // monthly-2024_01.json (YYYY_MONTH timelineObjects)
  const tmon = Parsers.parseGoogleText(fix("monthly-2024_01.json"));
  console.log("fixture monthly: pts", tmon.points.length, "mode0", tmon.points[0].mode);
  if (tmon.points.length !== 2 || tmon.points[0].mode !== "FLYING") { console.error("monthly fixture failure"); process.exit(1); }
  // mapper.json (canonical, preserves mode)
  const tmap = Parsers.parseMapperJson(fix("mapper.json"));
  console.log("fixture mapper: pts", tmap.points.length, "visits", tmap.visits.length, "manual", tmap.manual.length, "mode0", tmap.points[0].mode);
  if (tmap.points.length !== 2 || tmap.points[0].mode !== "WALKING" || tmap.manual.length !== 1) { console.error("mapper fixture failure"); process.exit(1); }
  // CSV (GPX requires DOMParser, covered in e2e)
  const tcsv = Parsers.parseCSV(fix("sample.csv"));
  console.log("fixture csv:", tcsv.points.length, "pts");
  if (tcsv.points.length !== 3) { console.error("csv fixture failure"); process.exit(1); }
  // mode round-trip through export/import
  const exp = Export.buildSanitizedData({ points: tmap.points, visits: [], manual: new Map(), regions: [] }, { includePoints: true, includeTimestamps: true, precision: 6 });
  const back = Parsers.parseMapperJson(JSON.stringify(exp));
  console.log("fixture mode round-trip:", back.points[0].mode);
  if (back.points[0].mode !== "WALKING") { console.error("mode not preserved through export/import"); process.exit(1); }
}

// --- per-country level fallback (county -> state -> country) ---
// ITA is bundled (ADM2) since the starter set now includes it; BRA still falls
// back to states, SMR to country.
{
  const res = await Boundaries.getFeatures("county", ["USA", "ITA", "BRA", "SMR"], { online: false });
  const byLevel = { county: 0, state: 0, country: 0 };
  for (const f of res.features) byLevel[f.level]++;
  const used = Object.fromEntries(res.levelUsed);
  console.log("fallback: feats", res.features.length, "county", byLevel.county, "state", byLevel.state, "country", byLevel.country, "used", JSON.stringify(used), "note", res.note.join(" | "));
  if (used.USA !== "county" || used.ITA !== "county" || used.BRA !== "state" || used.SMR !== "country") { console.error("levelUsed wrong"); process.exit(1); }
  if (byLevel.county < 50 || byLevel.state < 10 || byLevel.country !== 1) { console.error("fallback feature mix wrong"); process.exit(1); }
  // state level also falls back to country for subdivision-less nations
  const stRes = await Boundaries.getFeatures("state", ["ITA", "SMR"], { online: false });
  const stUsed = Object.fromEntries(stRes.levelUsed);
  console.log("state-level fallback:", JSON.stringify(stUsed));
  if (stUsed.ITA !== "state" || stUsed.SMR !== "country") { console.error("state-level fallback wrong"); process.exit(1); }
  console.log("countryName ITA:", Boundaries.countryName("ITA"));
}

// --- bundled ADM2 (county-level) for the starter set ---
{
  const can = await Boundaries.getSubdivisions("CAN", "county", { online: false });
  console.log("CAN county-level (ADM2):", can.length, "features, sample:", can.slice(0, 3).map(f => f.name).join(" | "));
  if (!can.length || can[0].level !== "county") { console.error("CAN ADM2 missing"); process.exit(1); }
  const usa = Boundaries.usCounties();
  console.log("US counties:", usa.length);
  if (usa.length < 3000) { console.error("US counties missing"); process.exit(1); }
  const canByISO = Boundaries.adm2ByISO().get("CAN");
  if (!canByISO || canByISO.length < 50) { console.error("adm2ByISO CAN wrong"); process.exit(1); }
  // county level with CAN data uses bundled ADM2 (census divisions), not states
  const c2 = await Boundaries.getFeatures("county", ["USA", "CAN"], { online: false });
  const canLevel = c2.levelUsed.get("CAN");
  console.log("county level CAN used:", canLevel, "features:", c2.features.length);
  if (canLevel !== "county") { console.error("CAN should use county-level ADM2"); process.exit(1); }
  // state level for CAN still returns provinces (ADM1)
  const canStates = await Boundaries.getSubdivisions("CAN", "state", { online: false });
  console.log("CAN state-level:", canStates.length, "features");
  if (!canStates.length || canStates[0].level !== "state") { console.error("CAN states missing"); process.exit(1); }
}

// --- dedupe ---
const dupPts = [Model.point(1.234567, 2.345678, 1600000000000, 5, "a"), Model.point(1.234567, 2.345678, 1600000000000, 5, "a"), Model.point(3, 4, 1600003600000, 5, "b")];
const deduped = Model.dedupe(dupPts);
console.log("dedupe:", deduped.length, "(expect 2)");
if (deduped.length !== 2) { console.error("dedupe failure"); process.exit(1); }

// --- sanitized export ---
const xpts = [{ lat: 12.3456789, lng: -77.1234567, ts: 1600000000000, acc: 10, src: "g" }];
const vis = [{ lat: 40.7, lng: -74.0, start: 1600000000000, end: 1600003600000, placeId: "p1", addr: "NYC", src: "g" }];
const regs = [{ id: "US-CA", name: "California", level: "state", country: "United States of America", count: 5, first: 1600000000000, last: 1600003600000, dwell: 600000 }];
const manual = new Map([["US-CA", { status: "dates", first: 1590000000000 }]]);
const full = Export.buildSanitizedData({ points: xpts, visits: vis, manual, regions: regs }, { includeRegions: true, includePoints: true, includeVisits: true, includeManual: true, includeTimestamps: true, includeAddresses: true, precision: 4 });
console.log("export full: pts", full.points.length, "rounded", full.points[0].lat, "visits", full.visits.length, "manual", full.manual.length, "region id", full.regions[0].id);
if (full.points[0].lat !== 12.3457 || full.visits[0].addr !== "NYC" || full.manual[0].id !== "US-CA" || full.regions[0].id !== "US-CA") { console.error("export full wrong"); process.exit(1); }
const priv = Export.buildSanitizedData({ points: xpts, visits: vis, manual, regions: regs }, { includeRegions: true, includePoints: false, includeVisits: true, includeManual: false, includeTimestamps: false, includeAddresses: false, precision: 6 });
console.log("export private: has points?", "points" in priv, "visit date:", priv.visits[0].date, "addr?", "addr" in priv.visits[0], "manual?", "manual" in priv);
if ("points" in priv || "manual" in priv || "addr" in priv.visits[0] || priv.visits[0].start !== undefined) { console.error("export privacy failure"); process.exit(1); }

// --- manual overrides ---
const base = new Map([["A", { count: 3, first: 100, last: 200, dwell: 50 }], ["B", { count: 1, first: 10, last: 20, dwell: 5 }]]);
const o1 = Export.applyManualOverrides(base, new Map([["A", { status: "remove" }], ["C", { status: "add", first: 999, last: 1000 }], ["B", { status: "dates", first: 555 }]]), Date.now());
console.log("overrides: A?", o1.has("A"), "C first", o1.get("C") && o1.get("C").first, "B first", o1.get("B").first);
if (o1.has("A") || !o1.get("C") || o1.get("C").first !== 999 || o1.get("B").first !== 555) { console.error("overrides wrong"); process.exit(1); }

// --- manual import from mapper.json ---
const withManual = Parsers.parseMapperJson(JSON.stringify({ manual: [{ id: "US-CA", status: "add", first: 1600000000000 }] }));
console.log("import manual:", withManual.manual.length, withManual.manual[0].id);
if (!withManual || withManual.manual[0].id !== "US-CA") { console.error("manual import failure"); process.exit(1); }

// --- regions-only export re-import (regions become manual add-overrides) ---
const exported = JSON.stringify({
  generated: "2026-01-01T00:00:00.000Z",
  regions: [
    { id: "US-CA", name: "California", level: "state", country: "United States of America", count: 7, first: "2020-06-01", last: "2024-09-13", dwellMs: 3600000 },
    { id: "FR-ARA", name: "Auvergne-Rhône-Alpes", level: "state", country: "France", count: 3, first: "2021-02-01", last: "2023-04-01", dwellMs: 1200000 },
  ],
});
const reimport = Parsers.parseMapperJson(exported);
console.log("regions-only import: manual", reimport.manual.length, reimport.manual[0].id, reimport.manual[0].status);
if (!reimport || reimport.manual.length !== 2 || reimport.manual[0].id !== "US-CA" || reimport.manual[0].status !== "add") { console.error("regions import failure"); process.exit(1); }

// --- date-only export round-trip (timestamps unchecked) ---
{
  const dateOnly = Export.buildSanitizedData({ points: xpts, visits: vis, manual, regions: regs }, { includeRegions: true, includePoints: true, includeVisits: true, includeManual: true, includeTimestamps: false, includeAddresses: false, precision: 6 });
  if (dateOnly.points[0].ts !== undefined || !dateOnly.points[0].date) { console.error("date-only export should write dates, not ts"); process.exit(1); }
  const rt = Parsers.parseMapperJson(JSON.stringify(dateOnly));
  const expectDay = Date.parse("2020-09-13");
  console.log("date-only reimport: pts", rt.points.length, rt.points[0] && new Date(rt.points[0].ts).toISOString(), "visits", rt.visits.length, rt.visits[0] && new Date(rt.visits[0].start).toISOString());
  if (!rt || rt.points.length !== 1 || rt.points[0].ts !== expectDay) { console.error("date-only point reimport wrong"); process.exit(1); }
  if (rt.visits.length !== 1 || rt.visits[0].start !== expectDay || rt.visits[0].end !== expectDay) { console.error("date-only visit reimport wrong"); process.exit(1); }
}

// --- manual-override merge (import should not wipe existing edits) ---
{
  const existing = new Map([["A", { status: "remove" }]]);
  const changed = Export.mergeManual(existing, new Map([["A", { status: "add", first: 7 }], ["B", { status: "dates", first: 42 }]]));
  console.log("mergeManual: changed", changed, "A", existing.get("A").status, "B first", existing.get("B").first);
  if (changed !== 2 || existing.get("A").status !== "add" || existing.get("A").first !== 7 || existing.get("B").first !== 42) { console.error("mergeManual wrong"); process.exit(1); }
}

// --- source tag round-trip (trip points keep their identity on re-import) ---
{
  const tripPt = [{ lat: 40.7, lng: -74.0, ts: 1600000000000, acc: 0, src: "trip:Trip A" }];
  const exp = Export.buildSanitizedData({ points: tripPt, visits: [], manual: new Map(), regions: [] }, { includePoints: true, includeTimestamps: true, precision: 6 });
  if (exp.points[0].src !== "trip:Trip A") { console.error("export should preserve point src"); process.exit(1); }
  const back = Parsers.parseMapperJson(JSON.stringify(exp));
  console.log("src round-trip:", back.points[0].src);
  if (!back || back.points.length !== 1 || back.points[0].src !== "trip:Trip A") { console.error("point src not preserved on re-import"); process.exit(1); }
}

// --- trip-identity recovery for older exports (points had no src) ---
{
  const old = JSON.stringify({
    version: 1,
    points: [
      { lat: 40, lng: -74, ts: 1600000000000 },
      { lat: 41, lng: -73, ts: 1600003600000 },
    ],
    visits: [{ lat: 40.5, lng: -73.5, start: 1600000000000, end: 1600003600000, src: "trip", addr: "Trip A" }],
  });
  const p = Parsers.parseMapperJson(old);
  console.log("trip recovery:", p.points.map(x => x.src).join(","));
  if (p.points[0].src !== "trip:Trip A" || p.points[1].src !== "trip:Trip A") { console.error("trip recovery failed"); process.exit(1); }
}

// --- photo date-taken extraction ---
{
  const dto = new Date("2023-06-01T10:00:00Z").getTime();
  const t1 = Parsers.photoTimestamp({ DateTimeOriginal: new Date(dto), CreateDate: new Date(dto) });
  console.log("photo date (DateTimeOriginal):", new Date(t1).toISOString());
  if (t1 !== dto) { console.error("photo DateTimeOriginal wrong"); process.exit(1); }
  const t2 = Parsers.photoTimestamp({ gps: { GPSDateStamp: "2022:07:04", GPSTimeStamp: [12, 30, 0] } });
  console.log("photo date (GPS only):", new Date(t2).toISOString());
  if (t2 !== Date.UTC(2022, 6, 4, 12, 30, 0)) { console.error("photo GPS date wrong"); process.exit(1); }
  const t3 = Parsers.photoTimestamp({});
  console.log("photo no-date -> null:", t3);
  if (t3 !== null) { console.error("photo no-date should be null"); process.exit(1); }
  // DateTimeOriginal is earlier than ModifyDate -> picks DateTimeOriginal
  const t4 = Parsers.photoTimestamp({ DateTimeOriginal: new Date(dto), ModifyDate: new Date(dto + 86400000) });
  if (t4 !== dto) { console.error("photo should prefer capture date"); process.exit(1); }
}

// --- user-entered point lines (add-points dialog) ---
{
  const d1 = GeoCode.extractDate("Los Angeles, California, USA 8/15/2026");
  console.log("add date 8/15/2026:", d1 && new Date(d1.ms).toISOString());
  if (!d1 || d1.ms !== Date.UTC(2026, 7, 15) || d1.match !== "8/15/2026") { console.error("date md wrong"); process.exit(1); }
  const d2 = GeoCode.extractDate("Somewhere 8/15/26");
  if (!d2 || d2.ms !== Date.UTC(2026, 7, 15)) { console.error("date 2-digit year wrong"); process.exit(1); }
  const d3 = GeoCode.extractDate("Paris, France 15 Aug 2026");
  console.log("add date 15 Aug 2026:", d3 && new Date(d3.ms).toISOString());
  if (!d3 || d3.ms !== Date.UTC(2026, 7, 15)) { console.error("date dmy wrong"); process.exit(1); }
  const d4 = GeoCode.extractDate("Sydney 2026-08-15");
  if (!d4 || d4.ms !== Date.UTC(2026, 7, 15)) { console.error("date iso wrong"); process.exit(1); }
  const c = GeoCode.parseCoords("34.0522, -118.2437");
  console.log("add coords:", JSON.stringify(c));
  if (!c || Math.abs(c.lat - 34.0522) > 1e-4 || Math.abs(c.lng - (-118.2437)) > 1e-4) { console.error("coords wrong"); process.exit(1); }
  const e1 = await GeoCode.parseEntry("34.0522, -118.2437 8/15/2026");
  console.log("add coord entry:", e1.lat, e1.lng, new Date(e1.ts).toISOString(), "geocoded", e1.geocoded);
  if (!e1 || e1.geocoded !== false || e1.ts !== Date.UTC(2026, 7, 15)) { console.error("coord entry wrong"); process.exit(1); }
  const e2 = await GeoCode.parseEntry("Los Angeles, California, USA 15 Aug 2026", async place => ({ lat: 34.05, lng: -118.24, display: "Los Angeles" }));
  console.log("add place entry:", e2.display, e2.lat, "geocoded", e2.geocoded);
  if (!e2 || e2.geocoded !== true || e2.ts !== Date.UTC(2026, 7, 15)) { console.error("place entry wrong"); process.exit(1); }
  const e3 = await GeoCode.parseEntry("Nowhere, Atlantis 8/15/26", async () => null);
  if (e3 !== null) { console.error("unlocated entry should be null"); process.exit(1); }
}

// --- robust dates: bad values must never crash fmtDate or the overrides ---
{
  console.log("fmtDate guards:", Model.fmtDate(null), Model.fmtDate(1e300), Model.fmtDate("garbage"), Model.fmtDate(1600000000000));
  if (Model.fmtDate(1e300) !== "–" || Model.fmtDate("garbage") !== "–" || Model.fmtDate(1600000000000) === "–") { console.error("fmtDate not defensive"); process.exit(1); }
  const badImport = Parsers.parseMapperJson(JSON.stringify({
    regions: [
      { id: "USA", name: "USA", level: "country", country: "USA", count: 3, first: 1e300, last: 1e300, dwellMs: 0 },
      { id: "FRA", name: "France", level: "country", country: "France", count: 1, first: null, last: null, dwellMs: 0 },
    ],
  }));
  const badStats = Export.applyManualOverrides(new Map(), new Map(badImport.manual.map(m => [m.id, m])), 1700000000000);
  const badFmt = [...badStats.entries()].map(([id, s]) => id + ":" + Model.fmtDate(s.first)).join(", ");
  console.log("bad-date import:", badFmt);
  if (badStats.get("USA").first !== 1700000000000) { console.error("bad date not sanitized to now"); process.exit(1); }
  if (badStats.get("FRA").first !== 1700000000000) { console.error("null date not defaulted"); process.exit(1); }
}

// --- continent lookup + shortest-path unwrapping ---
{
  console.log("continents:", ["USA", "BRA", "FRA", "JPN", "AUS", "EGY"].map(i => i + "=" + Boundaries.continentOf(i)).join(", "));
  if (Boundaries.continentOf("USA") !== "North America") { console.error("continentOf USA wrong"); process.exit(1); }
  if (Boundaries.continentOf("BRA") !== "South America") { console.error("continentOf BRA wrong"); process.exit(1); }
  if (Boundaries.continentOf("JPN") !== "Asia") { console.error("continentOf JPN wrong"); process.exit(1); }

  const segs = Model.antimeridianSegments([
    Model.point(34, -125, 1, 0, "g"),  // USA
    Model.point(35, -179, 2, 0, "g"),  // approaching the antimeridian
    Model.point(36, 179, 3, 0, "g"),   // just past it
    Model.point(35, 139, 4, 0, "g"),   // Japan
  ]);
  console.log("antimeridian segments:", JSON.stringify(segs.map(s => s.map(p => p[1]))));
  if (segs.length !== 2) { console.error("expected 2 segments"); process.exit(1); }
  const all = segs.flat();
  for (const [lat, lng] of all) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { console.error("coords out of range", lat, lng); process.exit(1); }
  }
  // Last segment ends at Japan (lng +139) on the SAME copy as the region polygon.
  const lastSeg = segs[segs.length - 1];
  if (Math.abs(lastSeg[lastSeg.length - 1][1] - 139) > 0.001) { console.error("segment should end at Japan +139"); process.exit(1); }
  // Two-point crossing (Sydney -> LA): shortest route must split into two
  // segments so the line wraps across the seam instead of spanning the world.
  const cross2 = Model.antimeridianSegments([
    Model.point(-33.87, 151.2, 1, 0, "trip:test"),
    Model.point(34.05, -118.24, 2, 0, "trip:test"),
  ]);
  console.log("2pt crossing segments:", JSON.stringify(cross2.map(s => s.map(p => p[1]))));
  if (cross2.length !== 2) { console.error("2pt crossing should split into 2 segments"); process.exit(1); }
  for (const seg of cross2) {
    for (const [lat, lng] of seg) if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { console.error("2pt crossing out of range", lat, lng); process.exit(1); }
  }
}

// --- trip date interpolation ---
{
  const dates = Model.interpolateDates(5, Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 15));
  console.log("interpolateDates:", dates.map(d => Model.fmtDate(d)).join(", "));
  if (dates.length !== 5) { console.error("interpolate count wrong"); process.exit(1); }
  if (dates[0] !== Date.UTC(2026, 7, 1) || dates[4] !== Date.UTC(2026, 7, 15)) { console.error("interpolate endpoints wrong"); process.exit(1); }
  if (!(dates[1] > dates[0] && dates[3] < dates[4])) { console.error("interpolate monotonic wrong"); process.exit(1); }
  const single = Model.interpolateDates(1, Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 15));
  if (single[0] !== Date.UTC(2026, 7, 1)) { console.error("interpolate single wrong"); process.exit(1); }
}

// --- supplemental metadata parser ---
{
  const valid = JSON.stringify({
    title: "test.jpg",
    photoTakenTime: { timestamp: "1243526298" },
    geoData: { latitude: 37.257, longitude: -112.963 }
  });
  const p = Parsers.parseSupplementalMetaFile(valid);
  if (!p) { console.error("supp valid should parse"); process.exit(1); }
  if (Math.abs(p.lat - 37.257) > 0.001) { console.error("supp lat wrong", p.lat); process.exit(1); }
  if (Math.abs(p.lng - (-112.963)) > 0.001) { console.error("supp lng wrong", p.lng); process.exit(1); }
  const expectedTs = 1243526298 * 1000;
  if (p.ts !== expectedTs) { console.error("supp ts wrong", p.ts, expectedTs); process.exit(1); }
  if (p.src !== "supplemental") { console.error("supp src wrong", p.src); process.exit(1); }
  console.log("supp valid:", p.lat, p.lng, new Date(p.ts).toISOString());

  // missing geoData
  const noGeo = JSON.stringify({ photoTakenTime: { timestamp: "1243526298" } });
  if (Parsers.parseSupplementalMetaFile(noGeo) !== null) { console.error("supp noGeo should be null"); process.exit(1); }

  // 0,0 null island
  const nullIsland = JSON.stringify({ photoTakenTime: { timestamp: "1243526298" }, geoData: { latitude: 0, longitude: 0 } });
  if (Parsers.parseSupplementalMetaFile(nullIsland) !== null) { console.error("supp 0,0 should be null"); process.exit(1); }

  // missing timestamp
  const noTs = JSON.stringify({ geoData: { latitude: 1, longitude: 2 } });
  if (Parsers.parseSupplementalMetaFile(noTs) !== null) { console.error("supp noTs should be null"); process.exit(1); }

  // creationTime fallback
  const fallback = JSON.stringify({
    geoData: { latitude: 40, longitude: -74 },
    creationTime: { timestamp: "1609459200" }
  });
  const fb = Parsers.parseSupplementalMetaFile(fallback);
  if (!fb) { console.error("supp creationTime fallback should parse"); process.exit(1); }
  if (fb.ts !== 1609459200000) { console.error("supp fallback ts wrong", fb.ts); process.exit(1); }
  console.log("supp creationTime fallback: OK");

  // invalid JSON
  if (Parsers.parseSupplementalMetaFile("not json") !== null) { console.error("supp bad json should be null"); process.exit(1); }
  console.log("supp: all checks passed");
}

console.log("\nALL CORE CHECKS PASSED");
})().catch(e => { console.error("FALLBACK TEST ERROR", e); process.exit(1); });
