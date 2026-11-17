# ADR 0001: Route inside PostgreSQL with pgRouting

- Status: accepted
- Date: 2026-11-17

## Context

Reach15 needs two kinds of graph queries over the Budapest street network:

1. **City-wide precomputation**: the travel time from every street vertex to the nearest
   POI of each category (grocery, pharmacy, park and so on).
2. **On-demand isochrones** for any clicked point.

Dedicated routing engines (OSRM, Valhalla, GraphHopper) answer point-to-point queries fast.
But they are separate services with their own data build, and their matrix and isochrone APIs
are not designed for "nearest of N sources" questions over the whole graph.

## Decision

Build the graph in PostgreSQL from the osm2pgsql import and query it with pgRouting.

- The graph build is a versioned SQL function, so it is unit-tested with pgTAP on a synthetic grid.
- The precomputation is a **multi-source Dijkstra**: per category and mode, a virtual vertex `0`
  gets a zero-cost edge to every POI vertex, and one one-to-all `pgr_dijkstraCost` runs from it.
  This replaces thousands of single-source runs with twenty (10 categories x 2 modes).
- Directed modes run on the reversed graph, because the search starts at the POIs.
- Vertex ids are OSM node ids, so every result can be traced back to OSM.

## Amendment (same day): super-source instead of `pgr_drivingDistance`

The first version used `pgr_drivingDistance(..., equicost => true)` with every POI as a start
vertex. On the Budapest graph it took ~47 s per category (9+ minutes per mode). The super-source
variant with `pgr_dijkstraCost` takes ~1.3 s per category and gives identical times for every
vertex (compared row by row before switching). The pgTAP suite on the synthetic grid stayed green
without changes, which is what made the swap safe.

## Consequences

- One stateful service (PostgreSQL) holds the data, the graph and the results. Fewer moving parts.
- pgRouting loads the edge set for each call. On-demand queries limit the edge query to a
  bounding box around the point (computed in EPSG:23700, metres) to stay fast.
- Turn restrictions and time-dependent public transport are out of scope for pgRouting.
  Transit routing (RAPTOR over GTFS) is planned as a separate service.
