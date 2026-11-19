// Performance profile against a running stack: start-up, tiles, pan/zoom frame times,
// re-weighting, and clicking a place. Prints a JSON report.
//   node web/scripts/profile.mjs   (BASE_URL defaults to http://localhost:8088; HEADED=1 for a real GPU)
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:8088";
const browser = await chromium.launch({
  headless: !process.env.HEADED,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 760 }, deviceScaleFactor: Number(process.env.DPR ?? 1.25) });
const page = await context.newPage();
// page.on sees the map worker's tile requests too (a CDP page session does not).
const rows = [];
page.on("requestfinished", async (req) => {
  const res = await req.response();
  const sizes = await req.sizes().catch(() => ({ responseBodySize: 0, responseHeadersSize: 0 }));
  const t = req.timing();
  rows.push({ url: req.url(), bytes: sizes.responseBodySize + sizes.responseHeadersSize, ms: t.responseEnd, enc: (await res?.allHeaders())?.["content-encoding"], at: Date.now() - t0 });
});
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
const profiles = {};
const profileWhile = async (name, fn) => {
  await cdp.send("Profiler.start");
  const out = await fn();
  const { profile } = await cdp.send("Profiler.stop");
  profiles[name] = profile;
  return out;
};

await page.addInitScript(() => {
  window.__perf = { long: [], frames: [] };
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push({ start: e.startTime, dur: e.duration }))).observe({ type: "longtask", buffered: true });
  const tick = (t) => {
    window.__perf.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const report = {};
let t0 = Date.now();
await profileWhile("startup", async () => {
  t0 = Date.now();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__reach15?.map?.loaded() && window.__reach15.map.areTilesLoaded(), null, { timeout: 60_000 });
  report.startupMs = Date.now() - t0;
});
report.renderer = await page.evaluate(() => {
  const gl = window.__reach15.map.getCanvas().getContext("webgl2") ?? window.__reach15.map.getCanvas().getContext("webgl");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?";
});

const mark = () => page.evaluate(() => performance.now());
const window_ = async (from) =>
  page.evaluate((from) => {
    const f = window.__perf.frames.filter((t) => t >= from);
    const d = f.slice(1).map((t, i) => t - f[i]);
    d.sort((a, b) => a - b);
    const long = window.__perf.long.filter((l) => l.start >= from);
    return {
      frames: d.length,
      p50: +d[Math.floor(d.length * 0.5)]?.toFixed(1),
      p95: +d[Math.floor(d.length * 0.95)]?.toFixed(1),
      max: +d[d.length - 1]?.toFixed(1),
      over50ms: d.filter((x) => x > 50).length,
      longTasks: long.length,
      longTaskMs: Math.round(long.reduce((s, l) => s + l.dur, 0)),
      longestTask: Math.round(Math.max(0, ...long.map((l) => l.dur))),
    };
  }, from);
const settle = () => page.waitForFunction(() => !window.__reach15.map.isMoving() && window.__reach15.map.areTilesLoaded(), null, { timeout: 30_000 });

report.startup = await window_(0);

// Pan and zoom like a person: drag, wheel in, wheel out.
let from = await mark();
const box = await page.getByTestId("map").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 40; i++) await page.mouse.move(cx - i * 12, cy - i * 6);
await page.mouse.up();
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(400);
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(40);
}
const tPan = Date.now();
await settle();
report.panZoom = { ...(await window_(from)), settleAfterInputMs: Date.now() - tPan };

// Re-weight: switch personas (the whole heatmap recolours).
from = await mark();
const chips = page.locator(".chips [role=radio]");
const n = await chips.count();
const tw = Date.now();
for (let i = 0; i < Math.min(n, 4); i++) {
  await chips.nth(i).click();
  await page.waitForTimeout(150);
}
await settle();
report.reweight = { ...(await window_(from)), totalMs: Date.now() - tw, personas: Math.min(n, 4) };

// Click a place: place panel and reach planes.
from = await mark();
const tc = Date.now();
await profileWhile("click", async () => {
  await page.mouse.click(cx + 100, cy + 40);
  await page.getByTestId("place-card").waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-testid=place-card] [aria-busy=true]"), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await settle();
});
report.click = { ...(await window_(from)), readyMs: Date.now() - tc };

// Network summary.
const group = (pred) => {
  const g = rows.filter(pred);
  const ms = g.map((r) => r.ms).sort((a, b) => a - b);
  return { n: g.length, kB: Math.round(g.reduce((s, r) => s + r.bytes, 0) / 1024), slowestMs: Math.round(ms[ms.length - 1] ?? 0), enc: [...new Set(g.map((r) => r.enc))].join(",") };
};
report.network = {
  h3: group((r) => r.url.includes("/tiles/h3/")),
  basemap: group((r) => r.url.includes("/tiles/basemap/")),
  glyphsSprites: group((r) => r.url.includes("basemaps-assets")),
  api: group((r) => r.url.includes("/api/")),
  js: group((r) => r.url.endsWith(".js") || r.url.endsWith(".mjs")),
};
report.h3TilesByZoom = Object.fromEntries(
  Object.entries(Object.groupBy(rows.filter((r) => r.url.includes("/tiles/h3/")), (r) => r.url.split("/tiles/h3/")[1].split("/")[0])).map(([z, g]) => [z, `${g.length} tiles, ${Math.round(g.reduce((s, r) => s + r.bytes, 0) / 1024)} kB`]),
);
// Self time by function for each profiled phase: where the main thread goes.
const top = (profile) => {
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(0).padStart(5)} ms  ${k}`);
};
report.hot = Object.fromEntries(Object.entries(profiles).map(([k, p]) => [k, top(p)]));
console.log(JSON.stringify(report, null, 2));
await browser.close();
