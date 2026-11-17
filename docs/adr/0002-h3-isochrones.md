# ADR 0002: Build isochrones from H3 cells, not buffers

- Status: accepted
- Date: 2026-11-17

## Context

An isochrone is the area reachable from a point within N minutes. The common PostGIS recipe is:
run a bounded Dijkstra, take the reached edges (partially reached ones cut with
`ST_LineSubstring`), buffer them by ~50 m and union the buffers.

On Budapest this was too slow for an interactive map: about 20 s for a 15-minute walk and more
than 4 minutes for a 15-minute bike ride (many more edges). Almost all the time went into
`ST_Buffer` + `ST_Union` over tens of thousands of line segments.

## Decision

Represent reachability as a set of H3 cells (resolution 10, edge ~65 m) and union the cells.

1. A bounded `pgr_dijkstraCost` from the snapped start vertex returns the time to every reached vertex.
2. Every reached edge is sampled every 0.0003° (~25-30 m), and each sample gets an interpolated time.
3. Samples map to H3 cells with `h3_latlng_to_cell`; each cell keeps its minimum time.
4. For each limit (5, 10, 15 minutes) the cells under the limit are merged with
   `h3_cells_to_multi_polygon_geometry` and wrapped in `ST_Multi`, so the API always returns
   `MultiPolygon` (a single-blob result used to come back as a `Polygon`; a pgTAP test now
   checks the geometry type).

## Consequences

- Walk and bike isochrones both take about 1 s cold; cached responses take ~40 ms.
- Edges are hexagonal at ~65 m resolution. At city zoom this reads as a natural "reach" shape;
  at street zoom it is visibly blocky. This is acceptable for the product (neighbourhood scale).
- Isochrones (resolution 10) and the heatmap (resolution 9) share the H3 hierarchy, so their
  cells line up visually on the map.
- Tests on the synthetic grid must think in cells, not exact outlines. The bike test starts on the
  oneway row: the 2-minute isochrone must contain the vertex 4 blocks downstream (96 s) and must
  not contain the one 5 blocks upstream (168 s detour).
