import { describe, expect, it } from "vitest";
import { formatAt, isWhen, resolveWhen } from "./when";

// 2026-11-17 is a Tuesday. 07:30 UTC = 08:30 in Budapest (CET, UTC+1).
const tuesdayMorning = new Date("2026-11-17T07:30:00Z");

describe("resolveWhen", () => {
  it("any time sends no time", () => {
    expect(resolveWhen("any", tuesdayMorning)).toBeUndefined();
  });

  it("now is the wall clock in Budapest, not the browser's zone", () => {
    expect(resolveWhen("now", tuesdayMorning)).toBe("2026-11-17T08:30");
  });

  it("weekday 8:00 skips today once 8:00 has passed", () => {
    expect(resolveWhen("wd8", tuesdayMorning)).toBe("2026-11-18T08:00");
    expect(resolveWhen("wd8", new Date("2026-11-17T06:00:00Z"))).toBe("2026-11-17T08:00");
  });

  it("weekday 8:00 on a Friday evening is Monday", () => {
    expect(resolveWhen("wd8", new Date("2026-11-20T19:00:00Z"))).toBe("2026-11-23T08:00");
  });

  it("Sunday 20:00 is the coming Sunday", () => {
    expect(resolveWhen("su20", tuesdayMorning)).toBe("2026-11-22T20:00");
  });

  it("passes custom times through and rejects junk", () => {
    expect(resolveWhen("2026-12-24T18:00")).toBe("2026-12-24T18:00");
    expect(isWhen("2026-12-24T18:00")).toBe(true);
    expect(isWhen("tomorrow")).toBe(false);
  });

  it("crosses months and daylight saving correctly", () => {
    // 2027-03-28 03:00 CEST: DST starts that Sunday morning.
    expect(resolveWhen("now", new Date("2027-03-28T01:30:00Z"))).toBe("2027-03-28T03:30");
    expect(resolveWhen("su20", new Date("2026-11-29T20:30:00Z"))).toBe("2026-12-06T20:00");
  });
});

describe("formatAt", () => {
  it("names the weekday in the UI language", () => {
    expect(formatAt("2026-11-22T20:00", "en")).toBe("Sun 20:00");
    expect(formatAt("2026-11-18T08:00:00", "en")).toBe("Wed 08:00"); // API timestamps carry seconds
    expect(formatAt("2026-11-22T20:00", "hu")).toMatch(/^V\.? 20:00$/);
  });
});
