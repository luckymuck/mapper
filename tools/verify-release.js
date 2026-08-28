const path = require("path");
const { chromium } = require("./e2e/node_modules/playwright-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const exe = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  let netErr = 0, unpkg = 0, pageErr = 0;
  page.on("requestfailed", r => { const u = r.url(); if (/unpkg\.com/.test(u)) { unpkg++; netErr++; } });
  page.on("request", r => { if (/unpkg\.com/.test(r.url())) unpkg++; });
  page.on("pageerror", e => { pageErr++; console.log("PAGEERROR:", e.message.slice(0, 80)); });
  const url = "file:///" + path.resolve(__dirname, "..", "release", "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await sleep(2000);
  const state = await page.evaluate(() => ({
    L: typeof window.L,
    Model: typeof Model,
    UI: typeof UI,
    mapReady: document.getElementById("map").classList.contains("leaflet-container"),
    busyHidden: document.getElementById("busy").classList.contains("hidden"),
  }));
  await page.click("#btn-demo");
  await page.waitForFunction(() => document.getElementById("stat-points").textContent.includes("1,794"), null, { timeout: 30000 });
  await sleep(3000);
  const demo = await page.evaluate(() => ({
    points: document.getElementById("stat-points").textContent,
    regions: document.querySelectorAll(".leaflet-overlay-pane path").length,
  }));
  console.log("RELEASE LOAD:", JSON.stringify(state), "unpkgRequests:" + unpkg, "pageErrors:" + pageErr);
  console.log("RELEASE DEMO:", JSON.stringify(demo));
  await browser.close();
  const ok = state.L === "object" && state.UI === "object" && state.mapReady && unpkg === 0 && pageErr === 0 && demo.points.includes("1,794");
  console.log(ok ? "RELEASE VERIFY PASS" : "RELEASE VERIFY FAIL");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });