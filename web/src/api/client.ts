import type { MultiPolygon } from "geojson";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type AccessResponse = Schemas["AccessResponse"];
export type CategoryAccess = Schemas["CategoryAccess"];
export type CategoryId = CategoryAccess["category"];
export type Mode = AccessResponse["mode"];
export type SearchResult = Schemas["SearchResult"];
export type DistrictScore = Schemas["DistrictScore"];
export type Persona = Schemas["PersonaDto"];
export type Category = Schemas["CategoryDto"];
export type DataRelease = Schemas["DataRelease"];
export type Weights = Partial<Record<CategoryId, number>>;
export type CommonGroundResponse = Schemas["CommonGroundResponse"];
export type Spot = Schemas["Spot"];
/** Walk and bike are precomputed for the whole city (heatmap, ranking); transit is per place. */
export type HeatMode = Exclude<Mode, "transit">;
export const heatMode = (mode: Mode): HeatMode => (mode === "transit" ? "walk" : mode);

/** A place the visitor needs to reach from home, for "where should we live?". */
export interface Anchor {
  lon: number;
  lat: number;
  mode: Mode;
  minutes: number;
  /** Shown in the list; not sent to the API. */
  label?: string;
}

export const placesParam = (anchors: Anchor[]) =>
  anchors.map((a) => `${a.lon.toFixed(5)},${a.lat.toFixed(5)},${a.mode},${a.minutes}`).join(";");

export interface IsochroneFeature {
  type: "Feature";
  properties: { minutes: number; mode: Mode; areaM2: number };
  geometry: MultiPolygon;
}
export interface IsochroneCollection {
  type: "FeatureCollection";
  features: IsochroneFeature[];
}

/** An RFC 9457 problem returned by the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | undefined>;

async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const response = await fetch(`${path}${query.size ? `?${query}` : ""}`, { signal });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(response.status, problem?.detail ?? response.statusText);
  }
  return (await response.json()) as T;
}

/** `grocery:3,park:1` - only positive weights, in a stable order so cache keys match. */
export function weightsParam(weights: Weights): string {
  return Object.entries(weights)
    .filter(([, w]) => (w ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, w]) => `${c}:${w}`)
    .join(",");
}

const BASE = "/api/v1";

export const api = {
  categories: () => get<Category[]>(`${BASE}/categories`),
  personas: () => get<Persona[]>(`${BASE}/personas`),
  meta: () => get<DataRelease>(`${BASE}/meta`),
  search: (q: string, near: { lon: number; lat: number } | undefined, signal?: AbortSignal) =>
    get<SearchResult[]>(`${BASE}/search`, { q, limit: 8, lon: near?.lon, lat: near?.lat }, signal),
  access: (lon: number, lat: number, mode: Mode, weights: Weights, at?: string) =>
    get<AccessResponse>(`${BASE}/access`, { lon, lat, mode, weights: weightsParam(weights), at }),
  isochrone: (lon: number, lat: number, mode: Mode, minutes: number[], at?: string) =>
    get<IsochroneCollection>(`${BASE}/isochrone`, { lon, lat, mode, minutes: minutes.join(","), at }),
  ranking: (mode: HeatMode, weights: Weights) =>
    get<DistrictScore[]>(`${BASE}/districts/ranking`, { mode, weights: weightsParam(weights) }),
  commonGround: (anchors: Anchor[], mode: HeatMode, weights: Weights, at?: string) =>
    get<CommonGroundResponse>(`${BASE}/common-ground`, { places: placesParam(anchors), mode, weights: weightsParam(weights), at }),
};
