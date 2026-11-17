-- Repeatable migration: graph building functions.
-- Functions that read osm.* are plpgsql, so they can be created before the first OSM import.

-- Walking: 80 m/min (4.8 km/h), steps take twice as long.
CREATE OR REPLACE FUNCTION routing.walk_cost_s(length_m double precision, highway text)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT length_m / (80.0 / 60.0) * CASE WHEN highway = 'steps' THEN 2.0 ELSE 1.0 END
$$;

-- Cycling: 15 km/h on roads, pushing the bike (1.1 m/s) on footways where cycling is not allowed,
-- no steps, oneway restrictions unless oneway:bicycle=no. -1 = not traversable.
CREATE OR REPLACE FUNCTION routing.bike_costs(
    length_m double precision,
    highway text,
    tags jsonb,
    OUT cost double precision,
    OUT reverse_cost double precision)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    WITH p AS (
        SELECT
            CASE
                WHEN tags ->> 'bicycle' = 'no' OR highway = 'steps' THEN NULL
                WHEN highway IN ('footway', 'pedestrian', 'corridor')
                     AND coalesce(tags ->> 'bicycle', '') NOT IN ('yes', 'designated', 'permissive') THEN 1.1
                ELSE 15.0 / 3.6
            END AS speed,
            CASE
                WHEN tags ->> 'oneway:bicycle' = 'no' THEN 0
                WHEN tags ->> 'oneway' IN ('yes', '1', 'true') OR tags ->> 'junction' = 'roundabout' THEN 1
                WHEN tags ->> 'oneway' = '-1' THEN -1
                ELSE 0
            END AS oneway
    )
    SELECT
        CASE WHEN speed IS NULL OR oneway = -1 THEN -1 ELSE length_m / speed END,
        CASE WHEN speed IS NULL OR oneway = 1 THEN -1 ELSE length_m / speed END
    FROM p
$$;

-- Builds routing.edges / routing.vertices from osm.walk_ways.
--
-- OSM ways are split at junctions: nodes shared by more than one way, plus way end points.
-- Vertex ids are OSM node ids. Afterwards connected components are computed and the
-- largest one is flagged, so POIs are never snapped onto an isolated island.
CREATE OR REPLACE FUNCTION routing.build_graph(
    OUT edge_count bigint,
    OUT vertex_count bigint,
    OUT skipped_ways bigint)
