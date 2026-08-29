export type LatLng = { lat: number; lng: number };

export type GraphNode = {
  id: number;
  lat: number;
  lng: number;
};

export type GraphEdge = {
  from: number;
  to: number;
  lengthM: number;
  walkSec: number;
  cycleSec: number;
  isSignal: boolean;
  /** OSM crossing way group; same id = one crossing (multi-segment). */
  crossingId: number;
};

export type GraphData = {
  origin: LatLng;
  maxRadiusM: number;
  walkSpeedMps: number;
  defaultCycleSec: number;
  defaultPedGreenSec: number;
  signalClusterM: number;
  promoteSignalM: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  signals: LatLng[];
  /** Signalized crossing hubs: [lat, lng, cycleSec] */
  hubs: { lat: number; lng: number; cycleSec: number }[];
};

/** Wire format from build_graph.py (compact arrays). */
type RawGraph = {
  v?: number;
  origin: LatLng;
  maxRadiusM: number;
  walkSpeedMps: number;
  defaultCycleSec?: number;
  defaultPedGreenSec?: number;
  signalClusterM?: number;
  promoteSignalM?: number;
  nodes: GraphNode[] | [number, number, number][];
  edges:
    | GraphEdge[]
    | [number, number, number, number, number][]
    | [number, number, number, number, number, number][];
  signals: LatLng[] | [number, number][];
  hubs?: [number, number, number][] | { lat: number; lng: number; cycleSec: number }[];
};

export type SignalStop = {
  index: number;
  lat: number;
  lng: number;
  arriveAt: number;
  waitSec: number;
  crossAt: number;
  clearAt: number;
  cycle: number;
  green: number;
  offset: number;
};

export type RouteResult = {
  path: LatLng[];
  nodeElapsed: number[];
  nodeWait: number[];
  totalSec: number;
  walkSec: number;
  waitSec: number;
  signalCount: number;
  departAt: number;
  signalStops: SignalStop[];
};

export function normalizeGraph(raw: RawGraph): GraphData {
  const nodes: GraphNode[] = raw.nodes.map((n) => {
    if (Array.isArray(n)) {
      return { id: n[0], lat: n[1], lng: n[2] };
    }
    return n;
  });
  const edges: GraphEdge[] = raw.edges.map((e) => {
    if (Array.isArray(e)) {
      const crossingId =
        e.length >= 6 ? Number(e[5] ?? 0) : e[4] === 1 ? 1 : 0;
      return {
        from: e[0],
        to: e[1],
        lengthM: 0,
        walkSec: e[2],
        cycleSec: e[3],
        isSignal: e[4] === 1 || crossingId > 0,
        crossingId,
      };
    }
    return {
      ...e,
      crossingId: e.crossingId ?? (e.isSignal ? 1 : 0),
    };
  });
  const signals: LatLng[] = raw.signals.map((s) => {
    if (Array.isArray(s)) return { lat: s[0], lng: s[1] };
    return s;
  });
  const hubs = (raw.hubs ?? []).map((h) => {
    if (Array.isArray(h)) return { lat: h[0], lng: h[1], cycleSec: h[2] };
    return h;
  });
  return {
    origin: raw.origin,
    maxRadiusM: raw.maxRadiusM,
    walkSpeedMps: raw.walkSpeedMps,
    defaultCycleSec: raw.defaultCycleSec ?? 125,
    defaultPedGreenSec: raw.defaultPedGreenSec ?? 15,
    signalClusterM: raw.signalClusterM ?? 40,
    promoteSignalM: raw.promoteSignalM ?? 18,
    nodes,
    edges,
    signals,
    hubs,
  };
}

export type SignalTiming = {
  cycle: number;
  green: number;
  offset: number;
};

/** Pedestrian walk interval inside a JARTIC vehicle cycle. */
export function timingFor(
  nodeId: number,
  cycleSec: number,
  defaultCycle: number,
  pedGreen: number
): SignalTiming {
  const cycle = Math.round(
    cycleSec >= 40 ? Math.min(200, cycleSec) : defaultCycle
  );
  const green = Math.min(pedGreen, Math.max(7, cycle - 10));
  return {
    cycle,
    green,
    offset: ((nodeId * 17 + 31) % cycle + cycle) % cycle,
  };
}

