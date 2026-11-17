import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

export const BUDAPEST_BOUNDS: [number, number, number, number] = [18.91, 47.34, 19.35, 47.62];
export const INITIAL_VIEW = { center: [19.06, 47.5] as [number, number], zoom: 12 };

const ASSETS = "https://protomaps.github.io/basemaps-assets";
const origin = () => window.location.origin;

/** Id of the layer the accessibility layers are inserted below, so place labels stay on top. */
export function firstSymbolLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}

/** Paper and ink of the app, re-inked onto the Protomaps flavours so the basemap joins the world. */
export const MAP_PAPER = { light: "#eef0f6", dark: "#0e1220" } as const;

/** Basemap POI icons recede to one muted ink so they never compete with the overlay. */
function mutedPois(color: string, green: string) {
  return { blue: color, green, lapis: color, pink: color, red: color, slategray: color, tangerine: color, turquoise: color };
}

function inked(dark: boolean): Flavor {
  const base = namedFlavor(dark ? "dark" : "light");
  if (dark) {
    return {
      ...base,
      background: MAP_PAPER.dark,
      earth: MAP_PAPER.dark,
      water: "#1b2650",
      park_a: "#14201f",
      park_b: "#14201f",
      wood_a: "#14201f",
      wood_b: "#14201f",
      buildings: "#161c31",
      minor_a: "#1d2440",
      minor_b: "#1d2440",
      other: "#1a2038",
      major: "#252d4d",
      highway: "#2c3558",
      railway: "#3a4366",
      boundaries: "#4a5480",
      roads_label_minor: "#a7aecb",
      roads_label_minor_halo: MAP_PAPER.dark,
      roads_label_major: "#c9cfe6",
      roads_label_major_halo: MAP_PAPER.dark,
      subplace_label: "#c9cfe6",
      // no halo: over the hexagons a paper halo smears; the ink alone reads on both
      subplace_label_halo: "rgba(14, 18, 32, 0)",
      city_label: "#e8ebf5",
      city_label_halo: MAP_PAPER.dark,
      pois: mutedPois("#9aa1bf", "#8fae95"),
    };
  }
  return {
    ...base,
    background: MAP_PAPER.light,
    earth: MAP_PAPER.light,
    water: "#bcc6e0",
    park_a: "#dde5d8",
    park_b: "#dde5d8",
    wood_a: "#d6dfd2",
    wood_b: "#d6dfd2",
    buildings: "#e1e4ec",
    minor_a: "#ffffff",
    minor_b: "#ffffff",
    other: "#f7f8fb",
    major: "#ffffff",
    highway: "#ffffff",
    railway: "#a3a9bd",
    boundaries: "#7b84a3",
    roads_label_minor: "#4a5068",
    roads_label_minor_halo: "#ffffff",
    roads_label_major: "#2a2f45",
    roads_label_major_halo: "#ffffff",
    subplace_label: "#2a2f45",
    subplace_label_halo: "rgba(238, 240, 246, 0)",
    city_label: "#151826",
    city_label_halo: MAP_PAPER.light,
    pois: mutedPois("#5a6180", "#4f6b55"),
  };
}

/**
 * Basemap label clean-up so labels never compete with the hexagons:
 * - POI icons are pre-coloured in the sprite: landmarks become text, from street zoom only;
 * - OSM place=locality is used for tiny named spots (a garden, a hospital block): keep towns only.
 */
function cleanLabels(layer: LayerSpecification): LayerSpecification {
  if (layer.type !== "symbol") return layer;
  if (layer.id === "places_locality") {
    return { ...layer, filter: ["all", ["==", ["get", "kind"], "locality"], [">=", ["to-number", ["get", "population_rank"], 0], 6]] };
  }
  if (layer.id !== "pois") return layer;
  const layout = { ...layer.layout };
  delete layout["icon-image"];
  // Landmarks from street zoom only: at city and district zoom they crowd the hexagons.
  return { ...layer, layout, minzoom: Math.max(layer.minzoom ?? 0, 15.5) };
}

/**
 * Basemap (self-hosted Protomaps extract served by Martin) when available; otherwise a plain
 * background, which keeps the app usable - and the E2E suite deterministic - without it.
 */
export function baseStyle(options: { basemap: boolean; dark: boolean; lang: string }): StyleSpecification {
  if (!options.basemap) {
    return {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": options.dark ? MAP_PAPER.dark : MAP_PAPER.light } }],
    };
  }
  const flavor = options.dark ? "dark" : "light";
  return {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`${origin()}/tiles/basemap/{z}/{x}/{y}`],
        maxzoom: 15,
        bounds: BUDAPEST_BOUNDS,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
    },
    layers: (layers("protomaps", inked(options.dark), { lang: options.lang }) as LayerSpecification[]).map(cleanLabels),
  };
}

export const H3_SOURCE = {
  type: "vector" as const,
  tiles: [] as string[],
  minzoom: 9,
  maxzoom: 16,
  bounds: BUDAPEST_BOUNDS,
  attribution: "Reach15",
};

export function h3Source() {
  return { ...H3_SOURCE, tiles: [`${origin()}/tiles/h3/{z}/{x}/{y}`] };
}
