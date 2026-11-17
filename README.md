# Reach15: a 15-minute city analyser for Budapest

Reach15 shows what you can reach from any point in Budapest within a few minutes on foot, by bike or
by public transport: groceries, pharmacies, doctors, schools, parks, transit stops. It scores every
neighbourhood, ranks the districts, lets you re-weight the score for how you live (family, student,
senior...), checks what is actually open at a given time, and finds where a household should live
so that everyone's office, school or family is within reach.

![Reach15 demo: heatmap, a place's score and isochrones, public transport, opening hours and "where should we live?"](docs/demo.gif)

It is built on OpenStreetMap data, PostgreSQL/PostGIS, pgRouting and H3, a Kotlin/Spring Boot API,
Martin vector tiles and a React + MapLibre GL front end. Tests are a first-class part of the design:
every layer has its own suite, and the CI/CD pipeline gates both code releases and weekly data releases.

> **Status:** phases 1–6 are done (data, API, tiles, front end, delivery, extensions). See the [roadmap](#roadmap).

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
| `etl/` | Python 3.13, osm2pgsql 2 (flex Lua), osmium, pmtiles CLI | download, import, GTFS import, opening-hours parser, build, quality gates, score drift, fixture generator |
| `api/` | Kotlin 2.4, Spring Boot 4, Jackson 3, springdoc, Caffeine | thin layer over SQL functions plus RAPTOR (public transport); RFC 9457 problem details |
| `tiles/` | Martin | `analytics.h3_tiles(z, x, y)` function source + PMTiles basemap |
| `web/` | React 19, Vite, MapLibre GL 6, @protomaps/basemaps, openapi-typescript | scoring runs on the GPU as style expressions |
| `deploy/` | Docker Compose, Caddy | blue/green for the app, rename-swap for the data |

### API

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/search?q=` | addresses, streets and places; accent- and abbreviation-insensitive (`andrassy u 1`, `nyugati pu`) |
| `GET /api/v1/reverse?lon=&lat=` | nearest address |
| `GET /api/v1/access?lon=&lat=&mode=&persona=&weights=&at=` | score 0–100, travel time and nearest place per category; `mode=transit` rides BKK's timetable, `at` (local time) keeps only places open then |
| `GET /api/v1/isochrone?lon=&lat=&mode=&minutes=5,10,15&at=` | GeoJSON multipolygons (walk, bike, or transit leaving at `at`) |
| `GET /api/v1/common-ground?places=lon,lat,mode,minutes;...` | "where should we live?": the area from which up to 4 places are each reachable in their own limit, and the best-scoring spots inside |
| `GET /api/v1/districts/ranking?mode=&persona=&weights=` | districts ranked by mean H3 cell score (area-weighted, not population-weighted), with p25/p75 |
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
| Full Budapest build | | ~90 s | import + graph + 2 modes × 10 categories + search index |
| API, cached / cold | | isochrone 38 ms / 1.4 s, search ~200 ms | Caffeine cache; coordinates rounded to 5 decimals (~1 m) |
| Transit (BKK: 5.8k stops, 40k weekday trips) | | timetable load 2.9 s per service day, then access ~0.8 s, isochrone ~1 s | RAPTOR over flat arrays; one seeded Dijkstra for every walk-on |
| Common ground (2 places) | | walk + bike ~1.2 s, with a transit place ~4 s (cold) | one seeded search per place, H3 intersection |
| GTFS import + opening hours | | 48 s + 0.1 s | 5.8M stop times via COPY; 5,174 of 5,326 `opening_hours` values parsed |

**Client-side scoring.** Vector tiles carry raw travel times per category (`walk_grocery`,
`bike_park`...), not scores. The browser turns the user's weights into a MapLibre style expression,
so moving a slider recolours the whole city without a single new tile request. The same formula
lives in SQL (`analytics.access_score`), Kotlin and TypeScript; `tests/fixtures/scoring-vectors.json`
holds shared input/output vectors that the Kotlin and TypeScript implementations (and the MapLibre
expression, evaluated by the style-spec engine in Vitest) must match. Those vectors found a
real bug: MapLibre's `["to-number", null, fallback]` returns `0` instead of the fallback, so an
unreachable category scored as *perfect* on the map. See [ADR 0003](docs/adr/0003-client-side-scoring.md).

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
[preview environments](docs/adr/0006-preview-environments.md).

## Testing strategy

| Layer | Tool | Count | What it proves |
|---|---|---|---|
| SQL functions | pgTAP | 119 | cost model (walk/bike, oneway, steps), scoring, search normalisation and ranking, isochrone geometry, seeded search, opening hours, GTFS calendars, common ground, input validation (SQLSTATE 22023) |
| OSM mapping, graph, precompute | pgTAP on the synthetic grid | (incl.) | Lua rules; ways split at junctions; snapping never targets an island; every vertex matches its hand-computed Manhattan time |
| ETL | pytest + ruff | 40 | fixture generators (OSM + GTFS), opening_hours parser, quality gates, score-drift gate |
| API | JUnit 5 + Testcontainers | 50 | RAPTOR on hand-made timetables; real PostGIS image restored from the fixture dump: endpoints, tram timetable, opening hours, common ground, error mapping, caching |
| API contract | snapshot test | 1 | `openapi/openapi.json` matches the running API (`./gradlew test -PupdateSnapshots` to accept) |
| Front-end types | CI drift check | | `src/api/schema.d.ts` regenerated from the contract must not differ |
| Front end | Vitest | 52 | scoring vectors, style expressions, URL state, "when?" presets across time zones and DST, components |
| End to end | Playwright + axe-core | 14 | production images (Caddy + API + Martin) on the fixture DB; desktop and mobile; no serious a11y violations |
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
python tasks.py pipeline    # import + GTFS + graph + precompute + opening hours + search index
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
- [x] **Phase 4, front end:** React + MapLibre GL, client-side re-weighting via style expressions, personas, EN/HU, light/dark, shareable URLs, Playwright + axe
- [x] **Phase 5, delivery:** signed multi-arch images, staging + approval-gated production, blue/green deploy, k6 budgets, weekly data release with an atomic database swap
- [x] **Phase 6, extensions:** "where should we live?" (intersection of several people's reach, best spots inside), opening hours, transit routing (RAPTOR over BKK GTFS), preview environments per PR

## Data and licence

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database Licence (ODbL). Public transport timetable: [BKK](https://bkk.hu/) open data (GTFS). Basemap tiles from [Protomaps](https://protomaps.com) builds of OpenStreetMap.
