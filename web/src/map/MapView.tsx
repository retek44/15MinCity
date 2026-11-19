import type { FeatureCollection, Geometry } from "geojson";
import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre resolves its worker relative to its own module URL, which does not survive Rollup
// bundling (production builds 404 on the worker). Emit the worker as an asset and point at it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef } from "react";
import type { CellTimes, HeatMode, IsochroneCollection, Weights } from "../api/client";
import { cellScores, heatColor } from "../scoring";
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
  /** Travel times of every hexagon; the map scores them and paints the scores. */
  cells?: CellTimes;
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
    __reach15?: { map: MlMap; heat?: { mode: HeatMode; categories: string[]; cells: number } };
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

/**
 * Hexagons stay readable under the reach planes; a focused district keeps its own cells.
 * A hexagon without a score yet (the travel times are still loading) is not drawn.
 */
function h3Opacity(hasPoint: boolean, focus?: DistrictFocus): ExpressionSpecification {
  const base = hasPoint ? 0.3 : 0.82;
  const shown: ExpressionSpecification | number = focus
    ? ["case", ["==", ["to-number", ["get", "district_id"]], focus.id], base, 0.08]
    : base;
  return ["case", ["==", ["typeof", ["feature-state", "score"]], "number"], shown, 0];
}

/**
 * Invisible for the one-off "warm-up" feature of each overlay source. MapLibre compiles a
 * layer's shaders the first time it draws it; drawing an invisible feature at start-up moves
 * that 100-200 ms stall from the first click to the first load.
 */
const unlessWarm = (value: number | ExpressionSpecification): ExpressionSpecification => ["case", ["has", "warm"], 0, value];

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
        "fill-color": heatColor(props.dark),
        "fill-opacity": h3Opacity(Boolean(props.point), props.focusDistrict),
        "fill-outline-color": "rgba(0,0,0,0)",
      },
    },
    before,
  );
  // The hexagon is the system's construction shape: outlined under the cursor and the selection.
  // Driven by feature state, not filters: a filter change re-lays out every tile of the layer
  // (the outline lagged behind a fast cursor), a feature-state change only repaints.
  const hovered: ExpressionSpecification = ["boolean", ["feature-state", "hover"], false];
  const selected: ExpressionSpecification = ["boolean", ["feature-state", "selected"], false];
  map.addLayer(
    {
      id: "r15-h3-outline",
      type: "line",
      source: "r15-h3",
      "source-layer": "h3",
      paint: {
        "line-color": ["case", selected, INK.saffron, INK.ink[t]],
        "line-width": ["case", selected, 3, 1.5],
        "line-opacity": ["case", ["any", selected, hovered], 1, 0],
        "line-opacity-transition": { duration: 0 },
      },
    },
    before,
  );
  // Overprint: the 5/10/15-minute reach as three nested flat ink planes.
  map.addLayer(
    {
      id: "r15-iso-fill",
      type: "fill",
      source: "r15-iso",
      paint: {
        "fill-color": ["match", ["get", "minutes"], 5, INK.ink[t], 10, INK.poppy[t], INK.saffron],
        "fill-opacity": unlessWarm(["match", ["get", "minutes"], 5, 0.62, 10, 0.72, 0.75]),
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
      paint: { "fill-color": INK.saffron, "fill-opacity": unlessWarm(0.32) },
    },
    before,
  );
  map.addLayer(
    {
      id: "r15-common-line",
      type: "line",
      source: "r15-common",
      paint: { "line-color": INK.ink[t], "line-width": 2.5, "line-opacity": unlessWarm(1) },
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
      "circle-opacity": unlessWarm(1),
      "circle-stroke-opacity": unlessWarm(1),
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
      "circle-opacity": unlessWarm(1),
      "circle-stroke-opacity": unlessWarm(1),
    },
  });
}

/** Puts one invisible feature in every overlay source, in view, so its shaders compile now. */
function warmUp(map: MlMap) {
  const { lng, lat } = map.getCenter();
  const d = 1e-5;
  const ring = [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat]];
  const area: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { warm: 1, minutes: 5, weight: 1 }, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
  const dot: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { warm: 1, weight: 1 }, geometry: { type: "Point", coordinates: [lng, lat] } }],
  };
  for (const id of ["r15-iso", "r15-common"]) (map.getSource(id) as GeoJSONSource | undefined)?.setData(area);
  for (const id of ["r15-pois", "r15-point"]) (map.getSource(id) as GeoJSONSource | undefined)?.setData(dot);
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

