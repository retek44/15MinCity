# Reach15: a 15-minute city analyser for Budapest

Reach15 shows what you can reach from any point in Budapest within a few minutes on foot, by bike or
by public transport: groceries, pharmacies, doctors, schools, parks, transit stops. It scores every
neighbourhood, ranks the districts, lets you re-weight the score for how you live (family, student,
senior...), checks what is actually open at a given time, and finds where a household should live
so that everyone's office, school or family is within reach.

![Reach15 demo: heatmap, a place's score and isochrones, public transport, holidays, hill-aware cycling, step-free walking, better nearby, compare and "where should we live?"](docs/demo.gif)

It is built on OpenStreetMap data, PostgreSQL/PostGIS, pgRouting and H3, a Kotlin/Spring Boot API,
Martin vector tiles and a React + MapLibre GL front end. Tests are a first-class part of the design:
every layer has its own suite, and the CI/CD pipeline gates both code releases and weekly data releases.

> **Status:** phases 1–8 are done (data, API, tiles, front end, delivery, extensions, depth, access). See the [roadmap](#roadmap).

## Architecture

```
   Geofabrik (weekly) + BKK GTFS                   Protomaps daily build
                   │                                        │ pmtiles extract (Budapest)
                   ▼                                        ▼
  etl (Python) ─ osmium ─ osm2pgsql flex (Lua) ─►  PostgreSQL 17                data/basemap.pmtiles
         GTFS import, opening_hours parser
                 build graph, precompute,          PostGIS · pgRouting · h3-pg          │
                 quality gates, drift gate         pg_trgm · unaccent · pgTAP           │
                                                      │              │                  │
                                         JdbcClient   │              │ SQL function     │
                                                      ▼              ▼ source           ▼
                                  api (Kotlin, Spring Boot)       Martin (tiles: h3 + basemap)
                                  /api/v1/* · OpenAPI · Caffeine        │
                                  RAPTOR over an in-memory timetable    │
                                                      │                 │
                                                      └──── web (Caddy) ┘  /api/*, /tiles/*, SPA
                                                               │
                                              React 19 · MapLibre GL · TanStack Query
```

| Component | Stack | Notes |
|---|---|---|
| `db/` | PostgreSQL 17, PostGIS 3, pgRouting 4, h3-pg, pgTAP | Flyway `V*` schema and `R__*` repeatable SQL functions |
| `etl/` | Python 3.13, osm2pgsql 2 (flex Lua), osmium, pmtiles CLI, rasterio | download, import, GTFS import, opening-hours parser, elevation (DEM), build, quality gates, score drift, fixture generator |
| `api/` | Kotlin 2.4, Spring Boot 4, Jackson 3, springdoc, Caffeine | thin layer over SQL functions plus RAPTOR (public transport, per place and as a heatmap batch job); RFC 9457 problem details |
| `tiles/` | Martin | `analytics.h3_tiles(z, x, y)` function source + PMTiles basemap |
| `web/` | React 19, Vite, MapLibre GL 6, @protomaps/basemaps, openapi-typescript | scores every hexagon in the browser, painted through feature state |
| `deploy/` | Docker Compose, Caddy | blue/green for the app, rename-swap for the data |

### API

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/search?q=` | addresses, streets and places; accent- and abbreviation-insensitive (`andrassy u 1`, `nyugati pu`) |
| `GET /api/v1/reverse?lon=&lat=` | nearest address |
| `GET /api/v1/access?lon=&lat=&mode=&persona=&weights=&at=` | score 0–100, travel time and nearest place per category; `mode=transit` rides BKK's timetable, `at` (local time) keeps only places open then, and names a public holiday |
| `GET /api/v1/isochrone?lon=&lat=&mode=&minutes=5,10,15&at=` | GeoJSON multipolygons (walk, step-free, bike, or transit leaving at `at`) |
| `GET /api/v1/nearby?lon=&lat=&mode=&persona=&weights=&minutes=10` | "better nearby": hexagons within a short walk that score higher than the point's own, spread out, best first, with the nearest address |
| `GET /api/v1/common-ground?places=lon,lat,mode,minutes;...` | "where should we live?": the area from which up to 4 places are each reachable in their own limit, and the best-scoring spots inside |
| `GET /api/v1/districts/ranking?mode=&persona=&weights=` | districts ranked by mean H3 cell score (area-weighted, not population-weighted), with p25/p75; walk, step-free, bike, transit (weekday 08:00) or transit_evening (Sunday 20:00) |
| `GET /api/v1/cells?mode=` | every heatmap hexagon's travel times per category, column by column, for one mode (as the ranking); the browser scores them |
| `GET /api/v1/categories`, `/personas`, `/meta` | reference data and the active data release |

The contract is [`openapi/openapi.json`](openapi/openapi.json); the front end's types are generated from it.

## How it works

```
osm.* tables ─► routing.build_graph()       split ways at junctions, walk/bike costs, components
             ─► routing.snap_sources()      POIs ─► nearest main-component vertex; parks ─► outline vertices
             ─► analytics.compute_category_times()   one multi-source Dijkstra per category and mode
             ─► analytics.compute_h3_cells()          per H3 cell: district + {mode_category: seconds}
             ─► search.build_index()                  addresses, streets, deduplicated POIs (trigram)
             ─► quality gates ─► meta.data_release (report + timings)
```

**Multi-source Dijkstra with a virtual super-source.** The naive approach runs a shortest-path
search from each of ~8,500 hexagons for every category. Reach15 adds a virtual vertex `0` with a
zero-cost edge to *every* POI of a category and runs a single one-to-all `pgr_dijkstraCost` from it.
Each street vertex gets its time to the *nearest* POI in one pass. For directed modes (cycling on
oneway streets) the graph is reversed, because the search expands from the POIs while people travel
towards them. The synthetic grid catches this: 168 s is correct, 120 s means the graph was not reversed.

**Performance findings** (Budapest: 260k edges, 189k vertices, 57k POIs, 8.5k H3 cells):

| Step | First attempt | Now | Change |
|---|---|---|---|
| Category precompute | `pgr_drivingDistance(equicost)`: 47 s per category | super-source + `pgr_dijkstraCost`: 1.3 s | ~35× faster, identical results (checked cell by cell) |
| Isochrone (walk, 15 min) | `ST_Buffer` of reached edges: 20 s | union of H3 res-10 cells: ~1 s | bike went from 4+ min to ~1 s |
| Full Budapest build | | ~3 min | import + graph + elevation + 3 modes × 10 categories + H3 + search index; then 2 transit heatmaps (~13 s) |
| API, cached / cold | | isochrone 38 ms / 0.5-1.3 s, search ~200 ms | Caffeine cache; coordinates rounded to 5 decimals (~1 m) |
| Street search to H3 cells (`reach_cells`, 10 min on foot) | 380-600 ms, mostly PostgreSQL JIT compiling the query (cost estimates of set-returning functions crossed `jit_above_cost`) | 14 ms with `jit=off` | isochrones, better nearby and common ground all run it; nearby went from 0.5-1.1 s to ~0.2 s cold |
| Precompute, 3 modes × 10 categories | walk, bike, step-free one after another: 96 s | one connection per mode, in parallel: 49 s | pgRouting is single-threaded per query |
| Transit (BKK: 5.8k stops, 40k weekday trips) | | timetable load 2.9 s per service day, then access ~0.8 s, isochrone ~1 s | RAPTOR over flat arrays; one seeded Dijkstra for every walk-on |
| Common ground (2 places) | | walk + bike ~1.2 s, with a transit place ~4 s (cold) | one seeded search per place, H3 intersection |
| GTFS import + opening hours | | 48 s + 0.1 s | 5.8M stop times via COPY; 5,174 of 5,326 `opening_hours` values parsed |
| Transit heatmap (8.5k cells, weekday 08:00) | | 7-8.5 s | in-memory walking graph + RAPTOR per cell, in parallel; the walk on from each stop is a precomputed lookup |
| Elevation (Copernicus DEM, 259k edges) | raw surface model: flat District V cycling +48 % over flat, more than hilly XII (+30 %) | ground model + 1 m hysteresis: 26 s; V +10 %, XII +19 % | roofs between narrow streets read as climbs until filtered out |
| Heatmap tiles (z11, 1,400 hexagons) | travel times as tile properties: 157 kB (88 kB gzip) | shape + district only: 69 kB (18 kB gzip) | times load once per release from `/api/v1/cells` |
| Heatmap times (`/api/v1/cells`) | all modes in one response: 418 kB gzip for 3 modes, 680 kB for 5 | one mode per request: ~150 kB on first paint | the other modes load when chosen; the previous one stays painted meanwhile |
| JavaScript | one 1.44 MB chunk (404 kB gzip), gzip per request | app 19 kB, MapLibre, React, vendor in their own chunks; Brotli at build time | a release that changes only the app keeps ~90 % cached; MapLibre 296 → 243 kB |
| Re-weighting the map (persona, slider) | data-driven paint expression: every tile re-parsed | scores as feature state: 40-50 ms to a finished frame | no tile is read again |
| Click on the map | camera padding shifted the map 196 px; clicks near the left edge also zoomed to the point; ~190 ms shader compile | map stays put (pans only if the panel covers the point); shaders compiled at start-up | measured with `web/scripts/profile.mjs` and `check-motion.mjs` |

**Client-side scoring.** The browser loads every hexagon's raw travel times once per data release
(`/api/v1/cells?mode=`: 8.5k hexagons × 10 categories), scores all of them in about a
millisecond, and hands the scores to MapLibre as feature state. Moving a slider recolours the whole
city without a request and without re-reading a tile. The vector tiles carry only the shape and
the district. The same formula lives in SQL (`analytics.access_score`), Kotlin and TypeScript;
`tests/fixtures/scoring-vectors.json` holds shared input/output vectors that the Kotlin and
TypeScript implementations must match. Those vectors found a real bug in an earlier version that
scored in MapLibre expressions: `["to-number", null, fallback]` returns `0` instead of the fallback,
so an unreachable category scored as *perfect* on the map. See [ADR 0003](docs/adr/0003-client-side-scoring.md).

**Public transport, opening hours, common ground.** Every on-demand street search starts from
*seeds*: vertices with the time already spent reaching them. A clicked point is one seed. By public
transport, the API walks to nearby stops (database), runs RAPTOR over an in-memory copy of the
service day's BKK timetable, and hands every stop reached back to the database as a seed at its
arrival time; one super-source Dijkstra walks on from all of them. "Where should we live?" runs one
seeded search per place (on the reversed graph for walk and bike: the time from home *to* the
office), intersects the H3 cells, and ranks the heatmap hexagons inside. OSM `opening_hours` values
are parsed once per build into `int4multirange` minutes of the week; values the parser does not model
stay "unknown" and count as open. See [ADR 0005](docs/adr/0005-transit-raptor-and-seeded-search.md).

Decision records: [routing inside PostGIS](docs/adr/0001-routing-inside-postgis.md),
[H3 isochrones](docs/adr/0002-h3-isochrones.md), [client-side scoring](docs/adr/0003-client-side-scoring.md),
[blue/green for code and data](docs/adr/0004-blue-green-code-and-data.md),
[transit with RAPTOR and seeded search](docs/adr/0005-transit-raptor-and-seeded-search.md),
[preview environments](docs/adr/0006-preview-environments.md),
[transit heatmap, hills, holidays](docs/adr/0007-transit-heatmap-hills-holidays.md),
[step-free walking, evening transit, better nearby](docs/adr/0008-stepfree-evening-transit-nearby.md).

## Testing strategy

| Layer | Tool | Count | What it proves |
|---|---|---|---|
| SQL functions | pgTAP | 153 | cost model (walk/step-free/bike, oneway, steps, hills), better nearby, public holidays and holiday hours, scoring, search normalisation and ranking, isochrone geometry, seeded search, opening hours, GTFS calendars, common ground, input validation (SQLSTATE 22023) |
| OSM mapping, graph, precompute | pgTAP on the synthetic grid | (incl.) | Lua rules; ways split at junctions; snapping never targets an island; every vertex matches its hand-computed Manhattan time |
| ETL | pytest + ruff | 47 | fixture generators (OSM + GTFS), opening_hours parser (incl. `PH`), elevation profiles, quality gates, score-drift gate |
| API | JUnit 5 + Testcontainers | 63 | RAPTOR on hand-made timetables; real PostGIS image restored from the fixture dump: endpoints, tram timetable, transit heatmaps (weekday, Sunday evening), step-free walking, better nearby, opening hours and holidays, common ground, error mapping, caching |
| API contract | snapshot test | 1 | `openapi/openapi.json` matches the running API (`./gradlew test -PupdateSnapshots` to accept) |
| Front-end types | CI drift check | | `src/api/schema.d.ts` regenerated from the contract must not differ |
| Front end | Vitest | 50 | scoring vectors, per-hexagon scores, heat modes per "When?", URL state (incl. compared places), "when?" presets across time zones and DST, components |
| End to end | Playwright + axe-core | 21 | production images (Caddy + API + Martin) on the fixture DB; desktop and mobile; no serious a11y violations |
| Performance | k6 | | p95 budgets per endpoint; fixture in CI, real Budapest data on staging |
| Release (data) | quality gates + drift gate | | graph health, coverage, and < 5 % of cells moving > 10 points vs production |
| Supply chain | hadolint, gitleaks, Trivy, cosign | | Dockerfile lint, secret scan, critical CVEs, signed images with SBOM + provenance |

The **synthetic grid fixture** (`etl/reach15_etl/fixtures.py`) is a 10×10 street grid with 100 m
blocks. Every edge case has a known answer: a oneway row, a `foot=no` shortcut, a motorway, steps,
a disconnected island with a cafe on it, and a park outline. Its GTFS twin runs one tram along the
diagonal (3 minutes, every 10 minutes, weekdays only, no service on 25 December), and three POIs carry
opening hours, so "3 min by tram at 08:00, 12 min at 08:01, the walk again on Sunday" are exact too. The pgTAP suites, the API integration
tests and the Playwright tests all run against it, so assertions are exact ("6 min", "3 min by bike
because of the oneway detour") instead of "something came back".

## CI/CD

```
pull request ──► ci.yml
                 ├─ ETL lint + unit ─┐
                 ├─ web lint + unit + type drift
                 ├─ static analysis (hadolint, gitleaks, Trivy fs)
                 └─ DB: migrations + fixture import + pgTAP ─► fixture dump ─┬─► API: Testcontainers + contract
                                                                             └─► E2E: Playwright + k6

pull request ──► preview.yml (same-repo PRs, when PREVIEW_HOST is set)
                 images pr-<n> ─► deploy/preview.sh: own DB built by the PR's migrations + ETL,
                 api/web/tiles at https://pr-<n>.<PREVIEW_DOMAIN>, sticky PR comment; removed on close

push to main ──► release.yml
                 ci.yml (reused) ─► images: api, web, db, etl (amd64 + arm64, SBOM, provenance,
                                    Trivy gate, keyless cosign signature)
                 ─► staging: verify signatures, blue/green deploy, smoke, k6 on Budapest data
                 ─► production (manual approval): blue/green deploy, smoke

every Monday ──► data-release.yml
                 staging, then production (approval): build reach15_next, quality + drift gates,
                 rename-swap, smoke; `rollback` input restores the previous release
```

Deploy jobs only run when the `STAGING_HOST` / `PRODUCTION_HOST` repository variables are set.

- **Preview** (`preview.yml`): every pull request from a branch of this repo gets its own environment at
  `https://pr-<n>.<PREVIEW_DOMAIN>` with its own database built by the PR's migrations and ETL on the
  real Budapest extract (`deploy/preview.sh`, [ADR 0006](docs/adr/0006-preview-environments.md)). A sticky
  PR comment has the link; closing the PR removes it and a daily job prunes stale ones. At most 5 at a
  time; fork PRs get no preview. Needs `PREVIEW_HOST`, `PREVIEW_DOMAIN`, `PREVIEW_SSH_KEY` and
  `PREVIEW_KNOWN_HOSTS`.

## Quick start

Requirements: Docker, Python 3.11+, Node 24 (front end), JDK 21+ (API).

```bash
python tasks.py test-db     # fresh DB, migrations, fixture import, full pgTAP suite, fixture dump
python tasks.py test-api    # API unit + Testcontainers integration + contract tests
python tasks.py e2e         # production images on the fixture DB + Playwright
```

Real Budapest data:

```bash
python tasks.py download    # Hungary extract from Geofabrik (~350 MB), cut to Budapest
python tasks.py basemap     # Budapest basemap from the latest Protomaps build (PMTiles)
python tasks.py gtfs        # BKK public transport timetable (GTFS, ~60 MB)
python tasks.py dem         # Copernicus elevation, Budapest window (optional: hill-aware cycling)
python tasks.py pipeline    # import + GTFS + DEM + graph + precompute + opening hours + search index + transit heatmap
python tasks.py app         # API + web + tiles in containers: http://localhost:8088
python tasks.py down        # stop (add --volumes to drop the data)
```

The README demo is recorded from that stack with Playwright: `node web/scripts/record-demo.mjs`
(see the script header for the ffmpeg line that turns it into `docs/demo.gif`).

For front-end development run `python tasks.py api` and `npm run dev` in `web/` (Vite proxies
`/api` and `/tiles`).

## Roadmap

- [x] **Phase 1, data foundation:** Docker DB, Flyway, OSM import, graph build, multi-source precompute, H3, quality gates, pgTAP
- [x] **Phase 2, API:** Kotlin + Spring Boot; search, reverse, access, isochrone, ranking; Testcontainers; OpenAPI contract snapshot
- [x] **Phase 3, tiles + analytics:** Martin function source, PMTiles basemap, district ranking, score-drift report between data releases
- [x] **Phase 4, front end:** React + MapLibre GL, client-side re-weighting, personas, EN/HU, light/dark, shareable URLs, Playwright + axe
- [x] **Phase 5, delivery:** signed multi-arch images, staging + approval-gated production, blue/green deploy, k6 budgets, weekly data release with an atomic database swap
- [x] **Phase 6, extensions:** "where should we live?" (intersection of several people's reach, best spots inside), opening hours, transit routing (RAPTOR over BKK GTFS), preview environments per PR
- [x] **Phase 7, depth:** public transport heatmap and ranking (RAPTOR per H3 cell), hill-aware cycling (Copernicus DEM), Hungarian public holidays in "When?", compare up to three places side by side
- [x] **Phase 8, access:** step-free walking (pushchair, wheelchair: no steps), a Sunday-evening public transport heatmap, "better nearby" suggestions, share button, recent places, per-mode heatmap data, split and precompressed front-end bundles, JIT off for short searches, non-root images

## Data and licence

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database Licence (ODbL). Public transport timetable: [BKK](https://bkk.hu/) open data (GTFS). Elevation: produced using
Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided
under COPERNICUS by the European Union and ESA; all rights reserved. Basemap tiles from [Protomaps](https://protomaps.com) builds of OpenStreetMap.
