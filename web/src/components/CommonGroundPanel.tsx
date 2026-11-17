import type { Anchor, CommonGroundResponse, Mode } from "../api/client";
import type { Strings } from "../i18n";
import { Icon } from "./Icon";

interface Props {
  t: Strings;
  anchors: Anchor[];
  onAnchors: (anchors: Anchor[]) => void;
  /** The point selected on the map or from search, which can be added as a place. */
  candidate?: { lon: number; lat: number; label?: string };
  result?: CommonGroundResponse;
  loading: boolean;
  error?: string;
  onSpot: (spot: { lon: number; lat: number }) => void;
}

export const LETTERS = ["A", "B", "C", "D"];
const LIMITS = [5, 10, 15, 20, 30, 45];
const MODES: Mode[] = ["walk", "bike", "transit"];
const fmtMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/**
 * "Where should we live?": up to four places the household needs to reach, each with its own
 * travel mode and limit. The map outlines the area where all of them are in reach; the best
 * spots inside are listed with the minutes to each place.
 */
export function CommonGroundPanel({ t, anchors, onAnchors, candidate, result, loading, error, onSpot }: Props) {
  const update = (i: number, change: Partial<Anchor>) => onAnchors(anchors.map((a, j) => (i === j ? { ...a, ...change } : a)));
  const canAdd = candidate && anchors.length < 4;

  return (
    <section className="common" aria-labelledby="common-title" aria-busy={loading} data-testid="common-ground">
      <h2 id="common-title">{t.commonTitle}</h2>
      <p className="roster-caption">{t.commonCaption}</p>

      {anchors.length > 0 && (
        <ol className="anchors">
          {anchors.map((a, i) => {
            const letter = LETTERS[i]!;
            return (
              <li key={`${a.lon},${a.lat},${i}`} className="anchor">
                <span className="anchor-badge num" aria-hidden="true">
                  {letter}
                </span>
                <span className="anchor-label" title={a.label}>
                  <span className="visually-hidden">{t.placeLabel(letter)}: </span>
                  {a.label ?? `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`}
                </span>
                <select aria-label={t.modeFor(letter)} value={a.mode} onChange={(e) => update(i, { mode: e.target.value as Mode })}>
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {t.modeName[m]}
                    </option>
                  ))}
                </select>
                <select aria-label={t.limitFor(letter)} value={a.minutes} onChange={(e) => update(i, { minutes: Number(e.target.value) })}>
                  {LIMITS.map((m) => (
                    <option key={m} value={m}>
                      {m} {t.min}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button rail-icon"
                  aria-label={t.removePlace(letter)}
                  onClick={() => onAnchors(anchors.filter((_, j) => j !== i))}
                >
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="common-actions">
        <button
          type="button"
          className="rail-button"
          disabled={!canAdd}
          onClick={() => candidate && onAnchors([...anchors, { ...candidate, mode: "transit", minutes: 30 }])}
        >
          <Icon name="plus" />
          {t.addPlace}
        </button>
        {anchors.length > 0 && (
          <button type="button" className="rail-button" onClick={() => onAnchors([])}>
            {t.clearPlaces}
          </button>
        )}
      </div>
      {!candidate && anchors.length < 4 && <p className="hint">{t.addHint}</p>}

      {anchors.length > 0 && (
        <div className="common-result" aria-live="polite">
          {error && <p className="common-error">{error}</p>}
          {!error && loading && !result && <p className="roster-status">{t.commonLoading}</p>}
          {!error && result && !result.area && <p className="roster-status">{t.commonEmpty}</p>}
          {!error && result?.area && (
            <>
              <p className="roster-caption">{t.commonArea((result.areaM2 / 1e6).toFixed(2))}</p>
              {result.spots.length > 0 && (
                <>
                  <h3 className="common-subtitle">{t.bestSpots}</h3>
                  <ol className="spots" data-testid="spots">
                    {result.spots.map((s, n) => (
                      <li key={`${s.lon},${s.lat}`}>
                        <button type="button" className="spot" title={t.showSpot(n + 1)} onClick={() => onSpot({ lon: s.lon, lat: s.lat })}>
                          <span className="spot-numeral num">{n + 1}</span>
                          <span className="spot-text">
                            <span className="spot-name">{s.address?.label ?? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`}</span>
                            <span className="spot-times">
                              {s.seconds.map((sec, i) => `${LETTERS[i]} ${fmtMinutes(sec)} ${t.min}`).join(" · ")}
                            </span>
                          </span>
                          <span className="spot-score num">{Math.round(s.score)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
