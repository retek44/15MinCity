// Records the README demo (docs/demo.gif) against a running stack with real Budapest data.
//
//   python tasks.py pipeline && python tasks.py app      # http://localhost:8088
//   node web/scripts/record-demo.mjs                       # writes docs/demo.webm
//   ffmpeg -ss 0.75 -i docs/demo.webm -vf "fps=7,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/demo.gif
import { chromium } from "@playwright/test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:8088";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");
const VIDEO_DIR = join(OUT, ".video");
const SIZE = { width: 1280, height: 760 };

// The real GPU where there is one: smoother frames than the software renderer.
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VIDEO_DIR, size: SIZE }, locale: "en-GB" });
await context.addInitScript(() => {
  localStorage.setItem("reach15.lang", "en");
  localStorage.setItem("reach15.theme", "light");
});
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
const idle = () =>
  page.waitForFunction(() => {
    const map = window.__reach15?.map;
    // heat: the hexagon scores are painted (travel times loaded from /api/v1/cells).
    return map && map.loaded() && map.areTilesLoaded() && window.__reach15.heat?.cells > 0;
  }, null, { timeout: 30_000 });

async function search(text, option) {
  const box = page.getByRole("combobox", { name: "Search" });
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: 60 });
  await page.getByRole("option", { name: option }).first().click();
}

// 1. The city-wide heatmap, then a place: score, minutes per category, 5/10/15-minute reach.
//    Pin it to compare with the flats viewed later.
await page.goto(BASE);
await idle();
await pause(1500);
await search("deak ferenc ter", /Deák Ferenc tér 1052/);
await page.getByTestId("score").waitFor();
await idle();
await pause(2000);
await page.getByTestId("compare-add").click();
await pause(600);

// 2. Re-weight for a family: the whole map recolours without a tile request.
await page.getByRole("radio", { name: "Family with kids" }).click();
await pause(1800);

// 3. Public transport, leaving on a weekday at 8:00; the heatmap switches to transit too.
await page.getByRole("radio", { name: "Weekday 8:00" }).click();
await page.getByRole("radio", { name: /Transit/ }).click();
await page.getByTestId("transit-note").waitFor();
await idle();
await pause(1200);
// Zoom out: by tram and metro the 15-minute reach runs along the lines.
await page.evaluate(() => window.__reach15.map.easeTo({ zoom: 12.4, duration: 550 }));
await idle();
await pause(2500);

// 4. Christmas morning on foot: holiday opening hours, and the holiday is named.
await page.getByRole("radio", { name: /Walk/ }).click();
await page.getByRole("radio", { name: "Pick a time" }).click();
await page.getByLabel("Date and time in Budapest").fill("2026-12-25T11:00");
await page.getByTestId("holiday-note").waitFor();
await idle();
await pause(2800);
await page.getByRole("radio", { name: "Any time" }).click();

// 5. By bike, city-wide: the Buda hills cost minutes (elevation model), flat Pest does not.
await page.getByRole("button", { name: "Clear selection" }).click();
await page.getByRole("radio", { name: /Bike/ }).click();
await page.locator('[data-testid="compare"][aria-busy="false"]').waitFor();
await page.evaluate(() => window.__reach15.map.easeTo({ center: [19.02, 47.505], zoom: 11.6, duration: 650 }));
await idle();
await pause(3000);

// 5b. Step-free in the Buda hills: steps close streets to a pushchair. "Better nearby" points to
//     higher-scoring hexagons a short walk away.
// Alma utca 8: 58 on foot, 21 step-free (family profile): the way down to the shops is steps.
await search("alma utca 8", /Alma utca 8 1122/);
await page.getByTestId("place-card").waitFor();
await page.getByRole("radio", { name: /Walk/ }).click();
await idle();
await pause(1200);
await page.getByRole("checkbox", { name: /Step-free/ }).check();
await page.getByTestId("stepfree-note").waitFor();
await idle();
await pause(1800);
const nearby = page.getByTestId("nearby");
await nearby.waitFor();
await nearby.scrollIntoViewIfNeeded();
await pause(1800);
await nearby.getByRole("button").first().click();
await page.getByTestId("score").waitFor();
await idle();
await pause(2200);
await page.getByRole("checkbox", { name: /Step-free/ }).uncheck();

// 6. Two flats in view: pin both to compare, and ask where the household could live
//    (an office in Óbuda by transit, a school in Újbuda by bike).
const panel = page.getByTestId("common-ground");
await search("becsi ut 100", /Bécsi út 100 1034/);
await page.getByTestId("place-card").waitFor();
await pause(700);
await page.getByTestId("compare-add").click();
await panel.getByRole("button", { name: "Add the selected point" }).click();
await panel.getByLabel("Time limit to place A").selectOption("30");
await search("bartok bela ut 50", /Bartók Béla út 50 1111/);
await page.getByTestId("place-card").waitFor();
await pause(700);
await page.getByTestId("compare-add").click();
await page.getByTestId("compare").locator("td.best").first().waitFor();
await page.getByTestId("compare").scrollIntoViewIfNeeded();
await pause(3200);
await panel.getByRole("button", { name: "Add the selected point" }).click();
await panel.getByLabel("Travel mode to place B").selectOption("bike");
await panel.getByLabel("Time limit to place B").selectOption("20");
await page.getByRole("button", { name: "Clear selection" }).click();
await panel.getByTestId("spots").waitFor({ timeout: 60_000 });
await panel.getByTestId("spots").scrollIntoViewIfNeeded();
await idle();
await pause(3200);
await panel.getByTestId("spots").getByRole("button").first().click();
await page.getByTestId("score").waitFor();
await idle();
await pause(3000);

const video = page.video();
await context.close();
await browser.close();
mkdirSync(OUT, { recursive: true });
renameSync(await video.path(), join(OUT, "demo.webm"));
rmSync(VIDEO_DIR, { recursive: true, force: true });
console.log(`recorded ${join(OUT, "demo.webm")}`);
