import type { ExpressionSpecification } from "maplibre-gl";
import type { CategoryId, CellTimes, Mode, Weights } from "./api/client";

/**
 * Accessibility scoring, mirrored from the API (Scoring.kt) and the database
 * (analytics.cell_scores). All three are tested against tests/fixtures/scoring-vectors.json.
 * The heatmap's travel times come from /api/v1/cells.
 */
export const MAX_SECONDS = 900;

export function categoryScore(seconds: number | null | undefined, maxSeconds = MAX_SECONDS): number {
  if (seconds === null || seconds === undefined) return 0;
  return Math.min(1, Math.max(0, 1 - seconds / maxSeconds));
}

export function score(times: Partial<Record<CategoryId, number | null>>, weights: Weights): number {
  const active = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0) as [CategoryId, number][];
  const total = active.reduce((sum, [, w]) => sum + w, 0);
  if (total === 0) return 0;
  return (100 * active.reduce((sum, [c, w]) => sum + w * categoryScore(times[c]), 0)) / total;
}

/**
 * Scores of every heatmap hexagon, in the order of `cells.h3`. Plain arithmetic over typed
 * columns: about a millisecond for Budapest's 8,500 hexagons. The map takes the scores as
 * feature state, so re-weighting repaints without re-reading a single tile.
 */
export function cellScores(cells: CellTimes, mode: Mode, weights: Weights): Float32Array {
  const out = new Float32Array(cells.h3.length);
  const columns = cells[mode];
  const active = cells.categories
    .map((c, i) => ({ weight: weights[c as CategoryId] ?? 0, times: columns[i] ?? [] }))
    .filter((c) => c.weight > 0);
  // Every weighted category counts, as in score(): one without a column scores 0.
  const total = Object.values(weights).reduce((sum: number, w) => sum + Math.max(0, w ?? 0), 0);
  if (total === 0) return out;
  for (const { weight, times } of active) {
    for (let i = 0; i < out.length; i++) out[i]! += weight * categoryScore(times[i]);
  }
  for (let i = 0; i < out.length; i++) out[i] = (100 * out[i]!) / total;
  return out;
}

/** Sequential single-hue ramp (light -> dark = low -> high), stepped separately for dark mode. */
export const HEAT_RAMP = {
  // Ultramarine ink, the same hue as the app's rail; dark mode steps up towards light.
  light: ["#dfe3f5", "#a9b4e6", "#6c7fd2", "#3a51b8", "#1a2a8a"],
  dark: ["#1d2758", "#2d43a0", "#4a68d8", "#8ca3f2", "#d6deff"],
} as const;

/** Fill colour of a hexagon from its score (feature state, set by the map). */
export function heatColor(dark: boolean): ExpressionSpecification {
  const ramp = dark ? HEAT_RAMP.dark : HEAT_RAMP.light;
  return [
    "interpolate",
    ["linear"],
    ["number", ["feature-state", "score"], 0],
    0, ramp[0], 25, ramp[1], 50, ramp[2], 75, ramp[3], 100, ramp[4],
  ];
}
