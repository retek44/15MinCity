import type { Anchor, Mode } from "./api/client";
import type { Pinned } from "./components/ComparePanel";
import { isWhen, type When } from "./when";

/**
 * Shareable state in the URL hash:
 * #p=47.49790,19.05460&m=bike&w=family&t=su20&a=47.5,19.04,transit,30&c=47.51,19.06;47.48,19.02
 */
export interface UrlState {
  point?: { lon: number; lat: number };
  mode?: Mode;
  persona?: string;
  when?: When;
  /** "Where should we live?" places. */
  anchors?: Anchor[];
  /** Places pinned to compare. */
  compare?: Pinned[];
}

const MODES: Mode[] = ["walk", "bike", "stepfree", "transit"];
const isMode = (value: string | null | undefined): value is Mode => MODES.includes(value as Mode);

function latLon(lat: number | undefined, lon: number | undefined) {
  return lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function parseUrlState(hash: string): UrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state: UrlState = {};
  const [lat, lon] = (params.get("p") ?? "").split(",").map(Number);
  if (latLon(lat, lon)) state.point = { lon: lon!, lat: lat! };
  const mode = params.get("m");
  if (isMode(mode)) state.mode = mode;
  const persona = params.get("w");
  if (persona && /^[a-z_-]{1,32}$/.test(persona)) state.persona = persona;
  const when = params.get("t");
  if (when && isWhen(when)) state.when = when;
  const anchors = (params.get("a") ?? "")
    .split(";")
    .filter(Boolean)
    .slice(0, 4)
    .flatMap((part): Anchor[] => {
      const [aLat, aLon, aMode, minutes] = part.split(",");
      const m = Number(minutes);
      if (!latLon(Number(aLat), Number(aLon)) || !isMode(aMode) || !Number.isInteger(m) || m < 1 || m > 45) return [];
      return [{ lat: Number(aLat), lon: Number(aLon), mode: aMode, minutes: m }];
    });
  if (anchors.length) state.anchors = anchors;
  const compare = (params.get("c") ?? "")
    .split(";")
    .filter(Boolean)
    .slice(0, 3)
    .flatMap((part): Pinned[] => {
      const [cLat, cLon] = part.split(",").map(Number);
      return latLon(cLat, cLon) ? [{ lat: cLat!, lon: cLon! }] : [];
    });
  if (compare.length) state.compare = compare;
  return state;
}

export function formatUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.point) params.set("p", `${state.point.lat.toFixed(5)},${state.point.lon.toFixed(5)}`);
  if (state.mode && state.mode !== "walk") params.set("m", state.mode);
  if (state.persona && state.persona !== "balanced") params.set("w", state.persona);
  if (state.when && state.when !== "any") params.set("t", state.when);
  if (state.anchors?.length) {
    params.set("a", state.anchors.map((a) => `${a.lat.toFixed(5)},${a.lon.toFixed(5)},${a.mode},${a.minutes}`).join(";"));
  }
  if (state.compare?.length) {
    params.set("c", state.compare.map((c) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`).join(";"));
  }
  // Commas, colons and semicolons are legal in a fragment; keep shared links readable.
  const s = params.toString().replaceAll("%2C", ",").replaceAll("%3B", ";").replaceAll("%3A", ":");
  return s ? `#${s}` : "";
}

export const readUrlState = () => parseUrlState(window.location.hash);

export function writeUrlState(state: UrlState) {
  const hash = formatUrlState(state);
  if (hash !== window.location.hash) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
}
