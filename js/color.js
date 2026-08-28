/* color.js — color ramps: recency, duration, count, and the history rainbow. */
"use strict";

const Color = (() => {
  const DAY = 86400000;

  // --- small color utilities -------------------------------------------------
  function hsl(h, s, l, a = 1) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    r = Math.round((r + m) * 255); g = Math.round((g + m) * 255); b = Math.round((b + m) * 255);
    if (a >= 1) return `rgb(${r},${g},${b})`;
    return `rgba(${r},${g},${b},${a})`;
  }
  function rampColor(ramp, t, a = 1) {
    t = Math.max(0, Math.min(1, t));
    const i = t * (ramp.length - 1);
    const lo = Math.floor(i), hi = Math.min(ramp.length - 1, lo + 1);
    const f = i - lo;
    const c1 = hexToRgb(ramp[lo]), c2 = hexToRgb(ramp[hi]);
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
    return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
  }
  function hexToRgb(h) {
    h = h.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  // Convert hex to HSL, shift lightness by +pct (clamped 0–1), return rgb() string.
  function brightenHex(hex, pct) {
    let [r, g, b] = hexToRgb(hex);
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    l = Math.min(1, Math.max(0, l + pct));
    return hsl(h, s, l);
  }

  // --- metric → color ---------------------------------------------------------
  // recency: recent (now) = hot red; long ago = cold blue/faded.
  const RECENCY_RAMP = ["#ff3b30", "#ff9500", "#ffcc00", "#4cd964", "#34aadc", "#7b6fd0"];
  const DWELL_RAMP = ["#fff3b0", "#f6d365", "#ffb347", "#ff7e5f", "#e63946", "#8e1e3c"];
  const COUNT_RAMP = ["#e0e7ff", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#312e81"];
  const RAINBOW = ["#ff0000", "#ff8800", "#ffff00", "#00cc00", "#00aaff", "#0000ff", "#8800ff"];

  // Recency bins in ms for the legend + classification.
  const RECENCY_BINS = [1 * DAY, 7 * DAY, 30 * DAY, 365 * DAY, Infinity];

  function recencyT(ts, now) {
    const age = Math.max(0, now - ts);
    // log-ish scale over ~5 years
    const t = Math.log10(1 + age / (6 * 60 * 1000)) / Math.log10(1 + (5 * 365 * DAY) / (6 * 60 * 1000));
    return Math.max(0, Math.min(1, t));
  }
  function dwellT(dwellMs, maxDwellMs) {
    if (!dwellMs || dwellMs <= 0) return 0;
    const t = Math.log10(dwellMs / 60000) / Math.log10(Math.max(60, maxDwellMs) / 60000);
    return Math.max(0, Math.min(1, t));
  }
  function countT(c, maxCount) {
    if (!c || c <= 0) return 0;
    return Math.log10(c) / Math.log10(Math.max(2, maxCount));
  }
  // Rainbow position: t in [0,1], oldest → newest sweeps hue 0 → 330.
  function rainbowT(ts, minTs, maxTs) {
    if (maxTs <= minTs) return 1;
    return Math.max(0, Math.min(1, (ts - minTs) / (maxTs - minTs)));
  }

  // Public: given metric + a value + domain, return css color.
  function colorFor(metric, value, domain, now) {
    switch (metric) {
      case "recency": return rampColor(RECENCY_RAMP, recencyT(value, now || Date.now()));
      case "dwell":   return rampColor(DWELL_RAMP, dwellT(value, domain?.maxDwell || 1));
      case "count":   return rampColor(COUNT_RAMP, countT(value, domain?.maxCount || 1));
      case "rainbow": return rampColor(RAINBOW, rainbowT(value, domain?.minTs || 0, domain?.maxTs || 1));
    }
    return "#666";
  }

  // Legend builder returns {title, rampHtml}.
  function legend(metric, domain, now) {
    const mk = (ramp, labels) => {
      const bar = ramp.map(c => c).join(",");
      return `<div class="bar" style="background:linear-gradient(to right, ${bar})"></div>
              <div class="ticks"><span>${labels[0]}</span><span>${labels[1]}</span><span>${labels[2]}</span></div>`;
    };
    const n = now || Date.now();
    switch (metric) {
      case "recency":
        return {
          title: "Last visited",
          html: mk(RECENCY_RAMP, ["today", "1 mo", ">5 yr ago"]),
          note: "Domain: " + (domain.minTs ? Model.fmtDate(domain.minTs) : "–") + " → " + (domain.maxTs ? Model.fmtDate(domain.maxTs) : "–"),
        };
      case "dwell":
        return {
          title: "Time spent (estimate)",
          html: mk(DWELL_RAMP, ["minutes", "hours", "days"]),
          note: "Max est. " + Model.fmtDur(domain?.maxDwell),
        };
      case "count":
        return {
          title: "Visits / point count",
          html: mk(COUNT_RAMP, ["few", "mid", "most"]),
          note: "Max " + (domain?.maxCount || 0),
        };
      case "rainbow":
        return {
          title: "Rainbow by date",
          html: mk(RAINBOW, ["oldest", "", "newest"]),
          note: "Colors follow the order you visited each place.",
        };
      case "single":
        return {
          title: "Single color",
          html: `<div style="width:100%;height:14px;border-radius:4px;background:${arguments[3] || "#4c8dff"}"></div>`,
          note: "All locations use the same color.",
        };
    }
    return { title: "", html: "", note: "" };
  }

  return { hsl, rampColor, colorFor, legend, brightenHex, recencyT, dwellT, countT, rainbowT, RECENCY_RAMP, DWELL_RAMP, COUNT_RAMP, RAINBOW, RECENCY_BINS };
})();
