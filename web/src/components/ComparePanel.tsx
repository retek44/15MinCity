import type { AccessResponse, CategoryId, Weights } from "../api/client";
import type { Strings } from "../i18n";
import { Icon } from "./Icon";

export interface Pinned {
  lon: number;
  lat: number;
}

/** One pinned place and its answer (undefined while loading or on error). */
export interface Compared extends Pinned {
  access?: AccessResponse;
  /** The address, kept from an earlier answer while a new one loads. */
  label?: string;
  error?: string;
}

interface Props {
  t: Strings;
  places: Compared[];
  weights: Weights;
  onRemove: (index: number) => void;
  onClear: () => void;
  onShow: (place: Pinned) => void;
}

export const MAX_COMPARED = 3;

const CATEGORY_ORDER: CategoryId[] = [
  "grocery", "transit", "pharmacy", "doctor", "park", "school", "kindergarten", "food", "gym", "library",
];
const fmtMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
const labelOf = (p: Compared) => p.access?.address?.label ?? p.label ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

/** Index of the best value of a row, or -1 on a tie or when fewer than two are known. */
function bestOf(values: (number | undefined)[], better: (a: number, b: number) => boolean): number {
  const known = values.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => x[0] !== undefined);
  if (known.length < 2) return -1;
  const best = known.reduce((a, b) => (better(b[0], a[0]) ? b : a));
  return known.filter(([v]) => v === best[0]).length > 1 ? -1 : best[1];
}

/**
 * Compare places: up to three pinned addresses (the flats being viewed) side by side, for the
 * current mode, profile and time. The score row first, then the minutes to the nearest place
 * of every weighted category; the best of each row is marked.
 */
export function ComparePanel({ t, places, weights, onRemove, onClear, onShow }: Props) {
  if (places.length === 0) return null;
  const categories = CATEGORY_ORDER.filter((c) => (weights[c] ?? 0) > 0);
  const minutes = (place: Compared, c: CategoryId) => {
    const s = place.access?.categories.find((x) => x.category === c)?.seconds;
    return s === null || s === undefined ? undefined : fmtMinutes(s);
  };
  const scores = places.map((p) => (p.access ? Math.round(p.access.score) : undefined));
  const loading = places.some((p) => !p.access && !p.error);

  return (
    <section className="compare" aria-labelledby="compare-title" aria-busy={loading} data-testid="compare">
      <h2 id="compare-title">{t.compareTitle}</h2>
      <ol className="compared">
        {places.map((p, i) => (
          <li key={`${p.lon},${p.lat}`} className="compared-place">
            <span className="compare-badge num" aria-hidden="true">
              {i + 1}
            </span>
            <button type="button" className="compare-place" title={t.compareShow(labelOf(p))} onClick={() => onShow(p)}>
              {labelOf(p)}
            </button>
            <button
              type="button"
              className="icon-button rail-icon compare-remove"
              aria-label={t.compareRemove(labelOf(p))}
              onClick={() => onRemove(i)}
            >
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ol>
      <table className="compare-table">
        <caption className="visually-hidden">{t.compareCaption}</caption>
        <thead>
          <tr>
            <td />
            {places.map((p, i) => (
              <th key={`${p.lon},${p.lat}`} scope="col">
                <span className="compare-badge num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="visually-hidden">{labelOf(p)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row
            t={t}
            label={t.compareScore}
            values={scores}
            best={bestOf(scores, (a, b) => a > b)}
            format={(v) => String(v)}
            errors={places.map((p) => p.error)}
            className="compare-score"
          />
          {categories.map((c) => {
            const values = places.map((p) => minutes(p, c));
            return (
              <Row
                key={c}
                t={t}
                label={t.categories[c]}
                values={values}
                best={bestOf(values, (a, b) => a < b)}
                format={(v) => `${v} ${t.min}`}
                missing={places.map((p) => Boolean(p.access))}
              />
            );
          })}
        </tbody>
      </table>
      <div className="common-actions">
        <button type="button" className="rail-button" onClick={onClear}>
          {t.compareClear}
        </button>
      </div>
    </section>
  );
}

function Row(props: {
  t: Strings;
  label: string;
  values: (number | undefined)[];
  best: number;
  format: (value: number) => string;
  /** Per place: the answer arrived, so a missing value means "not within 30 minutes". */
  missing?: boolean[];
  errors?: (string | undefined)[];
  className?: string;
}) {
  const { t, label, values, best, format, missing, errors, className } = props;
  return (
    <tr className={className}>
      <th scope="row">{label}</th>
      {values.map((v, i) => (
        <td key={i} className={i === best ? "best" : undefined}>
          {errors?.[i] ? (
            <span title={errors[i]}>!</span>
          ) : v !== undefined ? (
            <>
              {format(v)}
              {i === best && <span className="visually-hidden"> ({t.compareBest})</span>}
            </>
          ) : missing?.[i] ? (
            <span title={t.compareFar}>–</span>
          ) : (
            <span className="skeleton compare-skeleton" />
          )}
        </td>
      ))}
    </tr>
  );
}
