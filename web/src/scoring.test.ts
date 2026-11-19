import { describe, expect, it } from "vitest";
import vectors from "../../tests/fixtures/scoring-vectors.json";
import type { CategoryId, CellTimes, Weights } from "./api/client";
import { categoryScore, cellScores, heatColor, score } from "./scoring";

type Case = { name: string; times: Record<string, number>; weights: Record<string, number>; score: number };
const cases = vectors.cases as unknown as Case[];
const digits = -Math.log10(vectors.tolerance);

/** A one-hexagon CellTimes with the case's times as walking and doubled as cycling. */
function cell(times: Record<string, number>): CellTimes {
  const categories = Object.keys(times);
  return {
    categories,
    h3: ["89000000000ffff"],
    walk: categories.map((c) => [times[c]!]),
    bike: categories.map((c) => [times[c]! * 2]),
    transit: categories.map((c) => [times[c]! / 2]),
  };
}

describe("shared scoring vectors", () => {
  it.each(cases)("TypeScript: $name", (c) => {
    expect(score(c.times as Partial<Record<CategoryId, number>>, c.weights as Weights)).toBeCloseTo(c.score, digits);
  });

  it.each(cases)("heatmap cell scores: $name", (c) => {
    expect(cellScores(cell(c.times), "walk", c.weights as Weights)[0]).toBeCloseTo(c.score, 3);
  });
});

describe("scoring", () => {
  it("decays linearly and clamps", () => {
    expect(categoryScore(0)).toBe(1);
    expect(categoryScore(450)).toBe(0.5);
    expect(categoryScore(5000)).toBe(0);
    expect(categoryScore(null)).toBe(0);
  });

  it("cell scores read only the selected mode", () => {
    const cells = cell({ grocery: 450 });
    expect(cellScores(cells, "walk", { grocery: 1 })[0]).toBeCloseTo(50);
    expect(cellScores(cells, "bike", { grocery: 1 })[0]).toBeCloseTo(0);
  });

  it("an unreachable category scores 0, not a perfect 100", () => {
    const cells: CellTimes = { categories: ["grocery", "park"], h3: ["a", "b"], walk: [[0, null], [null, 0]], bike: [[], []], transit: [[], []] };
    expect([...cellScores(cells, "walk", { grocery: 1, park: 1 })]).toEqual([50, 50]);
    expect([...cellScores(cells, "walk", { grocery: 1 })]).toEqual([100, 0]);
  });

  it("all-zero weights score 0 instead of dividing by zero", () => {
    expect(score({ grocery: 0 }, { grocery: 0 })).toBe(0);
    expect([...cellScores(cell({ grocery: 0 }), "walk", { grocery: 0 })]).toEqual([0]);
  });

  it("the heat colour reads the score from feature state, not tile properties", () => {
    const expr = JSON.stringify(heatColor(false));
    expect(expr).toContain('["feature-state","score"]');
    expect(expr).not.toContain('"get"');
  });
});

describe("public transport heatmap", () => {
  it("scores from the transit column", () => {
    const cells = cell({ grocery: 900 });
    expect(cellScores(cells, "walk", { grocery: 1 })[0]).toBeCloseTo(0);
    expect(cellScores(cells, "transit", { grocery: 1 })[0]).toBeCloseTo(50);
  });
});
