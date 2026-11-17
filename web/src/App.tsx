import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type Anchor, api, type CategoryId, type DistrictScore, heatMode, type Mode, type Persona, type Weights } from "./api/client";
import { CommonGroundPanel, LETTERS } from "./components/CommonGroundPanel";
import { WhenPicker } from "./components/WhenPicker";
import { formatAt, resolveWhen, type When } from "./when";
import { DistrictRoster } from "./components/DistrictRoster";
import { districtFromPostcode, districtLine } from "./districts";
import { Icon } from "./components/Icon";
import { Legend } from "./components/Legend";
import { PlacePanel } from "./components/PlacePanel";
import { ProfilePanel } from "./components/ProfilePanel";
import { SearchBox } from "./components/SearchBox";
import { type Lang, strings } from "./i18n";
import { type DistrictFocus, type MapMarker, MapView, type PoiMarker } from "./map/MapView";
import { readUrlState, writeUrlState } from "./urlState";

const MINUTES = [5, 10, 15];
const BALANCED: Weights = {
  grocery: 1, pharmacy: 1, doctor: 1, school: 1, kindergarten: 1, park: 1, transit: 1, food: 1, gym: 1, library: 1,
};

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("reach15.lang");
    if (saved === "en" || saved === "hu") return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language.startsWith("hu") ? "hu" : "en";
}

