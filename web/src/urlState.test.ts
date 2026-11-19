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

  it("round-trips transit, a time and the places to reach", () => {
    const state = {
      mode: "transit" as const,
      when: "su20",
      anchors: [
        { lon: 19.0402, lat: 47.4979, mode: "transit" as const, minutes: 30 },
        { lon: 19.07, lat: 47.51, mode: "bike" as const, minutes: 15 },
      ],
    };
    expect(parseUrlState(formatUrlState(state))).toEqual(state);
    expect(formatUrlState(state)).toBe("#m=transit&t=su20&a=47.49790,19.04020,transit,30;47.51000,19.07000,bike,15");
  });

  it("keeps a custom time readable", () => {
    expect(formatUrlState({ when: "2026-12-24T18:00" })).toBe("#t=2026-12-24T18:00");
  });

  it("drops invalid places but keeps the valid ones", () => {
    expect(parseUrlState("#a=47.5,19.04,walk,10;47.5,19.04,car,10;47.5,19.04,walk,90").anchors).toEqual([
      { lat: 47.5, lon: 19.04, mode: "walk", minutes: 10 },
    ]);
  });

  it("round-trips up to three compared places and drops the rest", () => {
    const compare = [
      { lat: 47.51, lon: 19.06 },
      { lat: 47.48, lon: 19.02 },
      { lat: 47.5, lon: 19.1 },
    ];
    const hash = formatUrlState({ compare });
    expect(hash).toBe("#c=47.51000,19.06000;47.48000,19.02000;47.50000,19.10000");
    expect(parseUrlState(hash).compare).toEqual(compare);
    expect(parseUrlState(`${hash};47.4,19.0`).compare).toHaveLength(3);
    expect(parseUrlState("#c=47.5,19.0;nope;95,19").compare).toEqual([{ lat: 47.5, lon: 19 }]);
  });

  it("omits defaults", () => {
    expect(formatUrlState({ mode: "walk", persona: "balanced", when: "any", anchors: [] })).toBe("");
  });

  it.each([
    ["#p=abc,def", {}],
    ["#p=91,19", {}],
    ["#m=car", {}],
    ["#w=<script>", {}],
    ["#t=yesterday", {}],
    ["#a=x", {}],
    ["#c=x", {}],
    ["", {}],
  ])("ignores invalid input %s", (hash, expected) => {
    expect(parseUrlState(hash)).toEqual(expected);
  });
});
