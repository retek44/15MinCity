# ADR 0005: Public transport with RAPTOR in the API, walking legs in the database

- Status: accepted
- Date: 2026-11-17

## Context

Phase 6 adds public transport (BKK's GTFS feed), opening hours and "where should we live?".
All three need an on-demand search that does not start at a single clicked point:

- by public transport, a journey reaches many stops, each at its own time, and walks on from all of them;
- "where should we live?" intersects several searches, one per place the household needs to reach.

ADR 0001 kept routing inside PostgreSQL and expected transit to be "a separate service". pgRouting has
no time-dependent search, and a timetable search does not need the street graph at all.

## Decision

**RAPTOR runs in the API over an in-memory timetable; every street leg runs in the database.**

- The ETL imports the feed into a `transit` schema with dense integer keys (6,300 stops, 284k trips,
  5.8M stop times for BKK) and snaps every stop to the street graph after each build.
- The API loads one service day (plus the previous day's trips still running after midnight) into
  flat arrays grouped by pattern, and caches up to three days. RAPTOR (Delling et al., 2012) scans
  patterns round by round; patterns are split so that no trip overtakes another, which keeps
  "first trip after t" a binary search.
- **Seeded street search.** `analytics.reach_seeded(vertices[], seconds[])` adds a virtual super-source
  with an edge of cost `seconds` to each seed: one Dijkstra gives the earliest time at every vertex,
  the same trick as the precompute (ADR 0001). A clicked point is one seed; a transit journey is the
  origin plus every stop reached at its arrival time. Isochrones, nearest places and common ground are
  all built on it, so walking, cycling and transit answers come from the same code path.
- **Common ground** runs one seeded search per place (on the reversed graph for walking and cycling: the
  time from home *to* the office), keeps the H3 cells inside every limit, and scores the heatmap's
  resolution-9 cells whose centre lies inside.
- **Opening hours** are parsed once per build (Python, unit tested) into `int4multirange` minutes of the
  week, so "open at Sunday 20:00" is a containment test in the nearest-place query. Values the parser
  does not model (month ranges, sunrise, comments) are stored as unknown, never guessed.

## Consequences

- The heatmap and the district ranking stay walk and bike only: a transit heatmap needs a timetable
  search from all 8,500 hexagons per departure time. The UI says so in the legend.
- Transit times are "leaving at T"; for a common-ground place reached by public transport the journey
  runs *from* the place at T (an evening commute home), not arrive-by.
- Transfers between stops use straight-line distance × 1.3 within 250 m; access and egress walks use
  the street graph. No minimum change time, no real-time data, no holiday calendar beyond the feed's own.
- The first request for a service day pays the timetable load; later requests reuse it.
- Places with unknown opening hours count as open, and the panel labels them "hours unknown".
