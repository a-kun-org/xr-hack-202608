import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import {
  distanceFromOriginM,
  findRoute,
  formatDuration,
  normalizeGraph,
  snapToNode,
  type GraphData,
  type LatLng,
} from "./router";

const SAPPORO_STATION: LatLng = { lat: 43.0687, lng: 141.3508 };

const mapEl = document.getElementById("map")!;
const destLabel = document.getElementById("dest-label")!;
const statusEl = document.getElementById("status")!;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const resultEl = document.getElementById("result")!;

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

L.marker([SAPPORO_STATION.lat, SAPPORO_STATION.lng], {
  icon: originIcon,
  title: "札幌駅",
}).addTo(map);

let graph: GraphData | null = null;
let dest: LatLng | null = null;
let destMarker: L.Marker | null = null;
let routeLine: L.Polyline | null = null;
let signalLayer: L.LayerGroup | null = null;

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function fmtCoord(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
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

  if (graph.signals.length > 0) {
    signalLayer = L.layerGroup();
    for (const s of graph.signals) {
      L.circleMarker([s.lat, s.lng], {
        radius: 3,
        color: "#c9a227",
        weight: 1,
        fillColor: "#c9a227",
        fillOpacity: 0.5,
        opacity: 0.7,
      }).addTo(signalLayer);
    }
    signalLayer.addTo(map);
  }

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
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  setStatus("終点を設定しました。「ルート検索」を押してください");
});

searchBtn.addEventListener("click", () => {
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

  setStatus("経路を計算中…");
  const result = findRoute(graph, startId, endId);
  if (!result) {
    setStatus("経路が見つかりませんでした", true);
    return;
  }

  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(
    result.path.map((p) => [p.lat, p.lng] as [number, number]),
    { color: "#2bb673", weight: 5, opacity: 0.9 }
  ).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

  (document.getElementById("r-total")!).textContent = formatDuration(
    result.totalSec
  );
  (document.getElementById("r-walk")!).textContent = formatDuration(
    result.walkSec
  );
  (document.getElementById("r-wait")!).textContent = formatDuration(
    result.waitSec
  );
  (document.getElementById("r-signals")!).textContent = String(
    result.signalCount
  );
  resultEl.hidden = false;
  setStatus("ルートを表示しました");
});

loadGraph().catch((err) => {
  console.error(err);
  setStatus(
    "データの読み込みに失敗しました。graph.json を生成してから再読み込みしてください。",
    true
  );
});
