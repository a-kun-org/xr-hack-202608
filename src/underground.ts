import { formatDuration, type LatLng } from "./router";

export type UnderArea = {
  name: string;
  kind: "polygon" | "line";
  coords: [number, number][];
};

export type UndergroundData = {
  areas: UnderArea[];
};

export type UnderHit = {
  names: string[];
  underM: number;
  flags: boolean[];
};

const HIT_M = 12;
const NAME_ORDER = [
  "アピア",
  "チカホ",
  "オーロラタウン",
  "ポールタウン",
  "北一条地下道",
  "札幌駅地下",
  "地下道",
  "地下通路",
];

function toXY(p: LatLng, origin: LatLng): [number, number] {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return [(p.lng - origin.lng) * mLng, (p.lat - origin.lat) * mLat];
}

function pointInRing(p: LatLng, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > p.lat !== yj > p.lat &&
      p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi + 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegM(p: LatLng, a: LatLng, b: LatLng): number {
  const o = a;
  const [px, py] = toXY(p, o);
  const [ax, ay] = toXY(a, o);
  const [bx, by] = toXY(b, o);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const x = ax + dx * t - px;
  const y = ay + dy * t - py;
  return Math.hypot(x, y);
}

function distToLineM(p: LatLng, coords: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const a = { lng: coords[i - 1][0], lat: coords[i - 1][1] };
    const b = { lng: coords[i][0], lat: coords[i][1] };
    const d = distToSegM(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

export function hitUnderground(p: LatLng, areas: UnderArea[]): string | null {
  let bestName: string | null = null;
  let best = HIT_M;
  for (const area of areas) {
    if (area.kind === "polygon") {
      if (pointInRing(p, area.coords)) return area.name;
      continue;
    }
    const d = distToLineM(p, area.coords);
    if (d < best) {
      best = d;
      bestName = area.name;
    }
  }
  return bestName;
}

function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function sortNames(names: Iterable<string>): string[] {
  const set = new Set(names);
  const named = [...set].some(
    (n) => n !== "地下通路" && n !== "地下道" && n !== "札幌駅地下"
  );
  if (named) {
    set.delete("地下通路");
    set.delete("地下道");
    if (set.has("アピア")) set.delete("札幌駅地下");
  }
  return [...set].sort((a, b) => {
    const ia = NAME_ORDER.indexOf(a);
    const ib = NAME_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "ja");
  });
}

export function classifyPath(path: LatLng[], areas: UnderArea[]): UnderHit {
  const flags = path.map((p) => hitUnderground(p, areas) !== null);
  const names = new Set<string>();
  let underM = 0;
  for (let i = 0; i < path.length; i++) {
    const name = hitUnderground(path[i], areas);
    if (name) names.add(name);
    if (i === 0) continue;
    const mid: LatLng = {
      lat: (path[i - 1].lat + path[i].lat) / 2,
      lng: (path[i - 1].lng + path[i].lng) / 2,
    };
    const midName = hitUnderground(mid, areas);
    if (midName) names.add(midName);
    if (flags[i - 1] || flags[i] || midName) {
      underM += haversineM(path[i - 1], path[i]);
    }
  }
  return { names: sortNames(names), underM, flags };
}

export function formatUnderLabel(hit: UnderHit, walkSpeedMps: number): string {
  if (hit.underM < 8) return "なし";
  const sec = hit.underM / Math.max(0.5, walkSpeedMps);
  const place = hit.names.length > 0 ? hit.names.join("・") : "地下通路";
  return `${place} ${formatDuration(sec)}`;
}

export function undergroundGeoJSON(areas: UnderArea[]) {
  return {
    type: "FeatureCollection" as const,
    features: areas.map((area) => ({
      type: "Feature" as const,
      properties: { name: area.name, kind: area.kind },
      geometry:
        area.kind === "polygon"
          ? { type: "Polygon" as const, coordinates: [area.coords] }
          : { type: "LineString" as const, coordinates: area.coords },
    })),
  };
}

export function splitRouteGeoJSON(path: LatLng[], flags: boolean[]) {
  const under: [number, number][][] = [];
  const surface: [number, number][][] = [];
  let cur: [number, number][] = [];
  let curUnder: boolean | null = null;

  const pt = (i: number): [number, number] => [path[i].lng, path[i].lat];
  const flush = () => {
    if (cur.length >= 2 && curUnder !== null) {
      (curUnder ? under : surface).push(cur);
    }
    cur = [];
  };

  for (let i = 1; i < path.length; i++) {
    const isUnder = Boolean(flags[i - 1] || flags[i]);
    if (curUnder === null) {
      cur.push(pt(i - 1), pt(i));
      curUnder = isUnder;
    } else if (isUnder === curUnder) {
      cur.push(pt(i));
    } else {
      flush();
      cur.push(pt(i - 1), pt(i));
      curUnder = isUnder;
    }
  }
  flush();

  const features = [];
  if (surface.length > 0) {
    features.push({
      type: "Feature" as const,
      properties: { under: 0 },
      geometry: { type: "MultiLineString" as const, coordinates: surface },
    });
  }
  if (under.length > 0) {
    features.push({
      type: "Feature" as const,
      properties: { under: 1 },
      geometry: { type: "MultiLineString" as const, coordinates: under },
    });
  }
  return { type: "FeatureCollection" as const, features };
}
