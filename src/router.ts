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
  waitSec: number;
  isSignal: boolean;
};

export type GraphData = {
  origin: LatLng;
  maxRadiusM: number;
  walkSpeedMps: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  signals: LatLng[];
};

/** Wire format from build_graph.py (compact arrays). */
type RawGraph = {
  v?: number;
  origin: LatLng;
  maxRadiusM: number;
  walkSpeedMps: number;
  nodes: GraphNode[] | [number, number, number][];
  edges:
    | GraphEdge[]
    | [number, number, number, number, number][];
  signals: LatLng[] | [number, number][];
};

export type RouteResult = {
  path: LatLng[];
  totalSec: number;
  walkSec: number;
  waitSec: number;
  signalCount: number;
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
      return {
        from: e[0],
        to: e[1],
        lengthM: 0,
        walkSec: e[2],
        waitSec: e[3],
        isSignal: e[4] === 1,
      };
    }
    return e;
  });
  const signals: LatLng[] = raw.signals.map((s) => {
    if (Array.isArray(s)) return { lat: s[0], lng: s[1] };
    return s;
  });
  return {
    origin: raw.origin,
    maxRadiusM: raw.maxRadiusM,
    walkSpeedMps: raw.walkSpeedMps,
    nodes,
    edges,
    signals,
  };
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

type Adj = { to: number; walkSec: number; waitSec: number; isSignal: boolean };

function buildAdj(graph: GraphData): Map<number, Adj[]> {
  const adj = new Map<number, Adj[]>();
  for (const e of graph.edges) {
    const a = adj.get(e.from) ?? [];
    a.push({
      to: e.to,
      walkSec: e.walkSec,
      waitSec: e.waitSec,
      isSignal: e.isSignal,
    });
    adj.set(e.from, a);
  }
  return adj;
}

/** Binary-heap Dijkstra on walkSec + waitSec. */
export function findRoute(
  graph: GraphData,
  startId: number,
  endId: number
): RouteResult | null {
  if (startId === endId) {
    const n = graph.nodes.find((x) => x.id === startId)!;
    return {
      path: [{ lat: n.lat, lng: n.lng }],
      totalSec: 0,
      walkSec: 0,
      waitSec: 0,
      signalCount: 0,
    };
  }

  const adj = buildAdj(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const walkAcc = new Map<number, number>();
  const waitAcc = new Map<number, number>();
  const sigAcc = new Map<number, number>();

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
  sigAcc.set(startId, 0);
  push({ id: startId, cost: 0 });

  while (heap.length > 0) {
    const cur = pop()!;
    const d = dist.get(cur.id) ?? Infinity;
    if (cur.cost > d) continue;
    if (cur.id === endId) break;

    for (const edge of adj.get(cur.id) ?? []) {
      const nd = d + edge.walkSec + edge.waitSec;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        walkAcc.set(edge.to, (walkAcc.get(cur.id) ?? 0) + edge.walkSec);
        waitAcc.set(edge.to, (waitAcc.get(cur.id) ?? 0) + edge.waitSec);
        sigAcc.set(
          edge.to,
          (sigAcc.get(cur.id) ?? 0) + (edge.isSignal ? 1 : 0)
        );
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

  return {
    path: ids.map((id) => {
      const n = nodeById.get(id)!;
      return { lat: n.lat, lng: n.lng };
    }),
    totalSec: dist.get(endId)!,
    walkSec: walkAcc.get(endId)!,
    waitSec: waitAcc.get(endId)!,
    signalCount: sigAcc.get(endId)!,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  return `${m}分${r.toString().padStart(2, "0")}秒`;
}
