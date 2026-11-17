import type { ExpressionSpecification } from "maplibre-gl";
import type { CategoryId, Mode, Weights } from "./api/client";

/**
 * Accessibility scoring, mirrored from the API (Scoring.kt) and the database
 * (analytics.cell_scores). All three are tested against tests/fixtures/scoring-vectors.json.
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
 * The same score as a MapLibre expression over H3 tile properties (`walk_grocery`, ...),
 * so the GPU re-scores every hexagon when the weights change - no request, no new tiles.
 * A missing property means "not reachable within 30 minutes".
 */
export function scoreExpression(mode: Mode, weights: Weights, maxSeconds = MAX_SECONDS): ExpressionSpecification {
  const active = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0) as [CategoryId, number][];
  const total = active.reduce((sum, [, w]) => sum + w, 0);
  if (total === 0) return ["literal", 0] as unknown as ExpressionSpecification;
  const terms: ExpressionSpecification[] = active.map(([category, weight]) => [
    "*",
    weight,
    // coalesce, not to-number's fallback: ["to-number", null] is 0, which would score a
    // missing (unreachable) category as perfect.
    ["max", 0, ["-", 1, ["/", ["to-number", ["coalesce", ["get", `${mode}_${category}`], 1e9]], maxSeconds]]],
  ]);
  const sum: ExpressionSpecification = terms.length === 1 ? terms[0]! : ["+", ...terms] as ExpressionSpecification;
  return ["*", 100 / total, sum];
}

/** Sequential single-hue ramp (light -> dark = low -> high), stepped separately for dark mode. */
export const HEAT_RAMP = {
  // Ultramarine ink, the same hue as the app's rail; dark mode steps up towards light.
  light: ["#dfe3f5", "#a9b4e6", "#6c7fd2", "#3a51b8", "#1a2a8a"],
  dark: ["#1d2758", "#2d43a0", "#4a68d8", "#8ca3f2", "#d6deff"],
} as const;

export function heatColor(mode: Mode, weights: Weights, dark: boolean): ExpressionSpecification {
  const ramp = dark ? HEAT_RAMP.dark : HEAT_RAMP.light;
  return [
    "interpolate",
    ["linear"],
    scoreExpression(mode, weights),
    0, ramp[0], 25, ramp[1], 50, ramp[2], 75, ramp[3], 100, ramp[4],
  ];
}
