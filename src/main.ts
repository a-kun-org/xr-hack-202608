import {
  GeoJSONSource,
  LngLatBounds,
  Map as MapboxMap,
  Marker,
  NavigationControl,
  Popup,
} from "mapbox-gl/esm";
import "mapbox-gl/dist/mapbox-gl.css";
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
  type SignalStop,
} from "./router";
import { formatCoord, reverseGeocode } from "./geocode";
import {
  classifyPath,
  formatUnderLabel,
  undergroundGeoJSON,
  type UndergroundData,
} from "./underground";

const SAPPORO_STATION: LatLng = { lat: 43.0687, lng: 141.3508 };
const REFRESH_MS = 12000;
const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? "";
const TOKEN_ERROR =
  "Mapbox のアクセストークンが未設定です。VITE_MAPBOX_ACCESS_TOKEN を設定してください。";

const mapEl = document.getElementById("map")!;
const destLabel = document.getElementById("dest-label")!;
const originLabel = document.getElementById("origin-label")!;
const modeOriginBtn = document.getElementById("mode-origin") as HTMLButtonElement;
const modeDestBtn = document.getElementById("mode-dest") as HTMLButtonElement;
const modeInspectBtn = document.getElementById("mode-inspect") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const resultEl = document.getElementById("result")!;

const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
const softwareWebGL = isSoftwareWebGL();

let map: MapboxMap | null = null;
let originMarker: Marker | null = null;

function isSoftwareWebGL(): boolean {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) return true;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) return false;
  const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  return /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
}

function rasterStyle(dark: boolean) {
  const id = dark ? "dark-v11" : "streets-v12";
  return {
    version: 8 as const,
    sources: {
      basemap: {
        type: "raster" as const,
        tiles: [
          `https://api.mapbox.com/styles/v1/mapbox/${id}/tiles/{z}/{x}/{y}?access_token=${TOKEN}`,
        ],
        tileSize: 512,
        attribution: "© Mapbox © OpenStreetMap",
      },
    },
    layers: [{ id: "basemap", type: "raster" as const, source: "basemap" }],
  };
}

function lngLat(p: LatLng): [number, number] {
  return [p.lng, p.lat];
}

function makeDot(color: string, size: number, border = "3px solid #fff"): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = "50%";
  el.style.background = color;
  el.style.border = border;
  el.style.boxShadow = "0 2px 8px rgba(0,0,0,.25)";
  return el;
}

function emptyCollection() {
  return { type: "FeatureCollection" as const, features: [] };
}

function circlePolygon(center: LatLng, radiusM: number, steps = 64) {
  const coords: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(latRad);
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    coords.push([
      center.lng + (Math.cos(a) * radiusM) / mLng,
      center.lat + (Math.sin(a) * radiusM) / mLat,
    ]);
  }
  return { type: "Polygon" as const, coordinates: [coords] };
}

function showMapError(message: string) {
  const el = document.createElement("div");
  el.className = "map-error";
  el.setAttribute("role", "alert");
  el.textContent = message;
  mapEl.insertAdjacentElement("afterend", el);
}

function onMapReady(fn: () => void) {
  if (!map) return;
  if (map.isStyleLoaded()) fn();
  else map.once("idle", fn);
}

function ensureOverlays() {
  if (!map) return;
  if (!map.getSource("range")) {
    map.addSource("range", { type: "geojson", data: emptyCollection() });
    map.addLayer({
      id: "range-fill",
      type: "fill",
      source: "range",
      paint: { "fill-color": "#007AFF", "fill-opacity": 0.04 },
    });
    map.addLayer({
      id: "range-outline",
      type: "line",
      source: "range",
      paint: { "line-color": "#007AFF", "line-width": 1 },
    });
  }
  if (!map.getSource("underground")) {
    try {
      map.addSource("underground", { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: "underground-fill",
        type: "fill",
        source: "underground",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#AF52DE", "fill-opacity": 0.16 },
      });
      map.addLayer({
        id: "underground-line",
        type: "line",
        source: "underground",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#AF52DE",
          "line-width": 4,
          "line-opacity": 0.45,
        },
      });
    } catch (err) {
      console.warn("underground overlay skipped", err);
    }
  }
  if (!map.getSource("route")) {
    map.addSource("route", { type: "geojson", data: emptyCollection() });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#007AFF",
        "line-width": 5,
        "line-opacity": 0.92,
      },
    });
  }
}

function paintUnderground() {
  if (!map || !underground) return;
  ensureOverlays();
  (map.getSource("underground") as GeoJSONSource).setData(
    undergroundGeoJSON(underground.areas)
  );
}

