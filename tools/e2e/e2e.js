/* e2e.js — headless browser test of the full app using Edge. */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const APP = "file:///" + path.resolve(__dirname, "..", "..", "index.html").replace(/\\/g, "/");
const TMP = path.join(__dirname, "tmp");

const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on("unhandledRejection", err => {
  if (err && (err.name === "TargetClosedError" || /Target page, context or browser has been closed/.test(err.message || ""))) return;
  console.error("unhandledRejection:", err);
  process.exit(1);
});

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const isExpectedNetwork = t => /geoBoundaries|Access to fetch|ERR_FAILED|Failed to load resource|408|allorigins|timeout/i.test(t);
  page.on("console", m => {
    if (m.type() === "error" && !isExpectedNetwork(m.text())) errors.push("console: " + m.text());
  });
  page.on("pageerror", e => {
    if (!isExpectedNetwork(e.message)) errors.push("pageerror: " + e.message);
  });

  const stats = () => page.evaluate(() => ({
    points: document.getElementById("stat-points").textContent,
    visits: document.getElementById("stat-visits").textContent,
    regionPaths: document.querySelectorAll(".leaflet-overlay-pane svg path").length,
    status: document.getElementById("status").textContent,
  }));

  // Toggle edit mode to the desired state via the overlay button.
  const setEdit = async (on) => {
    const cur = await page.evaluate(() => window.App.__edit());
    if (cur !== on) {
      await page.click("#btn-edit-mode");
      await sleep(1500);
    }
  };

  await page.goto(APP, { waitUntil: "load", timeout: 60000 });
  await sleep(2500);
  console.log("page loaded, tiles:", await page.evaluate(() => {
    const imgs = [...document.querySelectorAll(".leaflet-tile-pane img.leaflet-tile")];
    return imgs.filter(i => i.naturalWidth > 0).length + "/" + imgs.length;
  }));

  // Run the rest of the suite with online boundary detail off (the app now
  // defaults it on); the dedicated online test below re-enables it.
  await page.uncheck("#c-online");
  await sleep(500);

  // ---- demo ----
  await page.click("#btn-demo");
  await page.waitForSelector("#summary:not(.hidden)", { timeout: 60000 });
  await sleep(1200);
  console.log("demo:", JSON.stringify(await stats()));

  // ---- map auto-centers on the continent with the most points ----
  const centerCheck = await page.evaluate(() => {
    const cont = window.App.__continent();
    const center = window.App.__center();
    const CENTERS = { "North America": [40, -100], "South America": [-16, -60], "Europe": [52, 10], "Asia": [40, 95], "Africa": [5, 20], "Oceania": [-25, 140] };
    return { cont, center, expected: CENTERS[cont] || null };
  });
  console.log("center check:", JSON.stringify(centerCheck));
  if (!centerCheck.cont) throw new Error("no continent detected");
  if (!centerCheck.expected) throw new Error("unknown continent center: " + centerCheck.cont);
  if (Math.abs(centerCheck.center[1] - centerCheck.expected[1]) > 10) throw new Error("map not centered on main continent: " + centerCheck.cont + " center " + centerCheck.center[1] + " vs " + centerCheck.expected[1]);

  // ---- trail segments are coherent: consecutive points don't jump >180° ----
  const trail = await page.evaluate(() => window.App.__trail());
  let maxJump = 0, badLats = 0;
  for (const seg of trail) {
    for (let i = 1; i < seg.length; i++) maxJump = Math.max(maxJump, Math.abs(seg[i][1] - seg[i - 1][1]));
    for (const p of seg) if (p[0] < -90 || p[0] > 90) badLats++;
  }
  console.log("trail: layers", trail.length, "max internal lng jump", maxJump.toFixed(1), "bad-lats", badLats);
  if (!trail.length) throw new Error("no trail layers");
  if (maxJump > 180) throw new Error("trail segment has a non-direct jump: " + maxJump);
  if (badLats) throw new Error("trail lat out of range: " + badLats);

  // ---- metric change must keep layers visible (regression) ----
  await page.selectOption("#c-metric", "dwell");
  await sleep(1800);
  const metricAfter = await stats();
  console.log("after metric change:", JSON.stringify({ regionPaths: metricAfter.regionPaths }));
  if (!(metricAfter.regionPaths > 0)) throw new Error("metric change cleared the regions");
  await page.selectOption("#c-metric", "recency");
  await sleep(1800);

  // ---- append multiple files ----
  await page.click("#btn-clear");
  await sleep(400);
  await page.setInputFiles("#file-input", path.join(TMP, "Location History.json"));
  await page.waitForFunction(() => document.getElementById("stat-points").textContent === "3", null, { timeout: 30000 });
  console.log("upload legacy:", JSON.stringify(await stats()));

  await page.setInputFiles("#file-input", path.join(TMP, "takeout.zip"));
  await page.waitForFunction(() => document.getElementById("stat-points").textContent === "7", null, { timeout: 30000 });
  await sleep(1200);
  const appended = await stats();
  console.log("append takeout zip:", JSON.stringify(appended));
  if (appended.points !== "7" || appended.visits !== "1") throw new Error("append failed: expected 7 pts / 1 visit");

  await page.setInputFiles("#file-input", path.join(TMP, "Timeline_export.json"));
  await page.waitForFunction(() => document.getElementById("stat-points").textContent === "9", null, { timeout: 30000 });
  await page.setInputFiles("#file-input", path.join(TMP, "Timeline-GoogleAccount-2024.json"));
  await page.waitForFunction(() => document.getElementById("stat-points").textContent === "14", null, { timeout: 30000 });
  await sleep(1200);
  console.log("after 4 appends:", JSON.stringify(await stats()));

  // ---- outlines toggle (at county level: draws every subdivision of visited countries) ----
  await page.click("#btn-demo");
  await page.waitForFunction(() => document.getElementById("stat-points").textContent !== "14", null, { timeout: 60000 });
  await page.selectOption("#c-level", "county");
  await page.uncheck("#l-outlines");
  await sleep(4000);
  const beforeOutlines = (await stats()).regionPaths;
  await page.check("#l-outlines");
  await sleep(4000);
  const afterOutlines = (await stats()).regionPaths;
  console.log("outlines (county): before", beforeOutlines, "after", afterOutlines);
  if (afterOutlines <= beforeOutlines) throw new Error("outlines toggle produced no new paths");
  await page.uncheck("#l-outlines");

  // ---- online county fetch must NOT block the render (background upgrade) ----
  await page.check("#c-online");
  await sleep(7000);
  const onlineRender = await stats();
  console.log("online county render (non-blocking):", JSON.stringify({ regionPaths: onlineRender.regionPaths }));
  if (!(onlineRender.regionPaths > 0)) throw new Error("online mode blocked the render");
  await page.uncheck("#c-online");
  await sleep(1500);

  // ---- county view shades the finest available level per country ----
  // Bundled counties shade as "county"; countries without county data shade
  // their states ("state") as the fallback. Only {county,state,country} may be
  // shaded, and "county" must be present (bundled US/ADM2 counties).
  await sleep(1500);
  const countyLv = await page.evaluate(() => [...new Set(window.App.__regions().map(r => r.level))]);
  console.log("county view shaded levels:", countyLv.join(","));
  if (!countyLv.includes("county")) throw new Error("county view must shade county-level regions: " + countyLv.join(","));
  if (countyLv.some(l => !["county", "state", "country"].includes(l))) throw new Error("county view shaded unexpected levels: " + countyLv.join(","));
  await setEdit(true);
  await sleep(4000);
  const editCountyLv = await page.evaluate(() => [...new Set(window.App.__regions().map(r => r.level))]);
  console.log("edit county view shaded levels:", editCountyLv.join(","));
  // Edit mode must not change the SET of shaded regions (levels only).
  const sameLevels = countyLv.every(l => editCountyLv.includes(l)) && editCountyLv.length === countyLv.length;
  if (!sameLevels) throw new Error("edit mode changed shaded levels: " + countyLv.join(",") + " vs " + editCountyLv.join(","));
  await setEdit(false);
  await sleep(1500);

  await page.selectOption("#c-level", "country");
  await sleep(4000);

  // ---- export modal + downloads ----
  await page.click("#btn-export");
  await page.waitForSelector("#export-modal:not(.hidden)", { timeout: 5000 });
  await page.uncheck("#x-points");
  await page.uncheck("#x-visits");
  let dl = page.waitForEvent("download");
  await page.click("#x-data");
  let d = await dl;
  const dataPath = await d.path();
  const dataJson = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  console.log("export data: keys", Object.keys(dataJson).join(","), "regions", (dataJson.regions || []).length);
  if ("points" in dataJson || "visits" in dataJson) throw new Error("export leaked unchecked data");
  if (!Array.isArray(dataJson.regions) || !dataJson.regions.length) throw new Error("export missing regions");
  if (!dataJson.regions[0].id) throw new Error("export regions missing id");
  fs.writeFileSync(path.join(TMP, "saved-export.json"), JSON.stringify(dataJson));

  dl = page.waitForEvent("download");
  await page.click("#x-overlays");
  d = await dl;
  const ov = JSON.parse(fs.readFileSync(await d.path(), "utf8"));
  console.log("export overlays: features", ov.features.length, "types", [...new Set(ov.features.map(f => f.properties.layer))].join(","));
  if (!ov.features.length) throw new Error("overlays export empty");

  dl = page.waitForEvent("download");
  await page.click("#x-settings");
  d = await dl;
  const setj = JSON.parse(fs.readFileSync(await d.path(), "utf8"));
  console.log("export settings: config.level", setj.config && setj.config.level);
  if (!setj.config || !setj.config.level) throw new Error("settings export invalid");
  await page.click("#x-close");

  // ---- edit mode ----
  await setEdit(true);
  await sleep(1500);
  await page.evaluate(() => window.App.__toggleRegion("USA")); // visited in demo -> toggles off
  await sleep(1500);
  const editAfter = (await stats()).status;
  console.log("edit toggle status:", editAfter);
  if (!/Manual edits: \d/.test(editAfter)) throw new Error("edit toggle did not change a region: " + editAfter);

  // right-click -> region details panel opens (no more popup)
  const opened = await page.evaluate(() => {
    const paths = document.querySelectorAll(".leaflet-overlay-pane path");
    for (const p of paths) {
      p.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, which: 3 }));
      const name = document.getElementById("rd-name").textContent;
      if (name && name !== "–") return "opened " + name;
    }
    return "none (" + paths.length + " paths)";
  });
  console.log("details panel opened:", opened);
  if (!/^opened/.test(opened)) throw new Error("details panel did not open: " + opened);
  // current dates should be shown (read-only) before editing
  const anyCountry = await page.evaluate(() => { const r = window.App.__regions().find(x => x.level === "country"); return r ? r.id : null; });
  if (!anyCountry) throw new Error("no visited country for dates check");
  await page.evaluate(id => window.App.__select(id), anyCountry);
  const curDates = await page.evaluate(() => document.getElementById("rd-current").textContent);
  console.log("current dates (" + anyCountry + "):", curDates);
  if (!/Current: \d{4}-\d{2}-\d{2}/.test(curDates)) throw new Error("current dates not shown: " + curDates);
  await page.fill("#rd-first", "2020-06-01");
  await page.click("#rd-save");
  await sleep(1500);
  const editSaved = (await stats()).status;
  console.log("after date save:", editSaved);
  if (!/Manual edits: \d+/.test(editSaved)) throw new Error("date save failed: " + editSaved);

  // Prev/Next cycle the in-set regions
  const idxBefore = await page.evaluate(() => document.getElementById("rd-name").textContent);
  await page.click("#rd-next");
  await sleep(800);
  const idxNext = await page.evaluate(() => document.getElementById("rd-name").textContent);
  console.log("prev/next:", idxBefore, "->", idxNext);
  if (idxBefore === idxNext) throw new Error("Next did not advance the region");
  await page.click("#rd-prev");
  await sleep(800);

  // Shift all dates by +1 day
  await page.fill("#rd-shift", "1");
  await page.click("#rd-shift-apply");
  await sleep(1500);
  console.log("after shift-all:", (await stats()).status);

  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await sleep(1500);
  await setEdit(false);

  // ---- bug 4: removing a country's last region hides its outlines ----
  await page.check("#l-outlines");
  await sleep(2000);
  const p0 = (await stats()).regionPaths;
  await setEdit(true);
  await sleep(2000);
  await page.evaluate(() => window.App.__toggleRegion("USA")); // USA is visited in the demo
  await sleep(1500);
  await setEdit(false);
  await sleep(2000);
  const p1 = (await stats()).regionPaths;
  console.log("outlines after removing a region:", p0, "->", p1);
  if (!(p1 < p0)) throw new Error("outlines not removed for a country with no regions");
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await page.uncheck("#l-outlines");
  await sleep(1500);

  // ---- issue 1: edit mode loads only countries in the data (lazy); clicking
  //     an unvisited country expands it and loads its subdivisions ----
  await page.selectOption("#c-level", "state");
  await sleep(6000);
  await setEdit(true);
  await sleep(8000);
  const lazyPaths = (await stats()).regionPaths;
  const globalCount = await page.evaluate(() => (window.StatesGeoJSON ? window.StatesGeoJSON.features.length : 0) + (window.CountriesGeoJSON ? window.CountriesGeoJSON.features.length : 0));
  console.log("edit state-level paths (lazy):", lazyPaths, "of global", globalCount);
  if (!(lazyPaths > 150 && lazyPaths < globalCount)) throw new Error("edit mode should be lazy (countries + visited states): " + lazyPaths);

  // ---- edit mode looks like the normal map: selected shaded (metric), unselected lines ----
  const fillStats = await page.evaluate(() => {
    const paths = [...document.querySelectorAll(".leaflet-overlay-pane path")];
    const fo = p => parseFloat(p.getAttribute("fill-opacity") || "0") || 0;
    return {
      shaded: paths.filter(p => fo(p) >= 0.5).length,
      lines: paths.filter(p => p.getAttribute("fill") === "none" || fo(p) <= 0.05).length,
    };
  });
  console.log("edit fill stats:", JSON.stringify(fillStats));
  if (!(fillStats.shaded > 0 && fillStats.lines > 0)) throw new Error("edit mode should shade selected and keep unselected as lines: " + JSON.stringify(fillStats));

  // ---- unselected outlines adapt to the basemap (dark on light, white on dark) ----
  const unselectedStroke = () => page.evaluate(() => {
    const p = [...document.querySelectorAll(".leaflet-overlay-pane path")]
      .find(x => x.getAttribute("fill") === "none" && parseFloat(x.getAttribute("stroke-width") || "99") <= 1.0 && x.getAttribute("stroke") && x.getAttribute("stroke") !== "none");
    return p ? p.getAttribute("stroke") : null;
  });
  const lightStroke = await unselectedStroke();
  await page.selectOption("#c-basemap", "dark");
  await sleep(1200);
  const darkStroke = await unselectedStroke();
  await page.selectOption("#c-basemap", "light");
  await sleep(1200);
  console.log("outline stroke: light-basemap", lightStroke, "| dark-basemap", darkStroke);
  if (!lightStroke || !darkStroke || lightStroke === darkStroke) throw new Error("outline contrast should change with basemap: " + lightStroke + " vs " + darkStroke);

  // ---- H1: interior clicks on unvisited (fill=none) edit-mode regions ----
  // Verify the topmost element at an unvisited region's interior is the
  // region-hit path itself (pointer-events override) and that a real click
  // registers an edit.
  const unvisitedTargets = await page.evaluate(() => {
    const paths = [...document.querySelectorAll(".leaflet-overlay-pane path")]
      .filter(p => p.getAttribute("fill") === "none" && (p.getAttribute("class") || "").includes("region-hit"));
    const out = [];
    for (const p of paths) {
      const r = p.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (r.width < 30 || r.height < 20 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (top && top.tagName === "path" && (top.getAttribute("class") || "").includes("region-hit") && top.getAttribute("fill") === "none") {
        out.push({ x, y });
        if (out.length >= 8) break;
      }
    }
    return out;
  });
  let unvisitedHit = false;
  for (const t of unvisitedTargets) {
    await page.mouse.click(t.x, t.y);
    await sleep(500);
    const st = await page.evaluate(() => document.getElementById("status").textContent);
    if (/Manual edits: \d|Loaded \d+ subdivisions|No subdivision data/.test(st)) { unvisitedHit = true; break; }
  }
  console.log("interior click on unvisited region:", unvisitedHit, "(" + unvisitedTargets.length + " candidates)");
  if (!unvisitedHit) throw new Error("interior clicks on unvisited (fill=none) regions do not register");
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await sleep(1200);

  // ---- real mouse click (hit-testing) must register on a polygon interior ----
  let realHit = false;
  const boxes = await page.evaluate(() => {
    return [...document.querySelectorAll(".leaflet-overlay-pane path")]
      .filter(p => parseFloat(p.getAttribute("fill-opacity") || "0") >= 0.5)
      .slice(0, 15)
      .map(p => {
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      })
      .filter(b => b.w > 10 && b.h > 10);
  });
  for (const b of boxes) {
    await page.mouse.click(b.x, b.y);
    await sleep(250);
    const st = await page.evaluate(() => document.getElementById("status").textContent);
    if (/Manual edits: \d|Loaded \d+ subdivisions/.test(st)) { realHit = true; break; }
  }
  console.log("real mouse click hit region:", realHit);
  if (!realHit) throw new Error("real map click did not hit a region (fill not clickable?)");
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await sleep(1200);

  // ---- left-click add must fill the region (fill:true regression) ----
  const unvisitedState = await page.evaluate(() => {
    const visited = new Set(window.App.__visited());
    return window.App.__subIds("USA").find(id => !visited.has(id)) || null;
  });
  console.log("unvisited state for add-fill test:", unvisitedState);
  if (!unvisitedState) throw new Error("no unvisited US state");
  const shadedCount = () => page.evaluate(() =>
    [...document.querySelectorAll(".leaflet-overlay-pane path")].filter(p => parseFloat(p.getAttribute("fill-opacity") || "0") >= 0.5).length);
  const shadedBefore = await shadedCount();
  await page.evaluate(id => window.App.__toggleRegion(id), unvisitedState);
  await sleep(1500);
  const shadedAfter = await shadedCount();
  console.log("shaded before/after add:", shadedBefore, "->", shadedAfter);
  if (!(shadedAfter > shadedBefore)) throw new Error("left-click add did not fill the region");
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await sleep(1200);

  // ---- point markers for selected region + remove a point ----
  const stateReg = await page.evaluate(() => { const r = window.App.__regions().find(x => x.level === "state" && x.count > 0); return r ? r.id : null; });
  console.log("selected region for point test:", stateReg);
  if (!stateReg) throw new Error("no visited state for point test");
  await page.evaluate(id => window.App.__select(id), stateReg);
  await sleep(800);
  const regionPtCount = await page.evaluate(() => window.App.__regionPoints());
  console.log("region points:", regionPtCount);
  if (regionPtCount < 1) throw new Error("expected point markers for selected region");
  await page.evaluate(() => window.App.__selectPoint(0));
  await sleep(300);
  const pointPanelVisible = await page.evaluate(() => !document.getElementById("point-block").classList.contains("hidden"));
  console.log("point panel visible:", pointPanelVisible);
  if (!pointPanelVisible) throw new Error("point panel not shown after selecting a point");
  const ptsBefore = parseInt((await stats()).points.replace(/,/g, ""), 10);
  await page.click("#pt-remove");
  await sleep(2000);
  const ptsAfter = parseInt((await stats()).points.replace(/,/g, ""), 10);
  console.log("points before/after remove:", ptsBefore, "->", ptsAfter);
  if (!(ptsAfter < ptsBefore)) throw new Error("point removal did not reduce point count");


  const beforeExpand = (await stats()).regionPaths;
  const expandTarget = await page.evaluate(() => {
    const expanded = new Set(window.App.__expanded());
    const feats = window.CountriesGeoJSON.features.map(f => f.properties.ISO3).filter(Boolean);
    return feats.find(c => /^[A-Z]{3}$/.test(c) && !expanded.has(c)) || "FJI";
  });
  console.log("expanding unvisited country:", expandTarget);
  await page.evaluate(iso => window.App.__expand(iso), expandTarget); // resolves after load
  await sleep(1500);
  const afterExpand = await page.evaluate(() => ({
    paths: document.querySelectorAll(".leaflet-overlay-pane path").length,
    status: document.getElementById("status").textContent,
  }));
  console.log("expand:", beforeExpand, "->", afterExpand.paths, "|", afterExpand.status);
  if (!(afterExpand.paths > beforeExpand)) throw new Error("expanding a country should add its subdivisions");
  if (!/Loaded \d+ subdivisions for /.test(afterExpand.status)) throw new Error("expand status wrong: " + afterExpand.status);

  // ---- issue 2: an edit click must not re-classify or re-mask ----
  // An edit click must not re-classify or re-mask. Captured synchronously in the
  // SAME task as the click: the click handler (toggleManual -> applyEdit) never
  // reclassifies — only an async background render could, so comparing within
  // one task is deterministic even while online ADM2 is still loading.
  const clickRes = await page.evaluate(() => {
    const before = window.App.__debug();
    const paths = document.querySelectorAll(".leaflet-overlay-pane path");
    let toggled = false;
    for (const p of paths) {
      p.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      if (/Manual edits: \d/.test(document.getElementById("status").textContent)) { toggled = true; break; }
    }
    const after = window.App.__debug();
    return { before, after, toggled };
  });
  await sleep(1500);
  const clickStatus = (await stats()).status;
  console.log("edit click debug:", JSON.stringify(clickRes.before), "->", JSON.stringify(clickRes.after));
  if (!clickRes.toggled) throw new Error("no region toggled at state level");
  if (clickRes.after.classify !== clickRes.before.classify) throw new Error("edit click reclassified: " + clickRes.after.classify);
  if (clickRes.after.mask !== clickRes.before.mask) throw new Error("edit click recomputed mask");
  if (!/Manual edits: \d+/.test(clickStatus)) throw new Error("edit click failed: " + clickStatus);
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await setEdit(false);
  await page.selectOption("#c-level", "country");
  await sleep(4000);

  // ---- issue 3: an added subdivision stays visible after edit mode is off ----
  await page.selectOption("#c-level", "state");
  await sleep(5000);
  await setEdit(true);
  await sleep(5000);
  const subId = await page.evaluate(iso => (window.App.__subIds(iso) || [])[0], expandTarget);
  console.log("adding subdivision:", subId);
  if (!subId) throw new Error("no subdivision available for expanded country");
  await page.evaluate(id => window.App.__toggleRegion(id), subId);
  await sleep(2500);
  await setEdit(false);
  await sleep(3000);
  const persisted = await page.evaluate(id => window.App.__regions().some(r => r.id === id), subId);
  const afterOff = (await stats()).regionPaths;
  console.log("added subdivision persists after edit off:", persisted, "paths", afterOff);
  if (!persisted) throw new Error("added subdivision did not persist after edit mode off");
  await page.evaluate(() => document.getElementById("btn-reset-edits").click());
  await sleep(2000);
  await page.selectOption("#c-level", "country");
  await sleep(4000);

  // ---- bug 1: re-import a regions-only export after Clear ----
  await page.click("#btn-clear");
  await sleep(500);
  await page.setInputFiles("#file-input", path.join(TMP, "saved-export.json"));
  await sleep(3000);
  const reimp = await stats();
  console.log("reimport regions-only:", JSON.stringify({ regionPaths: reimp.regionPaths, points: reimp.points, status: reimp.status }));
  if (reimp.regionPaths < 50) throw new Error("reimport produced too few region paths: " + reimp.regionPaths);
  if (/error/i.test(reimp.status)) throw new Error("reimport status error: " + reimp.status);

  // ---- bug: county-level edits roll up correctly to state level ----
  // Chicago (Cook County IL) + Des Moines (Polk County IA). Remove Cook, add Linn
  // County IA -> at state level Illinois must NOT be highlighted, Iowa MUST be.
  await page.click("#btn-clear");
  await sleep(500);
  await page.setInputFiles("#file-input", path.join(TMP, "il-ia.csv"));
  await page.waitForFunction(() => document.getElementById("stat-points").textContent === "2", null, { timeout: 30000 });
  await sleep(1500);
  await page.selectOption("#c-level", "county");
  await sleep(6000);
  await setEdit(true);
  await sleep(5000);
  // county-level edit mode must not colour the country polygons
  const levels = await page.evaluate(() => [...new Set(window.App.__regions().map(r => r.level))]);
  console.log("county-edit region levels:", levels.join(","));
  if (levels.includes("country")) throw new Error("countries should not be colored at county level in edit mode");
  await page.evaluate(() => window.App.__toggleRegion("US-17031")); // remove Cook County, IL
  await sleep(1500);
  await page.evaluate(() => window.App.__toggleRegion("US-19113")); // add Linn County, IA
  await sleep(1500);
  await setEdit(false);
  await sleep(2000);
  await page.selectOption("#c-level", "state");
  await sleep(6000);
  const stateNames = await page.evaluate(() => window.App.__regions().map(r => r.name));
  const hasIowa = stateNames.includes("Iowa");
  const hasIllinois = stateNames.includes("Illinois");
  console.log("rollup state names:", stateNames.filter(n => /Iowa|Illinois/.test(n)).join(", ") || "(neither)");
  if (!hasIowa || hasIllinois) throw new Error("county edits not rolled up to state: Iowa=" + hasIowa + " Illinois=" + hasIllinois);

  // ---- country rollup: state/county edits propagate to country level ----
  await page.selectOption("#c-level", "country");
  await sleep(6000);
  let countryNames = await page.evaluate(() => window.App.__regions().map(r => r.name));
  const usaPresent1 = countryNames.some(n => /United States/i.test(n));
  console.log("country rollup (some counties remain): USA present?", usaPresent1);
  if (!usaPresent1) throw new Error("USA should still be highlighted (Iowa counties remain)");

  // remove the remaining visited counties so the USA has none left
  await page.selectOption("#c-level", "county");
  await sleep(5000);
  await setEdit(true);
  await sleep(4000);
  await page.evaluate(() => window.App.__toggleRegion("US-19153")); // remove Polk County, IA
  await sleep(1200);
  await page.evaluate(() => window.App.__toggleRegion("US-19113")); // undo the Linn add
  await sleep(1200);
  await setEdit(false);
  await sleep(2000);
  await page.selectOption("#c-level", "country");
  await sleep(6000);
  countryNames = await page.evaluate(() => window.App.__regions().map(r => r.name));
  const usaPresent2 = countryNames.some(n => /United States/i.test(n));
  console.log("country rollup (all counties removed): USA present?", usaPresent2);
  if (usaPresent2) throw new Error("USA should be un-highlighted when all its counties are removed");

  // ---- add points dialog (coordinates + dates) ----
  await page.click("#btn-clear");
  await sleep(500);
  await page.click("#btn-add-points");
  await page.waitForSelector("#add-modal:not(.hidden)", { timeout: 5000 });
  await page.fill("#add-input", "34.0522, -118.2437 8/15/2026\n48.8566, 2.3522 15 Aug 2026\n-33.8688, 151.2093 8/15/26");
  await page.click("#add-submit");
  await sleep(2500);
  const addPts = await stats();
  const addRange = await page.evaluate(() => document.getElementById("stat-range").textContent);
  console.log("add points:", JSON.stringify({ points: addPts.points, range: addRange }));
  if (addPts.points !== "3") throw new Error("add points count wrong: " + addPts.points);
  if (!/2026-08-15/.test(addRange)) throw new Error("add points date not applied: " + addRange);

  // geocoding path (Nominatim) — should add a point for a place name
  await page.click("#btn-add-points");
  await page.fill("#add-input", "Los Angeles, California, USA 8/15/2026");
  await page.click("#add-submit");
  // Wait for the dialog to close and the busy overlay to clear. The geocode
  // request has no hard timeout, so a fixed sleep can race it.
  await page.waitForFunction(() => document.getElementById("add-modal").classList.contains("hidden"), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById("busy").classList.contains("hidden"), null, { timeout: 20000 });
  await sleep(300);
  const geoPts = await stats();
  console.log("add geocoded point:", geoPts.points);
  if (geoPts.points === "4") {
    // geocoded successfully
  } else if (geoPts.points === "3") {
    // Nominatim can rate-limit; the app must surface a graceful error, not crash
    const st = await page.evaluate(() => document.getElementById("status").textContent);
    if (!/Could not locate|No points added|Error/.test(st)) throw new Error("geocode failure not surfaced: " + st);
  } else {
    throw new Error("unexpected point count: " + geoPts.points);
  }

  // ---- Add-trip dialog (coordinate stops + start/end dates -> points + a visit) ----
  const beforeTrip = parseInt((await stats()).points, 10);
  await page.click("#btn-add-trip");
  await page.waitForSelector("#trip-modal:not(.hidden)", { timeout: 5000 });
  await page.fill("#trip-name", "E2E trip");
  await page.fill("#trip-start", "2026-09-01");
  await page.fill("#trip-end", "2026-09-05");
  await page.fill("#trip-input", "34.0522, -118.2437\n40.7128, -74.0060\n51.5074, -0.1278");
  await page.click("#trip-submit");
  await sleep(2500);
  const tripPts = await stats();
  const tripRange = await page.evaluate(() => document.getElementById("stat-range").textContent);
  console.log("add trip:", JSON.stringify({ points: tripPts.points, range: tripRange, before: beforeTrip }));
  if (parseInt(tripPts.points, 10) !== beforeTrip + 3) throw new Error("trip added wrong point count: " + tripPts.points);
  if (!/2026-09-05/.test(tripRange)) throw new Error("trip end date not applied: " + tripRange);

  // ---- seam-crossing trip lines survive appending more files ----
  await page.click("#btn-clear");
  await sleep(500);
  await page.click("#btn-add-trip");
  await page.waitForSelector("#trip-modal:not(.hidden)", { timeout: 5000 });
  await page.fill("#trip-name", "Pacific");
  await page.fill("#trip-start", "2026-10-01");
  await page.fill("#trip-end", "2026-10-10");
  await page.fill("#trip-input", "-33.8688, 151.2093\n21.3069, -157.8583\n34.0522, -118.2437");
  await page.click("#trip-submit");
  await sleep(2500);
  const tripLinesBefore = await page.evaluate(() => window.App.__trips().length);
  console.log("seam-crossing trip line segments:", tripLinesBefore);
  if (tripLinesBefore < 2) throw new Error("seam-crossing trip should render multiple line segments: " + tripLinesBefore);
  await page.setInputFiles("#file-input", path.join(TMP, "Location History.json"));
  await sleep(2500);
  const tripLinesAfter = await page.evaluate(() => window.App.__trips().length);
  console.log("trip line segments after append:", tripLinesAfter);
  if (tripLinesAfter !== tripLinesBefore) throw new Error("trip lines changed after append: " + tripLinesBefore + " -> " + tripLinesAfter);

  // ---- Draw-trip on the map (edit mode) ----
  await page.click("#btn-demo");
  await page.waitForSelector("#summary:not(.hidden)", { timeout: 60000 });
  await sleep(1500);
  const drawBeforeVisits = parseInt((await stats()).visits, 10);
  await setEdit(true);
  await sleep(2500);
  const editsBeforeDraw = await page.evaluate(() => window.App.__manual().length);
  await page.click("#btn-draw-trip");
  await page.waitForSelector("#draw-bar:not(.hidden)", { timeout: 5000 });
  const mapPos = await page.evaluate(() => {
    const el = document.getElementById("map");
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(mapPos.x, mapPos.y);
  await sleep(300);
  await page.mouse.click(mapPos.x + 60, mapPos.y + 30);
  await sleep(300);
  const drawCount = await page.evaluate(() => document.getElementById("draw-count").textContent);
  console.log("draw stops:", drawCount);
  if (drawCount !== "2") throw new Error("draw stops wrong: " + drawCount);
  const editsAfterDraw = await page.evaluate(() => window.App.__manual().length);
  console.log("draw clicks did not edit regions:", editsBeforeDraw, "->", editsAfterDraw);
  if (editsAfterDraw !== editsBeforeDraw) throw new Error("draw-trip clicks toggled regions: " + editsBeforeDraw + " -> " + editsAfterDraw);
  await page.click("#draw-finish");
  await sleep(2500);
  const drawAfter = await stats();
  console.log("after draw finish:", drawAfter.points, "visits", drawAfter.visits);
  if (parseInt(drawAfter.visits, 10) !== drawBeforeVisits + 1) throw new Error("draw trip should create a visit: " + drawAfter.visits + " before " + drawBeforeVisits);
  await setEdit(false);

  // ---- H3: date-only export round-trip (exact timestamps unchecked) ----
  const num = s => parseInt(String(s).replace(/,/g, ""), 10);
  const dpPoints = num((await stats()).points);
  const dpVisits = num((await stats()).visits);
  await page.click("#btn-export");
  await page.waitForSelector("#export-modal:not(.hidden)", { timeout: 5000 });
  await page.check("#x-points");
  await page.check("#x-visits");
  await page.uncheck("#x-times");
  let dlDate = page.waitForEvent("download");
  await page.click("#x-data");
  const dDate = await dlDate;
  const dateOnlyData = JSON.parse(fs.readFileSync(await dDate.path(), "utf8"));
  console.log("date-only export: pts", (dateOnlyData.points || []).length, "visits", (dateOnlyData.visits || []).length);
  if (dateOnlyData.points && dateOnlyData.points.length && "ts" in dateOnlyData.points[0]) throw new Error("date-only export leaked timestamps");
  fs.writeFileSync(path.join(TMP, "dateonly-export.json"), JSON.stringify(dateOnlyData));
  await page.check("#x-times");
  await page.uncheck("#x-points");
  await page.uncheck("#x-visits");
  await page.click("#x-close");
  await page.click("#btn-clear");
  await sleep(800);
  await page.setInputFiles("#file-input", path.join(TMP, "dateonly-export.json"));
  await sleep(3500);
  const dpAfter = await stats();
  console.log("date-only reimport:", JSON.stringify({ points: dpAfter.points, visits: dpAfter.visits }));
  if (num(dpAfter.points) !== dpPoints || num(dpAfter.visits) !== dpVisits) throw new Error("date-only round-trip lost data: " + dpPoints + "/" + dpVisits + " -> " + dpAfter.points + "/" + dpAfter.visits);

  // ---- export WITH manual edits, then re-import (round-trip, no crash) ----
  await page.click("#btn-demo");
  await page.waitForSelector("#summary:not(.hidden)", { timeout: 60000 });
  await sleep(1500);
  await setEdit(true);
  await sleep(2500);
  await page.evaluate(() => window.App.__toggleRegion("CL-AI")); // add a Chile state
  await sleep(1500);
  await page.click("#btn-export");
  await page.waitForSelector("#export-modal:not(.hidden)", { timeout: 5000 });
  let dl2 = page.waitForEvent("download");
  await page.click("#x-data");
  const d2 = await dl2;
  const editData = JSON.parse(fs.readFileSync(await d2.path(), "utf8"));
  console.log("edit export: manual", (editData.manual || []).length, "regions", (editData.regions || []).length);
  fs.writeFileSync(path.join(TMP, "edited-export.json"), JSON.stringify(editData));
  await page.click("#x-close");
  await page.click("#btn-clear");
  await sleep(800);
  await page.setInputFiles("#file-input", path.join(TMP, "edited-export.json"));
  await sleep(3500);
  const reimpEdit = await stats();
  console.log("reimport edited export:", JSON.stringify({ regionPaths: reimpEdit.regionPaths, status: reimpEdit.status.slice(0, 60) }));
  if (!(reimpEdit.regionPaths > 0)) throw new Error("reimport of edited export produced no regions");
  if (/error/i.test(reimpEdit.status)) throw new Error("reimport edited export error: " + reimpEdit.status);

  // ---- M3: importing a mapper.json merges manual edits instead of replacing ----
  fs.writeFileSync(path.join(TMP, "merge-manual.json"), JSON.stringify({ version: 1, manual: [{ id: "US-CA", status: "add", first: 1600000000000, last: 1700000000000 }] }));
  await page.setInputFiles("#file-input", path.join(TMP, "merge-manual.json"));
  await sleep(3000);
  const manualIds = await page.evaluate(() => window.App.__manual());
  console.log("manual merge:", manualIds.length, "edits, has CL-AI:", manualIds.includes("CL-AI"), "has US-CA:", manualIds.includes("US-CA"));
  if (!manualIds.includes("CL-AI") || !manualIds.includes("US-CA")) throw new Error("import replaced existing manual edits: " + JSON.stringify(manualIds.slice(0, 20)));

  // ---- supplemental metadata: single file → adds as a point ----
  await page.click("#btn-clear");
  await sleep(500);
  const suppSingle = path.join(__dirname, "fixtures", "supp", "emerald_pools.supplemental-metadata.json");
  await page.setInputFiles("#file-input", suppSingle);
  await sleep(2500);
  const supp1 = await stats();
  const suppRange1 = await page.evaluate(() => document.getElementById("stat-range").textContent);
  console.log("supp single:", JSON.stringify({ points: supp1.points, range: suppRange1 }));
  if (supp1.points !== "1") throw new Error("supp single should add 1 point: " + supp1.points);
  if (!/2009-05-28/.test(suppRange1)) throw new Error("supp single date wrong: " + suppRange1);

  // ---- supplemental metadata: batch of 3 → dialog appears ----
  await page.click("#btn-clear");
  await sleep(500);
  const suppDir = path.join(__dirname, "fixtures", "supp");
  const suppFiles = fs.readdirSync(suppDir).filter(f => f.endsWith(".json")).map(f => path.join(suppDir, f));
  await page.setInputFiles("#file-input", suppFiles);
  await sleep(2500);
  const suppDialog = await page.evaluate(() => !document.getElementById("supp-modal").classList.contains("hidden"));
  console.log("supp dialog visible:", suppDialog);
  if (!suppDialog) throw new Error("supp dialog should be visible for batch");

  // choose "Add as points" and confirm
  await page.click("#supp-ok");
  await sleep(2500);
  const supp3 = await stats();
  const suppRange3 = await page.evaluate(() => document.getElementById("stat-range").textContent);
  console.log("supp batch as points:", JSON.stringify({ points: supp3.points, range: suppRange3 }));
  if (supp3.points !== "3") throw new Error("supp batch should add 3 points: " + supp3.points);
  if (!/2009-05-28/.test(suppRange3)) throw new Error("supp batch date wrong: " + suppRange3);

  // ---- supplemental metadata: batch of 3 → create as trip ----
  await page.click("#btn-clear");
  await sleep(500);
  await page.setInputFiles("#file-input", suppFiles);
  await sleep(2500);
  // select "trip" radio
  await page.evaluate(() => {
    const radios = document.querySelectorAll("input[name=supp-mode]");
    radios.forEach(r => { if (r.value === "trip") r.checked = true; r.dispatchEvent(new Event("change")); });
  });
  await sleep(300);
  const tripOptsVisible = await page.evaluate(() => !document.getElementById("supp-trip-opts").classList.contains("hidden"));
  console.log("trip opts visible:", tripOptsVisible);
  if (!tripOptsVisible) throw new Error("trip opts should be visible when trip mode selected");
  await page.fill("#supp-trip-name", "My Photo Trip");
  await page.click("#supp-ok");
  await sleep(2500);
  const suppTrip = await stats();
  console.log("supp batch as trip:", JSON.stringify({ points: suppTrip.points, visits: suppTrip.visits }));
  if (suppTrip.points !== "3") throw new Error("supp trip should add 3 points: " + suppTrip.points);
  if (parseInt(suppTrip.visits, 10) < 1) throw new Error("supp trip should create a visit");
  const suppTripLines = await page.evaluate(() => window.App.__trips().length);
  console.log("supp trip line segments:", suppTripLines);
  if (suppTripLines < 1) throw new Error("supplemental trip should draw a trip line");

  // ---- basemap fallback, offline background, online ADM2 (deterministic) ----
  const FAKE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const LUX_API = JSON.stringify([{
    simplifiedGeometryGeoJSON: "https://github.com/wmgeolab/geoBoundaries/raw/fixture/releaseData/gbOpen/LUX/ADM2/geoBoundaries-LUX-ADM2_simplified.geojson",
  }]);
  const LUX_GEOJSON = JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { shapeName: "North", shapeISO: "LUX-N1" }, geometry: { type: "Polygon", coordinates: [[[6.0, 49.9], [6.2, 49.9], [6.2, 50.1], [6.0, 50.1], [6.0, 49.9]]] } },
      { type: "Feature", properties: { shapeName: "South", shapeISO: "LUX-N2" }, geometry: { type: "Polygon", coordinates: [[[6.0, 49.5], [6.2, 49.5], [6.2, 49.7], [6.0, 49.7], [6.0, 49.5]]] } },
    ],
  });
  const tctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // (a) CARTO blocked, other tiles fake-fulfilled -> settles on OSM, no offline.
  {
    const tp = await tctx.newPage();
    const terr = [];
    tp.on("pageerror", e => terr.push(e.message));
    // Block the default Esri basemaps (server.arcgisonline.com) and fake-fulfill
    // the remaining providers (.png = OSM) so the fallback must settle on OSM.
    await tp.route("**/*.png", r => r.fulfill({ status: 200, contentType: "image/png", body: FAKE_PNG }));
    await tp.route("**/server.arcgisonline.com/**", r => r.abort());
    await tp.goto(APP, { waitUntil: "load", timeout: 60000 });
    await sleep(12000);
    const fb = await tp.evaluate(() => ({
      basemap: document.getElementById("c-basemap").value,
      tiles: [...document.querySelectorAll(".leaflet-tile")].filter(t => t.complete && t.naturalWidth > 0).length,
      offlinePaths: document.querySelectorAll(".leaflet-pane.leaflet-offline-pane path").length,
    }));
    console.log("basemap fallback (Esri blocked):", JSON.stringify(fb));
    if (fb.basemap !== "osm") throw new Error("expected single fallback to OSM: " + fb.basemap);
    if (fb.tiles < 1) throw new Error("expected OSM tiles to load: " + fb.tiles);
    if (fb.offlinePaths > 0) throw new Error("offline overlay must not show while tiles load");
    if (terr.length) throw new Error("basemap fallback page errors: " + terr.join(" | "));
    await tp.close();
  }

  // (b) ALL tile providers blocked -> one fallback (OSM) then offline overlay.
  {
    const tp = await tctx.newPage();
    const terr = [];
    tp.on("pageerror", e => terr.push(e.message));
    await tp.route("**/server.arcgisonline.com/**", r => r.abort());
    await tp.route("**/*.png", r => r.abort());
    await tp.goto(APP, { waitUntil: "load", timeout: 60000 });
    await sleep(12000);
    const off = await tp.evaluate(() => ({
      basemap: document.getElementById("c-basemap").value,
      offlinePaths: document.querySelectorAll(".leaflet-pane.leaflet-offline-pane path").length,
      status: document.getElementById("status").textContent,
    }));
    console.log("offline background (all tiles blocked):", JSON.stringify(off));
    if (off.basemap !== "osm") throw new Error("fallback must be bounded (should stop at OSM): " + off.basemap);
    if (off.offlinePaths < 50) throw new Error("offline world overlay missing: " + off.offlinePaths);
    if (!/offline/i.test(off.status)) throw new Error("no offline status note: " + off.status);
    if (terr.length) throw new Error("offline page errors: " + terr.join(" | "));
    await tp.close();
  }

  // (c) online ADM2 via the media.githubusercontent mirror (github raw aborted).
  {
    const tp = await tctx.newPage();
    const terr = [];
    tp.on("pageerror", e => terr.push(e.message));
    await tp.route("https://www.geoboundaries.org/api/current/gbOpen/**", r => r.fulfill({ status: 200, contentType: "application/json", body: LUX_API }));
    await tp.route("**/media.githubusercontent.com/media/**", r => r.fulfill({ status: 200, contentType: "application/json", body: LUX_GEOJSON }));
    await tp.route("**/github.com/**", r => r.abort());
    await tp.route("**/api.allorigins.win/**", r => r.abort());
    await tp.goto(APP, { waitUntil: "load", timeout: 60000 });
    await sleep(1200);
    const lux = await tp.evaluate(async () => {
      const sub = await Boundaries.getSubdivisions("LUX", "county", { online: true });
      return sub ? { n: sub.length, first: sub[0] && sub[0].name, level: sub[0] && sub[0].level } : null;
    });
    console.log("online ADM2 via media mirror (github raw aborted):", JSON.stringify(lux));
    if (!lux || lux.n !== 2) throw new Error("expected 2 fake LUX ADM2 features via media mirror: " + JSON.stringify(lux));
    if (lux.level !== "county") throw new Error("online ADM2 level wrong: " + lux.level);
    if (terr.length) throw new Error("online ADM2 page errors: " + terr.join(" | "));
    await tp.close();
  }

  // (d) online ADM2 with EMPTY shapeISO (the real geoBoundaries format) must
  // still get stable ids, and left-clicking an expanded county must fill it.
  {
    const tp = await tctx.newPage();
    const terr = [];
    tp.on("pageerror", e => terr.push(e.message));
    const REAL_API = JSON.stringify([{
      simplifiedGeometryGeoJSON: "https://github.com/wmgeolab/geoBoundaries/raw/fixture/releaseData/gbOpen/AND/ADM2/geoBoundaries-AND-ADM2_simplified.geojson",
    }]);
    const REAL_GEOJSON = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { shapeName: "North", shapeISO: "", shapeID: "A1", shapeGroup: "AND", shapeType: "ADM2" }, geometry: { type: "Polygon", coordinates: [[[6.0, 49.9], [6.2, 49.9], [6.2, 50.1], [6.0, 50.1], [6.0, 49.9]]] } },
        { type: "Feature", properties: { shapeName: "South", shapeISO: "", shapeID: "A2", shapeGroup: "AND", shapeType: "ADM2" }, geometry: { type: "Polygon", coordinates: [[[6.0, 49.5], [6.2, 49.5], [6.2, 49.7], [6.0, 49.7], [6.0, 49.5]]] } },
      ],
    });
    await tp.route("https://www.geoboundaries.org/api/current/gbOpen/**", r => r.fulfill({ status: 200, contentType: "application/json", body: REAL_API }));
    await tp.route("**/media.githubusercontent.com/media/**", r => r.fulfill({ status: 200, contentType: "application/json", body: REAL_GEOJSON }));
    await tp.route("**/github.com/**", r => r.abort());
    await tp.route("**/api.allorigins.win/**", r => r.abort());
    await tp.goto(APP, { waitUntil: "load", timeout: 60000 });
    await sleep(1200);
    await tp.selectOption("#c-level", "county");
    await tp.click("#btn-edit-mode");
    await sleep(1500);
    await tp.evaluate(() => window.App.__expand("AND"));
    await sleep(4000);
    const andIds = await tp.evaluate(() => window.App.__subIds("AND").filter(Boolean));
    console.log("online ADM2 ids (empty shapeISO):", JSON.stringify(andIds));
    if (andIds.length !== 2 || andIds.join(",") !== "AND-A1,AND-A2") throw new Error("empty shapeISO must fall back to ISO3-shapeID ids: " + JSON.stringify(andIds));
    await tp.evaluate(id => { window.App.__select(id); window.App.__toggleRegion(id); }, andIds[0]);
    await sleep(1500);
    const filled = await tp.evaluate(id => window.App.__regions().some(r => r.id === id), andIds[0]);
    console.log("click-fill online county:", andIds[0], "->", filled);
    if (!filled) throw new Error("left-click on an online county must fill it: " + andIds[0]);
    if (terr.length) throw new Error("online ADM2 id/click page errors: " + terr.join(" | "));
    await tp.close();
  }

  // (e) county view falls back to state (then country) when county data is
  // unavailable: block all county downloads, load the demo, and check a visited
  // online-only country shades its STATES (not nothing, not the whole country).
  {
    const tp = await tctx.newPage();
    const terr = [];
    tp.on("pageerror", e => terr.push(e.message));
    for (const pat of ["**/media.githubusercontent.com/**", "**/github.com/**", "**/api.allorigins.win/**", "https://www.geoboundaries.org/**"]) {
      await tp.route(pat, r => r.abort());
    }
    await tp.goto(APP, { waitUntil: "load", timeout: 60000 });
    await sleep(1200);
    await tp.click("#btn-demo");
    await tp.waitForFunction(() => document.getElementById("stat-points").textContent.includes("1,794"), null, { timeout: 30000 });
    await tp.selectOption("#c-level", "county");
    await tp.waitForFunction(() => document.getElementById("busy").classList.contains("hidden"), null, { timeout: 60000 });
    await sleep(4000);
    const fb = await tp.evaluate(() => {
      const regs = window.App.__regions();
      const levels = new Set(regs.map(r => r.level));
      const brazilStates = regs.filter(r => r.country === "Brazil" && r.level === "state").length;
      const brazilCountry = regs.filter(r => r.country === "Brazil" && r.level === "country").length;
      return { levels: [...levels], brazilStates, brazilCountry };
    });
    console.log("county fallback (downloads blocked):", JSON.stringify(fb));
    if (!fb.levels.includes("state")) throw new Error("county view must shade state fallback: " + JSON.stringify(fb.levels));
    if (fb.brazilCountry > 0) throw new Error("Brazil must not shade as a whole country when its states are available");
    if (fb.brazilStates < 1) throw new Error("Brazil should shade its states as a fallback: " + fb.brazilStates);
    if (terr.length) throw new Error("county fallback page errors: " + terr.join(" | "));
    await tp.close();
  }

  await tctx.close();
  await page.screenshot({ path: path.join(__dirname, "shot.png") });

  if (errors.length) {
    console.log("\nERRORS (" + errors.length + "):");
    errors.slice(0, 15).forEach(e => console.log(" -", e));
    process.exitCode = 1;
  } else {
    console.log("\nE2E PASSED — no console/page errors");
  }
  await browser.close();
})().catch(e => { console.error("E2E FAILED:", e); process.exit(1); });
