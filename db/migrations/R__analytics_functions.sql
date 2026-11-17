-- Repeatable migration: accessibility precomputation and on-demand queries.

DROP FUNCTION IF EXISTS analytics.edges_sql(text);

-- Linear decay: 1 at 0 s, 0 at max_seconds (default 15 min) or when unreachable (NULL).
CREATE OR REPLACE FUNCTION analytics.access_score(
    seconds double precision,
    max_seconds double precision DEFAULT 900)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN seconds IS NULL THEN 0.0
        ELSE greatest(0.0, least(1.0, 1.0 - seconds / max_seconds))
    END
$$;

-- Top speed of a travel mode in m/s; used to bound the search radius.
CREATE OR REPLACE FUNCTION analytics.mode_speed(p_mode text)
RETURNS double precision
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    CASE p_mode
        WHEN 'walk' THEN RETURN 80.0 / 60.0;
        WHEN 'bike' THEN RETURN 15.0 / 3.6;
        ELSE RAISE EXCEPTION 'unknown travel mode: %', p_mode USING ERRCODE = 'invalid_parameter_value';
    END CASE;
END
$$;

-- Edge query for pgRouting.
--
-- p_reverse: pgr_drivingDistance expands outward from its start vertices. From a point
--   (isochrone) that is the direction of travel. From POIs (precompute) it is the opposite,
--   because people travel towards the POI, so the graph is reversed by swapping cost and
--   reverse_cost. Walking is symmetric; for cycling on oneway streets it matters.
-- p_bbox: optional filter, so on-demand queries do not load the whole city into pgRouting.
CREATE OR REPLACE FUNCTION analytics.edges_sql(
    p_mode text,
    p_reverse boolean DEFAULT false,
    p_bbox geometry DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    fwd text;
    bwd text;
BEGIN
    PERFORM analytics.mode_speed(p_mode);  -- validates the mode
    fwd := format('cost_%s_s', p_mode);
    bwd := format('reverse_cost_%s_s', p_mode);
    IF p_reverse THEN
        SELECT bwd, fwd INTO fwd, bwd;
    END IF;
    RETURN format('SELECT id, source, target, %I AS cost, %I AS reverse_cost FROM routing.edges', fwd, bwd)
        || CASE WHEN p_bbox IS NULL THEN ''
                ELSE format(' WHERE geom && %L::geometry', ST_AsEWKT(p_bbox)) END;
END
$$;

-- Multi-source Dijkstra: one pgr_drivingDistance run per category, with every source of
-- the category as a start vertex. equicost assigns each vertex to its nearest source, so a
-- single run yields "time to the nearest grocery" for the whole city.
CREATE OR REPLACE FUNCTION analytics.compute_category_times(
    p_mode text DEFAULT 'walk',
    p_max_seconds double precision DEFAULT 1800)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_category text;
    n          bigint;
BEGIN
    DELETE FROM analytics.vertex_category_time WHERE mode = p_mode;

    FOR v_category IN SELECT DISTINCT category FROM analytics.poi_vertex ORDER BY category LOOP
        -- Virtual super-source (vertex 0, OSM ids are positive) with a zero-cost edge to
        -- every source of the category. One Dijkstra from it equals a multi-source Dijkstra.
        --
        -- Measured on Budapest (260k edges), per category:
        --   pgr_drivingDistance, multi-start + equicost   minutes
        --   pgr_drivingDistance from the super-source     ~47 s
        --   pgr_dijkstraCost one-to-all                   ~1.3 s, identical results
        INSERT INTO analytics.vertex_category_time (mode, category, vertex_id, seconds)
        SELECT p_mode, v_category, d.end_vid, d.agg_cost
        FROM pgr_dijkstraCost(
            analytics.edges_sql(p_mode, true)
                || format(' UNION ALL SELECT -row_number() OVER (), 0, vertex_id, 0, -1'
                          ' FROM analytics.category_sources WHERE category = %L', v_category),
            0, ARRAY(SELECT id FROM routing.vertices), directed => true) d
        WHERE d.agg_cost <= p_max_seconds;
    END LOOP;

    SELECT count(*) INTO n FROM analytics.vertex_category_time WHERE mode = p_mode;
    RETURN n;
END
$$;

-- Aggregates vertex times into H3 cells (median of the reachable vertices in each cell),
-- registers every cell that contains street vertices and assigns it to the smallest
-- administrative area that contains the cell centre.
-- h3_cell.times holds {"walk_grocery": 312, ...}; ST_AsMVT expands it into tile properties.
CREATE OR REPLACE FUNCTION analytics.compute_h3_cells(p_resolution integer DEFAULT 9)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    TRUNCATE analytics.h3_category_time, analytics.h3_cell;

    INSERT INTO analytics.h3_category_time (h3, mode, category, seconds, vertices)
    SELECT h3_latlng_to_cell(v.geom, p_resolution),
           t.mode,
           t.category,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY t.seconds),
           count(*)
    FROM analytics.vertex_category_time t
    JOIN routing.vertices v ON v.id = t.vertex_id
    GROUP BY 1, 2, 3;

    INSERT INTO analytics.h3_cell (h3, district_id, geom, times)
    SELECT c.h3,
           (SELECT d.relation_id
            FROM osm.districts d
            WHERE ST_Contains(d.geom, h3_cell_to_geometry(c.h3))
            ORDER BY ST_Area(d.geom)
            LIMIT 1),
           h3_cell_to_boundary_geometry(c.h3),
           coalesce((SELECT jsonb_object_agg(t.mode || '_' || t.category, round(t.seconds)::int)
                     FROM analytics.h3_category_time t WHERE t.h3 = c.h3), '{}'::jsonb)
    FROM (SELECT DISTINCT h3_latlng_to_cell(geom, p_resolution) AS h3
          FROM routing.vertices WHERE in_main_component) c;

    ANALYZE analytics.h3_cell;
    SELECT count(*) INTO n FROM analytics.h3_cell;
    RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- On-demand queries (used by the API)
