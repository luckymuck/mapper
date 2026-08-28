// tilecheck.js — which basemap tiles load from a file:// origin?
const { chromium } = require("playwright-core");
const path = require("path");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const APP = "file:///" + path.resolve(__dirname, "..", "..", "index.html").replace(/\\/g, "/");

const candidates = {
  osm: "https://tile.openstreetmap.org/1/0/0.png",
  cartoLight: "https://a.basemaps.cartocdn.com/light_all/1/0/0.png",
  cartoDark: "https://a.basemaps.cartocdn.com/dark_all/1/0/0.png",
  esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/0/0/0",
  esriImagery: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/0/0/0",
  openTopo: "https://a.tile.opentopomap.org/1/0/0.png",
};

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage();
  await page.goto(APP, { waitUntil: "load", timeout: 60000 });
  const results = await page.evaluate(async (cands) => {
    const out = {};
    for (const [name, url] of Object.entries(cands)) {
      out[name] = await new Promise((resolve) => {
        const img = new Image();
        const t = setTimeout(() => { img.onload = img.onerror = null; resolve("timeout"); }, 12000);
        img.onload = () => { clearTimeout(t); resolve("OK " + (img.naturalWidth || 0) + "x" + (img.naturalHeight || 0)); };
        img.onerror = () => { clearTimeout(t); resolve("ERR"); };
        img.src = url;
      });
    }
    return out;
  }, candidates);
  console.log(results);
  await browser.close();
})().catch(e => { console.error("FAILED", e); process.exit(1); });
