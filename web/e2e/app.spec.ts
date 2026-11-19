import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { GRID, link, mapReady, minutesFor, sourceFeatures } from "./support";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reach15.lang", "en"));
});

test("loads the map with the accessibility heatmap @mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Reach15" })).toBeVisible();
  await mapReady(page);
  await expect.poll(() => sourceFeatures(page, "r15-h3", "h3")).toBeGreaterThan(0);
  await expect(page.getByText("Click anywhere on the map")).toBeVisible();
});

test("search, pick a result, see score, nearest places and isochrones", async ({ page }) => {
  await page.goto("/");
  await mapReady(page);

  await page.getByRole("combobox").fill("andrassy 1");
  await page.getByRole("option", { name: /^Andrássy út 1 / }).click();

  await expect(page.getByTestId("place-title")).toHaveText("Andrássy út 1");
  await expect(page.getByTestId("score")).toHaveText(/^\d{1,3}$/);
  await expect(page.getByTestId("category-grocery")).toContainText("Corner Market");
  await expect.poll(() => sourceFeatures(page, "r15-iso")).toBeGreaterThanOrEqual(3);
  await expect(page).toHaveURL(/#p=47\.5018\d,19\.0526\d/); // address point of v1022, 5 decimals
});

test("keyboard-only search", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox");
  await search.focus();
  await page.keyboard.type("grid pharm");
  await expect(page.getByRole("option").first()).toContainText("Grid Pharmacy");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("place-card")).toBeVisible();
});

test("shared link restores the point and travel mode; bike respects oneway streets", async ({ page }) => {
  // Vertex 1005 -> grocery at 1000: 5 blocks west, but row 0 is oneway eastwards.
  await page.goto(link(GRID.v1005));
  await expect(page.getByTestId("place-card")).toBeVisible();
  expect(await minutesFor(page, "grocery")).toBe("6 min"); // walk: 5 blocks = 375 s

  await page.getByRole("radio", { name: /Bike/ }).click();
  await expect(page).toHaveURL(/m=bike/);
  await expect.poll(() => minutesFor(page, "grocery")).toBe("3 min"); // bike: 7-block detour = 168 s
});

test("changing the profile re-scores the heatmap without new tiles", async ({ page }) => {
  await page.goto("/");
  await mapReady(page);
  // The map scores every hexagon from /api/v1/cells and paints the scores as feature state.
  const heat = () => page.evaluate(() => window.__reach15!.heat);
  const scoreOf = () =>
    page.evaluate(() => {
      const map = window.__reach15!.map;
      const id = map.queryRenderedFeatures({ layers: ["r15-h3"] })[0]?.id;
      return id === undefined ? undefined : map.getFeatureState({ source: "r15-h3", sourceLayer: "h3", id }).score;
    });
  await expect.poll(async () => (await heat())?.cells).toBeGreaterThan(0);
  await expect.poll(scoreOf).toEqual(expect.any(Number));
  const before = await heat();
  const requests: string[] = [];
  page.on("request", (r) => /\/tiles\/h3\/|\/api\/v1\/cells/.test(r.url()) && requests.push(r.url()));

  await page.getByRole("radio", { name: "Family with kids" }).click();
  await expect.poll(heat).not.toEqual(before);
  expect((await heat())?.categories).toContain("kindergarten");
  expect(requests).toHaveLength(0);
});

