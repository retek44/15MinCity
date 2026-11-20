# ADR 0008: Step-free walking, an evening transit heatmap, better nearby, per-mode heatmap data

- Status: accepted
- Date: 2026-11-19

## Context

Budapest's Buda side has whole streets of steps, and many underpasses have stairs only. A family
with a pushchair or a wheelchair user does not walk the same city as the walking model does.
The public transport heatmap answered for one departure (weekday 08:00), but evening and
weekend service is much thinner, and that is when the city feels far. Flat-hunters who like an
area but not a particular street had no way to ask "is there something better a few minutes
away?". Each new mode made `/api/v1/cells` larger: every visitor downloaded every mode's times.

## Decisions

**Step-free walking is a fourth precomputed mode.** `routing.edges` gets
`cost_stepfree_s`/`reverse_cost_stepfree_s`: the walking time, or -1 for steps and ways tagged
`wheelchair=no`. The ETL precomputes it like walking and cycling (about 30 s for Budapest), so
the heatmap, the ranking, isochrones, the place panel and "where should we live?" support it
without special cases. In the interface it is a switch under "Walk" (a kind of walking, not a
fifth button); the link says `m=stepfree`. Kerbs and slopes are not modelled, and the place
panel says so. Considered: a penalty instead of a ban on steps (a pushchair can be carried) -
rejected, because a wheelchair cannot, and the honest answer for the strictest case is the
useful one.

**A second public transport heatmap, Sunday 20:00.** The batch job now computes a list of
departure slots (`TransitHeatmap.Slot`); each is stored as its own heat mode (`transit`,
`transit_evening`). The map uses the evening one when "When?" is "Sunday 20:00", the weekday
one otherwise, and the legend names the departure. The walking graph is loaded once for all
slots. Considered: a heatmap per hour (24 x 8.5k RAPTOR runs per release, and a slider nobody
asked for).

**`/api/v1/cells?mode=` serves one heat mode.** The map loads only the mode it shows: 150 kB
(gzip) on first paint instead of 418 kB for three modes, or 680 kB for five. The previous
mode stays painted while the next one loads. Hexagons are in the same order in every response.

**Better nearby: `/api/v1/nearby`.** From a point: the hexagons reachable within a 10-minute
walk (the street network, `analytics.reach_cells`) that score at least a point more than the
point's own hexagon for the current profile and mode (for step-free scores the walk there is
step-free too), at most one per resolution-8 parent so
the suggestions are spread out, best first, each with its nearest address. It compares
hexagon scores (the median of a hexagon's streets) with each other; the place panel then
shows the exact score of the chosen point.

**Front-end delivery.** MapLibre, React and the other libraries are split into their own
chunks, so a release that changes only the app keeps 90 % of the JavaScript cached; the app
itself is 19 kB (gzip). Assets are precompressed at build time (Brotli 11 and gzip 9) and Caddy
serves the files as they are: MapLibre goes from 296 kB (gzip) to 243 kB.

## Consequences

- The data release has one more precompute (step-free) and one more timetable run (evening).
- The `/api/v1/cells` contract changed (`mode` + `times` instead of one array per mode).
- The ranking accepts the heat modes, so districts can be ranked by Sunday-evening transit.
- Images run as non-root (Trivy DS-0002): the web image listens on 8080 inside the container.
