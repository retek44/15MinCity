# ADR 0003: Score in the browser with MapLibre expressions

- Status: accepted
- Date: 2026-11-17

## Context

The score of a hexagon depends on the user's weights (a family cares about kindergartens and
parks, a student about food and transit). Users move sliders and expect the map to react at once.

Server-side scoring would mean a tile set per weight combination: either a cache explosion or
uncached tile renders on every slider move.

## Decision

Tiles carry *inputs*, not scores: each H3 cell has its travel time per mode and category
(`walk_grocery`, `bike_park`, ...). The front end builds a MapLibre style expression from the
weights and sets it as the fill colour:

```
score = 100 * Σ w_c * clamp(1 - t_c / 900, 0, 1) / Σ w_c
```

The same formula exists in three places: SQL (`analytics.access_score`, used by the API and the
district ranking), Kotlin (`Scoring.kt`) and TypeScript (`scoring.ts`, which emits the expression).

To keep them in sync, `tests/fixtures/scoring-vectors.json` holds shared weights/times/score
vectors. The Kotlin tests and the Vitest suite both run them; Vitest also evaluates the generated
style expression with `@maplibre/maplibre-gl-style-spec`, so the expression is tested, not just the
plain TypeScript function.

## Consequences

- Moving a slider recolours the city with zero network requests (an E2E test asserts that no
  tile request is made after a persona change).
- Tiles are cacheable forever per data release.
- The shared vectors caught a real bug: `["to-number", null, fallback]` returns `0` in MapLibre,
  not the fallback, so a missing time (category unreachable) produced a *perfect* score on the map
  while the API said 0. The expression now uses `["to-number", ["coalesce", ["get", key], 1e9]]`.
- Three implementations is a maintenance cost; the vectors are what makes it acceptable.
