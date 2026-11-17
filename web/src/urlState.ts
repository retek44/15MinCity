import type { Mode } from "./api/client";

/** Shareable state in the URL hash: #p=47.49790,19.05460&m=bike&w=family */
export interface UrlState {
  point?: { lon: number; lat: number };
  mode?: Mode;
  persona?: string;
}

export function parseUrlState(hash: string): UrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state: UrlState = {};
  const [lat, lon] = (params.get("p") ?? "").split(",").map(Number);
  if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    state.point = { lon, lat };
  }
  const mode = params.get("m");
  if (mode === "walk" || mode === "bike") state.mode = mode;
  const persona = params.get("w");
  if (persona && /^[a-z_-]{1,32}$/.test(persona)) state.persona = persona;
  return state;
}

export function formatUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.point) params.set("p", `${state.point.lat.toFixed(5)},${state.point.lon.toFixed(5)}`);
  if (state.mode && state.mode !== "walk") params.set("m", state.mode);
  if (state.persona && state.persona !== "balanced") params.set("w", state.persona);
  // Commas are legal in a fragment; keep shared links readable (#p=47.49790,19.05460).
  const s = params.toString().replaceAll("%2C", ",");
  return s ? `#${s}` : "";
}

export const readUrlState = () => parseUrlState(window.location.hash);

export function writeUrlState(state: UrlState) {
  const hash = formatUrlState(state);
  if (hash !== window.location.hash) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
}
