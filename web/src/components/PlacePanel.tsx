import { useState } from "react";
import type { AccessResponse, CategoryId, NearbyPlace, NearbyResponse } from "../api/client";
import type { Strings } from "../i18n";
import { formatAt } from "../when";
import { Icon } from "./Icon";

interface Props {
  t: Strings;
  access?: AccessResponse;
  loading: boolean;
  error?: string;
  minutes: number[];
  /** "Walk · Family with kids": what the score was computed for. */
  scoreFor: string;
  /** "VI. kerület · Terézváros" when the point lies in a district. */
  district?: string;
  focusCategory?: CategoryId;
  lang: string;
  onFocusCategory: (category: CategoryId | undefined) => void;
  onClear: () => void;
  /** Pin the place to the comparison: possible, done already, or three are pinned. */
  compare: "add" | "added" | "full";
  onCompare: () => void;
  /** Higher-scoring hexagons within a short walk (absent while loading or when there are none). */
  nearby?: NearbyResponse;
  onNearby: (place: NearbyPlace) => void;
}

const LIMIT_SECONDS = 15 * 60;
/** Categories whose places keep opening hours; "hours unknown" is noise for parks, stops and schools. */
const HOURS_MATTER = new Set<CategoryId>(["grocery", "pharmacy", "doctor", "food", "gym", "library"]);
const fmtMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

function CloseButton({ t, onClear }: Pick<Props, "t" | "onClear">) {
  return (
    <button type="button" className="icon-button" aria-label={t.clear} onClick={onClear}>
      <Icon name="close" />
    </button>
  );
}

/**
 * Shares the link (it already holds the point, mode, profile, time and pinned places): the
 * system share sheet where there is one (phones), else the clipboard, with a spoken confirmation.
 */
function ShareButton({ t, title, score }: { t: Strings; title: string; score: number }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === "function" && window.matchMedia?.("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: `Reach15 · ${title}`, text: t.shareText(title, score), url });
        return;
      } catch {
        /* dismissed, or not allowed: fall back to the clipboard */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t.shareManual, url);
    }
  };
  return (
    <>
      <button type="button" className="place-compare" onClick={share} data-testid="share">
        <Icon name={copied ? "check" : "share"} />
        {copied ? t.shareCopied : t.share}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? t.shareCopied : ""}
      </span>
    </>
  );
}

/**
 * The selected point: the score as a poster numeral, then the minutes behind it, one row per
 * category, nearest first. Pressing a row recolours the map by that category alone.
 */
