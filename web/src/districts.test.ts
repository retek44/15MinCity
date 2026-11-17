import { describe, expect, it } from "vitest";
import { districtFromPostcode, districtLabel, districtLine } from "./districts";

describe("districts", () => {
  it.each([
    ["1065 Budapest", "VI. kerület"],
    ["1011 Budapest", "I. kerület"],
    ["1239 Budapest", "XXIII. kerület"],
    ["2000 Szentendre", null],
    ["1245 Budapest", null], // post office boxes, not a district
    [undefined, null],
  ])("reads the district from the postcode %s", (text, expected) => {
    expect(districtFromPostcode(text)).toBe(expected);
  });

  it("names districts by official name where one exists", () => {
    expect(districtLabel("VII. kerület")).toEqual({ numeral: "VII", name: "Erzsébetváros", osmName: "VII. kerület" });
    expect(districtLabel("XIII. kerület").name).toBeNull();
    expect(districtLine("VI. kerület")).toBe("VI. kerület · Terézváros");
    expect(districtLine("XIII. kerület")).toBe("XIII. kerület");
  });
});
