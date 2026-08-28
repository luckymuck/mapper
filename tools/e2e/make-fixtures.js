// make-fixtures.js — generates sample upload files for the e2e test.
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "tmp");
fs.mkdirSync(dir, { recursive: true });

// 1) legacy Google "Location History.json"
const legacy = [
  { timestampMs: "1600000000000", latitudeE7: 377749000, longitudeE7: -1224194000, accuracy: 15 },
  { timestampMs: "1600003600000", latitudeE7: 377739000, longitudeE7: -1224184000, accuracy: 18 },
  { timestampMs: "1600007200000", latitudeE7: 515074000, longitudeE7: -12780000, accuracy: 25 },
];
fs.writeFileSync(path.join(dir, "Location History.json"), JSON.stringify(legacy));

// 2) Takeout zip with records.json + semantic history
const JSZip = require("jszip");
const zip = new JSZip();
zip.file("Takeout/Location History/records.json", JSON.stringify([
  { timestamp: "2022-01-01T10:00:00Z", latitudeE7: 485200000, longitudeE7: 24000000, accuracyMeters: 20, source: "GPS" },
  { timestamp: "2022-01-01T11:00:00Z", latitudeE7: 485210000, longitudeE7: 24010000, accuracyMeters: 22, source: "WIFI" },
]));
zip.file("Takeout/Location History/Semantic Location History/2022/2022_JANUARY.json", JSON.stringify({
  timelineObjects: [
    { placeVisit: { location: { latitudeE7: 485200000, longitudeE7: 24000000, placeId: "ChIJx", address: "Kyiv" }, duration: { startTimestampMs: "1641024000000", endTimestampMs: "1641067200000" }, confidence: "HIGH" } },
    { activitySegment: { startLocation: { latitudeE7: 485200000, longitudeE7: 24000000 }, endLocation: { latitudeE7: 505000000, longitudeE7: 303200000 }, duration: { startTimestampMs: "1641067200000", endTimestampMs: "1641110400000" } } },
  ],
}));
zip.generateAsync({ type: "nodebuffer" }).then(buf => {
  fs.writeFileSync(path.join(dir, "takeout.zip"), buf);
  console.log("fixtures written to", dir);
});

// 3) Google Maps "Export timeline" — bare array of timeline objects, top-level timestamps
const mapsExport = [
  { startTimestamp: "2024-01-01T08:00:00.000Z", endTimestamp: "2024-01-01T10:00:00.000Z",
    placeVisit: { location: { latitudeE7: 377749000, longitudeE7: -1224194000, placeId: "x", name: "San Francisco" }, visitConfidence: "HIGH" } },
  { startTimestamp: "2024-01-01T10:00:00.000Z", endTimestamp: "2024-01-01T11:00:00.000Z",
    activitySegment: { startLocation: { latitudeE7: 377749000, longitudeE7: -1224194000 }, endLocation: { latitudeE7: 486000000, longitudeE7: 24000000 } } },
];
fs.writeFileSync(path.join(dir, "Timeline_export.json"), JSON.stringify(mapsExport, null, 2));

// 4) Google Maps "Export timeline" — semanticSegments format (as seen in
//    Timeline-GoogleAccount-*.json files)
const semanticSegments = {
  semanticSegments: [
    { startTime: "2024-11-15T17:00:00.000-08:00", endTime: "2024-11-15T19:00:00.000-08:00",
      timelinePath: [
        { point: "37.8168015°, -122.2634391°", time: "2024-11-15T17:29:00.000-08:00" },
        { point: "37.9159883°, -122.3076212°", time: "2024-11-15T18:04:00.000-08:00" },
      ] },
    { startTime: "2024-11-15T17:29:19.000-08:00", endTime: "2024-11-15T18:04:29.000-08:00",
      activity: { start: { latLng: "37.8168015°, -122.2634391°" }, end: { latLng: "37.9159883°, -122.3076212°" } } },
    { startTime: "2024-11-16T09:00:00.000-08:00", endTime: "2024-11-16T11:00:00.000-08:00",
      placeVisit: { location: { latLng: "37.7749°, -122.4194°", placeId: "p", name: "San Francisco" } } },
  ],
};
fs.writeFileSync(path.join(dir, "Timeline-GoogleAccount-2024.json"), JSON.stringify(semanticSegments, null, 2));

// 5) two US points: Chicago (Cook County IL) + Des Moines (Polk County IA) —
//    used to test that county edits roll up correctly to state level
fs.writeFileSync(path.join(dir, "il-ia.csv"),
  "latitude,longitude,timestamp\n41.8781,-87.6298,2023-01-01T00:00:00Z\n41.5868,-93.6250,2023-02-01T00:00:00Z\n");
