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
  const colorExpression = () =>
    page.evaluate(() => JSON.stringify(window.__reach15!.map.getPaintProperty("r15-h3", "fill-color")));

  const before = await colorExpression();
  const tileRequests: string[] = [];
  page.on("request", (r) => r.url().includes("/tiles/h3/") && tileRequests.push(r.url()));

  await page.getByRole("radio", { name: "Family with kids" }).click();
  await expect.poll(colorExpression).not.toBe(before);
  expect(await colorExpression()).toContain("walk_kindergarten");
  expect(tileRequests).toHaveLength(0);
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
  const color = () => page.evaluate(() => JSON.stringify(window.__reach15!.map.getPaintProperty("r15-h3", "fill-color")));
  await expect.poll(color).toContain("walk_pharmacy");
  expect(await color()).not.toContain("walk_grocery");
  await expect(page.getByRole("figure")).toContainText("Pharmacy");

  await page.getByRole("button", { name: "Show all categories" }).click();
  await expect.poll(color).toContain("walk_grocery");
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
