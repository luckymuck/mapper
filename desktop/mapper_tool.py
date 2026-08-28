#!/usr/bin/env python3
"""mapper_tool.py — desktop companion to the Mapper web app.

Handles the cases the browser can't: Apple iOS backups, very large Google
Takeout archives, and big photo libraries. Every command writes a canonical
`mapper.json` file that you can drag straight into the web app.

  python mapper_tool.py apple   <backup-directory>  -o out.json
  python mapper_tool.py takeout <takeout.zip>       -o out.json
  python mapper_tool.py photos  <photo-directory>   -o out.json
  python mapper_tool.py merge   a.json b.json ...   -o out.json

The canonical JSON shape is:
  {"points": [{"lat":..,"lng":..,"ts":<ms epoch>,"acc":..,"src":".."}],
   "visits": [{"lat":..,"lng":..,"start":<ms>,"end":<ms>,"placeId":..,"addr":..,"src":".."}]}

Requires only the standard library (exifread is used for photos if installed).
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import zipfile

# CoreData / WebKit store dates as seconds since 2001-01-01T00:00:00Z.
REFERENCE_DATE = 978307200

# --------------------------------------------------------------------------
# Canonical JSON
# --------------------------------------------------------------------------
def write_output(path, points, visits):
    data = {"points": points, "visits": visits}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"wrote {path}: {len(points)} points, {len(visits)} visits")


# --------------------------------------------------------------------------
# Apple iOS backups (routined.sqlite etc.)
# --------------------------------------------------------------------------
def _cd_to_ms(value):
    """CoreData timestamp (seconds since 2001) -> ms epoch. Value may be str/int/float/None."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return int((v + REFERENCE_DATE) * 1000)


def _find_visit_tables(conn):
    """Return tables that look like location-visit stores with their column mapping."""
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    results = []
    for (name,) in tables:
        try:
            cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{name}")')]
        except sqlite3.Error:
            continue
        lat = next((c for c in cols if re.search(r"lat", c, re.I) and not re.search(r"lon|long", c, re.I)), None)
        lon = next((c for c in cols if re.search(r"lon|long", c, re.I)), None)
        if not lat or not lon:
            continue
        date_cols = [c for c in cols if re.search(r"date|time|arriv|depart|start|end|epoch", c, re.I)]
        if not date_cols:
            continue
        # pick an arrival/start and a departure/end date column when possible
        start_col = next((c for c in date_cols if re.search(r"arriv|start|from", c, re.I)), date_cols[0])
        end_col = next((c for c in date_cols if re.search(r"depart|end|to", c, re.I)), date_cols[1] if len(date_cols) > 1 else None)
        results.append((name, lat, lon, start_col, end_col))
    return results


def _extract_apple(backup_dir):
    points, visits = [], []
    dbs = glob.glob(os.path.join(backup_dir, "**", "*.sqlite"), recursive=True)
    if not dbs:
        raise SystemExit(
            "No .sqlite files found. Extract your iOS backup first with a tool like "
            "iMazing, iBackup Viewer, or libimobiledevice (idevicebackup2), then point "
            "this at the extracted folder."
        )
    seen = set()
    for db in dbs:
        if db in seen:
            continue
        seen.add(db)
        if os.path.getsize(db) < 4096:
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            for table, lat_c, lon_c, start_c, end_c in _find_visit_tables(conn):
                sel = f'SELECT "{lat_c}","{lon_c}","{start_c}"'
                if end_c:
                    sel += f',"{end_c}"'
                try:
                    rows = conn.execute(sel + f' FROM "{table}"').fetchall()
                except sqlite3.Error:
                    continue
                count = 0
                for r in rows:
                    lat, lon, s, e = r[0], r[1], r[2], r[3] if len(r) > 3 else None
                    try:
                        lat, lon = float(lat), float(lon)
                    except (TypeError, ValueError):
                        continue
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        continue
                    start_ms = _cd_to_ms(s) or 0
                    end_ms = _cd_to_ms(e) if e is not None else start_ms
                    visits.append({"lat": lat, "lng": lon, "start": start_ms, "end": end_ms,
                                   "placeId": None, "addr": "", "src": "apple:" + os.path.basename(db)})
                    count += 1
                if count:
                    print(f"  {os.path.basename(db)} :: {table} -> {count} visits")
        finally:
            conn.close()
    return points, visits


