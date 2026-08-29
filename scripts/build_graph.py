#!/usr/bin/env python3
"""Build walking graph with signal wait costs for Sapporo Station area.

Sources:
  - OpenStreetMap (Overpass): pedestrian network + signal positions
  - JARTIC 交差点制御情報: cycle lengths (optional local zip / CSV)
  - data/signal-locations.json: intersection_id -> lat/lng mapping
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import statistics
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "scripts" / ".cache"
OUT = ROOT / "public" / "data" / "graph.json"
SIGNAL_LOC = ROOT / "data" / "signal-locations.json"

# 札幌駅
ORIGIN = {"lat": 43.0687, "lng": 141.3508}
MAX_RADIUS_M = 5000
WALK_SPEED = 1.2  # m/s
MATCH_M = 60
DEFAULT_CYCLE = 90.0
DEFAULT_GREEN_RATIO = 1 / 3

# ~5.2km bbox
BBOX = (43.022, 141.288, 43.115, 141.414)  # south, west, north, east

FOOT_HIGHWAYS = {
    "footway",
    "path",
    "pedestrian",
    "steps",
    "living_street",
    "residential",
    "unclassified",
    "service",
    "tertiary",
    "secondary",
    "primary",
    "trunk",
    "track",
    "cycleway",
}


def haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def expected_wait(cycle: float, green: float | None = None) -> float:
    g = green if green is not None else cycle * DEFAULT_GREEN_RATIO
    g = max(0.0, min(g, cycle))
    red = cycle - g
    if cycle <= 0:
        return 0.0
    return (red * red) / (2.0 * cycle)


def overpass_query() -> str:
    s, w, n, e = BBOX
    return f"""
