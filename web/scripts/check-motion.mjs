// Ad-hoc check of camera motion against a running stack: how far the map content jumps per frame
// when a place is clicked or cleared, and how long a persona change takes to a finished frame.
//   node web/scripts/check-motion.mjs   (BASE_URL defaults to http://localhost:8088)
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 760 }, deviceScaleFactor: 1.25 });
await page.goto(process.env.BASE_URL ?? "http://localhost:8088");
await page.waitForFunction(() => window.__reach15?.heat?.cells > 0 && window.__reach15.map.areTilesLoaded(), null, { timeout: 60_000 });
await page.evaluate(() => window.__reach15.map.jumpTo({ zoom: 13, center: [19.06, 47.5] }));
await page.waitForTimeout(1500);
const track = async (action) => {
  await page.evaluate(() => {
    const map = window.__reach15.map;
    window.__track = [];
    const t = performance.now();
    let last = t;
    const tick = () => {
      const now = performance.now();
      const p = map.project([19.07, 47.5]);
      window.__track.push({ t: Math.round(now - t), gap: Math.round(now - last), x: Math.round(p.x), y: Math.round(p.y) });
      last = now;
      if (now - t < 1200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(1400);
  const tr = await page.evaluate(() => window.__track);
  const moved = Math.max(...tr.map((f, i) => (i ? Math.hypot(f.x - tr[i - 1].x, f.y - tr[i - 1].y) : 0)));
  return { maxJumpPerFramePx: Math.round(moved), totalMovePx: Math.round(Math.hypot(tr.at(-1).x - tr[0].x, tr.at(-1).y - tr[0].y)), longestFrameMs: Math.max(...tr.map((f) => f.gap)) };
};
console.log("click near left edge:", await track(() => page.mouse.click(450, 400)));
console.log("close panel:", await track(() => page.getByRole("button", { name: "Clear selection" }).click()));
console.log("click under panel area:", await track(() => page.mouse.click(1300, 400)));
const times = [];
for (const i of [1, 2, 0, 3]) {
  times.push(await page.evaluate((i) => new Promise((resolve) => {
    const map = window.__reach15.map; const t = performance.now();
    map.once("idle", () => resolve(Math.round(performance.now() - t)));
    document.querySelectorAll(".chips [role=radio]")[i].click();
  }), i));
}
console.log("recolour (persona change to map idle):", times.join(", "), "ms");
await browser.close();