/** Camera moves: quick enough to feel direct, long enough to keep the sense of place. */
const MOVE_MS = 550;

/** Right camera padding while the place panel is open: its width plus a margin. */
const PANEL_PAD = 392;

export function MapView(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  /** Hexagon outlined as the selection (feature id = H3 index). */
  const selectedId = useRef<string | undefined>(undefined);
  /** Re-applies the selection outline; a new style (theme, language) drops feature state. */
  const reselect = useRef<() => void>(() => {});
  /** Re-applies the hexagon scores, for the same reason. */
  const rescore = useRef<() => void>(() => {});
  /** The overlay sources have held real data (so the warm-up is no longer needed). */
  const hasData = useRef(false);
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
      // Labels and tiles appear without the default 300 ms fade.
      fadeDuration: 80,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.GeolocateControl({}), "bottom-right");
    map.on("style.load", () => {
      addOverlay(map, propsRef.current);
      selectedId.current = undefined;
      rescore.current();
      reselect.current();
      const { isochrones, pois, point, commonArea } = propsRef.current;
      if (hasData.current || isochrones || pois.length || point || commonArea) {
        applyData(map, propsRef.current);
      } else {
        // After the first full frame (its own shaders are a long task already), draw the
        // warm-up features; once they are drawn, swap them for the real, empty data.
        map.once("idle", () => {
          if (hasData.current) return;
          warmUp(map);
          map.once("idle", () => {
            if (!hasData.current) applyData(map, propsRef.current);
          });
        });
      }
    });
    map.on("click", (e) => {
      propsRef.current.onSelect({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "hex-popup", offset: 10 });
    // At most one hover update per frame, however fast the pointer moves.
    // MapLibre deletes e.features once the handler returns, so keep the feature itself.
    let pending: { feature: maplibregl.MapGeoJSONFeature; lngLat: maplibregl.LngLat } | undefined;
    let frame = 0;
    let hoverId: string | undefined;
    const setHover = (id: string | undefined) => {
      if (id === hoverId) return;
      if (hoverId !== undefined) map.setFeatureState({ source: "r15-h3", sourceLayer: "h3", id: hoverId }, { hover: false });
      if (id !== undefined) map.setFeatureState({ source: "r15-h3", sourceLayer: "h3", id }, { hover: true });
      hoverId = id;
    };
    const hover = () => {
      frame = 0;
      if (!pending) return;
      const { feature, lngLat } = pending;
      const id = feature.id === undefined ? undefined : String(feature.id);
      setHover(id);
      const value = id === undefined ? undefined : map.getFeatureState({ source: "r15-h3", sourceLayer: "h3", id }).score;
      if (typeof value !== "number") {
        popup.remove();
        return;
      }
      popup.setLngLat(lngLat).setText(`${propsRef.current.scoreLabel}: ${Math.round(value)}`).addTo(map);
    };
    map.on("mousemove", "r15-h3", (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      pending = { feature, lngLat: e.lngLat };
      map.getCanvas().style.cursor = "crosshair";
      if (!frame) frame = requestAnimationFrame(hover);
    });
    map.on("mouseleave", "r15-h3", () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = undefined;
      map.getCanvas().style.cursor = "";
      setHover(undefined);
      popup.remove();
    });
    // A new style drops feature state; forget the hovered cell with it.
    map.on("style.load", () => {
      hoverId = undefined;
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

  // Re-score the hexagons when the profile, the mode or the focused category changes. Scores
  // are computed here and handed over as feature state, so no tile is read again (a paint
  // expression over tile properties made MapLibre re-parse every tile on each change).
  const { mode, weights, cells, point, focusDistrict } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    rescore.current = () => {
      if (!cells || !map.getSource("r15-h3")) return;
      const scores = cellScores(cells, mode, weights);
      for (let i = 0; i < scores.length; i++) {
        map.setFeatureState({ source: "r15-h3", sourceLayer: "h3", id: cells.h3[i]! }, { score: scores[i] });
      }
      const categories = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0).map(([c]) => c);
      window.__reach15 = { map, heat: { mode, categories, cells: scores.length } };
    };
    rescore.current();
  }, [cells, mode, weights]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("r15-h3")) return;
    map.setPaintProperty("r15-h3", "fill-opacity", h3Opacity(Boolean(point), focusDistrict));
  }, [point, focusDistrict]);

  const { isochrones, pois, commonArea } = props;
  useEffect(() => {
    const map = mapRef.current;
    // Before the first style.load there are no sources yet; style.load applies the data then.
    if (!map?.getSource("r15-iso")) return;
    if (isochrones || pois.length || point || commonArea) hasData.current = true;
    applyData(map, { isochrones, pois, point, commonArea });
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
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: 64,
      maxZoom: 15,
      duration: MOVE_MS,
    });
  }, [commonArea]);

  // Fly to points chosen from search results; keep the place panel from covering the point;
  // outline the hexagon the point falls in as soon as the tile under it is rendered.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const right = point && wide() ? PANEL_PAD : 0;
    if (map.getPadding().right !== right) {
      // Padding moves the camera centre. Move the centre with it, so the map under the
      // cursor stays where it is when the panel opens or closes (it jumped sideways before).
      const { clientWidth: w, clientHeight: h } = map.getContainer();
      const centre = map.unproject([(w - right) / 2, h / 2]);
      map.jumpTo({ center: centre, padding: { left: 0, top: 0, bottom: 0, right } });
    }
    /** final: accept "no hexagon here" (the map is idle, so the tile is not just loading). */
    const outline = (final = false): boolean => {
      if (!map.getLayer("r15-h3-outline")) return false;
      const hit = point ? map.queryRenderedFeatures(map.project([point.lon, point.lat]), { layers: ["r15-h3"] })[0] : undefined;
      if (point && !hit && !final) return false; // tile not rendered yet
      const id = hit?.id === undefined ? undefined : String(hit.id);
      if (selectedId.current !== undefined && map.getSource("r15-h3")) {
        map.setFeatureState({ source: "r15-h3", sourceLayer: "h3", id: selectedId.current }, { selected: false });
      }
      if (id !== undefined) map.setFeatureState({ source: "r15-h3", sourceLayer: "h3", id }, { selected: true });
      selectedId.current = id;
      const district = Number(hit?.properties.district_id);
      propsRef.current.onCell?.(hit ? { h3: String(hit.properties.h3), districtId: Number.isFinite(district) && district > 0 ? district : null } : undefined);
      return true;
    };
    const retry = () => {
      if (outline()) stop();
    };
    const settle = () => {
      outline(true);
      stop();
    };
    const stop = () => {
      map.off("render", retry);
      map.off("idle", settle);
    };
    const watch = () => {
      stop();
      map.on("render", retry);
      map.on("idle", settle);
    };
    reselect.current = () => {
      if (!outline()) watch();
    };
    let moving = false;
    if (point?.fly) {
      // A search result: go there and zoom to street level.
      map.flyTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), 14), duration: MOVE_MS, essential: true });
      moving = true;
    } else if (point) {
      // A click: the point is on screen. Pan only if the place panel now covers it.
      const { clientWidth: w, clientHeight: h } = map.getContainer();
      const p = map.project([point.lon, point.lat]);
      if (p.x < 0 || p.y < 0 || p.x > w - right - 16 || p.y > h) {
        map.easeTo({ center: [point.lon, point.lat], duration: MOVE_MS, essential: true });
        moving = true;
      }
    }
    // Clicks are already in view: outline now if the tile is there, else as soon as it renders.
    if (moving || !outline()) watch();
    return stop;
  }, [point]);

  // Frame a focused district.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusDistrict || focusDistrict.bbox.length !== 4) return;
    const [w, s, e, n] = focusDistrict.bbox as [number, number, number, number];
    map.fitBounds([[w, s], [e, n]], { padding: 48, maxZoom: 14.5, duration: MOVE_MS });
  }, [focusDistrict]);

  return <div ref={container} className="map" role="region" aria-label="Map" data-testid="map" />;
}
