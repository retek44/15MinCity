// k6 load test with latency budgets per endpoint. Fails (non-zero exit) when a budget is missed.
//
//   k6 run tests/perf/api.js                                   # fixture stack on :8088 (CI)
//   k6 run -e AREA=budapest -e BASE_URL=http://localhost:8088 tests/perf/api.js
import { check, group } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://localhost:8088";
const AREAS = {
  // synthetic 10x10 grid used in CI
  fixture: { south: 47.5, west: 19.05, north: 47.508, east: 19.062 },
  // central Budapest
  budapest: { south: 47.47, west: 19.02, north: 47.53, east: 19.11 },
};
const area = AREAS[__ENV.AREA || "fixture"];

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "15s", target: 8 },
        { duration: "45s", target: 8 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    "http_req_duration{endpoint:search}": ["p(95)<200"],
    "http_req_duration{endpoint:access}": ["p(95)<1000"],
    "http_req_duration{endpoint:isochrone}": ["p(95)<1500"],
    "http_req_duration{endpoint:ranking}": ["p(95)<800"],
    "http_req_duration{endpoint:tile}": ["p(95)<400"],
  },
};

const rand = (a, b) => a + Math.random() * (b - a);

function tile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return `${z}/${x}/${y}`;
}

const QUERIES = ["andrassy", "grid", "pharm", "deak ter", "nyugati", "vaci ut 1"];

export default function () {
  const lon = rand(area.west, area.east);
  const lat = rand(area.south, area.north);
  const mode = Math.random() < 0.7 ? "walk" : "bike";

  group("map browsing", () => {
    const r = http.get(`${BASE}/tiles/h3/${tile(lon, lat, 14)}`, { tags: { endpoint: "tile" } });
    check(r, { "tile 200/204": (res) => res.status === 200 || res.status === 204 });
  });

  group("search", () => {
    const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
    const r = http.get(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}`, { tags: { endpoint: "search" } });
    check(r, { "search 200": (res) => res.status === 200 });
  });

  group("select a point", () => {
    const access = http.get(`${BASE}/api/v1/access?lon=${lon}&lat=${lat}&mode=${mode}&persona=family`, {
      tags: { endpoint: "access" },
    });
    check(access, { "access 200": (res) => res.status === 200, "has score": (res) => res.json("score") >= 0 });
    const iso = http.get(`${BASE}/api/v1/isochrone?lon=${lon}&lat=${lat}&mode=${mode}`, {
      tags: { endpoint: "isochrone" },
    });
    check(iso, { "isochrone 200": (res) => res.status === 200 });
  });

  if (Math.random() < 0.2) {
    const r = http.get(`${BASE}/api/v1/districts/ranking?persona=student&mode=${mode}`, { tags: { endpoint: "ranking" } });
    check(r, { "ranking 200": (res) => res.status === 200 });
  }
}
