#!/usr/bin/env node
/* combine-supplemental.js — merge thousands of Google Photos
 * supplemental-metadata.json files (from a Google Takeout) into one
 * .mapper.json the app can import directly.
 *
 * Usage:
 *   node combine-supplemental.js "<folder>" [output.mapper.json]
 *
 * It recursively scans <folder> for *.json files, keeps the ones shaped like
 * Google Photos metadata (geoData.latitude/longitude + photoTakenTime /
 * creationTime), extracts one point per photo, dedupes, sorts by time, and
 * groups them by UTC day. Each day becomes its own trip line (multi-photo
 * days); single-photo days still count toward the heat grid and region
 * shading even though they can't form a line.
 *
 * Output defaults to "<folder>/combined-photos.mapper.json".
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Recursively collect every .json file under dir.
function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) out.push(p);
    }
  }
  return out;
}

// Extract {lat, lng, ts} from one supplemental-metadata file, or null.
function extractPoint(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch (e) { return null; }
  let j;
  try { j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch (e) { return null; }
  const g = j && j.geoData;
  if (!g || g.latitude == null || g.longitude == null) return null;
  const lat = Number(g.latitude), lng = Number(g.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null; // null-island guard
  const tsRaw = (j.photoTakenTime && j.photoTakenTime.timestamp) != null
    ? j.photoTakenTime.timestamp
    : (j.creationTime && j.creationTime.timestamp);
  if (tsRaw == null) return null;
  const ts = Number(tsRaw) * 1000; // seconds -> ms
  if (!isFinite(ts) || ts <= 0) return null;
  return { lat, lng, ts };
}

function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10); // UTC day
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node combine-supplemental.js <folder> [output.mapper.json]");
    process.exit(1);
  }
  const folder = path.resolve(args[0]);
  if (!fs.existsSync(folder)) { console.error("Folder not found: " + folder); process.exit(1); }
  const outPath = path.resolve(args[1] || path.join(folder, "combined-photos.mapper.json"));

  const files = walk(folder);
  console.log("Scanning " + files.length + " JSON files under " + folder + " ...");

  const seen = new Set();
  const points = [];
  let extracted = 0, dupes = 0, skipped = 0;
  for (const file of files) {
    const p = extractPoint(file);
    if (!p) { skipped++; continue; }
    const key = p.lat.toFixed(6) + "," + p.lng.toFixed(6) + "," + p.ts;
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    points.push(p);
    extracted++;
    if (extracted % 2000 === 0) console.log("  ... " + extracted + " points extracted");
  }

  points.sort((a, b) => a.ts - b.ts);
  const out = {
    generated: new Date().toISOString(),
    version: 1,
    points: points.map(p => ({ lat: p.lat, lng: p.lng, ts: p.ts, src: "trip:" + dayOf(p.ts) })),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  const days = new Set(out.points.map(p => p.src)).size;
  console.log("\nDone.");
  console.log("  Files scanned:    " + files.length);
  console.log("  Points extracted: " + extracted);
  console.log("  Duplicates:       " + dupes);
  console.log("  Skipped (no GPS): " + skipped);
  console.log("  Trip days:        " + days);
  console.log("  Output:           " + outPath);
}

main();
