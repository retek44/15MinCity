import { expect, type Page } from "@playwright/test";

/**
 * Synthetic grid fixture (tests/fixtures/osm/grid.osm): vertex (row, col) sits 100 m apart;
 * one block is 75 s on foot and 24 s by bike; row 0 is oneway eastwards.
 */
export const GRID = {
  v1000: { lat: 47.5, lon: 19.05 },
  v1005: { lat: 47.5, lon: 19.0566363 },
  v1022: { lat: 47.5017989, lon: 19.0526545 },
  v1044: { lat: 47.5035978, lon: 19.055309 },
  /** Far corner: 18 blocks from the market; the school (3101) is up the steps north of it. */
  v1099: { lat: 47.508095, lon: 19.0619453 },
};

export const link = (p: { lat: number; lon: number }, extra = "") => `/#p=${p.lat},${p.lon}${extra}`;

/** Waits until MapLibre has loaded the style and the accessibility overlay. */
export async function mapReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__reach15?.map.isStyleLoaded() && window.__reach15.map.getLayer("r15-h3"))))
    .toBe(true);
}

/** Number of features currently in an overlay source (asserting map state, not pixels). */
export function sourceFeatures(page: Page, source: string, sourceLayer?: string) {
  return page.evaluate(
    ([s, l]) => window.__reach15!.map.querySourceFeatures(s!, l ? { sourceLayer: l } : undefined).length,
    [source, sourceLayer] as const,
  );
}

export async function minutesFor(page: Page, category: string) {
  return page.getByTestId(`category-${category}`).locator(".meter-value").innerText();
}
