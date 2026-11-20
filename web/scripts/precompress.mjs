// Writes .br and .gz next to every text asset in dist/, so Caddy serves them as they are
// (file_server precompressed) instead of compressing on every request: Brotli at its highest
// level is about 20 % smaller than the on-the-fly gzip for MapLibre, and costs nothing per request.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const TEXT = /\.(js|mjs|css|html|svg|json|txt|map)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT.test(name) && !name.endsWith(".map")) yield path;
  }
}

let raw = 0;
let br = 0;
for (const path of files(ROOT)) {
  const data = readFileSync(path);
  if (data.length < 1024) continue;
  const brotli = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  writeFileSync(`${path}.br`, brotli);
  writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
  raw += data.length;
  br += brotli.length;
}
console.log(`precompressed ${(raw / 1024).toFixed(0)} kB to ${(br / 1024).toFixed(0)} kB (brotli)`);
