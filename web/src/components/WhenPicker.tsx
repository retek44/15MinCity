import type { Strings } from "../i18n";
import { PRESETS, resolveWhen, type When } from "../when";

interface Props {
  t: Strings;
  when: When;
  onWhen: (when: When) => void;
}

/**
 * "When?": presets as chips, plus a custom local time. A preset is resolved to a concrete time
 * when chosen ("Sunday 20:00" means the coming Sunday), so shared links mean the same moment.
 */
export function WhenPicker({ t, when, onWhen }: Props) {
  const custom = !PRESETS.includes(when as (typeof PRESETS)[number]);
  return (
    <section className="when" aria-label={t.when}>
      <div className="chips" role="radiogroup" aria-label={t.when}>
        {PRESETS.map((p) => (
          <button key={p} type="button" role="radio" className="chip" aria-checked={when === p} onClick={() => onWhen(p)}>
            {t.whenPresets[p]}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          className="chip"
          aria-checked={custom}
          onClick={() => onWhen(resolveWhen("wd8")!)}
        >
          {t.whenCustom}
        </button>
      </div>
      {custom && (
        <input
          className="when-input"
          type="datetime-local"
          aria-label={t.whenCustomLabel}
          value={when}
          onChange={(e) => e.target.value && onWhen(e.target.value.slice(0, 16))}
        />
      )}
      {when !== "any" && <p className="when-note">{t.whenNote}</p>}
    </section>
  );
}
