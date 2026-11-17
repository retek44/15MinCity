import { describe, expect, it } from "vitest";
import { formatUrlState, parseUrlState } from "./urlState";

describe("url state", () => {
  it("round-trips", () => {
    const state = { point: { lon: 19.0546, lat: 47.4979 }, mode: "bike" as const, persona: "family" };
    expect(parseUrlState(formatUrlState(state))).toEqual(state);
  });

  it("keeps shared links readable", () => {
    expect(formatUrlState({ point: { lon: 19.0546, lat: 47.4979 }, mode: "bike" })).toBe("#p=47.49790,19.05460&m=bike");
  });

  it("omits defaults", () => {
    expect(formatUrlState({ mode: "walk", persona: "balanced" })).toBe("");
  });

  it.each([
    ["#p=abc,def", {}],
    ["#p=91,19", {}],
    ["#m=car", {}],
    ["#w=<script>", {}],
    ["", {}],
  ])("ignores invalid input %s", (hash, expected) => {
    expect(parseUrlState(hash)).toEqual(expected);
  });
});
