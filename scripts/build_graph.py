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
DEFAULT_PED_GREEN = 15.0  # 歩行者青（点滅は含めない）
NEAR_SIGNAL_M = 18.0
# 車用信号は交差点中央寄りなので、横断歩道端までやや広めに見る
NEAR_VEHICLE_SIGNAL_M = 30.0
# 同一交差点で連続待ちしないための統合距離
SIGNAL_CLUSTER_M = 40.0
# OSM の交差点角で歩道ノードが数十cm切れていると直進横断できない
STITCH_NEARBY_M = 1.5

# ~5.2km bbox
BBOX = (43.022, 141.288, 43.115, 141.414)  # south, west, north, east

# 歩道・歩行者空間のみ（札幌中心部は footway が十分ある）
WALK_ONLY = {"footway", "path", "pedestrian", "steps", "living_street"}
# 車道中心線。OSM では sidewalk 未記入が多く「歩ける」と誤判定しやすい
CARRIAGEWAY = {"residential", "unclassified", "service", "track", "cycleway"}


def way_walkable(tags: dict) -> bool:
    if tags.get("foot") in {"no", "private", "use_sidepath"}:
        return False
    if tags.get("footway") == "crossing" or tags.get("highway") == "crossing":
        return True
    hw = tags.get("highway", "")
    if hw in WALK_ONLY:
        return True
    if hw in CARRIAGEWAY:
        # 歩道が別にある車道は使わない
        if tags.get("sidewalk") in {"both", "left", "right", "separate"}:
            return False
        # 共有空間（歩道なし）か、歩行明示がある場合だけ車道を許可
        if tags.get("sidewalk") == "no":
            return True
        if tags.get("foot") in {"yes", "designated"}:
            return True
        return False
    return False


def haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def stitch_nearby_nodes(
    nodes: list[dict],
    edges: list[dict],
    walk_speed: float,
    max_m: float = STITCH_NEARBY_M,
) -> int:
    """Connect sidewalk nodes that almost touch (typical OSM intersection gaps)."""
    existing = {(e["from"], e["to"]) for e in edges}
    by_id = {n["id"]: n for n in nodes}
    cell = 0.00002
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for n in nodes:
        grid[(int(n["lat"] / cell), int(n["lng"] / cell))].append(n["id"])

    added = 0
    for n in nodes:
        ci, cj = int(n["lat"] / cell), int(n["lng"] / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for oid in grid.get((ci + di, cj + dj), []):
                    if oid <= n["id"]:
                        continue
                    if (n["id"], oid) in existing or (oid, n["id"]) in existing:
                        continue
                    other = by_id[oid]
                    length = haversine_m(n["lat"], n["lng"], other["lat"], other["lng"])
                    if length < 0.15 or length > max_m:
                        continue
                    walk = round(length / walk_speed, 2)
                    for u, v in ((n["id"], oid), (oid, n["id"])):
                        edges.append(
                            {
                                "from": u,
                                "to": v,
                                "walkSec": walk,
                                "cycleSec": 0.0,
                                "isSignal": False,
                                "crossingId": 0,
                            }
                        )
                        existing.add((u, v))
                    added += 1
    return added


def stitch_compact_graph(graph: dict) -> int:
    """Add stitch edges to a compact graph.json object. Returns pair count."""
    nodes = [{"id": n[0], "lat": n[1], "lng": n[2]} for n in graph["nodes"]]
    edges = []
    for e in graph["edges"]:
        cid = e[5] if len(e) >= 6 else 0
        edges.append(
            {
                "from": e[0],
                "to": e[1],
                "walkSec": e[2],
                "cycleSec": e[3],
                "isSignal": e[4] == 1 or cid > 0,
                "crossingId": cid,
            }
        )
    added = stitch_nearby_nodes(
        nodes, edges, float(graph.get("walkSpeedMps", WALK_SPEED)), STITCH_NEARBY_M
    )
    graph["edges"] = [
        [
            e["from"],
            e["to"],
            e["walkSec"],
            e["cycleSec"],
            1 if e["isSignal"] else 0,
            int(e.get("crossingId", 0)),
        ]
        for e in edges
    ]
    return added


def expected_wait(cycle: float, green: float | None = None) -> float:
    g = green if green is not None else DEFAULT_PED_GREEN
    g = max(0.0, min(g, cycle))
    red = cycle - g
    if cycle <= 0:
        return 0.0
    return (red * red) / (2.0 * cycle)


def is_ped_signal_node(tags: dict) -> bool:
    return tags.get("crossing") in {"traffic_signals", "toucan"} or tags.get(
        "crossing:signals"
    ) == "yes"


def is_vehicle_signal_node(tags: dict) -> bool:
    return tags.get("highway") == "traffic_signals" and not is_ped_signal_node(tags)


def is_crossing_way(tags: dict) -> bool:
    return (
        tags.get("footway") == "crossing"
        or tags.get("highway") == "crossing"
        or tags.get("crossing") in {"traffic_signals", "toucan", "marked"}
        or tags.get("crossing:signals") == "yes"
    )


def is_uncontrolled_crossing(tags: dict) -> bool:
    return tags.get("crossing") in {"uncontrolled", "unmarked"}


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
    ped_signal_ids: set[int] = set()
    vehicle_pts: list[tuple[float, float]] = []
    ped_pts: list[tuple[float, float]] = []

    print("Parsing OSM elements…", flush=True)
    for el in osm.get("elements", []):
        if el["type"] == "node":
            tags = el.get("tags", {})
            nodes_raw[el["id"]] = {
                "lat": el["lat"],
                "lng": el["lon"],
                "tags": tags,
            }
            if is_ped_signal_node(tags):
                ped_signal_ids.add(el["id"])
                ped_pts.append((el["lat"], el["lon"]))
            elif is_vehicle_signal_node(tags):
                vehicle_pts.append((el["lat"], el["lon"]))
        elif el["type"] == "way":
            ways.append(el)
    print(
        f"  nodes={len(nodes_raw)} ways={len(ways)} "
        f"pedSignals={len(ped_signal_ids)} vehicleSignals={len(vehicle_pts)}",
        flush=True,
    )

    # (lat, lng, cycle) from JARTIC-mapped intersections
    mapped: list[tuple[float, float, float]] = []
    for loc in locations:
        iid = str(loc.get("intersectionId", loc.get("id", "")))
        lat = float(loc["lat"])
        lng = float(loc["lng"])
        cycle = float(loc.get("cycle") or cycles.get(iid) or DEFAULT_CYCLE)
        mapped.append((lat, lng, cycle))

    default_cycle = statistics.median(cycles.values()) if cycles else DEFAULT_CYCLE
    default_wait = expected_wait(float(default_cycle), DEFAULT_PED_GREEN)
    print(
        f"  pedGreen={DEFAULT_PED_GREEN:.0f}s cycle={default_cycle:.0f}s "
        f"E[wait]={default_wait:.1f}s",
        flush=True,
    )

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

    def cycle_near(lat: float, lng: float) -> float:
        best = MATCH_M
        cycle = float(default_cycle)
        for mlat, mlng, mcyc in mapped:
            d = haversine_m(lat, lng, mlat, mlng)
            if d < best:
                best = d
                cycle = mcyc
        return cycle

    cell = 0.0002
    def index_pts(pts: list[tuple[float, float]]) -> dict[tuple[int, int], list[tuple[float, float]]]:
        grid: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
        for plat, plng in pts:
            grid[(int(plat / cell), int(plng / cell))].append((plat, plng))
        return grid

    ped_grid = index_pts(ped_pts)
    vehicle_grid = index_pts(vehicle_pts)

    def near_any(
        lat: float,
        lng: float,
        grid: dict[tuple[int, int], list[tuple[float, float]]],
        max_m: float,
    ) -> bool:
        i, j = int(lat / cell), int(lng / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for plat, plng in grid.get((i + di, j + dj), []):
                    if haversine_m(lat, lng, plat, plng) <= max_m:
                        return True
        return False

    def way_is_ped_crossing(tags: dict, nds: list[int]) -> bool:
        """信号待ちする横断歩道か。

        OSM では歩行者信号タグが欠けることが多く、交差点の車用信号近くの
        footway=crossing は実質ほぼ歩行者信号あり、として扱う。
        """
        if is_uncontrolled_crossing(tags):
            return False
        # 横断歩道として明示されたウェイだけが対象（歩道の直進は待たない）
        if not is_crossing_way(tags):
            return False
        if (
            tags.get("crossing") in {"traffic_signals", "toucan"}
            or tags.get("crossing:signals") == "yes"
        ):
            return True
        if any(n in ped_signal_ids for n in nds):
            return True
        for nid in nds:
            n = nodes_raw[nid]
            if near_any(n["lat"], n["lng"], ped_grid, NEAR_SIGNAL_M):
                return True
            if near_any(n["lat"], n["lng"], vehicle_grid, NEAR_VEHICLE_SIGNAL_M):
                return True
        return False

    edge_map: dict[tuple[int, int], dict] = {}
    ped_edge_count = 0
    next_crossing_id = 0
    # 信号横断の中心（表示・デバッグ用）
    crossing_hubs: list[tuple[float, float, float]] = []
    for way in ways:
        tags = way.get("tags", {})
        if not way_walkable(tags):
            continue
        nds = [n for n in way.get("nodes", []) if n in id_map]
        ped_crossing = way_is_ped_crossing(tags, nds)
        segs: list[tuple[int, int, float, float, float]] = []
        for a, b in zip(nds, nds[1:]):
            na, nb = nodes_raw[a], nodes_raw[b]
            length = haversine_m(na["lat"], na["lng"], nb["lat"], nb["lng"])
            if length < 0.5 or length > 800:
                continue
            ia, ib = id_map[a], id_map[b]
            mid_lat = (na["lat"] + nb["lat"]) / 2
            mid_lng = (na["lng"] + nb["lng"]) / 2
            segs.append((ia, ib, length, mid_lat, mid_lng))
        crossing_id = 0
        if ped_crossing and segs:
            next_crossing_id += 1
            crossing_id = next_crossing_id
            mid_lat = sum(s[3] for s in segs) / len(segs)
            mid_lng = sum(s[4] for s in segs) / len(segs)
            crossing_hubs.append((mid_lat, mid_lng, cycle_near(mid_lat, mid_lng)))
        # 横断ウェイの全セグメントを同じ crossingId で信号扱い
        for ia, ib, length, mid_lat, mid_lng in segs:
            is_sig = crossing_id > 0
            cycle = cycle_near(mid_lat, mid_lng) if is_sig else 0.0
            walk = round(length / WALK_SPEED, 2)
            for u, v in ((ia, ib), (ib, ia)):
                key = (u, v)
                prev = edge_map.get(key)
                if prev is None:
                    edge_map[key] = {
                        "from": u,
                        "to": v,
                        "walkSec": walk,
                        "cycleSec": round(cycle, 1),
                        "isSignal": is_sig,
                        "crossingId": crossing_id,
                    }
                    if is_sig:
                        ped_edge_count += 1
                elif is_sig and not prev["isSignal"]:
                    prev["isSignal"] = True
                    prev["cycleSec"] = round(cycle, 1)
                    prev["crossingId"] = crossing_id
                    ped_edge_count += 1

    print(
        f"  edges={len(edge_map)} pedCrossingEdges={ped_edge_count} "
        f"crossings={next_crossing_id} hubs={len(crossing_hubs)}",
        flush=True,
    )

    edges_out = list(edge_map.values())

    used = {e["from"] for e in edges_out} | {e["to"] for e in edges_out}
    remap: dict[int, int] = {}
    nodes_kept: list[dict] = []
    for n in nodes_out:
        if n["id"] not in used:
            continue
        new_id = len(nodes_kept)
        remap[n["id"]] = new_id
        nodes_kept.append({"id": new_id, "lat": n["lat"], "lng": n["lng"]})
    for e in edges_out:
        e["from"] = remap[e["from"]]
        e["to"] = remap[e["to"]]
    print(f"  pruned nodes {len(nodes_out)} -> {len(nodes_kept)}", flush=True)
    nodes_out = nodes_kept
    stitched = stitch_nearby_nodes(nodes_out, edges_out, WALK_SPEED, STITCH_NEARBY_M)
    print(f"  stitched nearby sidewalks={stitched}", flush=True)

    signals_out = []
    for osm_id in ped_signal_ids:
        n = nodes_raw[osm_id]
        if haversine_m(ORIGIN["lat"], ORIGIN["lng"], n["lat"], n["lng"]) <= MAX_RADIUS_M:
            signals_out.append([round(n["lat"], 6), round(n["lng"], 6)])

    hubs_out = [
        [round(h[0], 6), round(h[1], 6), round(h[2], 1)] for h in crossing_hubs
    ]

    nodes_compact = [
        [n["id"], round(n["lat"], 6), round(n["lng"], 6)] for n in nodes_out
    ]
    edges_compact = [
        [
            e["from"],
            e["to"],
            e["walkSec"],
            e["cycleSec"],
            1 if e["isSignal"] else 0,
            int(e.get("crossingId", 0)),
        ]
        for e in edges_out
    ]

    return {
        "v": 4,
        "origin": ORIGIN,
        "maxRadiusM": MAX_RADIUS_M,
        "walkSpeedMps": WALK_SPEED,
        "defaultCycleSec": round(float(default_cycle), 1),
        "defaultPedGreenSec": DEFAULT_PED_GREEN,
        "defaultWaitSec": round(default_wait, 2),
        "jarticCycleCount": len(cycles),
        "signalClusterM": SIGNAL_CLUSTER_M,
        "promoteSignalM": 0,
        "nodes": nodes_compact,
        "edges": edges_compact,
        "signals": signals_out,
        "hubs": hubs_out,
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