# --------------------------------------------------------------------------
# Google Takeout
# --------------------------------------------------------------------------
def _parse_google_array(arr, points):
    for r in arr or []:
        if not isinstance(r, dict):
            continue
        lat_e7 = r.get("latitudeE7")
        if isinstance(lat_e7, (int, float)):
            ts = r.get("timestampMs")
            if ts is None:
                iso = r.get("timestamp")
                ts = None if iso is None else iso
            if isinstance(ts, str):
                if ts.isdigit():
                    ts = int(ts)
                else:
                    try:
                        from datetime import datetime
                        ts = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
                    except Exception:
                        ts = None
            if ts:
                points.append({"lat": lat_e7 / 1e7, "lng": r.get("longitudeE7", 0) / 1e7,
                               "ts": int(ts), "acc": r.get("accuracyMeters", r.get("accuracy", 0)), "src": "google"})


def _parse_latlng_str(s):
    """Parse Google's '37.8168015°, -122.2634391°' location strings."""
    if not s:
        return None
    m = re.findall(r"-?\d+\.?\d*", str(s))
    if len(m) < 2:
        return None
    try:
        return (float(m[0]), float(m[1]))
    except ValueError:
        return None


def _ts_to_ms(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v * 1000) if v < 1e12 else int(v)
    s = str(v).strip()
    if s.isdigit():
        n = int(s)
        return n * 1000 if n < 1e12 else n
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _extract_semantic_segments(segments, points, visits):
    for seg in segments or []:
        if not isinstance(seg, dict):
            continue
        start = _ts_to_ms(seg.get("startTime"))
        end = _ts_to_ms(seg.get("endTime"))
        for tp in seg.get("timelinePath") or []:
            ll = _parse_latlng_str(tp.get("point"))
            t = _ts_to_ms(tp.get("time"))
            if ll and t:
                points.append({"lat": ll[0], "lng": ll[1], "ts": t, "acc": 0, "src": "google"})
        pv = seg.get("placeVisit")
        if pv:
            loc = pv.get("location") or {}
            dur = pv.get("duration") or {}
            s = _ts_to_ms(dur.get("startTimestampMs") or start)
            e = _ts_to_ms(dur.get("endTimestampMs") or end)
            ll = _parse_latlng_str(loc.get("latLng"))
            if ll is None and loc.get("latitudeE7") is not None:
                ll = (loc["latitudeE7"] / 1e7, loc.get("longitudeE7", 0) / 1e7)
            if ll and s:
                visits.append({"lat": ll[0], "lng": ll[1], "start": s, "end": e or s,
                               "placeId": loc.get("placeId"), "addr": loc.get("address", loc.get("name", "")), "src": "google"})
                points.append({"lat": ll[0], "lng": ll[1], "ts": s, "acc": 0, "src": "google"})
        act = seg.get("activity")
        if act and not seg.get("timelinePath"):
            s0 = _parse_latlng_str((act.get("start") or {}).get("latLng"))
            s1 = _parse_latlng_str((act.get("end") or {}).get("latLng"))
            if s0 and start:
                points.append({"lat": s0[0], "lng": s0[1], "ts": start, "acc": 0, "src": "google"})
            if s1 and end:
                points.append({"lat": s1[0], "lng": s1[1], "ts": end, "acc": 0, "src": "google"})


def _extract_takeout(src):
    points, visits = [], []
    targets = [r"(?i)Location ?History\.json$", r"(?i)records\.json$",
               r"(?i)Semantic Location History/.*\.json$", r"(?i)Timeline-GoogleAccount.*\.json$"]
    if os.path.isdir(src):
        files = []
        for root, _, names in os.walk(src):
            for n in names:
                p = os.path.join(root, n)
                if any(re.search(t, p) for t in targets):
                    files.append(p)
    else:
        with zipfile.ZipFile(src) as z:
            files = [n for n in z.namelist() if any(re.search(t, n) for t in targets)]
    for f in files:
        text = None
        if os.path.isdir(src):
            with open(f, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            name = os.path.basename(f)
        else:
            with zipfile.ZipFile(src) as z:
                text = z.read(f).decode("utf-8", errors="replace")
            name = f
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            print(f"  skip (not JSON): {name}")
            continue
        if isinstance(data, list):
            _parse_google_array(data, points)
        elif isinstance(data, dict):
            if isinstance(data.get("locations"), list):
                _parse_google_array(data["locations"], points)
            elif isinstance(data.get("records"), list):
                _parse_google_array(data["records"], points)
            elif isinstance(data.get("semanticSegments"), list):
                _extract_semantic_segments(data["semanticSegments"], points, visits)
            elif isinstance(data.get("timelineObjects"), list):
                for obj in data["timelineObjects"]:
                    pv = obj.get("placeVisit")
                    if pv:
                        loc = pv.get("location") or {}
                        dur = pv.get("duration") or {}
                        start = int(dur.get("startTimestampMs") or 0)
                        end = int(dur.get("endTimestampMs") or start)
                        if loc.get("latitudeE7") is not None and start:
                            visits.append({"lat": loc["latitudeE7"] / 1e7, "lng": loc.get("longitudeE7", 0) / 1e7,
                                           "start": start, "end": end, "placeId": loc.get("placeId"),
                                           "addr": loc.get("address", loc.get("name", "")), "src": "google"})
                    seg = obj.get("activitySegment")
                    if seg:
                        dur = seg.get("duration") or {}
                        s = int(dur.get("startTimestampMs") or 0)
                        e = int(dur.get("endTimestampMs") or s)
                        for key in ("startLocation", "endLocation"):
                            l = seg.get(key) or {}
                            if l.get("latitudeE7") is not None and s:
                                points.append({"lat": l["latitudeE7"] / 1e7, "lng": l.get("longitudeE7", 0) / 1e7,
                                               "ts": s if key == "startLocation" else e, "acc": 0, "src": "google"})
        else:
            print(f"  skip (unknown shape): {name}")
        print(f"  {name} -> {len(points)} points total so far")
    return points, visits


# --------------------------------------------------------------------------
# Photos (EXIF GPS)
# --------------------------------------------------------------------------
def _dms_to_decimal(dms, ref):
    if not dms:
        return None
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError):
        return None
    val = d + m / 60.0 + s / 3600.0
    if ref and ref.upper() in ("S", "W"):
        val = -val
    return val