/** Seconds until green at absolute unix time. 0 if already green. */
export function waitIfRed(atUnix: number, t: SignalTiming): number {
  const phase = ((atUnix + t.offset) % t.cycle + t.cycle) % t.cycle;
  if (phase < t.green) return 0;
  return t.cycle - phase;
}

export function isGreenAt(atUnix: number, t: SignalTiming): boolean {
  return waitIfRed(atUnix, t) === 0;
}

export function phaseRemain(atUnix: number, t: SignalTiming): {
  green: boolean;
  remain: number;
} {
  const phase = ((atUnix + t.offset) % t.cycle + t.cycle) % t.cycle;
  if (phase < t.green) {
    return { green: true, remain: Math.max(1, Math.ceil(t.green - phase)) };
  }
  return { green: false, remain: Math.max(1, Math.ceil(t.cycle - phase)) };
}

function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceFromOriginM(p: LatLng, origin: LatLng): number {
  return haversineM(p, origin);
}

/** Nearest node within maxSnapM, or null. */
export function snapToNode(
  graph: GraphData,
  point: LatLng,
  maxSnapM = 80
): number | null {
  let bestId: number | null = null;
  let best = maxSnapM;
  for (const n of graph.nodes) {
    const d = haversineM(point, n);
    if (d < best) {
      best = d;
      bestId = n.id;
    }
  }
  return bestId;
}

type Adj = {
  to: number;
  walkSec: number;
  cycleSec: number;
  isSignal: boolean;
  crossingId: number;
};

function buildAdj(graph: GraphData): Map<number, Adj[]> {
  const adj = new Map<number, Adj[]>();
  for (const e of graph.edges) {
    const a = adj.get(e.from) ?? [];
    a.push({
      to: e.to,
      walkSec: e.walkSec,
      cycleSec: e.cycleSec,
      isSignal: e.isSignal,
      crossingId: e.crossingId,
    });
    adj.set(e.from, a);
  }
  return adj;
}