[out:json][timeout:180];
(
  way["highway"~"^(footway|path|pedestrian|steps|living_street|residential|unclassified|service|tertiary|secondary|primary|trunk|track|cycleway)$"]({s},{w},{n},{e});
  node["highway"="traffic_signals"]({s},{w},{n},{e});
  node["crossing"="traffic_signals"]({s},{w},{n},{e});
  node["crossing"="toucan"]({s},{w},{n},{e});
);
out body;
>;
out skel qt;
"""


def fetch_overpass(force: bool = False) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE / "osm_sapporo.json"
    if cache_path.exists() and not force:
        print(f"Using cached OSM: {cache_path}")
        return json.loads(cache_path.read_text(encoding="utf-8"))

    print("Fetching OSM via Overpass…")
    import urllib.parse

    body = urllib.parse.urlencode({"data": overpass_query()}).encode("utf-8")
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ]
    last_err: Exception | None = None
    payload = b""
    for url in endpoints:
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "xr-hack-202608-graph-builder/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=240) as resp:
                payload = resp.read()
            print(f"Overpass OK via {url} ({len(payload)} bytes)")
            break
        except Exception as exc:
            print(f"Overpass failed ({url}): {exc}")
            last_err = exc
    else:
        raise RuntimeError(f"All Overpass endpoints failed: {last_err}")
    cache_path.write_bytes(payload)
    print(f"Cached OSM ({len(payload)} bytes)")
    return json.loads(payload)


def parse_jartic_cycles(raw_dir: Path) -> dict[str, float]:
    """Parse cycle seconds keyed by intersection id (median over time series)."""
    samples: dict[str, list[float]] = defaultdict(list)
    if not raw_dir.exists():
        return {}

    # Prefer compact summary if present
    summary = raw_dir / "sapporo_cycles.json"
    if summary.exists():
        obj = json.loads(summary.read_text(encoding="utf-8"))
        if isinstance(obj, dict) and obj:
            print(f"  using {summary.name} ({len(obj)} intersections)")
            return {str(k): float(v) for k, v in obj.items()}

    for path in sorted(raw_dir.rglob("*")):
        if path.suffix.lower() == ".json":
            try:
                obj = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        try:
                            samples[str(k)].append(float(v))
                        except (TypeError, ValueError):
                            pass
            except Exception as exc:
                print(f"skip json {path}: {exc}")
            continue

        if path.suffix.lower() not in {".csv", ".txt"}:
            continue
        if "定義" in path.name:
            continue
        # Skip multi-100MB control files unless explicitly needed
        if path.stat().st_size > 20_000_000:
            print(f"  skip large CSV {path.name} (generate sapporo_cycles.json first)")
            continue

        opened = False
        f = None
        for enc in ("cp932", "utf-8-sig", "utf-8"):
            try:
                f = path.open("r", encoding=enc, newline="")
                reader = csv.reader(f)
                header = [c.strip() for c in next(reader)]
                opened = True
                break
            except Exception:
                if f is not None and not f.closed:
                    f.close()
                continue
        if not opened or f is None:
            continue

        id_idx = next(
            (
                i
                for i, h in enumerate(header)
                if "交差点" in h and ("番号" in h or "ID" in h.upper() or "id" in h)
            ),
            None,
        )
        cycle_idx = next(
            (i for i, h in enumerate(header) if "サイクル" in h or "周期" in h or h.lower() == "cycle"),
            None,
        )
        if id_idx is None or cycle_idx is None:
            f.close()
            continue

        for i, row in enumerate(reader):
            if i % 20 != 0:
                continue
            if len(row) <= max(id_idx, cycle_idx):
                continue
            try:
                iid = row[id_idx].strip()
                cyc = float(row[cycle_idx])
            except ValueError:
                continue
            if 20 <= cyc <= 300:
                samples[str(iid)].append(cyc)
        f.close()
        print(f"  parsed cycles from {path.name}")

    return {k: float(statistics.median(v)) for k, v in samples.items() if v}


def ensure_jartic_raw(dest: Path) -> None:
    """Ensure Sapporo JARTIC CSVs exist under data/raw (extract from cached national zip)."""
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.glob("*制御*.csv")):
        return

    url = "http://storage.compusophia.com:1475/traffic/typeC/2026_06.zip"
    zip_path = CACHE / "jartic_2026_06.zip"
    CACHE.mkdir(parents=True, exist_ok=True)
    if not zip_path.exists():
        print(f"Downloading JARTIC archive (~400MB): {url}")
        try:
            urllib.request.urlretrieve(url, zip_path)
        except Exception as exc:
            print(f"JARTIC download failed ({exc}); using defaults")
            return

    print("Extracting Sapporo control/definition CSVs…")
    try:
        with zipfile.ZipFile(zip_path) as outer:
            member = "typeC_sapporo_2026_06.zip"
            if member not in outer.namelist():
                print("Sapporo zip not found in archive")
                return
            inner_bytes = outer.read(member)
        with zipfile.ZipFile(io.BytesIO(inner_bytes)) as inner:
            for n in inner.namelist():
                if not n.lower().endswith(".csv"):
                    continue
                target = dest / Path(n).name
                target.write_bytes(inner.read(n))
                print(f"  extracted {target.name}")
    except Exception as exc:
        print(f"extract failed: {exc}")


def load_signal_locations() -> list[dict]:
    if not SIGNAL_LOC.exists():
        return []
    return json.loads(SIGNAL_LOC.read_text(encoding="utf-8"))


def build_graph(osm: dict, cycles: dict[str, float], locations: list[dict]) -> dict:
    nodes_raw: dict[int, dict] = {}
    ways: list[dict] = []
    signal_osm_ids: set[int] = set()

    print("Parsing OSM elements…", flush=True)
    for el in osm.get("elements", []):
        if el["type"] == "node":
            nodes_raw[el["id"]] = {
                "lat": el["lat"],
                "lng": el["lon"],
                "tags": el.get("tags", {}),
            }
            tags = el.get("tags", {})
            if tags.get("highway") == "traffic_signals" or tags.get("crossing") in {
                "traffic_signals",
                "toucan",
            }:
                signal_osm_ids.add(el["id"])
        elif el["type"] == "way":
            ways.append(el)
    print(
        f"  nodes={len(nodes_raw)} ways={len(ways)} osmSignals={len(signal_osm_ids)}",
        flush=True,
    )

    mapped: list[tuple[float, float, float]] = []
    for loc in locations:
        iid = str(loc.get("intersectionId", loc.get("id", "")))
        lat = float(loc["lat"])
        lng = float(loc["lng"])
        cycle = float(loc.get("cycle") or cycles.get(iid) or DEFAULT_CYCLE)
        green = loc.get("green")
        wait = expected_wait(cycle, float(green) if green is not None else None)
        mapped.append((lat, lng, wait))

    default_cycle = statistics.median(cycles.values()) if cycles else DEFAULT_CYCLE
    default_wait = expected_wait(float(default_cycle))
    print(f"  defaultWait={default_wait:.1f}s (cycle={default_cycle})", flush=True)

    lat_pad = (MAX_RADIUS_M + 200) / 111_000
    lng_pad = (MAX_RADIUS_M + 200) / (111_000 * math.cos(math.radians(ORIGIN["lat"])))
    keep_ids: set[int] = set()
    for nid, n in nodes_raw.items():
        if abs(n["lat"] - ORIGIN["lat"]) > lat_pad or abs(n["lng"] - ORIGIN["lng"]) > lng_pad:
            continue
        if haversine_m(ORIGIN["lat"], ORIGIN["lng"], n["lat"], n["lng"]) <= MAX_RADIUS_M + 200:
            keep_ids.add(nid)

    id_map: dict[int, int] = {}
    nodes_out: list[dict] = []
    for nid in sorted(keep_ids):
        n = nodes_raw[nid]
        new_id = len(nodes_out)
        id_map[nid] = new_id
        nodes_out.append({"id": new_id, "lat": n["lat"], "lng": n["lng"]})
    print(f"  kept nodes={len(nodes_out)}", flush=True)

    node_wait: dict[int, float] = {}

    # Grid of kept nodes for snapping signals onto the walk network
    cell = 0.0005
    node_grid: dict[tuple[int, int], list[tuple[int, float, float]]] = defaultdict(list)
    for osm_id, new_id in id_map.items():
        n = nodes_raw[osm_id]
        key = (int(n["lat"] / cell), int(n["lng"] / cell))
        node_grid[key].append((new_id, n["lat"], n["lng"]))

    def snap_wait(lat: float, lng: float, wait: float, max_m: float = 28.0) -> None:
        i, j = int(lat / cell), int(lng / cell)
        best_id = None
        best_d = max_m
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for new_id, nlat, nlng in node_grid.get((i + di, j + dj), []):
                    d = haversine_m(nlat, nlng, lat, lng)
                    if d < best_d:
                        best_d = d
                        best_id = new_id
        if best_id is not None:
            # keep larger wait if already set
            node_wait[best_id] = max(node_wait.get(best_id, 0.0), wait)

    for osm_id in signal_osm_ids:
        n = nodes_raw[osm_id]
        if osm_id not in id_map and haversine_m(
            ORIGIN["lat"], ORIGIN["lng"], n["lat"], n["lng"]
        ) > MAX_RADIUS_M + 200:
            continue
        wait = default_wait
        best = MATCH_M
        for mlat, mlng, mwait in mapped:
            d = haversine_m(n["lat"], n["lng"], mlat, mlng)
            if d < best:
                best = d
                wait = mwait
        snap_wait(n["lat"], n["lng"], wait)

    for mlat, mlng, mwait in mapped:
        snap_wait(mlat, mlng, mwait, max_m=25.0)

    print(f"  signal-attached nodes={len(node_wait)}", flush=True)

    edges_out: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for way in ways:
        tags = way.get("tags", {})
        hw = tags.get("highway", "")
        if hw not in FOOT_HIGHWAYS and tags.get("footway") != "crossing":
            continue
        if tags.get("foot") in {"no", "private"}:
            continue
        nds = [n for n in way.get("nodes", []) if n in id_map]
        for a, b in zip(nds, nds[1:]):
            na, nb = nodes_raw[a], nodes_raw[b]
            length = haversine_m(na["lat"], na["lng"], nb["lat"], nb["lng"])
            if length < 0.5 or length > 800:
                continue
            ia, ib = id_map[a], id_map[b]
            for u, v in ((ia, ib), (ib, ia)):
                if (u, v) in seen:
                    continue
                seen.add((u, v))
                wait = node_wait.get(v, 0.0)
                edges_out.append(
                    {
                        "from": u,
                        "to": v,
                        "lengthM": round(length, 2),
                        "walkSec": round(length / WALK_SPEED, 2),
                        "waitSec": round(wait, 2),
                        "isSignal": wait > 0,
                    }
                )
    print(f"  edges={len(edges_out)}", flush=True)

    signals_out = []
    for osm_id in signal_osm_ids:
        n = nodes_raw[osm_id]
        if haversine_m(ORIGIN["lat"], ORIGIN["lng"], n["lat"], n["lng"]) <= MAX_RADIUS_M:
            signals_out.append([round(n["lat"], 6), round(n["lng"], 6)])

    # Compact arrays to keep download size down
    nodes_compact = [
        [n["id"], round(n["lat"], 6), round(n["lng"], 6)] for n in nodes_out
    ]
    edges_compact = [
        [
            e["from"],
            e["to"],
            e["walkSec"],
            e["waitSec"],
            1 if e["isSignal"] else 0,
        ]
        for e in edges_out
    ]

    return {
        "v": 1,
        "origin": ORIGIN,
        "maxRadiusM": MAX_RADIUS_M,
        "walkSpeedMps": WALK_SPEED,
        "defaultCycleSec": round(float(default_cycle), 1),
        "defaultWaitSec": round(default_wait, 2),
        "jarticCycleCount": len(cycles),
        "nodes": nodes_compact,
        "edges": edges_compact,
        "signals": signals_out,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force-osm", action="store_true")
    parser.add_argument("--skip-jartic", action="store_true")
    args = parser.parse_args()

    raw = ROOT / "data" / "raw"
    if not args.skip_jartic:
        ensure_jartic_raw(raw)

    cycles = parse_jartic_cycles(raw)
    print(f"JARTIC cycles loaded: {len(cycles)}")
    if cycles:
        summary = raw / "sapporo_cycles.json"
        summary.write_text(json.dumps(cycles, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {summary}")

    locations = load_signal_locations()
    # prefer measured JARTIC cycle when intersectionId matches
    for loc in locations:
        iid = str(loc.get("intersectionId", loc.get("id", "")))
        if iid in cycles and "cycle" not in loc:
            loc["cycle"] = cycles[iid]
        elif iid in cycles:
            # keep curated green, refresh cycle from JARTIC
            loc["cycle"] = cycles[iid]
    print(f"Signal locations: {len(locations)}")

    osm = fetch_overpass(force=args.force_osm)
    graph = build_graph(osm, cycles, locations)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Wrote {OUT} nodes={len(graph['nodes'])} edges={len(graph['edges'])} signals={len(graph['signals'])}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