def _extract_photos(directory):
    points, visits = [], []
    try:
        import exifread
    except ImportError:
        raise SystemExit("exifread is required for photos:  pip install exifread")
    exts = (".jpg", ".jpeg", ".heic", ".png", ".tif", ".tiff")
    files = [p for p in glob.glob(os.path.join(directory, "**", "*"), recursive=True)
             if os.path.splitext(p)[1].lower() in exts]
    for i, f in enumerate(files, 1):
        if i % 200 == 0:
            print(f"  {i}/{len(files)} photos…")
        try:
            with open(f, "rb") as fh:
                tags = exifread.process_file(fh, details=False)
        except Exception:
            continue
        lat = _dms_to_decimal(tags.get("GPS GPSLatitude"), tags.get("GPS GPSLatitudeRef"))
        lon = _dms_to_decimal(tags.get("GPS GPSLongitude"), tags.get("GPS GPSLongitudeRef"))
        if lat is None or lon is None:
            continue
        ts = None
        dto = str(tags.get("EXIF DateTimeOriginal", ""))
        if dto and dto != "None":
            try:
                from datetime import datetime
                ts = int(datetime.strptime(dto.strip(), "%Y:%m:%d %H:%M:%S").timestamp() * 1000)
            except ValueError:
                ts = None
        points.append({"lat": lat, "lng": lon, "ts": ts or int(os.path.getmtime(f) * 1000),
                       "acc": 0, "src": "photo:" + os.path.basename(f)})
    return points, visits


# --------------------------------------------------------------------------
# Merge
# --------------------------------------------------------------------------
def _merge(files):
    points, visits = [], []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        points.extend(d.get("points", []))
        visits.extend(d.get("visits", []))
    # de-duplicate identical points
    seen = set()
    uniq = []
    for p in points:
        k = (round(p["lat"], 6), round(p["lng"], 6), p.get("ts"))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq, visits


def main():
    ap = argparse.ArgumentParser(description="Mapper desktop tool — produce canonical mapper.json files.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, help_ in [("apple", "extract visits from an extracted iOS backup"),
                        ("takeout", "parse a Google Takeout zip or folder"),
                        ("photos", "extract GPS from a photo library"),
                        ("merge", "merge several mapper.json files")]:
        s = sub.add_parser(name, help=help_)
        s.add_argument("src", nargs="*", help="source path(s)")
        s.add_argument("-o", "--out", required=True, help="output .json path")
    args = ap.parse_args()

    if args.cmd == "apple":
        if len(args.src) != 1:
            ap.error("apple takes exactly one backup directory")
        points, visits = _extract_apple(args.src[0])
    elif args.cmd == "takeout":
        if len(args.src) != 1:
            ap.error("takeout takes exactly one zip or folder")
        points, visits = _extract_takeout(args.src[0])
    elif args.cmd == "photos":
        if len(args.src) != 1:
            ap.error("photos takes exactly one directory")
        points, visits = _extract_photos(args.src[0])
    elif args.cmd == "merge":
        if not args.src:
            ap.error("merge needs at least one input file")
        points, visits = _merge(args.src)
    else:
        ap.error("unknown command")

    if not points and not visits:
        print("warning: nothing found in the given source.", file=sys.stderr)
    write_output(args.out, points, visits)


if __name__ == "__main__":
    main()