LANGUAGE plpgsql
SET client_min_messages = warning
AS $$
BEGIN
    TRUNCATE routing.edges, routing.vertices CASCADE;
    DROP TABLE IF EXISTS pg_temp.way_points, pg_temp.junctions, pg_temp.seg_points;

    -- One row per (way, position): the OSM node id zipped with its geometry point.
    -- osm2pgsql drops consecutive duplicate locations, so a way whose point count differs
    -- from its node count cannot be zipped reliably and is skipped.
    CREATE TEMP TABLE way_points ON COMMIT DROP AS
    SELECT w.way_id, p.idx, p.node_id, p.geom
    FROM osm.walk_ways w
    CROSS JOIN LATERAL ROWS FROM (unnest(w.nodes), ST_DumpPoints(w.geom))
        WITH ORDINALITY AS p (node_id, path, geom, idx)
    WHERE cardinality(w.nodes) = ST_NPoints(w.geom);

    SELECT count(*) INTO skipped_ways
    FROM osm.walk_ways w
    WHERE cardinality(w.nodes) <> ST_NPoints(w.geom);

    CREATE TEMP TABLE junctions ON COMMIT DROP AS
    SELECT node_id FROM way_points GROUP BY node_id HAVING count(*) > 1
    UNION
    SELECT wp.node_id
    FROM way_points wp
    JOIN (SELECT way_id, max(idx) AS last_idx FROM way_points GROUP BY way_id) l USING (way_id)
    WHERE wp.idx = 1 OR wp.idx = l.last_idx;
    ALTER TABLE junctions ADD PRIMARY KEY (node_id);

    -- seg = number of junctions passed so far. A junction starts segment `seg` and also
    -- ends segment `seg - 1`, so it is emitted twice below.
    CREATE TEMP TABLE seg_points ON COMMIT DROP AS
    SELECT wp.way_id, wp.idx, wp.node_id, wp.geom,
           j.node_id IS NOT NULL AS is_junction,
           sum((j.node_id IS NOT NULL)::int) OVER (PARTITION BY wp.way_id ORDER BY wp.idx) AS seg
    FROM way_points wp
    LEFT JOIN junctions j USING (node_id);

    WITH pts AS (
        SELECT way_id, seg, idx, node_id, geom FROM seg_points
        UNION ALL
        SELECT way_id, seg - 1, idx, node_id, geom FROM seg_points WHERE is_junction AND seg > 1
    ),
    segments AS (
        SELECT way_id,
               (array_agg(node_id ORDER BY idx))[1]      AS source,
               (array_agg(node_id ORDER BY idx DESC))[1] AS target,
               ST_MakeLine(geom ORDER BY idx)            AS geom
        FROM pts
        GROUP BY way_id, seg
        HAVING count(*) > 1
    ),
    measured AS (
        SELECT s.*, w.highway, w.tags, ST_Length(s.geom::geography) AS length_m
        FROM segments s
        JOIN osm.walk_ways w USING (way_id)
    )
    INSERT INTO routing.edges (way_id, source, target, highway, length_m,
                               cost_walk_s, reverse_cost_walk_s, cost_bike_s, reverse_cost_bike_s, geom)
    SELECT m.way_id, m.source, m.target, m.highway, m.length_m,
           routing.walk_cost_s(m.length_m, m.highway),
           routing.walk_cost_s(m.length_m, m.highway),
           b.cost, b.reverse_cost, m.geom
    FROM measured m
    CROSS JOIN LATERAL routing.bike_costs(m.length_m, m.highway, m.tags) b
    WHERE m.length_m > 0;

    INSERT INTO routing.vertices (id, geom)
    SELECT DISTINCT ON (sp.node_id) sp.node_id, sp.geom
    FROM seg_points sp
    WHERE sp.is_junction
      AND (EXISTS (SELECT 1 FROM routing.edges e WHERE e.source = sp.node_id)
           OR EXISTS (SELECT 1 FROM routing.edges e WHERE e.target = sp.node_id))
    ORDER BY sp.node_id;

    UPDATE routing.vertices v
    SET component = c.component
    FROM pgr_connectedComponents(
        'SELECT id, source, target, cost_walk_s AS cost, reverse_cost_walk_s AS reverse_cost FROM routing.edges') c
    WHERE v.id = c.node;

    UPDATE routing.vertices
    SET in_main_component = component = (
        SELECT component FROM routing.vertices
        GROUP BY component ORDER BY count(*) DESC, component LIMIT 1);

    ANALYZE routing.edges;
    ANALYZE routing.vertices;

    SELECT count(*) INTO edge_count FROM routing.edges;
    SELECT count(*) INTO vertex_count FROM routing.vertices;
END
$$;

-- Fills analytics.poi_vertex: the graph vertices each POI is reachable from.
--   * every POI is snapped to the nearest main-component vertex (if within p_max_snap_m)
--   * parks with an outline additionally get every vertex within p_park_edge_m of it,
--     because a large park is reachable from all around, not just from its centre
CREATE OR REPLACE FUNCTION routing.snap_sources(
    p_max_snap_m double precision DEFAULT 300,
    p_park_edge_m double precision DEFAULT 25)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    TRUNCATE analytics.poi_vertex;

    INSERT INTO analytics.poi_vertex (poi_type, poi_id, category, vertex_id)
    SELECT p.osm_type, p.osm_id, p.category, nv.id
    FROM osm.pois p
    CROSS JOIN LATERAL (
        SELECT v.id, v.geom
        FROM routing.vertices v
        WHERE v.in_main_component
        ORDER BY v.geom <-> p.geom
        LIMIT 1
    ) nv
    WHERE ST_DWithin(nv.geom::geography, p.geom::geography, p_max_snap_m)
    ON CONFLICT DO NOTHING;

    INSERT INTO analytics.poi_vertex (poi_type, poi_id, category, vertex_id)
    SELECT p.osm_type, p.osm_id, 'park', v.id
    FROM osm.pois p
    JOIN routing.vertices v
      ON v.in_main_component
     AND v.geom && ST_Expand(p.area_geom, 0.001)
     AND ST_DWithin(v.geom::geography, p.area_geom::geography, p_park_edge_m)
    WHERE p.category = 'park' AND p.area_geom IS NOT NULL
    ON CONFLICT DO NOTHING;

    ANALYZE analytics.poi_vertex;
    SELECT count(*) INTO n FROM analytics.poi_vertex;
    RETURN n;
END
$$;

-- Nearest main-component vertex to a point, and how far it is.
CREATE OR REPLACE FUNCTION routing.nearest_vertex(
    p_lon double precision,
    p_lat double precision,
    OUT vertex_id bigint,
    OUT distance_m double precision)
LANGUAGE sql STABLE AS $$
    SELECT v.id, ST_Distance(v.geom::geography, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography)
    FROM routing.vertices v
    WHERE v.in_main_component
    ORDER BY v.geom <-> ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)
    LIMIT 1
$$;