-- ---------------------------------------------------------------------------

-- Every vertex reachable from a point within p_max_seconds. The walk from the point to
-- its nearest vertex is included in the time.
CREATE OR REPLACE FUNCTION analytics.reach(
    p_lon double precision,
    p_lat double precision,
    p_mode text,
    p_max_seconds double precision)
RETURNS TABLE (node bigint, seconds double precision)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start    bigint;
    v_snap_m   double precision;
    v_offset   double precision;
    v_radius_m double precision;
    v_bbox     geometry;
BEGIN
    SELECT n.vertex_id, n.distance_m INTO v_start, v_snap_m FROM routing.nearest_vertex(p_lon, p_lat) n;
    IF v_start IS NULL OR v_snap_m > 500 THEN
        RAISE EXCEPTION 'point is not near the street network'
            USING ERRCODE = 'invalid_parameter_value',
                  DETAIL = format('nearest street vertex is %s m away', round(v_snap_m));
    END IF;

    v_offset := v_snap_m / analytics.mode_speed('walk');
    v_radius_m := p_max_seconds * analytics.mode_speed(p_mode) + 100;
    v_bbox := ST_Transform(
        ST_Expand(ST_Transform(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 23700), v_radius_m), 4326);

    -- pgr_dijkstraCost to every vertex in the box (see compute_category_times for why not
    -- pgr_drivingDistance). The start vertex is not reported as its own target.
    RETURN QUERY
    SELECT v_start, v_offset
    UNION ALL
    SELECT d.end_vid, d.agg_cost + v_offset
    FROM pgr_dijkstraCost(analytics.edges_sql(p_mode, false, v_bbox), v_start,
                          ARRAY(SELECT v.id FROM routing.vertices v WHERE v.geom && v_bbox AND v.id <> v_start),
                          directed => true) d
    WHERE d.agg_cost + v_offset <= p_max_seconds;
END
$$;

-- Isochrone polygons as unions of H3 cells (default resolution 10, ~66 m edge).
--
-- Every edge touched by the search is sampled every ~30 m; each sample gets the time it is
-- reached from either end (partially reachable edges are cut where time runs out), each
-- H3 cell keeps its earliest time, and each limit becomes the polygon of the cells reached
-- in time. Measured on Budapest: ~1 s for 15 min by bike, where buffering the reached
-- streets (ST_Buffer of ~40k segments) took 7.5 s for a single limit.
DROP FUNCTION IF EXISTS analytics.isochrone(double precision, double precision, text, integer[], double precision);

CREATE OR REPLACE FUNCTION analytics.isochrone(
    p_lon double precision,
    p_lat double precision,
    p_mode text DEFAULT 'walk',
    p_minutes integer[] DEFAULT '{5,10,15}',
    p_resolution integer DEFAULT 10)
RETURNS TABLE (minutes integer, geom geometry)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_minutes IS NULL OR cardinality(p_minutes) = 0
       OR EXISTS (SELECT 1 FROM unnest(p_minutes) m WHERE m IS NULL OR m < 1 OR m > 30) THEN
        RAISE EXCEPTION 'minutes must be between 1 and 30' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH r AS (
        SELECT * FROM analytics.reach(p_lon, p_lat, p_mode, (SELECT max(m) FROM unnest(p_minutes) m) * 60.0)
    ),
    touched AS (
        SELECT e.id FROM r JOIN routing.edges e ON e.source = r.node
        UNION
        SELECT e.id FROM r JOIN routing.edges e ON e.target = r.node
    ),
    e AS (
        SELECT e.geom,
               CASE p_mode WHEN 'walk' THEN e.cost_walk_s ELSE e.cost_bike_s END                 AS fwd,
               CASE p_mode WHEN 'walk' THEN e.reverse_cost_walk_s ELSE e.reverse_cost_bike_s END AS bwd,
               rs.seconds AS s_sec,
               rt.seconds AS t_sec
        FROM touched
        JOIN routing.edges e USING (id)
        LEFT JOIN r rs ON rs.node = e.source
        LEFT JOIN r rt ON rt.node = e.target
    ),
    samples AS (
        SELECT dp.geom AS pt,
               least(
                   CASE WHEN e.s_sec IS NOT NULL AND e.fwd > 0
                        THEN e.s_sec + ST_LineLocatePoint(e.geom, dp.geom) * e.fwd END,
                   CASE WHEN e.t_sec IS NOT NULL AND e.bwd > 0
                        THEN e.t_sec + (1 - ST_LineLocatePoint(e.geom, dp.geom)) * e.bwd END
               ) AS seconds
        FROM e
        CROSS JOIN LATERAL ST_DumpPoints(ST_Segmentize(e.geom, 0.0003)) dp
    ),
    cells AS (
        SELECT h3_latlng_to_cell(s.pt, p_resolution) AS h3, min(s.seconds) AS seconds
        FROM samples s
        WHERE s.seconds IS NOT NULL
        GROUP BY 1
    )
    SELECT lim.minutes,
           ST_Multi(h3_cells_to_multi_polygon_geometry(array_agg(c.h3)))
    FROM unnest(p_minutes) AS lim (minutes)
    JOIN cells c ON c.seconds <= lim.minutes * 60
    GROUP BY lim.minutes
    ORDER BY lim.minutes;
