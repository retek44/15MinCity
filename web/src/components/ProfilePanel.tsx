import type { CategoryId, Mode, Persona, Weights } from "../api/client";
import type { Strings } from "../i18n";
import { Icon } from "./Icon";

interface Props {
  t: Strings;
  mode: Mode;
  onMode: (mode: Mode) => void;
  personas: Persona[];
  personaId: string;
  onPersona: (persona: Persona) => void;
  weights: Weights;
  onWeights: (weights: Weights) => void;
}

const CATEGORY_ORDER: CategoryId[] = [
  "grocery", "transit", "pharmacy", "doctor", "park", "school", "kindergarten", "food", "gym", "library",
];

export function ProfilePanel({ t, mode, onMode, personas, personaId, onPersona, weights, onWeights }: Props) {
  return (
    <section className="controls" aria-label={t.persona}>
      <div className="segmented" role="radiogroup" aria-label={t.travelMode}>
        {(["walk", "bike"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onMode(m)}>
            <Icon name={m} />
            {t[m]}
          </button>
        ))}
      </div>

      <div className="chips" role="radiogroup" aria-label={t.persona}>
        {personas.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            className="chip"
            aria-checked={personaId === p.id}
            onClick={() => onPersona(p)}
          >
            {t.personas[p.id] ?? p.label}
          </button>
        ))}
      </div>

      <details className="weights">
        <summary>
          <Icon name="chevron" />
          {t.customize}
        </summary>
        <ul>
          {CATEGORY_ORDER.map((c) => {
            const value = weights[c] ?? 0;
            return (
              <li key={c}>
                <label htmlFor={`w-${c}`}>{t.categories[c]}</label>
                <input
                  id={`w-${c}`}
                  type="range"
                  min={0}
                  max={3}
                  step={1}
                  value={value}
                  aria-label={t.weightFor(t.categories[c])}
                  aria-valuetext={t.weightLabel(value)}
                  onChange={(e) => onWeights({ ...weights, [c]: Number(e.target.value) })}
                />
                <output htmlFor={`w-${c}`}>{value}</output>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