export function PlacePanel(props: Props) {
  const { t, access, loading, error, minutes, scoreFor, district, focusCategory, lang, onFocusCategory, onClear, compare, onCompare, nearby, onNearby } = props;
  if (error) {
    return (
      <section className="place" role="alert">
        <div className="place-header">
          <p className="place-error">{error}</p>
          <CloseButton t={t} onClear={onClear} />
        </div>
      </section>
    );
  }
  if (!access) {
    return (
      <section className="place" aria-busy="true" aria-label={t.loading}>
        <div className="place-header">
          <p className="place-status">{t.loading}</p>
          <CloseButton t={t} onClear={onClear} />
        </div>
        <span className="skeleton" style={{ width: "40%", height: 72 }} />
        {[70, 55, 62, 48, 66].map((w) => (
          <span key={w} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </section>
    );
  }

  const rows = [...access.categories]
    .filter((c) => c.weight > 0)
    .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity));
  const title = access.address?.label ?? `${access.point.lat.toFixed(5)}, ${access.point.lon.toFixed(5)}`;

  return (
    <section className="place" aria-label={title} aria-busy={loading} data-testid="place-card">
      <header className="place-header">
        <div>
          <h2 data-testid="place-title">{title}</h2>
          {district && <p className="place-district">{district}</p>}
          {access.address?.sublabel && <p className="place-sub">{access.address.sublabel}</p>}
        </div>
        <CloseButton t={t} onClear={onClear} />
      </header>
      <div className="place-actions">
        <button
          type="button"
          className="place-compare"
          aria-pressed={compare === "added"}
          disabled={compare !== "add"}
          onClick={onCompare}
          data-testid="compare-add"
        >
          <Icon name={compare === "added" ? "check" : "plus"} />
          {compare === "added" ? t.compareAdded : compare === "full" ? t.compareFull : t.compareAdd}
        </button>
        <ShareButton t={t} title={title} score={Math.round(access.score)} />
      </div>

      <div className="score">
        <span className="score-value num" data-testid="score">
          {Math.round(access.score)}
        </span>
        <span className="score-caption">
          <strong>{t.score}</strong>
          {t.outOf} · {scoreFor}
        </span>
      </div>

      {access.transit ? (
        <p className={access.transit.tripsRunning > 0 ? "place-when" : "place-when warn"} data-testid="transit-note">
          {access.transit.tripsRunning > 0
            ? t.transitLeaving(formatAt(access.transit.departure, lang), access.transit.stopsReached)
            : t.noService}
        </p>
      ) : (
        access.at && <p className="place-when">{t.openAt(formatAt(access.at, lang))}</p>
      )}
      {access.mode === "stepfree" && (
        <p className="place-when" data-testid="stepfree-note">
          {t.stepFreeNote}
        </p>
      )}
      {access.holiday && (
        <p className="place-when" data-testid="holiday-note">
          {t.holidayNote(t.holidays[access.holiday] ?? access.holiday)}
        </p>
      )}

      <p className="iso-key-title" id="iso-key-title">
        {t.isochrones}
      </p>
      <ul className="iso-key" aria-labelledby="iso-key-title">
        {minutes.map((m) => (
          <li key={m}>
            <span className={`iso-swatch iso-${m}`} aria-hidden="true" />
            {m} {t.min}
          </li>
        ))}
      </ul>

      <h3 className="section-title">{t.nearest}</h3>
      <ul className={focusCategory ? "meters focused" : "meters"}>
        {rows.map((c) => {
          const pressed = c.category === focusCategory;
          const share = c.seconds == null ? 1 : Math.min(1, c.seconds / LIMIT_SECONDS);
          return (
            <li key={c.category} data-testid={`category-${c.category}`}>
              <button
                type="button"
                className="meter"
                aria-pressed={pressed}
                title={t.focusCategory(t.categories[c.category])}
                onClick={() => onFocusCategory(pressed ? undefined : c.category)}
              >
                <span className="meter-name">
                  {t.categories[c.category]}
                  {(c.poi?.name || (access.at && c.poi && HOURS_MATTER.has(c.category))) && (
                    <span className="meter-poi">
                      {[c.poi?.name, access.at && c.poi && HOURS_MATTER.has(c.category) ? (c.open ? t.open : t.hoursUnknown) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <span className="meter-value num">
                  {c.seconds == null ? `${t.unreachable} ${t.min}` : `${fmtMinutes(c.seconds)} ${t.min}`}
                </span>
                <span className="meter-track" aria-hidden="true">
                  <span className={share >= 1 ? "meter-fill over" : "meter-fill"} style={{ width: `${share * 100}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {nearby && nearby.places.length > 0 && (
        <section className="nearby" aria-labelledby="nearby-title" data-testid="nearby">
          <h3 className="section-title" id="nearby-title">
            {t.nearbyTitle}
          </h3>
          <p className="nearby-caption">{t.nearbyCaption(nearby.minutes, Math.round(nearby.hereScore))}</p>
          <ol className="nearby-list">
            {nearby.places.map((p) => {
              const label = p.address?.label ?? t.nearbyUnnamed;
              return (
                <li key={p.h3}>
                  <button
                    type="button"
                    className="nearby-place"
                    aria-label={t.nearbyShow(label, Math.round(p.score))}
                    onClick={() => onNearby(p)}
                  >
                    <span className="nearby-score num">{Math.round(p.score)}</span>
                    <span className="nearby-name">
                      {label}
                      <span className="nearby-walk">{t.nearbyWalk(fmtMinutes(p.seconds))}</span>
                    </span>
                    <Icon name="chevron" />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </section>
  );
}