function setRouteLine(path: LatLng[] | null) {
  if (!map) return;
  ensureOverlays();
  const src = map.getSource("route") as GeoJSONSource;
  if (!path || path.length < 2) {
    src.setData(emptyCollection());
    return;
  }
  src.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: path.map(lngLat) },
  });
  if (map.getLayer("route-line")) map.moveLayer("route-line");
}

type TapMode = "origin" | "dest" | "inspect";
type SignalPin = { marker: Marker; popup: Popup; el: HTMLElement; wrap: HTMLElement };

let graph: GraphData | null = null;
let underground: UndergroundData | null = null;
let origin: LatLng = { ...SAPPORO_STATION };
let dest: LatLng | null = null;
let destMarker: Marker | null = null;
let tapMode: TapMode = "dest";
let walkerMarker: Marker | null = null;
let routeSignals: SignalPin[] = [];
let lastResult: RouteResult | null = null;
let refreshTimer: number | null = null;
let originLookup = 0;
let destLookup = 0;

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function tickLive() {
  updateLiveSignals();
  updateWalker();
}

async function showAddress(
  el: HTMLElement,
  p: LatLng,
  seq: number,
  current: () => number
) {
  el.textContent = "住所を取得中…";
  try {
    const addr = await reverseGeocode(p);
    if (seq !== current()) return;
    el.textContent = addr;
  } catch {
    if (seq !== current()) return;
    el.textContent = formatCoord(p);
  }
}

function signalPopupHTML(stop: SignalStop): string {
  const passGreen = stop.waitSec <= 0.5;
  const arrive = formatClock(new Date(stop.arriveAt * 1000));
  const cross = formatClock(new Date(stop.crossAt * 1000));
  const clear = formatClock(new Date(stop.clearAt * 1000));
  const plan = passGreen
    ? `${arrive}到着・青のためそのまま横断`
    : `${arrive}到着 → ${formatDuration(stop.waitSec)}待ち → ${cross}に横断`;
  const phase = phaseRemain(Date.now() / 1000, stop);
  const nowText = phase.green
    ? `いま青（残り約${phase.remain}秒）`
    : `いま赤（青まで約${phase.remain}秒）`;
  return `
    <div class="signal-popup-title">信号 ${stop.index} ${passGreen ? "青通過" : "赤待ち"}</div>
    <div>${plan}</div>
    <div>渡り終わり ${clear}</div>
    <div class="signal-popup-meta">サイクル ${Math.round(stop.cycle)}秒 / 歩行者青 ${Math.round(stop.green)}秒</div>
    <div class="signal-popup-meta">${nowText}</div>
  `;
}

function updateInspectEnabled() {
  modeInspectBtn.disabled =
    lastResult === null || lastResult.signalStops.length === 0;
}

function nearestSignalIndex(
  click: LatLng,
  maxPx = 36
): number | null {
  if (!map || !lastResult) return null;
  const c = map.project([click.lng, click.lat]);
  let best = maxPx;
  let bestIndex: number | null = null;
  for (const stop of lastResult.signalStops) {
    const p = map.project([stop.lng, stop.lat]);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < best) {
      best = d;
      bestIndex = stop.index;
    }
  }
  return bestIndex;
}

function openSignalInfo(index: number) {
  const i = index - 1;
  const pin = routeSignals[i];
  const stop = lastResult?.signalStops[i];
  if (!pin || !stop || !map) return;
  for (const other of routeSignals) {
    if (other !== pin) other.popup.remove();
    other.wrap.classList.toggle("is-open", other === pin);
  }
  pin.popup.setLngLat(lngLat(stop)).setHTML(signalPopupHTML(stop));
  if (!pin.popup.isOpen()) pin.popup.addTo(map);
}

