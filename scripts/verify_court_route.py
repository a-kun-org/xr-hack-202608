#!/usr/bin/env python3
"""検証: 札幌駅 → 札幌高等裁判所。横断歩道上の信号待ちだけを正解とする。"""
from __future__ import annotations

import heapq
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_graph import stitch_compact_graph

STATION = (43.0687, 141.3508)
COURT = (43.05983, 141.34008)
# 経路が横断ウェイ上にあるとみなす距離
ON_CROSSING_M = 6.0
HIT_M = 40.0


def hav(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


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
        or tags.get("crossing") in {"traffic_signals", "toucan", "marked", "zebra"}
        or tags.get("crossing:signals") == "yes"
    )


def is_uncontrolled(tags: dict) -> bool:
    return tags.get("crossing") in {"uncontrolled", "unmarked"}


def timing_for(node_id: int, cycle_sec: float, default_cycle: float = 125.0, green: float = 15.0):
    cycle = round(cycle_sec if cycle_sec >= 40 else default_cycle)
    cycle = min(200, cycle)
    offset = ((node_id * 17 + 31) % cycle + cycle) % cycle
    return cycle, green, offset


def route(graph: dict, start, end):
    nodes = {n[0]: (n[1], n[2]) for n in graph["nodes"]}
    adj = defaultdict(list)
    for e in graph["edges"]:
        cid = e[5] if len(e) >= 6 else (1 if e[4] == 1 else 0)
        adj[e[0]].append(
            {
                "to": e[1],
                "walk": e[2],
                "cycle": e[3],
                "sig": e[4] == 1 or cid > 0,
                "cid": cid,
            }
        )

    def snap(p, maxd=120):
        best, bd = None, maxd
        for i, ll in nodes.items():
            d = hav(p, ll)
            if d < bd:
                bd, best = d, i
        return best, bd

    s, sd = snap(start)
    e, ed = snap(end)
    if s is None or e is None:
        raise SystemExit(f"snap failed {sd}/{ed}")

    dist = {s: 0.0}
    prev: dict[int, int] = {}
    last_cid: dict[int, int] = {s: 0}
    pq = [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if d != dist.get(u):
            continue
        if u == e:
            break
        for edge in adj[u]:
            v = edge["to"]
            wait = 0.0
            charged = last_cid[u]
            if edge["sig"] and edge["cid"] > 0 and charged != edge["cid"]:
                cy, gr, off = timing_for(v, edge["cycle"])
                phase = (d + off) % cy
                wait = 0.0 if phase < gr else cy - phase
                charged = edge["cid"]
            nd = d + wait + edge["walk"]
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                last_cid[v] = charged
                heapq.heappush(pq, (nd, v))

    if e not in dist:
        raise SystemExit("no route")

    ids = []
    cur = e
    while True:
        ids.append(cur)
        if cur == s:
            break
        cur = prev[cur]
    ids.reverse()

    sig_pts = []
    last_stop_cid = 0
    for a, b in zip(ids, ids[1:]):
        edge = next(x for x in adj[a] if x["to"] == b)
        if not edge["sig"] or edge["cid"] <= 0:
            continue
        if edge["cid"] == last_stop_cid:
            continue
        last_stop_cid = edge["cid"]
        mid = (
            (nodes[a][0] + nodes[b][0]) / 2,
            (nodes[a][1] + nodes[b][1]) / 2,
        )
        sig_pts.append(mid)

    return {
        "snap": (sd, ed),
        "total": dist[e],
        "signalCount": len(sig_pts),
        "sig_pts": sig_pts,
        "path": [nodes[i] for i in ids],
        "path_edges": list(zip(ids, ids[1:])),
        "adj": adj,
        "nodes": nodes,
    }


def main() -> int:
    graph = json.loads((ROOT / "public/data/graph.json").read_text())
    stitch_compact_graph(graph)
    osm = json.loads((ROOT / "scripts/.cache/osm_sapporo.json").read_text())
    result = route(graph, STATION, COURT)

    osm_nodes = {}
    veh, ped = [], []
    cross_ways = []
    for el in osm["elements"]:
        if el["type"] == "node":
            tags = el.get("tags", {})
            osm_nodes[el["id"]] = (el["lat"], el["lon"], tags)
            if is_ped_signal_node(tags):
                ped.append((el["lat"], el["lon"]))
            elif is_vehicle_signal_node(tags):
                veh.append((el["lat"], el["lon"]))
        elif el["type"] == "way" and is_crossing_way(el.get("tags", {})):
            cross_ways.append(el)

    def nearest_sig(p):
        if not result["sig_pts"]:
            return 1e9
        return min(hav(p, s) for s in result["sig_pts"])

    # 経路が実際に踏んだ信号横断のみを期待値にする
    expected = []
    for w in cross_ways:
        tags = w.get("tags", {})
        if is_uncontrolled(tags):
            continue
        nds = [n for n in w.get("nodes", []) if n in osm_nodes]
        if len(nds) < 2:
            continue
        mid = (
            sum(osm_nodes[n][0] for n in nds) / len(nds),
            sum(osm_nodes[n][1] for n in nds) / len(nds),
        )
        has_tag = tags.get("crossing") in {"traffic_signals", "toucan"} or tags.get(
            "crossing:signals"
        ) == "yes"
        near_veh = any(hav(mid, v) <= 35 for v in veh)
        near_ped = any(hav(mid, v) <= 25 for v in ped)
        if not (has_tag or near_veh or near_ped):
            continue
        # 経路エッジ中点が横断中心に十分近いか
        d_path = min(hav(mid, q) for q in result["path"])
        on_path = False
        for a, b in result["path_edges"]:
            emid = (
                (result["nodes"][a][0] + result["nodes"][b][0]) / 2,
                (result["nodes"][a][1] + result["nodes"][b][1]) / 2,
            )
            if hav(mid, emid) <= ON_CROSSING_M:
                on_path = True
                break
        if not on_path:
            continue
        expected.append((d_path, mid, tags, w["id"]))

    hits = misses = 0
    miss_list = []
    for d_path, mid, tags, wid in sorted(expected):
        ns = nearest_sig(mid)
        if ns <= HIT_M:
            hits += 1
        else:
            misses += 1
            miss_list.append((wid, mid, d_path, ns, tags))

    # 偽陽性: 信号待ちがどの横断からも離れている
    false_pos = 0
    for sp in result["sig_pts"]:
        near = False
        for w in cross_ways:
            tags = w.get("tags", {})
            if is_uncontrolled(tags):
                continue
            nds = [n for n in w.get("nodes", []) if n in osm_nodes]
            if len(nds) < 2:
                continue
            mid = (
                sum(osm_nodes[n][0] for n in nds) / len(nds),
                sum(osm_nodes[n][1] for n in nds) / len(nds),
            )
            if hav(sp, mid) <= 20:
                near = True
                break
        if not near:
            false_pos += 1
            print(f"  FALSE_WAIT ({sp[0]:.5f},{sp[1]:.5f})")

    print(
        f"station→court snap={result['snap'][0]:.0f}/{result['snap'][1]:.0f}m "
        f"total={result['total']:.0f}s signals={result['signalCount']}"
    )
    print(
        f"walked signalized crossings: {len(expected)} hit={hits} miss={misses} "
        f"false_wait={false_pos}"
    )
    for wid, mid, d_path, ns, tags in miss_list:
        t = {k: tags.get(k) for k in ("footway", "crossing", "crossing:signals")}
        print(f"  MISS way={wid} ({mid[0]:.5f},{mid[1]:.5f}) dPath={d_path:.0f} dSig={ns:.0f} {t}")

    rate = hits / len(expected) if expected else 1.0
    ok = misses == 0 and false_pos == 0
    print(f"hit_rate={rate:.0%} {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
