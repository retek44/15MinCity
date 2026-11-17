import type { FeatureCollection, Geometry } from "geojson";
import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre resolves its worker relative to its own module URL, which does not survive Rollup
// bundling (production builds 404 on the worker). Emit the worker as an asset and point at it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef } from "react";
import type { HeatMode, IsochroneCollection, Weights } from "../api/client";
import { heatColor, score } from "../scoring";
import { BUDAPEST_BOUNDS, baseStyle, firstSymbolLayer, h3Source, INITIAL_VIEW } from "./style";

maplibregl.setWorkerUrl(workerUrl);

export interface PoiMarker {
  category: string;
  label: string;
  name: string;
  lon: number;
  lat: number;
  /** Weight of the category in the current profile, 1..3: sets the marker size. */
  weight: number;
}

export interface DistrictFocus {
  id: number;
  /** west, south, east, north */
  bbox: number[];
}

/** A lettered place (A-D) or a numbered spot (1-5) of "where should we live?". */
export interface MapMarker {
  lon: number;
  lat: number;
  text: string;
  kind: "anchor" | "spot";
  title: string;
}

interface Props {
  mode: HeatMode;
  /** Weights the heatmap is coloured by (the profile, or one focused category). */
  weights: Weights;
  dark: boolean;
  lang: string;
  basemap: boolean;
  /** fly: centre the map on it (search results); map clicks are already in view. */
  point?: { lon: number; lat: number; fly?: boolean };
  isochrones?: IsochroneCollection;
  pois: PoiMarker[];
  /** "Where should we live?": the area from which every place is in reach. */
  commonArea?: Geometry | null;
  markers: MapMarker[];
  focusDistrict?: DistrictFocus;
  scoreLabel: string;
  /** The H3 cell under the selected point (its district feeds the place panel). */
  onCell?: (cell: { h3: string; districtId: number | null } | undefined) => void;
  onSelect: (point: { lon: number; lat: number }) => void;
}

