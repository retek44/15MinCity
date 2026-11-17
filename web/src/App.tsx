import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, type CategoryId, type DistrictScore, type Mode, type Persona, type Weights } from "./api/client";
import { DistrictRoster } from "./components/DistrictRoster";
import { districtFromPostcode, districtLine } from "./districts";
import { Icon } from "./components/Icon";
import { Legend } from "./components/Legend";
import { PlacePanel } from "./components/PlacePanel";
import { ProfilePanel } from "./components/ProfilePanel";
import { SearchBox } from "./components/SearchBox";
import { type Lang, strings } from "./i18n";
import { type DistrictFocus, MapView, type PoiMarker } from "./map/MapView";
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
  const t = strings[lang];

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.lang = lang;
  }, [dark, lang]);

  useEffect(() => writeUrlState({ point, mode, persona: personaId }), [point, mode, personaId]);

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

  const choosePersona = (p: Persona) => {
    setPersonaId(p.id);
    setCustomWeights(undefined);
  };

  const access = useQuery({
    queryKey: ["access", point?.lon, point?.lat, mode, weights],
    queryFn: () => api.access(point!.lon, point!.lat, mode, weights),
    enabled: Boolean(point),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const isochrone = useQuery({
    queryKey: ["isochrone", point?.lon, point?.lat, mode],
    queryFn: () => api.isochrone(point!.lon, point!.lat, mode, MINUTES),
    enabled: Boolean(point),
    retry: false,
  });
  const ranking = useQuery({
    queryKey: ["ranking", mode, weights],
    queryFn: () => api.ranking(mode, weights),
    placeholderData: (previous) => previous,
  });

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
        <MapView
          mode={mode}
          weights={heatWeights}
          dark={dark}
          lang={lang}
          basemap={basemap.data ?? false}
          point={point}
          isochrones={point && !isochrone.isError ? isochrone.data : undefined}
          pois={point ? pois : []}
          focusDistrict={districtFocus}
          scoreLabel={focusCategory ? t.categories[focusCategory] : t.score}
          onSelect={(p) => setPoint(p)}
          onCell={(cell) => setCellDistrictId(cell?.districtId ?? null)}
        />
        <Legend
          title={focusCategory ? t.legendFocus(t.categories[focusCategory], modeName) : t.legendTitle(modeName, profileName)}
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
            scoreFor={t.scoreFor(modeName, profileName)}
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
