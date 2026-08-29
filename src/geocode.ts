import type { LatLng } from "./router";

const GSI_REVERSE =
  "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";

/** 国土地理院 muni.js の市区町村コード（札幌市内）。 */
const MUNI: Record<string, string> = {
  "01101": "札幌市中央区",
  "01102": "札幌市北区",
  "01103": "札幌市東区",
  "01104": "札幌市白石区",
  "01105": "札幌市豊平区",
  "01106": "札幌市南区",
  "01107": "札幌市西区",
  "01108": "札幌市厚別区",
  "01109": "札幌市手稲区",
  "01110": "札幌市清田区",
};

type GsiReverse = {
  results?: { muniCd?: string; lv01Nm?: string };
};

export function formatCoord(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

export async function reverseGeocode(p: LatLng): Promise<string> {
  const url = `${GSI_REVERSE}?lat=${p.lat}&lon=${p.lng}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reverse geocode ${res.status}`);
  const data = (await res.json()) as GsiReverse;
  const town = data.results?.lv01Nm?.trim();
  if (!town) throw new Error("no address");
  const city = MUNI[data.results?.muniCd ?? ""] ?? "";
  return `${city}${town}`;
}
