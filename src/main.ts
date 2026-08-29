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
const originLabel = document.getElementById("origin-label")!;
const modeOriginBtn = document.getElementById("mode-origin") as HTMLButtonElement;
const modeDestBtn = document.getElementById("mode-dest") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const resultEl = document.getElementById("result")!;
const clockEl = document.getElementById("clock")!;

const map = L.map(mapEl, { zoomControl: true }).setView(
  [SAPPORO_STATION.lat, SAPPORO_STATION.lng],
  14
);
map.zoomControl.setPosition("topright");

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

const originIcon = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;border-radius:50%;background:#34C759;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const destIcon = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;border-radius:50%;background:#FF3B30;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const walkerIcon = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#007AFF;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,122,255,.35)"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

let originMarker = L.marker([SAPPORO_STATION.lat, SAPPORO_STATION.lng], {
  icon: originIcon,
  title: "起点",
}).addTo(map);

let graph: GraphData | null = null;
let origin: LatLng = { ...SAPPORO_STATION };
let dest: LatLng | null = null;
let destMarker: L.Marker | null = null;
let tapMode: "origin" | "dest" = "dest";
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
      color: green ? "#34C759" : "#FF3B30",
      fillColor: green ? "#34C759" : "#FF3B30",
    });
    const arrive = formatClock(new Date(stop.arriveAt * 1000));
    const cross = formatClock(new Date(stop.crossAt * 1000));
    const plan =
      stop.waitSec > 0.5
        ? `${arrive}到着 → ${formatDuration(stop.waitSec)}待ち → ${cross}に横断`
        : `${arrive}到着・青のためそのまま横断`;
    marker.setTooltipContent(
      `#${stop.index} ${plan}<br>いま ${green ? "青" : "赤"} あと${remain}秒`
    );
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
    { color: "#007AFF", weight: 5, opacity: 0.92 }
  ).addTo(map);
  if (fitted) {
    const wide = window.innerWidth > 720;
    map.fitBounds(routeLine.getBounds(), {
      paddingTopLeft: wide ? [420, 24] : [24, 24],
      paddingBottomRight: wide ? [24, 24] : [24, 280],
    });
  }

  for (const m of routeSignals) map.removeLayer(m);
  routeSignals = result.signalStops.map((stop) => {
    const marker = L.circleMarker([stop.lat, stop.lng], {
      radius: 7,
      color: "#FF3B30",
      weight: 2,
      fillColor: "#FF3B30",
      fillOpacity: 0.9,
    }).addTo(map);
    marker.bindTooltip("", { permanent: false, direction: "top", opacity: 0.95 });
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

  const timeline = document.getElementById("signal-timeline")!;
  timeline.replaceChildren();
  if (result.signalStops.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "歩行者用信号のある横断はありません";
    timeline.append(empty);
  } else {
    for (const stop of result.signalStops) {
      const li = document.createElement("li");
      const wait = stop.waitSec > 0.5;
      const clear = formatClock(new Date(stop.clearAt * 1000));
      li.innerHTML = `
        <div class="timeline-head">
          <span class="badge">信号 ${stop.index}</span>
          <span class="state ${wait ? "wait" : "go"}">${wait ? "赤待ち" : "青通過"}</span>
        </div>
        <div class="timeline-body">
          <div>到着 <strong>${formatClock(new Date(stop.arriveAt * 1000))}</strong></div>
          ${
            wait
              ? `<div>待ち <strong>${formatDuration(stop.waitSec)}</strong> → 青 <strong>${formatClock(new Date(stop.crossAt * 1000))}</strong> に横断開始</div>`
              : `<div>青のため <strong>${formatClock(new Date(stop.crossAt * 1000))}</strong> にそのまま横断</div>`
          }
          <div>渡り終わり <strong>${clear}</strong></div>
        </div>
      `;
      timeline.append(li);
    }
  }
  resultEl.hidden = false;
}

function updateSearchEnabled() {
  searchBtn.disabled = dest === null;
}

function setTapMode(mode: "origin" | "dest", announce = true) {
  tapMode = mode;
  modeOriginBtn.classList.toggle("active", mode === "origin");
  modeDestBtn.classList.toggle("active", mode === "dest");
  if (!announce) return;
  setStatus(
    mode === "origin"
      ? "地図をタップして起点を指定してください"
      : "地図をタップして終点を指定してください"
  );
}

function searchRoute(silent = false) {
  if (!graph || !dest) return;

  const startId = snapToNode(graph, origin, 80);
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
    color: "#007AFF",
    weight: 1,
    fillColor: "#007AFF",
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

  if (tapMode === "origin") {
    origin = p;
    originLabel.textContent = fmtCoord(p);
    originMarker.setLatLng([p.lat, p.lng]);
    resultEl.hidden = true;
    clearRoute();
    updateSearchEnabled();
    setTapMode("dest", false);
    setStatus("起点を設定しました。続けて終点を指定できます");
    return;
  }

  dest = p;
  destLabel.textContent = fmtCoord(p);
  if (destMarker) destMarker.setLatLng([p.lat, p.lng]);
  else destMarker = L.marker([p.lat, p.lng], { icon: destIcon }).addTo(map);

  updateSearchEnabled();
  resultEl.hidden = true;
  clearRoute();
  setStatus("終点を設定しました。「いま出発で検索」を押してください");
});

modeOriginBtn.addEventListener("click", () => setTapMode("origin"));
modeDestBtn.addEventListener("click", () => setTapMode("dest"));

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
