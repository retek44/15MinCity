import type { DistrictScore } from "../api/client";
import { districtLabel } from "../districts";
import type { Strings } from "../i18n";

interface Props {
  t: Strings;
  ranking?: DistrictScore[];
  loading: boolean;
  focusedId?: number;
  onFocus: (district: DistrictScore | undefined) => void;
}

const pct = (v: number) => `${Math.min(100, Math.max(0, v))}%`;

/**
 * The 23 districts as a finite ranked roster with fixed furniture per row: numeral, name,
 * mean score, and the spread of its cells (p25-p75 band, mean tick) on one 0-100 scale.
 * Pressing a row frames that district on the map and fades the rest of the city.
 */
export function DistrictRoster({ t, ranking, loading, focusedId, onFocus }: Props) {
  return (
    <section className="roster" aria-labelledby="roster-title" aria-busy={loading} data-testid="ranking">
      <h2 id="roster-title">{t.districts}</h2>
      <p className="roster-caption">{t.rosterCaption}</p>
      {!ranking && loading && <p className="roster-status">{t.rosterLoading}</p>}
      {ranking?.length === 0 && <p className="roster-status">{t.rosterEmpty}</p>}
      <ol>
        {ranking?.map((d) => {
          const label = districtLabel(d.name);
          const pressed = d.districtId === focusedId;
          return (
            <li key={d.districtId}>
              <button
                type="button"
                className="district"
                aria-pressed={pressed}
                title={t.focusDistrict(label.name ?? label.osmName)}
                onClick={() => onFocus(pressed ? undefined : d)}
              >
                <span className="district-numeral num">
                  <span className="visually-hidden">{t.rank(d.rank)}, </span>
                  {label.numeral ?? d.rank}
                </span>
                <span>
                  {label.name ? (
                    <span className="district-name">{label.name}</span>
                  ) : (
                    <span className="district-name unnamed">{label.numeral ? t.numberedDistrict(label.numeral) : label.osmName}</span>
                  )}
                  <span className="spread" aria-hidden="true">
                    <span className="spread-band" style={{ left: pct(d.p25), width: pct(d.p75 - d.p25) }} />
                    <span className="spread-mean" style={{ left: pct(d.score) }} />
                  </span>
                </span>
                <span className="district-score num">{Math.round(d.score)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