test("points away from the street network show a helpful error", async ({ page }) => {
  await page.goto(link({ lat: 47.56, lon: 19.25 }));
  await expect(page.getByRole("alert")).toContainText("not near the street network");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("district roster is the first view; focusing a district fades the rest of the city", async ({ page }) => {
  await page.goto("/");
  await mapReady(page);
  const district = page.getByTestId("ranking").getByRole("button", { name: /Test District/ });
  await expect(district).toBeVisible();
  const opacity = () => page.evaluate(() => JSON.stringify(window.__reach15!.map.getPaintProperty("r15-h3", "fill-opacity")));

  await district.click();
  await expect(district).toHaveAttribute("aria-pressed", "true");
  await expect.poll(opacity).toContain("district_id");

  await district.click();
  await expect(district).toHaveAttribute("aria-pressed", "false");
  await expect.poll(opacity).not.toContain("district_id");
});

test("focusing a category recolours the map by that category alone", async ({ page }) => {
  await page.goto(link(GRID.v1044));
  await mapReady(page);
  await page.getByTestId("category-pharmacy").getByRole("button").click();
  const scored = () => page.evaluate(() => window.__reach15!.heat?.categories);
  await expect.poll(scored).toEqual(["pharmacy"]);
  await expect(page.getByRole("figure")).toContainText("Pharmacy");

  await page.getByRole("button", { name: "Show all categories" }).click();
  await expect.poll(scored).toContain("grocery");
});

test("switches language and theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Magyar" }).click();
  await expect(page.getByRole("radio", { name: /Gyalog/ })).toBeVisible();
  await page.getByRole("button", { name: "Sötét mód váltása" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("has no serious accessibility violations", async ({ page }) => {
  await page.goto(link(GRID.v1044));
  await expect(page.getByTestId("place-card")).toBeVisible();
  const results = await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("public transport: the tram reaches the far corner in 3 minutes on a weekday morning", async ({ page }) => {
  // Tram T1 leaves Corner (vertex 1000) every 10 minutes and reaches Far Corner (1099) in 3.
  await page.goto(link(GRID.v1000, "&m=transit&t=2026-11-17T08:00"));
  await expect(page.getByTestId("place-card")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transit/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => minutesFor(page, "pharmacy")).toBe("3 min"); // walking: 18 blocks = 23 min
  await expect(page.getByTestId("transit-note")).toContainText("Leaving Tue 08:00");
  await expect(page.getByRole("figure")).toContainText("transit is per place");
});

test("opening hours: on Sunday the only grocery is closed", async ({ page }) => {
  await page.goto(link(GRID.v1000));
  await expect.poll(() => minutesFor(page, "grocery")).toBe("1 min");
  await page.getByRole("radio", { name: "Pick a time" }).click();
  await page.getByLabel("Date and time in Budapest").fill("2026-11-22T12:00");
  await expect(page).toHaveURL(/t=2026-11-22T12:00/);
  await expect.poll(() => minutesFor(page, "grocery")).toBe("30+ min");
  await expect(page.getByTestId("category-pharmacy")).toContainText("open");
});

test("where should we live: two places outline their common ground and list spots", async ({ page }) => {
  await page.goto(link(GRID.v1044));
  await expect(page.getByTestId("place-card")).toBeVisible();
  const panel = page.getByTestId("common-ground");
  await panel.getByRole("button", { name: "Add the selected point" }).click();
  await panel.getByLabel("Travel mode to place A").selectOption("walk");
  await panel.getByLabel("Time limit to place A").selectOption("10");

  await page.getByRole("combobox", { name: "Search" }).fill("andrassy 1");
  await page.getByRole("option", { name: /^Andrássy út 1 / }).click();
  await expect(page.getByTestId("place-title")).toHaveText("Andrássy út 1");
  await panel.getByRole("button", { name: "Add the selected point" }).click();
  await panel.getByLabel("Travel mode to place B").selectOption("walk");
  await panel.getByLabel("Time limit to place B").selectOption("10");

  await expect(page).toHaveURL(/a=47\.\d+,19\.\d+,walk,10;47\.\d+,19\.\d+,walk,10/);
  await expect(panel).toContainText("Common area");
  await expect.poll(() => sourceFeatures(page, "r15-common")).toBeGreaterThan(0);
  await expect(page.locator(".map-marker.anchor")).toHaveCount(2);

  const spot = panel.getByTestId("spots").getByRole("button").first();
  await expect(spot).toContainText(/A \d+ min · B \d+ min/);
  await spot.click();
  await expect(page.getByTestId("place-card")).toBeVisible();
});