END
$$;

-- Nearest POI of every category from a point, with travel time.
CREATE OR REPLACE FUNCTION analytics.point_access(
    p_lon double precision,
    p_lat double precision,
    p_mode text DEFAULT 'walk',
    p_max_seconds double precision DEFAULT 1800)
RETURNS TABLE (category text, seconds double precision, poi_name text, poi_lon double precision,
               poi_lat double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ON (pv.category)
           pv.category, r.seconds, p.name, ST_X(p.geom), ST_Y(p.geom)
    FROM analytics.reach(p_lon, p_lat, p_mode, p_max_seconds) r
    JOIN analytics.poi_vertex pv ON pv.vertex_id = r.node
    JOIN osm.pois p ON p.osm_type = pv.poi_type AND p.osm_id = pv.poi_id
    ORDER BY pv.category, r.seconds, p.name IS NULL, p.name;
END
$$;

-- Weighted score (0-100) of every H3 cell for a set of category weights.
-- Categories missing from a cell count as unreachable (score 0).
CREATE OR REPLACE FUNCTION analytics.cell_scores(p_weights jsonb, p_mode text DEFAULT 'walk')
RETURNS TABLE (h3 h3index, district_id bigint, score double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    PERFORM analytics.mode_speed(p_mode);
    IF p_weights IS NULL OR jsonb_typeof(p_weights) <> 'object'
       OR NOT EXISTS (SELECT 1 FROM jsonb_each_text(p_weights) w WHERE w.value::double precision > 0) THEN
        RAISE EXCEPTION 'weights must be an object with at least one positive weight'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH w AS (
        SELECT key AS category, value::double precision AS weight
        FROM jsonb_each_text(p_weights)
        WHERE value::double precision > 0
    )
    SELECT c.h3, c.district_id,
           100 * sum(w.weight * analytics.access_score(t.seconds)) / sum(w.weight)
    FROM analytics.h3_cell c
    CROSS JOIN w
    LEFT JOIN analytics.h3_category_time t
           ON t.h3 = c.h3 AND t.mode = p_mode AND t.category = w.category
    GROUP BY c.h3, c.district_id;
END
$$;

-- Districts ranked by their mean cell score, with their bounding box (west, south, east, north)
-- so a client can frame a district without loading its geometry.
DROP FUNCTION IF EXISTS analytics.district_ranking(jsonb, text, integer);
CREATE FUNCTION analytics.district_ranking(
    p_weights jsonb,
    p_mode text DEFAULT 'walk',
    p_admin_level integer DEFAULT 9)
RETURNS TABLE (district_id bigint, name text, score double precision, cells bigint,
               p25 double precision, p75 double precision,
               west double precision, south double precision, east double precision, north double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    SELECT d.relation_id, d.name, avg(s.score), count(*),
           percentile_cont(0.25) WITHIN GROUP (ORDER BY s.score),
           percentile_cont(0.75) WITHIN GROUP (ORDER BY s.score),
           ST_XMin(d.geom), ST_YMin(d.geom), ST_XMax(d.geom), ST_YMax(d.geom)
    FROM analytics.cell_scores(p_weights, p_mode) s
    JOIN osm.districts d ON d.relation_id = s.district_id
    WHERE d.admin_level = p_admin_level
    GROUP BY d.relation_id, d.name, d.geom
    ORDER BY avg(s.score) DESC, d.name;
END
$$;

-- Martin function source: H3 cells as Mapbox Vector Tiles. Travel times are tile
-- properties, so the client computes scores itself and re-weights without a request.
CREATE OR REPLACE FUNCTION analytics.h3_tiles(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
    mvt bytea;
BEGIN
    SELECT ST_AsMVT(t, 'h3', 4096, 'geom') INTO mvt
    FROM (
        SELECT c.h3::text AS h3,
               c.district_id,
               c.times,
               ST_AsMVTGeom(ST_Transform(c.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom
        FROM analytics.h3_cell c
        WHERE c.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)
    ) t
    WHERE t.geom IS NOT NULL;
    RETURN mvt;
END
$$;