function updateLiveSignals() {
  if (!lastResult) return;
  lastResult.signalStops.forEach((stop, i) => {
    const pin = routeSignals[i];
    if (!pin) return;
    const passGreen = stop.waitSec <= 0.5;
    const color = passGreen ? "#34C759" : "#FF3B30";
    pin.el.style.background = color;
    pin.el.style.borderColor = color;
    pin.popup.setHTML(signalPopupHTML(stop));
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
  walkerMarker.setLngLat(lngLat(p));
}

function clearRoute() {
  onMapReady(() => setRouteLine(null));
  walkerMarker?.remove();
  walkerMarker = null;
  for (const pin of routeSignals) {
    pin.popup.remove();
    pin.marker.remove();
  }
  routeSignals = [];
  lastResult = null;
  updateInspectEnabled();
  if (tapMode === "inspect") setTapMode("dest", false);
}

function showResult(result: RouteResult, fitted: boolean) {
  if (!map) return;
  const currentMap = map;
  lastResult = result;
  const underHit = underground
    ? classifyPath(result.path, underground.areas)
    : { names: [], underM: 0, flags: [] };
  document.getElementById("r-under")!.textContent = formatUnderLabel(
    underHit,
    graph?.walkSpeedMps ?? 1.2
  );
  setRouteLine(result.path);
  const fit = () => {
    if (!fitted) return;
    const bounds = new LngLatBounds();
    for (const p of result.path) bounds.extend(lngLat(p));
    const wide = window.innerWidth > 720;
    currentMap.fitBounds(bounds, {
      padding: wide
        ? { top: 24, left: 420, bottom: 24, right: 24 }
        : { top: 24, left: 24, bottom: 280, right: 24 },
      duration: 600,
    });
  };
  if (fitted) onMapReady(fit);

  const openIndex = routeSignals.findIndex((p) => p.popup.isOpen());
  for (const pin of routeSignals) {
    pin.popup.remove();
    pin.marker.remove();
  }
  routeSignals = result.signalStops.map((stop) => {
    const passGreen = stop.waitSec <= 0.5;
    const color = passGreen ? "#34C759" : "#FF3B30";
    const el = makeDot(color, 14, `2px solid ${color}`);
    const wrap = document.createElement("div");
    wrap.className = "signal-pin";
    wrap.append(el);
    const popup = new Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 16,
      className: "signal-popup",
    });
    popup.on("close", () => wrap.classList.remove("is-open"));
    wrap.addEventListener("click", (ev) => {
      if (tapMode !== "inspect") return;
      ev.stopPropagation();
      openSignalInfo(stop.index);
    });
    const marker = new Marker({ element: wrap, anchor: "center" })
      .setLngLat(lngLat(stop))
      .addTo(currentMap);
    return { marker, popup, el, wrap };
  });
  updateLiveSignals();
  updateInspectEnabled();
  if (fitted && result.signalStops.length > 0) setTapMode("inspect", false);
  if (openIndex >= 0 && routeSignals[openIndex]) {
    openSignalInfo(openIndex + 1);
  }

  if (!walkerMarker) {
    const el = makeDot("#007AFF", 18);
    el.style.boxShadow = "0 2px 8px rgba(0,122,255,.35)";
    walkerMarker = new Marker({ element: el, anchor: "center" })
      .setLngLat(lngLat(result.path[0]))
      .addTo(currentMap);
  }
  updateWalker();

  const depart = new Date(result.departAt * 1000);
  const arrive = new Date((result.departAt + result.totalSec) * 1000);
  document.getElementById("r-depart")!.textContent = formatClock(depart);
  document.getElementById("r-arrive")!.textContent = formatClock(arrive);
  document.getElementById("r-total")!.textContent = formatDuration(result.totalSec);
  document.getElementById("r-walk")!.textContent = formatDuration(result.walkSec);
  document.getElementById("r-wait")!.textContent = formatDuration(result.waitSec);
  document.getElementById("r-signals")!.textContent = String(result.signalCount);

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
      li.tabIndex = 0;
      li.setAttribute("role", "button");
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
      const focusStop = () => {
        if (tapMode !== "inspect") setTapMode("inspect", false);
        openSignalInfo(stop.index);
      };
      li.addEventListener("click", focusStop);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          focusStop();
        }
      });
      timeline.append(li);
    }
  }
  resultEl.hidden = false;
}

function updateSearchEnabled() {
  searchBtn.disabled = dest === null;
}

function setTapMode(mode: TapMode, announce = true) {
  tapMode = mode;
  modeOriginBtn.classList.toggle("active", mode === "origin");
  modeDestBtn.classList.toggle("active", mode === "dest");
  modeInspectBtn.classList.toggle("active", mode === "inspect");
  if (!announce) return;
  if (!TOKEN) {
    setStatus(TOKEN_ERROR, true);
    return;
  }
  if (mode === "origin") {
    setStatus("地図をタップして起点を指定してください");
    return;
  }
  if (mode === "inspect") {
    setStatus("交差点をタップすると通過情報を表示します。地点を変えるときは「起点」または「終点」を押してください");
    return;
  }
  setStatus("地図をタップして終点を指定してください");
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
      : result.signalStops.length > 0
        ? "交差点をタップすると通過情報を表示します。地点を変えるときは「起点」または「終点」を押してください"
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
  if (TOKEN) setStatus("歩行ネットワークを読み込み中…");
  const res = await fetch(`${import.meta.env.BASE_URL}data/graph.json`);
  if (!res.ok) throw new Error(`graph.json の取得に失敗 (${res.status})`);
  graph = normalizeGraph(await res.json());
  try {
    const underRes = await fetch(`${import.meta.env.BASE_URL}data/underground.json`);
    if (underRes.ok) underground = (await underRes.json()) as UndergroundData;
  } catch {
    underground = null;
  }

  onMapReady(() => {
    paintRange();
    paintUnderground();
  });

  if (TOKEN) setStatus("地図をタップして終点を指定してください");
}

