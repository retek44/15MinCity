import { expression } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import vectors from "../../tests/fixtures/scoring-vectors.json";
import type { CategoryId, Weights } from "./api/client";
import { categoryScore, score, scoreExpression } from "./scoring";

type Case = { name: string; times: Record<string, number>; weights: Record<string, number>; score: number };
const cases = vectors.cases as unknown as Case[];
const digits = -Math.log10(vectors.tolerance);

/** Evaluates a MapLibre expression the way the renderer does, against one feature. */
function evaluate(expr: unknown, properties: Record<string, number>): number {
  const compiled = expression.createExpression(expr, "layers[0].paint.fill-opacity");
  if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom: 12 }, { type: "Polygon", properties } as never) as number;
}

describe("shared scoring vectors", () => {
  it.each(cases)("TypeScript: $name", (c) => {
    expect(score(c.times as Partial<Record<CategoryId, number>>, c.weights as Weights)).toBeCloseTo(c.score, digits);
  });

  it.each(cases)("MapLibre expression (walk): $name", (c) => {
    const properties = Object.fromEntries(Object.entries(c.times).map(([k, v]) => [`walk_${k}`, v]));
    expect(evaluate(scoreExpression("walk", c.weights as Weights), properties)).toBeCloseTo(c.score, digits);
  });

  it.each(cases)("MapLibre expression (bike): $name", (c) => {
    const properties = Object.fromEntries(Object.entries(c.times).map(([k, v]) => [`bike_${k}`, v]));
    expect(evaluate(scoreExpression("bike", c.weights as Weights), properties)).toBeCloseTo(c.score, digits);
  });
});

describe("scoring", () => {
  it("decays linearly and clamps", () => {
    expect(categoryScore(0)).toBe(1);
    expect(categoryScore(450)).toBe(0.5);
    expect(categoryScore(5000)).toBe(0);
    expect(categoryScore(null)).toBe(0);
  });

  it("the expression reads only the selected mode", () => {
    const expr = scoreExpression("bike", { grocery: 1 });
    expect(evaluate(expr, { walk_grocery: 0 })).toBe(0);
    expect(evaluate(expr, { bike_grocery: 0 })).toBe(100);
  });

  it("all-zero weights score 0 instead of dividing by zero", () => {
    expect(score({ grocery: 0 }, { grocery: 0 })).toBe(0);
    expect(evaluate(scoreExpression("walk", { grocery: 0 }), { walk_grocery: 0 })).toBe(0);
  });
});