/** Time-dependent Dijkstra: wait is remaining red at arrival, not average. */
export function findRoute(
  graph: GraphData,
  startId: number,
  endId: number,
  departAt = Date.now() / 1000
): RouteResult | null {
  if (startId === endId) {
    const n = graph.nodes.find((x) => x.id === startId)!;
    return {
      path: [{ lat: n.lat, lng: n.lng }],
      nodeElapsed: [0],
      nodeWait: [0],
      totalSec: 0,
      walkSec: 0,
      waitSec: 0,
      signalCount: 0,
      departAt,
      signalStops: [],
    };
  }

  const adj = buildAdj(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const walkAcc = new Map<number, number>();
  const waitAcc = new Map<number, number>();
  /** Last crossing id charged on the best path to this node (0 = none). */
  const lastCrossing = new Map<number, number>();

  type Item = { id: number; cost: number };
  const heap: Item[] = [];
  const push = (item: Item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= heap[i].cost) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): Item | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length === 0) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < heap.length && heap[l].cost < heap[s].cost) s = l;
      if (r < heap.length && heap[r].cost < heap[s].cost) s = r;
      if (s === i) break;
      [heap[i], heap[s]] = [heap[s], heap[i]];
      i = s;
    }
    return top;
  };

  dist.set(startId, 0);
  walkAcc.set(startId, 0);
  waitAcc.set(startId, 0);
  lastCrossing.set(startId, 0);
  push({ id: startId, cost: 0 });

  while (heap.length > 0) {
    const cur = pop()!;
    const d = dist.get(cur.id) ?? Infinity;
    if (cur.cost > d) continue;
    if (cur.id === endId) break;

    for (const edge of adj.get(cur.id) ?? []) {
      let wait = 0;
      let chargedId = lastCrossing.get(cur.id) ?? 0;
      // 同一横断ウェイの連続セグメントは1回だけ待つ。
      // 二段階横断の別ウェイは別 ID なので別待ちになる。
      if (edge.isSignal && edge.crossingId > 0) {
        if (chargedId !== edge.crossingId) {
          const timing = timingFor(
            edge.to,
            edge.cycleSec,
            graph.defaultCycleSec,
            graph.defaultPedGreenSec
          );
          wait = waitIfRed(departAt + d, timing);
          chargedId = edge.crossingId;
        }
      }

      const nd = d + wait + edge.walkSec;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        walkAcc.set(edge.to, (walkAcc.get(cur.id) ?? 0) + edge.walkSec);
        waitAcc.set(edge.to, (waitAcc.get(cur.id) ?? 0) + wait);
        lastCrossing.set(edge.to, chargedId);
        prev.set(edge.to, cur.id);
        push({ id: edge.to, cost: nd });
      }
    }
  }

  if (!dist.has(endId)) return null;

  const ids: number[] = [];
  let cur: number | undefined = endId;
  while (cur !== undefined) {
    ids.push(cur);
    if (cur === startId) break;
    cur = prev.get(cur);
  }
  ids.reverse();

  const path = ids.map((id) => {
    const n = nodeById.get(id)!;
    return { lat: n.lat, lng: n.lng };
  });
  const nodeElapsed = ids.map((id) => dist.get(id) ?? 0);
  const nodeWait = ids.map((id, i) => {
    if (i === 0) return 0;
    const walk = walkAcc.get(id)! - walkAcc.get(ids[i - 1])!;
    return (dist.get(id) ?? 0) - (dist.get(ids[i - 1]) ?? 0) - walk;
  });

  const signalStops: SignalStop[] = [];
  let signalIndex = 0;
  let lastStopCrossing = 0;
  for (let i = 1; i < ids.length; i++) {
    const from = ids[i - 1];
    const to = ids[i];
    const edge = (adj.get(from) ?? []).find((e) => e.to === to);
    if (!edge?.isSignal || edge.crossingId <= 0) continue;
    if (edge.crossingId === lastStopCrossing) continue;
    lastStopCrossing = edge.crossingId;
    signalIndex += 1;
    const timing = timingFor(
      to,
      edge.cycleSec,
      graph.defaultCycleSec,
      graph.defaultPedGreenSec
    );
    const atNear = dist.get(from) ?? 0;
    const waitSec = nodeWait[i] ?? waitIfRed(departAt + atNear, timing);
    const fromNode = nodeById.get(from)!;
    signalStops.push({
      index: signalIndex,
      lat: fromNode.lat,
      lng: fromNode.lng,
      arriveAt: departAt + atNear,
      waitSec,
      crossAt: departAt + atNear + waitSec,
      clearAt: departAt + (dist.get(to) ?? atNear + waitSec + edge.walkSec),
      ...timing,
    });
  }

  return {
    path,
    nodeElapsed,
    nodeWait,
    totalSec: dist.get(endId)!,
    walkSec: walkAcc.get(endId)!,
    waitSec: waitAcc.get(endId)!,
    signalCount: signalStops.length,
    departAt,
    signalStops,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  return `${m}分${r.toString().padStart(2, "0")}秒`;
}

export function formatClock(date = new Date()): string {
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Position along the timed path. waits[i] = wait at path[i-1] before walking to i. */
export function pointAtElapsed(
  path: LatLng[],
  nodeElapsed: number[],
  elapsed: number,
  waits: number[] = []
): LatLng {
  if (path.length === 0) return { lat: 0, lng: 0 };
  if (elapsed <= 0 || path.length === 1) return path[0];
  for (let i = 1; i < path.length; i++) {
    const t0 = nodeElapsed[i - 1];
    const t1 = nodeElapsed[i];
    if (elapsed > t1) continue;
    const wait = waits[i] ?? 0;
    const depart = t0 + wait;
    if (elapsed < depart) return path[i - 1];
    const span = t1 - depart;
    const u = span <= 0 ? 1 : (elapsed - depart) / span;
    return {
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * u,
      lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * u,
    };
  }
  return path[path.length - 1];
}
