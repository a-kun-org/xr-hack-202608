#!/usr/bin/env python3
"""検証: 南3西8は直進横断し、交差点を三辺回りしない。"""
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

# 西8丁目通りの西側歩道、南3条の南北
NORTH = (43.05730, 141.34473)
SOUTH = (43.05626, 141.34499)
AROUND_CIDS = {387, 388, 389}
STRAIGHT_CID = 386


def hav(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def snap(nodes: dict[int, tuple[float, float]], p: tuple[float, float], maxd=80):
    best, bd = None, maxd
    for i, ll in nodes.items():
        d = hav(p, ll)
        if d < bd:
            bd, best = d, i
    return best, bd


def route(graph: dict, start, end):
    nodes = {n[0]: (n[1], n[2]) for n in graph["nodes"]}
    adj = defaultdict(list)
    for e in graph["edges"]:
        cid = e[5] if len(e) >= 6 else 0
        adj[e[0]].append(
            {
                "to": e[1],
                "walk": e[2],
                "cycle": e[3],
                "sig": e[4] == 1 or cid > 0,
                "cid": cid,
            }
        )

    sid, sd = snap(nodes, start)
    eid, ed = snap(nodes, end)
    if sid is None or eid is None:
        raise SystemExit(f"snap failed {sd}/{ed}")

    dist = {sid: 0.0}
    prev: dict[int, int] = {}
    last_cid = {sid: 0}
    pq = [(0.0, sid)]
    while pq:
        d, u = heapq.heappop(pq)
        if d != dist.get(u):
            continue
        if u == eid:
            break
        for edge in adj[u]:
            v = edge["to"]
            wait = 0.0
            charged = last_cid[u]
            if edge["sig"] and edge["cid"] > 0 and charged != edge["cid"]:
                cycle = min(200, round(edge["cycle"] if edge["cycle"] >= 40 else 125))
                green = min(15, max(7, cycle - 10))
                offset = ((v * 17 + 31) % cycle + cycle) % cycle
                phase = (d + offset) % cycle
                wait = 0.0 if phase < green else cycle - phase
                charged = edge["cid"]
            nd = d + wait + edge["walk"]
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                last_cid[v] = charged
                heapq.heappush(pq, (nd, v))

    if eid not in dist:
        raise SystemExit("no route")

    ids = []
    cur = eid
    while True:
        ids.append(cur)
        if cur == sid:
            break
        cur = prev[cur]
    ids.reverse()

    cids = []
    last = 0
    walk = 0.0
    for a, b in zip(ids, ids[1:]):
        edge = next(x for x in adj[a] if x["to"] == b)
        walk += edge["walk"]
        if edge["sig"] and edge["cid"] and edge["cid"] != last:
            last = edge["cid"]
            cids.append(edge["cid"])
    return {
        "snap": (sd, ed),
        "total": dist[eid],
        "walk": walk,
        "cids": cids,
        "path": [nodes[i] for i in ids],
    }


def main() -> int:
    graph = json.loads((ROOT / "public/data/graph.json").read_text())
    stitch_compact_graph(graph)
    result = route(graph, NORTH, SOUTH)
    around = AROUND_CIDS.issubset(set(result["cids"]))
    straight = STRAIGHT_CID in result["cids"] and not around
    print(
        f"南3西8 west sidewalk snap={result['snap'][0]:.0f}/{result['snap'][1]:.0f}m "
        f"total={result['total']:.0f}s walk={result['walk']:.0f}s cids={result['cids']}"
    )
    if around:
        print("FAIL: 交差点を三辺回っている")
        return 1
    if not straight:
        print("FAIL: 西側の直進横断を使っていない")
        return 1
    if result["walk"] > 180:
        print("FAIL: 歩行が長すぎる（街区外周の疑い）")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