function onMapClick(e: { lngLat: { lat: number; lng: number } }) {
  if (!graph || !map) return;
  const p: LatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };

  if (tapMode === "inspect") {
    const idx = nearestSignalIndex(p);
    if (idx !== null) {
      openSignalInfo(idx);
      return;
    }
    setStatus(
      "交差点の丸印をタップしてください。地点を変えるときは「起点」または「終点」を押してください"
    );
    return;
  }

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
    void showAddress(originLabel, p, ++originLookup, () => originLookup);
    originMarker?.setLngLat(lngLat(p));
    resultEl.hidden = true;
    clearRoute();
    updateSearchEnabled();
    setTapMode("dest", false);
    setStatus("起点を設定しました。続けて終点を指定できます");
    return;
  }

  dest = p;
  void showAddress(destLabel, p, ++destLookup, () => destLookup);
  if (destMarker) destMarker.setLngLat(lngLat(p));
  else {
    destMarker = new Marker({
      element: makeDot("#FF3B30", 22),
      anchor: "center",
    })
      .setLngLat(lngLat(p))
      .addTo(map);
  }

  updateSearchEnabled();
  resultEl.hidden = true;
  clearRoute();
  setStatus("終点を設定しました。「いま出発で検索」を押してください");
}

function paintRange() {
  if (!map || !graph) return;
  ensureOverlays();
  (map.getSource("range") as GeoJSONSource).setData({
    type: "Feature",
    properties: {},
    geometry: circlePolygon(graph.origin, graph.maxRadiusM),
  });
}

function initMap() {
  const current = new MapboxMap({
    container: mapEl,
    accessToken: TOKEN,
    style: softwareWebGL ? rasterStyle(darkMq.matches) : "mapbox://styles/mapbox/standard",
    center: [SAPPORO_STATION.lng, SAPPORO_STATION.lat],
    zoom: 14,
    maxPitch: 0,
    dragRotate: false,
    language: softwareWebGL ? undefined : "ja",
    config: softwareWebGL
      ? undefined
      : { basemap: { lightPreset: darkMq.matches ? "night" : "day" } },
    locale: {
      "NavigationControl.ZoomIn": "拡大",
      "NavigationControl.ZoomOut": "縮小",
    },
  });
  current.addControl(new NavigationControl({ showCompass: false }), "top-right");
  darkMq.addEventListener("change", () => {
    if (softwareWebGL) current.setStyle(rasterStyle(darkMq.matches));
    else current.setConfigProperty("basemap", "lightPreset", darkMq.matches ? "night" : "day");
  });
  originMarker = new Marker({
    element: makeDot("#34C759", 22),
    anchor: "center",
  })
    .setLngLat(lngLat(SAPPORO_STATION))
    .addTo(current);
  current.on("style.load", () => {
    ensureOverlays();
    paintRange();
    paintUnderground();
    if (lastResult) setRouteLine(lastResult.path);
  });
  current.on("click", onMapClick);
  map = current;
}

if (!TOKEN) {
  showMapError(TOKEN_ERROR);
  setStatus(TOKEN_ERROR, true);
} else {
  initMap();
}

modeOriginBtn.addEventListener("click", () => setTapMode("origin"));
modeDestBtn.addEventListener("click", () => setTapMode("dest"));
modeInspectBtn.addEventListener("click", () => {
  if (modeInspectBtn.disabled) return;
  setTapMode("inspect");
});

searchBtn.addEventListener("click", () => {
  searchRoute(false);
  scheduleRefresh();
});

void showAddress(originLabel, origin, ++originLookup, () => originLookup);
tickLive();
window.setInterval(tickLive, 1000);

loadGraph().catch((err) => {
  console.error(err);
  setStatus(
    "データの読み込みに失敗しました。graph.json を生成してから再読み込みしてください。",
    true
  );
});