declare global {
  interface Window {
    /** Exposed for end-to-end tests: map state is asserted, not pixels. */
    __reach15?: { map: MlMap };
  }
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Flat offset inks; the 5-minute plane is ink on paper, or paper on the dark map. */
const INK = {
  saffron: "#f2a93b",
  poppy: { light: "#e2412b", dark: "#f0573f" },
  ink: { light: "#151826", dark: "#e8ebf5" },
  paper: { light: "#ffffff", dark: "#0e1220" },
} as const;

const tone = (dark: boolean) => (dark ? "dark" : "light");

/** Hexagons stay readable under the reach planes; a focused district keeps its own cells. */
function h3Opacity(hasPoint: boolean, focus?: DistrictFocus): ExpressionSpecification | number {
  const base = hasPoint ? 0.3 : 0.82;
  if (!focus) return base;
  return ["case", ["==", ["to-number", ["get", "district_id"]], focus.id], base, 0.08];
}

/** Adds the accessibility overlay to whatever basemap style is loaded. */
function addOverlay(map: MlMap, props: Props) {
  const before = firstSymbolLayer(map.getStyle());
  const t = tone(props.dark);
  if (!map.getSource("r15-h3")) map.addSource("r15-h3", h3Source());
  if (!map.getSource("r15-iso")) map.addSource("r15-iso", { type: "geojson", data: EMPTY });
  if (!map.getSource("r15-pois")) map.addSource("r15-pois", { type: "geojson", data: EMPTY });
  if (!map.getSource("r15-point")) map.addSource("r15-point", { type: "geojson", data: EMPTY });
  if (!map.getSource("r15-common")) map.addSource("r15-common", { type: "geojson", data: EMPTY });

  if (map.getLayer("r15-h3")) return;
  map.addLayer(
    {
      id: "r15-h3",
      type: "fill",
      source: "r15-h3",
      "source-layer": "h3",
      paint: {
        "fill-color": heatColor(props.mode, props.weights, props.dark),
        "fill-opacity": h3Opacity(Boolean(props.point), props.focusDistrict),
        "fill-outline-color": "rgba(0,0,0,0)",
      },
    },
    before,
  );
  // The hexagon is the system's construction shape: outlined under the cursor and the selection.
  for (const id of ["r15-h3-hover", "r15-h3-selected"]) {
    map.addLayer(
      {
        id,
        type: "line",
        source: "r15-h3",
        "source-layer": "h3",
        filter: ["==", ["get", "h3"], ""],
        paint: {
          "line-color": id === "r15-h3-selected" ? INK.saffron : INK.ink[t],
          "line-width": id === "r15-h3-selected" ? 3 : 1.5,
        },
      },
      before,
    );
  }
  // Overprint: the 5/10/15-minute reach as three nested flat ink planes.
  map.addLayer(
    {
      id: "r15-iso-fill",
      type: "fill",
      source: "r15-iso",
      paint: {
        "fill-color": ["match", ["get", "minutes"], 5, INK.ink[t], 10, INK.poppy[t], INK.saffron],
        "fill-opacity": ["match", ["get", "minutes"], 5, 0.62, 10, 0.72, 0.75],
      },
    },
    before,
  );
  // Common ground: a saffron plane with a heavy ink edge, above the reach planes.
  map.addLayer(
    {
      id: "r15-common-fill",
      type: "fill",
      source: "r15-common",
      paint: { "fill-color": INK.saffron, "fill-opacity": 0.32 },
    },
    before,
  );
  map.addLayer(
    {
      id: "r15-common-line",
      type: "line",
      source: "r15-common",
      paint: { "line-color": INK.ink[t], "line-width": 2.5 },
    },
    before,
  );
  map.addLayer({
    id: "r15-pois",
    type: "circle",
    source: "r15-pois",
    paint: {
      // Fixed three-step ramp: the place's weight in the profile, not its importance.
      "circle-radius": ["match", ["get", "weight"], 3, 8, 2, 6.5, 5],
      "circle-color": INK.ink[t],
      "circle-stroke-width": 2,
      "circle-stroke-color": INK.paper[t],
    },
  });
  map.addLayer({
    id: "r15-point",
    type: "circle",
    source: "r15-point",
    paint: {
      "circle-radius": 9,
      "circle-color": INK.paper[t],
      "circle-stroke-width": 5,
      "circle-stroke-color": INK.ink[t],
    },
  });
}

/** Pushes the selection (isochrones, nearest POIs, the point) into the overlay sources. */
function applyData(map: MlMap, { isochrones, pois, point, commonArea }: Pick<Props, "isochrones" | "pois" | "point" | "commonArea">) {
  (map.getSource("r15-common") as GeoJSONSource | undefined)?.setData(
    commonArea ? { type: "Feature", properties: {}, geometry: commonArea } : EMPTY,
  );
  // Largest plane first, so the 10- and 5-minute planes print on top of it.
  const iso = isochrones
    ? { ...isochrones, features: [...isochrones.features].sort((a, b) => b.properties.minutes - a.properties.minutes) }
    : EMPTY;
  (map.getSource("r15-iso") as GeoJSONSource | undefined)?.setData(iso as FeatureCollection);
  (map.getSource("r15-pois") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: pois.map((p) => ({
      type: "Feature",
      properties: { category: p.category, label: p.label, name: p.name, weight: Math.min(3, Math.max(1, Math.round(p.weight))) },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  });
  (map.getSource("r15-point") as GeoJSONSource | undefined)?.setData(
    point ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [point.lon, point.lat] } } : EMPTY,
  );
}

const wide = () => window.innerWidth > 720;

export function MapView(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: baseStyle(propsRef.current),
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: 10,
      maxBounds: [
        [BUDAPEST_BOUNDS[0] - 0.1, BUDAPEST_BOUNDS[1] - 0.06],
        [BUDAPEST_BOUNDS[2] + 0.1, BUDAPEST_BOUNDS[3] + 0.06],
      ],
      // The data credit lives in the map's bottom band (Legend), set in the app's type.
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.GeolocateControl({}), "bottom-right");
    map.on("style.load", () => {
      addOverlay(map, propsRef.current);
      applyData(map, propsRef.current);
    });
    map.on("click", (e) => {
      propsRef.current.onSelect({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "hex-popup", offset: 10 });
    map.on("mousemove", "r15-h3", (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const { mode, weights, scoreLabel } = propsRef.current;
      const times = Object.fromEntries(
        Object.keys(weights).map((c) => [c, feature.properties[`${mode}_${c}`] as number | undefined]),
      );
      map.getCanvas().style.cursor = "crosshair";
      map.setFilter("r15-h3-hover", ["==", ["get", "h3"], String(feature.properties.h3 ?? "")]);
      popup.setLngLat(e.lngLat).setText(`${scoreLabel}: ${Math.round(score(times, weights))}`).addTo(map);
    });
    map.on("mouseleave", "r15-h3", () => {
      map.getCanvas().style.cursor = "";
      map.setFilter("r15-h3-hover", ["==", ["get", "h3"], ""]);
      popup.remove();
    });

    mapRef.current = map;
    window.__reach15 = { map };
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Basemap flavour / language: swap the style, the overlay is re-added on style.load.
  const { basemap, dark, lang } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(baseStyle({ basemap, dark, lang }), { diff: false });
  }, [basemap, dark, lang]);

  // Re-score the hexagons on the GPU when the profile, focus or selection changes.
  const { mode, weights, point, focusDistrict } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("r15-h3")) return;
    map.setPaintProperty("r15-h3", "fill-color", heatColor(mode, weights, dark));
    map.setPaintProperty("r15-h3", "fill-opacity", h3Opacity(Boolean(point), focusDistrict));
  }, [mode, weights, dark, point, focusDistrict]);

  const { isochrones, pois, commonArea } = props;
  useEffect(() => {
    const map = mapRef.current;
    // Before the first style.load there are no sources yet; style.load applies the data then.
    if (map?.getSource("r15-iso")) applyData(map, { isochrones, pois, point, commonArea });
  }, [isochrones, pois, point, commonArea]);

  // Lettered places and numbered spots are DOM markers: crisp type without a glyph server.
  const { markers } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const placed = markers.map((m) => {
      const el = document.createElement("div");
      el.className = `map-marker ${m.kind}`;
      el.textContent = m.text;
      el.title = m.title;
      el.setAttribute("aria-hidden", "true");
      if (m.kind === "spot") {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          propsRef.current.onSelect({ lon: m.lon, lat: m.lat });
        });
      }
      return new maplibregl.Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
    });
    return () => placed.forEach((m) => m.remove());
  }, [markers]);

  // Frame the common area when it changes and no single place is selected.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !commonArea || propsRef.current.point) return;
    const coords = (commonArea as { coordinates: number[][][][] }).coordinates.flat(2);
    if (!coords.length) return;
    const lons = coords.map((c) => c[0]!);
    const lats = coords.map((c) => c[1]!);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 64, maxZoom: 15 });
  }, [commonArea]);

  // Fly to points chosen from search results; keep the place panel from covering the point;
  // outline the hexagon the point falls in once the tiles under it are rendered.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setPadding({ left: 0, top: 0, bottom: 0, right: point && wide() ? 392 : 0 });
    const outline = () => {
      if (!map.getLayer("r15-h3-selected")) return;
      const hit = point ? map.queryRenderedFeatures(map.project([point.lon, point.lat]), { layers: ["r15-h3"] })[0] : undefined;
      map.setFilter("r15-h3-selected", ["==", ["get", "h3"], String(hit?.properties.h3 ?? "")]);
      const district = Number(hit?.properties.district_id);
      propsRef.current.onCell?.(hit ? { h3: String(hit.properties.h3), districtId: Number.isFinite(district) && district > 0 ? district : null } : undefined);
    };
    if (point && (point.fly || !map.getBounds().contains([point.lon, point.lat]))) {
      map.flyTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), 14) });
    }
    map.once("idle", outline);
    return () => {
      map.off("idle", outline);
    };
  }, [point]);

  // Frame a focused district.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusDistrict || focusDistrict.bbox.length !== 4) return;
    const [w, s, e, n] = focusDistrict.bbox as [number, number, number, number];
    map.fitBounds([[w, s], [e, n]], { padding: 48, maxZoom: 14.5 });
  }, [focusDistrict]);

  return <div ref={container} className="map" role="region" aria-label="Map" data-testid="map" />;
}
