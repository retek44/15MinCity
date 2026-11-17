// Ad-hoc responsiveness check against a running stack: hover outline latency under a fast
// pointer, time from click to the selected outline, and camera move duration.
//   node web/scripts/check-hover.mjs   (BASE_URL defaults to http://localhost:8088)
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:8088";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await page.goto(BASE);
await page.waitForFunction(() => window.__reach15?.map?.loaded() && window.__reach15.map.areTilesLoaded(), null, { timeout: 30_000 });

// Fast sweep: one mousemove per frame across the map, checking the outline every frame.
const box = await page.getByTestId("map").boundingBox();
let hits = 0;
let lagging = 0;
for (let i = 0; i < 60; i++) {
  const x = box.x + 120 + i * 9;
  const y = box.y + 220 + Math.sin(i / 5) * 80;
  await page.mouse.move(x, y);
  const ok = await page.evaluate(
    ([px, py]) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const map = window.__reach15.map;
          const f = map.queryRenderedFeatures([px, py], { layers: ["r15-h3"] })[0];
          if (!f) return resolve(null);
          resolve(map.getFeatureState({ source: "r15-h3", sourceLayer: "h3", id: f.id }).hover === true);
        }),
      ),
    [x - box.x, y - box.y],
  );
  if (ok === null) continue;
  hits++;
  if (!ok) lagging++;
}
console.log(`hover: outline on the hexagon under the cursor ${hits - lagging}/${hits} frames`);

// Click: time until the selected hexagon is outlined.
const lngLat = await page.evaluate(() => window.__reach15.map.unproject([400, 300]).toArray());
const t0 = Date.now();
await page.mouse.click(box.x + 400, box.y + 300);
await page.waitForFunction(
  (ll) => {
    const map = window.__reach15.map;
    const f = map.queryRenderedFeatures(map.project(ll), { layers: ["r15-h3"] })[0];
    return f && map.getFeatureState({ source: "r15-h3", sourceLayer: "h3", id: f.id }).selected === true;
  },
  lngLat,
  { timeout: 10_000 },
);
console.log(`click: selected outline after ${Date.now() - t0} ms`);
await page.getByTestId("place-card").waitFor();
console.log(`click: place panel loaded after ${Date.now() - t0} ms`);

// Search result: camera move duration.
await page.getByRole("combobox", { name: "Search" }).fill("deak ferenc ter");
await page.getByRole("option").first().waitFor();
const t1 = Date.now();
await page.getByRole("option").first().click();
await page.waitForFunction(() => window.__reach15.map.isMoving(), null, { timeout: 5_000 }).catch(() => {});
await page.waitForFunction(() => !window.__reach15.map.isMoving(), null, { timeout: 10_000 });
console.log(`search: camera settled after ${Date.now() - t1} ms`);
await browser.close();
