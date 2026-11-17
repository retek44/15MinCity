# Reach15: a 15-minute city analyser for Budapest

Reach15 shows what you can reach from any point in Budapest within a few minutes on foot or by bike:
groceries, pharmacies, doctors, schools, parks, public transport. It scores every neighbourhood,
ranks the districts and lets you re-weight the score for how you live (family, student, senior...).

It is built on OpenStreetMap data, PostgreSQL/PostGIS, pgRouting and H3, a Kotlin/Spring Boot API,
Martin vector tiles and a React + MapLibre GL front end. Tests are a first-class part of the design:
every layer has its own suite, and the CI/CD pipeline gates both code releases and weekly data releases.

> **Status:** phases 1–5 are done (data, API, tiles, front end, delivery). See the [roadmap](#roadmap).

## Architecture

```
            Geofabrik (weekly)                     Protomaps daily build
                   │                                        │ pmtiles extract (Budapest)
                   ▼                                        ▼
  etl (Python) ─ osmium ─ osm2pgsql flex (Lua) ─►  PostgreSQL 17                data/basemap.pmtiles
                 build graph, precompute,          PostGIS · pgRouting · h3-pg          │
                 quality gates, drift gate         pg_trgm · unaccent · pgTAP           │
                                                      │              │                  │
                                         JdbcClient   │              │ SQL function     │
                                                      ▼              ▼ source           ▼
                                  api (Kotlin, Spring Boot)       Martin (tiles: h3 + basemap)
                                  /api/v1/* · OpenAPI · Caffeine        │
                                                      │                 │
                                                      └──── web (Caddy) ┘  /api/*, /tiles/*, SPA
                                                               │
                                              React 19 · MapLibre GL · TanStack Query
```

| Component | Stack | Notes |
|---|---|---|
| `db/` | PostgreSQL 17, PostGIS 3, pgRouting 4, h3-pg, pgTAP | Flyway `V*` schema and `R__*` repeatable SQL functions |
| `etl/` | Python 3.13, osm2pgsql 2 (flex Lua), osmium, pmtiles CLI | download, import, build, quality gates, score drift, fixture generator |
| `api/` | Kotlin 2.4, Spring Boot 4, Jackson 3, springdoc, Caffeine | thin layer over SQL functions; RFC 9457 problem details |
| `tiles/` | Martin | `analytics.h3_tiles(z, x, y)` function source + PMTiles basemap |
| `web/` | React 19, Vite, MapLibre GL 6, @protomaps/basemaps, openapi-typescript | scoring runs on the GPU as style expressions |
| `deploy/` | Docker Compose, Caddy | blue/green for the app, rename-swap for the data |

### API

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/search?q=` | addresses, streets and places; accent- and abbreviation-insensitive (`andrassy u 1`, `nyugati pu`) |
| `GET /api/v1/reverse?lon=&lat=` | nearest address |
| `GET /api/v1/access?lon=&lat=&mode=&persona=&weights=` | score 0–100, travel time and nearest place per category |
| `GET /api/v1/isochrone?lon=&lat=&mode=&minutes=5,10,15` | GeoJSON multipolygons |
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

**Client-side scoring.** Vector tiles carry raw travel times per category (`walk_grocery`,
`bike_park`...), not scores. The browser turns the user's weights into a MapLibre style expression,
so moving a slider recolours the whole city without a single new tile request. The same formula
lives in SQL (`analytics.access_score`), Kotlin and TypeScript; `tests/fixtures/scoring-vectors.json`
holds shared input/output vectors that the Kotlin and TypeScript implementations (and the MapLibre
expression, evaluated by the style-spec engine in Vitest) must match. Those vectors found a
real bug: MapLibre's `["to-number", null, fallback]` returns `0` instead of the fallback, so an
unreachable category scored as *perfect* on the map. See [ADR 0003](docs/adr/0003-client-side-scoring.md).

Decision records: [routing inside PostGIS](docs/adr/0001-routing-inside-postgis.md),
[H3 isochrones](docs/adr/0002-h3-isochrones.md), [client-side scoring](docs/adr/0003-client-side-scoring.md),
[blue/green for code and data](docs/adr/0004-blue-green-code-and-data.md).

## Testing strategy

| Layer | Tool | Count | What it proves |
|---|---|---|---|
| SQL functions | pgTAP | 92 | cost model (walk/bike, oneway, steps), scoring, search normalisation and ranking, isochrone geometry, input validation (SQLSTATE 22023) |
| OSM mapping, graph, precompute | pgTAP on the synthetic grid | (incl.) | Lua rules; ways split at junctions; snapping never targets an island; every vertex matches its hand-computed Manhattan time |
| ETL | pytest + ruff | 20 | fixture generator, quality gates, score-drift gate |
| API | JUnit 5 + Testcontainers | 33 | real PostGIS image restored from the fixture dump; endpoints, error mapping, caching |
| API contract | snapshot test | 1 | `openapi/openapi.json` matches the running API (`./gradlew test -PupdateSnapshots` to accept) |
| Front-end types | CI drift check | | `src/api/schema.d.ts` regenerated from the contract must not differ |
| Front end | Vitest | 32 | scoring vectors, style expressions, URL state, components |
| End to end | Playwright + axe-core | 10 | production images (Caddy + API + Martin) on the fixture DB; desktop and mobile; no serious a11y violations |
| Performance | k6 | | p95 budgets per endpoint; fixture in CI, real Budapest data on staging |
| Release (data) | quality gates + drift gate | | graph health, coverage, and < 5 % of cells moving > 10 points vs production |
| Supply chain | hadolint, gitleaks, Trivy, cosign | | Dockerfile lint, secret scan, critical CVEs, signed images with SBOM + provenance |

The **synthetic grid fixture** (`etl/reach15_etl/fixtures.py`) is a 10×10 street grid with 100 m
blocks. Every edge case has a known answer: a oneway row, a `foot=no` shortcut, a motorway, steps,
a disconnected island with a cafe on it, and a park outline. The pgTAP suites, the API integration
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
python tasks.py pipeline    # import + graph + precompute + search index (~90 s)
python tasks.py app         # API + web + tiles in containers: http://localhost:8088
python tasks.py down        # stop (add --volumes to drop the data)
```

For front-end development run `python tasks.py api` and `npm run dev` in `web/` (Vite proxies
`/api` and `/tiles`).

## Roadmap

- [x] **Phase 1, data foundation:** Docker DB, Flyway, OSM import, graph build, multi-source precompute, H3, quality gates, pgTAP
- [x] **Phase 2, API:** Kotlin + Spring Boot; search, reverse, access, isochrone, ranking; Testcontainers; OpenAPI contract snapshot
- [x] **Phase 3, tiles + analytics:** Martin function source, PMTiles basemap, district ranking, score-drift report between data releases
- [x] **Phase 4, front end:** React + MapLibre GL, client-side re-weighting via style expressions, personas, EN/HU, light/dark, shareable URLs, Playwright + axe
- [x] **Phase 5, delivery:** signed multi-arch images, staging + approval-gated production, blue/green deploy, k6 budgets, weekly data release with an atomic database swap
- [ ] **Phase 6, extensions:** "where should I live?" (isochrone intersection of several people's places), opening hours, transit routing (RAPTOR over BKK GTFS), preview environments per PR

## Data and licence

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database Licence (ODbL). Basemap tiles from [Protomaps](https://protomaps.com) builds of OpenStreetMap.