function initialDark(): boolean {
  try {
    const saved = localStorage.getItem("reach15.theme");
    if (saved) return saved === "dark";
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function App() {
  const [fromUrl] = useState(readUrlState);
  const [lang, setLang] = useState<Lang>(initialLang);
  const [dark, setDark] = useState(initialDark);
  const [mode, setMode] = useState<Mode>(fromUrl.mode ?? "walk");
  const [personaId, setPersonaId] = useState(fromUrl.persona ?? "balanced");
  /** Slider overrides; undefined = use the selected persona's weights. */
  const [customWeights, setCustomWeights] = useState<Weights>();
  const [point, setPoint] = useState<{ lon: number; lat: number; fly?: boolean } | undefined>(fromUrl.point);
  const [focusDistrict, setFocusDistrict] = useState<DistrictScore>();
  const [focusCategory, setFocusCategory] = useState<CategoryId>();
  /** District of the H3 cell under the selected point, reported by the map. */
  const [cellDistrictId, setCellDistrictId] = useState<number | null>();
  const [when, setWhen] = useState<When>(fromUrl.when ?? "any");
  const [anchors, setAnchors] = useState<Anchor[]>(fromUrl.anchors ?? []);
  /** The `at` sent to the API; presets resolve when chosen ("now" stays the time it was picked). */
  const at = useMemo(() => resolveWhen(when), [when]);
  /** The heatmap and ranking are precomputed for walking and cycling; transit shows walking there. */
  const heat = heatMode(mode);
  const t = strings[lang];

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.lang = lang;
  }, [dark, lang]);

  useEffect(
    () => writeUrlState({ point, mode, persona: personaId, when, anchors }),
    [point, mode, personaId, when, anchors],
  );

  const personas = useQuery({ queryKey: ["personas"], queryFn: api.personas, staleTime: Infinity });
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const basemap = useQuery({
    queryKey: ["catalog"],
    queryFn: async () => {
      const res = await fetch("/tiles/catalog");
      if (!res.ok) return false;
      const catalog = (await res.json()) as { tiles?: Record<string, unknown> };
      return Boolean(catalog.tiles?.basemap);
    },
    staleTime: Infinity,
  });

  const persona = personas.data?.find((x) => x.id === personaId);
  const weights = customWeights ?? (persona?.weights as Weights | undefined) ?? BALANCED;
  /** The heatmap follows the profile, or a single category the visitor focused. */
  const heatWeights: Weights = useMemo(() => (focusCategory ? { [focusCategory]: 1 } : weights), [focusCategory, weights]);
  const profileName = personaId === "custom" ? t.customProfile : (t.personas[personaId] ?? persona?.label ?? personaId);
  const modeName = t.modeName[mode];
  const whenName = at ? ` · ${formatAt(at, lang)}` : "";

  const choosePersona = (p: Persona) => {
    setPersonaId(p.id);
    setCustomWeights(undefined);
  };

  const access = useQuery({
    queryKey: ["access", point?.lon, point?.lat, mode, weights, at],
    queryFn: () => api.access(point!.lon, point!.lat, mode, weights, at),
    enabled: Boolean(point),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const isochrone = useQuery({
    // Only the timetable depends on the time; walking and cycling isochrones are shared.
    queryKey: ["isochrone", point?.lon, point?.lat, mode, mode === "transit" ? at : undefined],
    queryFn: () => api.isochrone(point!.lon, point!.lat, mode, MINUTES, mode === "transit" ? at : undefined),
    enabled: Boolean(point),
    retry: false,
  });
  const ranking = useQuery({
    queryKey: ["ranking", heat, weights],
    queryFn: () => api.ranking(heat, weights),
    placeholderData: (previous) => previous,
  });
  const anchorKey = anchors.map(({ lon, lat, mode: m, minutes }) => [lon, lat, m, minutes]);
  const common = useQuery({
    queryKey: ["common", anchorKey, heat, weights, at],
    queryFn: () => api.commonGround(anchors, heat, weights, at),
    enabled: anchors.length > 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const commonData = anchors.length > 0 ? common.data : undefined;

  const markers: MapMarker[] = useMemo(
    () => [
      ...anchors.map((a, i) => ({
        lon: a.lon,
        lat: a.lat,
        text: LETTERS[i]!,
        kind: "anchor" as const,
        title: a.label ?? t.placeLabel(LETTERS[i]!),
      })),
      ...(commonData?.spots ?? []).map((s, n) => ({
        lon: s.lon,
        lat: s.lat,
        text: String(n + 1),
        kind: "spot" as const,
        title: t.showSpot(n + 1),
      })),
    ],
    [anchors, commonData, t],
  );

  const pois: PoiMarker[] = useMemo(
    () =>
      (access.data?.categories ?? [])
        .filter((c) => c.poi && c.weight > 0)
        .map((c) => ({
          category: c.category,
          label: t.categories[c.category],
          name: c.poi!.name ?? t.categories[c.category],
          lon: c.poi!.lon,
          lat: c.poi!.lat,
          weight: c.weight,
        })),
    [access.data, t],
  );

  const districtFocus: DistrictFocus | undefined = useMemo(
    () => (focusDistrict ? { id: focusDistrict.districtId, bbox: focusDistrict.bbox } : undefined),
    [focusDistrict],
  );

  const error = (access.error ?? isochrone.error)?.message;
  // The address's postcode names its district exactly; the H3 cell is the fallback for clicks
  // that have no address (a cell on a border belongs to one district only).
  const placeDistrict =
    districtFromPostcode(access.data?.address?.sublabel) ?? ranking.data?.find((d) => d.districtId === cellDistrictId)?.name;
  const clear = () => {
    setPoint(undefined);
    setFocusCategory(undefined);
  };

  return (
    <div className="app">
      <aside className="rail" aria-label={t.appTitle}>
        <header className="masthead">
          <h1 className="wordmark">
            Reach<span>15</span>
          </h1>
          <div className="toolbar">
            <button
              type="button"
              className="rail-button"
              onClick={() => {
                const next = lang === "en" ? "hu" : "en";
                setLang(next);
                persist("reach15.lang", next);
              }}
            >
              {t.language}
            </button>
            <button
              type="button"
              className="rail-button"
              aria-label={t.theme}
              aria-pressed={dark}
              onClick={() => {
                setDark(!dark);
                persist("reach15.theme", dark ? "light" : "dark");
              }}
            >
              <Icon name={dark ? "sun" : "moon"} />
            </button>
          </div>
          <p className="tagline">{t.tagline}</p>
        </header>

        <SearchBox t={t} near={point} onPick={(r) => setPoint({ lon: r.lon, lat: r.lat, fly: true })} />
        {!point && <p className="hint">{t.clickHint}</p>}

        <ProfilePanel
          t={t}
          mode={mode}
          onMode={setMode}
          personas={personas.data ?? []}
          personaId={personaId}
          onPersona={choosePersona}
          weights={weights}
          onWeights={(w) => {
            setCustomWeights(w);
            setPersonaId("custom");
          }}
        />

        <WhenPicker t={t} when={when} onWhen={setWhen} />

        {focusCategory && (
          <p className="focus-note">
            <span>
              {t.focusOnly} <strong>{t.categories[focusCategory]}</strong>
            </span>
            <button type="button" className="rail-button" onClick={() => setFocusCategory(undefined)}>
              {t.showAll}
            </button>
          </p>
        )}

        <CommonGroundPanel
          t={t}
          anchors={anchors}
          onAnchors={setAnchors}
          candidate={point && { lon: point.lon, lat: point.lat, label: access.data?.address?.label }}
          result={commonData}
          loading={common.isFetching}
          error={anchors.length > 0 ? common.error?.message : undefined}
          onSpot={(p) => setPoint({ ...p, fly: true })}
        />

        <DistrictRoster
          t={t}
          ranking={ranking.data}
          loading={ranking.isFetching}
          focusedId={focusDistrict?.districtId}
          onFocus={setFocusDistrict}
        />

        <footer className="colophon">{meta.data && t.data(new Date(meta.data.importedAt).toLocaleDateString(lang))}</footer>
      </aside>

      <main className={point ? "stage has-place" : "stage"}>
        {/* Wait for the tile catalog (a few ms) so the map starts with its final style instead
            of loading a plain one and swapping it, which reloaded every tile on start-up. */}
        {basemap.isFetched ? (
        <MapView
          mode={heat}
          weights={heatWeights}
          dark={dark}
          lang={lang}
          basemap={basemap.data ?? false}
          point={point}
          isochrones={point && !isochrone.isError ? isochrone.data : undefined}
          pois={point ? pois : []}
          commonArea={commonData?.area as GeoJSON.Geometry | null | undefined}
          markers={markers}
          focusDistrict={districtFocus}
          scoreLabel={focusCategory ? t.categories[focusCategory] : t.score}
          onSelect={(p) => setPoint(p)}
          onCell={(cell) => setCellDistrictId(cell?.districtId ?? null)}
        />
        ) : (
          <div className="map" role="region" aria-label="Map" data-testid="map" />
        )}
        <Legend
          title={
            focusCategory
              ? t.legendFocus(t.categories[focusCategory], t.modeName[heat])
              : mode === "transit"
                ? t.legendTransit(profileName)
                : t.legendTitle(modeName, profileName)
          }
          dark={dark}
          low={t.legendLow}
          high={t.legendHigh}
        />
        {point && (
          <PlacePanel
            t={t}
            access={access.data}
            loading={access.isFetching || isochrone.isFetching}
            error={error}
            minutes={MINUTES}
            scoreFor={t.scoreFor(modeName, profileName) + whenName}
            lang={lang}
            district={placeDistrict ? districtLine(placeDistrict) : undefined}
            focusCategory={focusCategory}
            onFocusCategory={setFocusCategory}
            onClear={clear}
          />
        )}
      </main>
    </div>
  );
}
