// Records the README demo (docs/demo.gif) against a running stack with real Budapest data.
//
//   python tasks.py pipeline && python tasks.py app      # http://localhost:8088
//   node web/scripts/record-demo.mjs                       # writes docs/demo.webm
//   ffmpeg -i docs/demo.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" docs/demo.gif
import { chromium } from "@playwright/test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:8088";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");
const VIDEO_DIR = join(OUT, ".video");
const SIZE = { width: 1280, height: 760 };

const browser = await chromium.launch();
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
    return map && map.loaded() && map.areTilesLoaded();
  }, null, { timeout: 30_000 });

async function search(text, option) {
  const box = page.getByRole("combobox", { name: "Search" });
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: 60 });
  await page.getByRole("option", { name: option }).first().click();
}

// 1. The city-wide heatmap, then a place: score, minutes per category, 5/10/15-minute reach.
await page.goto(BASE);
await idle();
await pause(1500);
await search("deak ferenc ter", /Deák Ferenc tér 1052/);
await page.getByTestId("score").waitFor();
await idle();
await pause(2500);

// 2. Re-weight for a family: the whole map recolours without a tile request.
await page.getByRole("radio", { name: "Family with kids" }).click();
await pause(2000);

// 3. Public transport, leaving on a weekday at 8:00.
await page.getByRole("radio", { name: "Weekday 8:00" }).click();
await page.getByRole("radio", { name: /Transit/ }).click();
await page.getByTestId("transit-note").waitFor();
await idle();
await pause(1500);
// Zoom out: by tram and metro the 15-minute reach runs along the lines.
await page.evaluate(() => window.__reach15.map.easeTo({ zoom: 12.6, duration: 550 }));
await idle();
await pause(3000);

// 4. Sunday evening: closed shops drop out.
await page.getByRole("radio", { name: /Walk/ }).click();
await page.getByRole("radio", { name: "Sunday 20:00" }).click();
await pause(3000);
await page.getByRole("radio", { name: "Any time" }).click();

// 5. Where should we live? An office in Óbuda by transit, a school in Újbuda by bike.
const panel = page.getByTestId("common-ground");
await search("becsi ut 100", /Bécsi út 100 1034/);
await page.getByTestId("place-card").waitFor();
await pause(800);
await panel.getByRole("button", { name: "Add the selected point" }).click();
await panel.getByLabel("Time limit to place A").selectOption("30");
await search("bartok bela ut 50", /Bartók Béla út 50 1111/);
await page.getByTestId("place-card").waitFor();
await pause(800);
await panel.getByRole("button", { name: "Add the selected point" }).click();
await panel.getByLabel("Travel mode to place B").selectOption("bike");
await panel.getByLabel("Time limit to place B").selectOption("20");
await page.getByRole("button", { name: "Clear selection" }).click();
await panel.getByTestId("spots").waitFor({ timeout: 60_000 });
await idle();
await pause(3500);
await panel.getByTestId("spots").getByRole("button").first().click();
await page.getByTestId("score").waitFor();
await idle();
await pause(3500);

const video = page.video();
await context.close();
await browser.close();
mkdirSync(OUT, { recursive: true });
renameSync(await video.path(), join(OUT, "demo.webm"));
rmSync(VIDEO_DIR, { recursive: true, force: true });
console.log(`recorded ${join(OUT, "demo.webm")}`);
