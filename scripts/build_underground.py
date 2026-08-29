#!/usr/bin/env python3
"""Build compact GeoJSON of Sapporo underground walkways (チカホ / アピア etc.)."""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "scripts" / ".cache"
OUT = ROOT / "public" / "data" / "underground.json"

BBOX = (43.048, 141.344, 43.073, 141.360)  # south, west, north, east

QUERY = f"""
[out:json][timeout:90];
(
  way["highway"~"^(footway|path|pedestrian|steps|corridor)$"]["tunnel"]({",".join(map(str, BBOX))});
  way["highway"~"^(footway|path|pedestrian|steps|corridor)$"]["location"="underground"]({",".join(map(str, BBOX))});
  way["highway"~"^(footway|path|pedestrian|steps|corridor)$"]["indoor"="yes"]({",".join(map(str, BBOX))});
  way["highway"~"^(footway|path|pedestrian|steps|corridor)$"]["layer"~"^-[0-9]"]({",".join(map(str, BBOX))});
  way["name"~"チカホ|地下歩行|アピア|ポールタウン|オーロラタウン|地下街|地下道"]({",".join(map(str, BBOX))});
);
out geom tags;
"""


def fetch_overpass(force: bool = False) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE / "underground_osm.json"
    if cache_path.exists() and not force:
        print(f"Using cached OSM: {cache_path}")
        return json.loads(cache_path.read_text(encoding="utf-8"))

    print("Fetching underground ways via Overpass…")
    body = urllib.parse.urlencode({"data": QUERY}).encode("utf-8")
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
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
                    "User-Agent": "xr-hack-202608-underground/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
            print(f"Overpass OK via {url} ({len(payload)} bytes)")
            break
        except Exception as exc:
            print(f"Overpass failed ({url}): {exc}")
            last_err = exc
    else:
        raise RuntimeError(f"All Overpass endpoints failed: {last_err}")
    cache_path.write_bytes(payload)
    return json.loads(payload)


def parse_int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    text = str(value).split(";")[0].strip()
    try:
        return int(text)
    except ValueError:
        return default


def keep_way(tags: dict) -> bool:
    layer = parse_int(tags.get("layer"), 0)
    level = parse_int(tags.get("level"), 0)
    # layer=-2 などは粗い下水管・地下鉄スケッチを拾いやすい
    if layer >= 1 or layer <= -2 or level >= 1:
        return False
    name = tags.get("name") or ""
    desc = tags.get("description") or ""
    named = any(
        key in name or key in desc
        for key in (
            "アピア",
            "地下歩行",
            "ポールタウン",
            "オーロラタウン",
            "地下道",
            "地下街",
            "チカホ",
        )
    )
    if named:
        return True
    tunnel = tags.get("tunnel") in {"yes", "building_passage"}
    loc = tags.get("location") == "underground"
    return tunnel or loc or layer < 0 or level < 0


def display_name(tags: dict, lat: float, lng: float) -> str:
    name = tags.get("name") or ""
    desc = tags.get("description") or ""
    blob = name + desc
    if "アピア" in blob:
        return "アピア"
    if "地下歩行" in blob or "チカホ" in blob:
        return "チカホ"
    if "ポールタウン" in blob:
        return "ポールタウン"
    if "オーロラタウン" in blob:
        return "オーロラタウン"
    if "北一条地下道" in blob or "北1条地下道" in blob:
        return "北一条地下道"
    if "地下道" in blob:
        return "地下道"
    if lat >= 43.0668:
        return "札幌駅地下"
    if 43.0602 <= lat <= 43.0668 and 141.3500 <= lng <= 141.3525:
        return "チカホ"
    if lat < 43.0602 and 141.3514 <= lng <= 141.3542:
        return "ポールタウン"
    if 43.0602 <= lat <= 43.0616 and lng >= 141.3522:
        return "オーロラタウン"
    return "地下通路"


def is_closed(geom: list[dict]) -> bool:
    if len(geom) < 4:
        return False
    a, b = geom[0], geom[-1]
    return abs(a["lat"] - b["lat"]) < 1e-7 and abs(a["lon"] - b["lon"]) < 1e-7


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def way_length_m(geom: list[dict]) -> float:
    total = 0.0
    for a, b in zip(geom, geom[1:]):
        total += haversine_m((a["lat"], a["lon"]), (b["lat"], b["lon"]))
    return total


def coords_lnglat(geom: list[dict]) -> list[list[float]]:
    return [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom]


def build(osm: dict) -> dict:
    areas: list[dict] = []
    for el in osm.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        tags = el.get("tags", {})
        if not keep_way(tags):
            continue
        geom = el["geometry"]
        mid = geom[len(geom) // 2]
        name = display_name(tags, mid["lat"], mid["lon"])
        closed = is_closed(geom) and (tags.get("shop") == "mall" or "アピア" in name)
        if closed:
            kind = "polygon"
        else:
            kind = "line"
            if way_length_m(geom) < 8:
                continue
        areas.append(
            {
                "name": name,
                "kind": kind,
                "coords": coords_lnglat(geom),
            }
        )
    return {"areas": areas}


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--force-osm", action="store_true")
    args = parser.parse_args()

    osm = fetch_overpass(force=args.force_osm)
    data = build(osm)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts: dict[str, int] = {}
    for a in data["areas"]:
        counts[a["name"]] = counts.get(a["name"], 0) + 1
    print(f"Wrote {OUT} areas={len(data['areas'])} {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
