import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import {
  distanceFromOriginM,
  findRoute,
  formatClock,
  formatDuration,
  normalizeGraph,
  phaseRemain,
  pointAtElapsed,
  snapToNode,
  type GraphData,
  type LatLng,
  type RouteResult,
} from "./router";

const SAPPORO_STATION: LatLng = { lat: 43.0687, lng: 141.3508 };
const REFRESH_MS = 12000;

const mapEl = document.getElementById("map")!;
const destLabel = document.getElementById("dest-label")!;
const statusEl = document.getElementById("status")!;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const resultEl = document.getElementById("result")!;
const clockEl = document.getElementById("clock")!;

const map = L.map(mapEl, { zoomControl: true }).setView(
  [SAPPORO_STATION.lat, SAPPORO_STATION.lng],
  14
);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

const originIcon = L.divIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#2bb673;border:2px solid #fff;box-shadow:0 0 0 4px rgba(43,182,115,.35)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const destIcon = L.divIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#e07a5f;border:2px solid #fff;box-shadow:0 0 0 4px rgba(224,122,95,.35)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const walkerIcon = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #2bb673;box-shadow:0 0 10px rgba(43,182,115,.8)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

L.marker([SAPPORO_STATION.lat, SAPPORO_STATION.lng], {
  icon: originIcon,
  title: "札幌駅",
}).addTo(map);

let graph: GraphData | null = null;
let dest: LatLng | null = null;
let destMarker: L.Marker | null = null;
let routeLine: L.Polyline | null = null;
let walkerMarker: L.Marker | null = null;
let routeSignals: L.CircleMarker[] = [];
let lastResult: RouteResult | null = null;
let refreshTimer: number | null = null;

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function fmtCoord(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

function tickClock() {
  clockEl.textContent = formatClock();
  updateLiveSignals();
  updateWalker();
}

function updateLiveSignals() {
  if (!lastResult) return;
  const now = Date.now() / 1000;
  lastResult.signalStops.forEach((stop, i) => {
    const marker = routeSignals[i];
    if (!marker) return;
    const { green, remain } = phaseRemain(now, stop);
    marker.setStyle({
      color: green ? "#2bb673" : "#e23d3d",
      fillColor: green ? "#2bb673" : "#e23d3d",
    });
    marker.setTooltipContent(green ? `青 あと${remain}秒` : `赤 あと${remain}秒`);
  });
}

function updateWalker() {
  if (!lastResult || !walkerMarker) return;
  const elapsed = Date.now() / 1000 - lastResult.departAt;
  const p = pointAtElapsed(
    lastResult.path,
    lastResult.nodeElapsed,
    elapsed,
    lastResult.nodeWait
  );
  walkerMarker.setLatLng([p.lat, p.lng]);
}

function clearRoute() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (walkerMarker) {
    map.removeLayer(walkerMarker);
    walkerMarker = null;
  }
  for (const m of routeSignals) map.removeLayer(m);
  routeSignals = [];
  lastResult = null;
}

function showResult(result: RouteResult, fitted: boolean) {
  lastResult = result;
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(
    result.path.map((p) => [p.lat, p.lng] as [number, number]),
    { color: "#2bb673", weight: 5, opacity: 0.9 }
  ).addTo(map);
  if (fitted) map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

  for (const m of routeSignals) map.removeLayer(m);
  routeSignals = result.signalStops.map((stop) => {
    const marker = L.circleMarker([stop.lat, stop.lng], {
      radius: 7,
      color: "#e23d3d",
      weight: 2,
      fillColor: "#e23d3d",
      fillOpacity: 0.9,
    }).addTo(map);
    marker.bindTooltip("", { permanent: false, direction: "top" });
    return marker;
  });
  updateLiveSignals();

  if (!walkerMarker) {
    walkerMarker = L.marker(result.path[0], { icon: walkerIcon, zIndexOffset: 800 }).addTo(map);
  }
  updateWalker();

  const depart = new Date(result.departAt * 1000);
  const arrive = new Date((result.departAt + result.totalSec) * 1000);
  (document.getElementById("r-depart")!).textContent = formatClock(depart);
  (document.getElementById("r-arrive")!).textContent = formatClock(arrive);
  (document.getElementById("r-total")!).textContent = formatDuration(result.totalSec);
  (document.getElementById("r-walk")!).textContent = formatDuration(result.walkSec);
  (document.getElementById("r-wait")!).textContent = formatDuration(result.waitSec);
  (document.getElementById("r-signals")!).textContent = String(result.signalCount);
  resultEl.hidden = false;
}

function searchRoute(silent = false) {
  if (!graph || !dest) return;

  const startId = snapToNode(graph, graph.origin, 120);
  const endId = snapToNode(graph, dest, 80);
  if (startId === null) {
    setStatus("起点を道路ネットワークに接続できませんでした", true);
    return;
  }
  if (endId === null) {
    setStatus("終点付近に歩行可能な道が見つかりません（別の地点を試してください）", true);
    return;
  }

  if (!silent) setStatus("いまの時刻で経路を計算中…");
  const result = findRoute(graph, startId, endId, Date.now() / 1000);
  if (!result) {
    setStatus("経路が見つかりませんでした", true);
    return;
  }

  showResult(result, !silent);
  setStatus(
    silent
      ? `${formatClock()} 時点でルートを更新しました`
      : "いま出発する場合のルートです（約12秒ごとに再計算）"
  );
}

function scheduleRefresh() {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (dest && graph) searchRoute(true);
  }, REFRESH_MS);
}

async function loadGraph(): Promise<void> {
  setStatus("歩行ネットワークを読み込み中…");
  const res = await fetch(`${import.meta.env.BASE_URL}data/graph.json`);
  if (!res.ok) throw new Error(`graph.json の取得に失敗 (${res.status})`);
  graph = normalizeGraph(await res.json());

  L.circle([graph.origin.lat, graph.origin.lng], {
    radius: graph.maxRadiusM,
    color: "#2bb673",
    weight: 1,
    fillColor: "#2bb673",
    fillOpacity: 0.04,
    interactive: false,
  }).addTo(map);

  setStatus("地図をタップして終点を指定してください");
}

map.on("click", (e) => {
  if (!graph) return;
  const p: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
  const d = distanceFromOriginM(p, graph.origin);
  if (d > graph.maxRadiusM) {
    setStatus(
      `範囲外です（札幌駅から約${(d / 1000).toFixed(1)}km）。${(graph.maxRadiusM / 1000).toFixed(0)}km以内を指定してください。`,
      true
    );
    return;
  }

  dest = p;
  destLabel.textContent = fmtCoord(p);
  if (destMarker) destMarker.setLatLng([p.lat, p.lng]);
  else destMarker = L.marker([p.lat, p.lng], { icon: destIcon }).addTo(map);

  searchBtn.disabled = false;
  resultEl.hidden = true;
  clearRoute();
  setStatus("終点を設定しました。「いま出発で検索」を押してください");
});

searchBtn.addEventListener("click", () => {
  searchRoute(false);
  scheduleRefresh();
});

tickClock();
window.setInterval(tickClock, 1000);

loadGraph().catch((err) => {
  console.error(err);
  setStatus(
    "データの読み込みに失敗しました。graph.json を生成してから再読み込みしてください。",
    true
  );
});
