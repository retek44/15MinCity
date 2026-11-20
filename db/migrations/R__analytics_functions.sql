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
        WHEN 'stepfree' THEN RETURN 80.0 / 60.0;
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
--
-- Every on-demand search starts from "seeds": street vertices with the time already spent
-- when reaching them. A clicked point is one seed (its nearest vertex, plus the walk to it);
-- a public transport journey is many (every stop reached, at its arrival time). One
-- Dijkstra from a virtual super-source with an edge of cost `seconds` to each seed then gives
-- the earliest time at every vertex - the same trick as the precompute.

DROP FUNCTION IF EXISTS analytics.point_access(double precision, double precision, text, double precision);

-- Nearest main-component vertex to a point and the time to walk there.
CREATE OR REPLACE FUNCTION analytics.snap_seed(
    p_lon double precision,
    p_lat double precision,
    OUT vertex_id bigint,
    OUT seconds double precision)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_snap_m double precision;
BEGIN
    SELECT n.vertex_id, n.distance_m INTO vertex_id, v_snap_m FROM routing.nearest_vertex(p_lon, p_lat) n;
    IF vertex_id IS NULL OR v_snap_m > 500 THEN
        RAISE EXCEPTION 'point is not near the street network'
            USING ERRCODE = 'invalid_parameter_value',
                  DETAIL = format('nearest street vertex is %s m away', round(v_snap_m));
    END IF;
    seconds := v_snap_m / analytics.mode_speed('walk');
END
$$;

-- Every vertex reachable from the seeds within p_max_seconds.
--
-- p_reverse: time from each vertex *to* the seeds instead of from them (for "how long from
--   here to my office": by bike the graph is directed, so the search runs on the reversed graph).
-- The edge set is limited to a box around the seeds, as far as the remaining budget reaches at
-- the mode's top speed (computed in EPSG:23700, metres).
CREATE OR REPLACE FUNCTION analytics.reach_seeded(
    p_vertices bigint[],
    p_seconds double precision[],
    p_mode text,
    p_max_seconds double precision,
    p_reverse boolean DEFAULT false)
RETURNS TABLE (node bigint, seconds double precision)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_speed double precision := analytics.mode_speed(p_mode);
    v_bbox  geometry;
BEGIN
    IF p_vertices IS NULL OR p_seconds IS NULL OR cardinality(p_vertices) <> cardinality(p_seconds) THEN
        RAISE EXCEPTION 'seed vertices and seconds must be arrays of the same length'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT ST_Transform(ST_SetSRID(ST_Extent(
               ST_Expand(ST_Transform(v.geom, 23700), (p_max_seconds - s.sec) * v_speed + 100))::geometry, 23700), 4326)
    INTO v_bbox
    FROM unnest(p_vertices, p_seconds) AS s (vertex_id, sec)
    JOIN routing.vertices v ON v.id = s.vertex_id
    WHERE s.sec <= p_max_seconds;
    IF v_bbox IS NULL THEN
        RETURN;
    END IF;

    -- Super-source 0 (OSM ids are positive) with negative ids for its edges, like the precompute.
    RETURN QUERY
    SELECT d.end_vid, d.agg_cost
    FROM pgr_dijkstraCost(
        analytics.edges_sql(p_mode, p_reverse, v_bbox)
            || format(' UNION ALL SELECT -row_number() OVER (), 0, s.v, s.sec, -1'
                      ' FROM unnest(%L::bigint[], %L::float8[]) AS s (v, sec) WHERE s.sec <= %s',
                      p_vertices, p_seconds, p_max_seconds),
        0, ARRAY(SELECT v.id FROM routing.vertices v WHERE v.geom && v_bbox), directed => true) d
    WHERE d.agg_cost <= p_max_seconds;
END
$$;

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
    s record;
BEGIN
    SELECT * INTO s FROM analytics.snap_seed(p_lon, p_lat);
    RETURN QUERY
    SELECT r.node, r.seconds
    FROM analytics.reach_seeded(ARRAY[s.vertex_id], ARRAY[s.seconds], p_mode, p_max_seconds) r;
END
$$;

-- H3 cells reached from the seeds, each with its earliest time.
--
-- Every edge touched by the search is sampled every ~30 m; each sample gets the time it is
-- reached from either end (partially reachable edges are cut where time runs out), and each
-- H3 cell keeps its earliest time. Measured on Budapest: ~1 s for 15 min by bike, where
-- buffering the reached streets (ST_Buffer of ~40k segments) took 7.5 s for a single limit.
CREATE OR REPLACE FUNCTION analytics.reach_cells(
    p_vertices bigint[],
    p_seconds double precision[],
    p_mode text,
    p_max_seconds double precision,
    p_reverse boolean DEFAULT false,
    p_resolution integer DEFAULT 10)
RETURNS TABLE (h3 h3index, seconds double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    WITH r AS (
        SELECT * FROM analytics.reach_seeded(p_vertices, p_seconds, p_mode, p_max_seconds, p_reverse)
    ),
    -- The edges come with their columns straight from the source/target index lookups. Joining
    -- them again by id let the planner (which guesses 1,000 rows for any set-returning function)
    -- pick a sequential scan of all 260k edges: 0.5 s of a 0.6 s 10-minute walk.
    touched AS (
        SELECT DISTINCT ON (x.id) x.*
        FROM (
            SELECT e.id, e.source, e.target, e.geom, e.cost_walk_s, e.reverse_cost_walk_s, e.cost_bike_s,
                   e.reverse_cost_bike_s, e.cost_stepfree_s, e.reverse_cost_stepfree_s
            FROM r JOIN routing.edges e ON e.source = r.node
            UNION ALL
            SELECT e.id, e.source, e.target, e.geom, e.cost_walk_s, e.reverse_cost_walk_s, e.cost_bike_s,
                   e.reverse_cost_bike_s, e.cost_stepfree_s, e.reverse_cost_stepfree_s
            FROM r JOIN routing.edges e ON e.target = r.node
        ) x
        ORDER BY x.id
    ),
    costs AS (
        SELECT e.geom,
               CASE p_mode WHEN 'walk' THEN e.cost_walk_s WHEN 'stepfree' THEN e.cost_stepfree_s
                           ELSE e.cost_bike_s END                                                 AS fwd,
               CASE p_mode WHEN 'walk' THEN e.reverse_cost_walk_s WHEN 'stepfree' THEN e.reverse_cost_stepfree_s
                           ELSE e.reverse_cost_bike_s END                                         AS bwd,
               rs.seconds AS s_sec,
               rt.seconds AS t_sec
        FROM touched e
        LEFT JOIN r rs ON rs.node = e.source
        LEFT JOIN r rt ON rt.node = e.target
    ),
    -- Leaving a vertex along the edge uses the travel direction's cost; towards the seeds
    -- (p_reverse) the direction flips.
    e AS (
        SELECT geom, s_sec, t_sec,
               CASE WHEN p_reverse THEN bwd ELSE fwd END AS from_source,
               CASE WHEN p_reverse THEN fwd ELSE bwd END AS from_target
        FROM costs
    ),
    samples AS (
        SELECT dp.geom AS pt,
               least(
                   CASE WHEN e.s_sec IS NOT NULL AND e.from_source > 0
                        THEN e.s_sec + ST_LineLocatePoint(e.geom, dp.geom) * e.from_source END,
                   CASE WHEN e.t_sec IS NOT NULL AND e.from_target > 0
                        THEN e.t_sec + (1 - ST_LineLocatePoint(e.geom, dp.geom)) * e.from_target END
               ) AS seconds
        FROM e
        CROSS JOIN LATERAL ST_DumpPoints(ST_Segmentize(e.geom, 0.0003)) dp
    )
    SELECT h3_latlng_to_cell(s.pt, p_resolution), min(s.seconds)
    FROM samples s
    WHERE s.seconds IS NOT NULL AND s.seconds <= p_max_seconds
    GROUP BY 1;
END
$$;

-- Isochrone polygons (unions of H3 cells, default resolution 10, ~66 m edge) from seeds.
CREATE OR REPLACE FUNCTION analytics.isochrone_seeded(
    p_vertices bigint[],
    p_seconds double precision[],
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
    WITH cells AS (
        SELECT * FROM analytics.reach_cells(p_vertices, p_seconds, p_mode,
                                            (SELECT max(m) FROM unnest(p_minutes) m) * 60.0, false, p_resolution)
    )
    SELECT lim.minutes,
           ST_Multi(h3_cells_to_multi_polygon_geometry(array_agg(c.h3)))
    FROM unnest(p_minutes) AS lim (minutes)
    JOIN cells c ON c.seconds <= lim.minutes * 60
    GROUP BY lim.minutes
    ORDER BY lim.minutes;
END
$$;

-- Isochrones from a point.
DROP FUNCTION IF EXISTS analytics.isochrone(double precision, double precision, text, integer[], double precision);

CREATE OR REPLACE FUNCTION analytics.isochrone(
    p_lon double precision,
    p_lat double precision,
    p_mode text DEFAULT 'walk',
    p_minutes integer[] DEFAULT '{5,10,15}',
    p_resolution integer DEFAULT 10)
RETURNS TABLE (minutes integer, geom geometry)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s record;
BEGIN
    SELECT * INTO s FROM analytics.snap_seed(p_lon, p_lat);
    RETURN QUERY
    SELECT i.minutes, i.geom
    FROM analytics.isochrone_seeded(ARRAY[s.vertex_id], ARRAY[s.seconds], p_mode, p_minutes, p_resolution) i;
END
$$;

-- Minute of the week (0 = Monday 00:00) of a local time, the unit of analytics.poi_hours.
CREATE OR REPLACE FUNCTION analytics.minute_of_week(p_at timestamp)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT (extract(isodow FROM p_at)::int - 1) * 1440
           + extract(hour FROM p_at)::int * 60
           + extract(minute FROM p_at)::int
$$;

-- Easter Sunday of a year (Gregorian calendar; anonymous algorithm, Meeus/Jones/Butcher).
CREATE OR REPLACE FUNCTION analytics.easter_sunday(p_year integer)
RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    a int := p_year % 19;
    b int := p_year / 100;
    c int := p_year % 100;
    d int := b / 4;
    e int := b % 4;
    f int := (b + 8) / 25;
    g int := (b - f + 1) / 3;
    h int := (19 * a + b - d - g + 15) % 30;
    i int := c / 4;
    k int := c % 4;
    l int := (32 + 2 * e + 2 * i - h - k) % 7;
    m int := (a + 11 * h + 22 * l) / 451;
    month int := (h + l - 7 * m + 114) / 31;
    day int := ((h + l - 7 * m + 114) % 31) + 1;
BEGIN
    RETURN make_date(p_year, month, day);
END
$$;

-- The Hungarian public holiday on a date (Labour Code, Mt. 102. §), as a key the UI translates,
-- or NULL. 24 December is not on the list: a bill to add it was before Parliament in autumn
-- 2026. Bridging days (moved working days) are not holidays; the BKK timetable models them.
CREATE OR REPLACE FUNCTION analytics.hu_holiday(p_date date)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    easter date := analytics.easter_sunday(extract(year FROM p_date)::int);
BEGIN
    RETURN CASE
        WHEN to_char(p_date, 'MM-DD') = '01-01' THEN 'new_year'
        WHEN to_char(p_date, 'MM-DD') = '03-15' THEN 'revolution_1848'
        WHEN p_date = easter - 2 THEN 'good_friday'
        WHEN p_date = easter THEN 'easter'
        WHEN p_date = easter + 1 THEN 'easter_monday'
        WHEN to_char(p_date, 'MM-DD') = '05-01' THEN 'labour_day'
        WHEN p_date = easter + 49 THEN 'whit_sunday'
        WHEN p_date = easter + 50 THEN 'whit_monday'
        WHEN to_char(p_date, 'MM-DD') = '08-20' THEN 'state_foundation'
        WHEN to_char(p_date, 'MM-DD') = '10-23' THEN 'revolution_1956'
        WHEN to_char(p_date, 'MM-DD') = '11-01' THEN 'all_saints'
        WHEN to_char(p_date, 'MM-DD') = '12-25' THEN 'christmas'
        WHEN to_char(p_date, 'MM-DD') = '12-26' THEN 'christmas_2'
    END;
END
$$;

-- Is a place with these hours open at a local time? On a public holiday the holiday hours apply
-- where the opening_hours value names PH; NULL when the hours are unknown.
CREATE OR REPLACE FUNCTION analytics.is_open(
    p_open_minutes int4multirange,
    p_holiday_minutes int4multirange,
    p_at timestamp)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN p_at IS NULL OR p_open_minutes IS NULL THEN NULL
        WHEN p_holiday_minutes IS NOT NULL AND analytics.hu_holiday(p_at::date) IS NOT NULL
            THEN p_holiday_minutes @> (extract(hour FROM p_at)::int * 60 + extract(minute FROM p_at)::int)
        ELSE p_open_minutes @> analytics.minute_of_week(p_at)
    END
$$;

-- Nearest POI of every category from the seeds, with travel time.
--
-- p_at: only places open at that local time count; places with unknown opening hours are kept
--   (most OSM shops have no opening_hours tag) and reported with open = NULL. On a public
--   holiday, holiday hours (PH) apply where they are mapped.
CREATE OR REPLACE FUNCTION analytics.point_access_seeded(
    p_vertices bigint[],
    p_seconds double precision[],
    p_mode text DEFAULT 'walk',
    p_max_seconds double precision DEFAULT 1800,
    p_at timestamp DEFAULT NULL)
RETURNS TABLE (category text, seconds double precision, poi_name text, poi_lon double precision,
               poi_lat double precision, opening_hours text, open boolean)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT pv.category, r.seconds, p.name, p.geom, p.opening_hours AS hours,
               analytics.is_open(h.open_minutes, h.holiday_minutes, p_at) AS open
        FROM analytics.reach_seeded(p_vertices, p_seconds, p_mode, p_max_seconds) r
        JOIN analytics.poi_vertex pv ON pv.vertex_id = r.node
        JOIN osm.pois p ON p.osm_type = pv.poi_type AND p.osm_id = pv.poi_id
        LEFT JOIN analytics.poi_hours h ON h.poi_type = p.osm_type AND h.poi_id = p.osm_id
    )
    SELECT DISTINCT ON (c.category)
           c.category, c.seconds, c.name, ST_X(c.geom), ST_Y(c.geom), c.hours, c.open
    FROM candidates c
    WHERE c.open IS NOT FALSE
    ORDER BY c.category, c.seconds, c.open IS NULL, c.name IS NULL, c.name;
END
$$;

-- Nearest POI of every category from a point.
CREATE OR REPLACE FUNCTION analytics.point_access(
    p_lon double precision,
    p_lat double precision,
    p_mode text DEFAULT 'walk',
    p_max_seconds double precision DEFAULT 1800,
    p_at timestamp DEFAULT NULL)
RETURNS TABLE (category text, seconds double precision, poi_name text, poi_lon double precision,
               poi_lat double precision, opening_hours text, open boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s record;
BEGIN
    SELECT * INTO s FROM analytics.snap_seed(p_lon, p_lat);
    RETURN QUERY
    SELECT * FROM analytics.point_access_seeded(ARRAY[s.vertex_id], ARRAY[s.seconds], p_mode, p_max_seconds, p_at);
END
$$;

-- Weighted score (0-100) of every H3 cell for a set of category weights.
-- Categories missing from a cell count as unreachable (score 0).
CREATE OR REPLACE FUNCTION analytics.cell_scores(p_weights jsonb, p_mode text DEFAULT 'walk')
RETURNS TABLE (h3 h3index, district_id bigint, score double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_mode IN ('transit', 'transit_evening') THEN
        -- Precomputed per cell by the API (TransitHeatmap) after each data build: transit for a
        -- weekday 08:00 departure, transit_evening for Sunday 20:00.
        IF NOT EXISTS (SELECT 1 FROM analytics.h3_category_time t WHERE t.mode = p_mode) THEN
            RAISE EXCEPTION 'the public transport heatmap has not been computed for this data release'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    ELSE
        PERFORM analytics.mode_speed(p_mode);
    END IF;
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

-- Martin function source: H3 cells as Mapbox Vector Tiles, shape and district only. The travel
-- times come once per release from the API (/api/v1/cells) and colour the cells through feature
-- state: carried in every tile they were more than half its size, at every zoom level.
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
               ST_AsMVTGeom(ST_Transform(c.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom
        FROM analytics.h3_cell c
        WHERE c.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)
    ) t
    WHERE t.geom IS NOT NULL;
    RETURN mvt;
END
$$;
-- "Where should we live?": the area from which every anchor (an office, a school, a parent's
-- flat) can be reached within its own limit, and the best-scoring hexagons inside it.
--
-- p_anchors: [{"vertices": [..], "seconds": [..], "mode": "walk", "reverse": true, "max_seconds": 1200}, ...]
--   seeds as in reach_seeded. Walking and cycling anchors are searched on the reversed graph
--   (time from home to the anchor); public transport anchors arrive as the stops reached from the
--   anchor, walked on from there (the API runs the timetable search, see TransitService).
-- Spots are resolution-9 cells (the heatmap's) whose centre child lies in the common area, scored
-- with p_weights, at most one per resolution-8 parent so they are spread over the area.
CREATE OR REPLACE FUNCTION analytics.common_ground(
    p_anchors jsonb,
    p_weights jsonb,
    p_score_mode text DEFAULT 'walk',
    p_limit integer DEFAULT 5,
    p_resolution integer DEFAULT 10)
RETURNS TABLE (area geometry, cells integer, spots jsonb)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    n integer;
BEGIN
    IF p_anchors IS NULL OR jsonb_typeof(p_anchors) <> 'array' THEN
        RAISE EXCEPTION 'anchors must be an array' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    n := jsonb_array_length(p_anchors);
    IF n NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION 'between 1 and 4 places are allowed' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_anchors) x
               WHERE (x ->> 'max_seconds')::float8 IS NULL OR (x ->> 'max_seconds')::float8 NOT BETWEEN 60 AND 2700) THEN
        RAISE EXCEPTION 'each limit must be between 1 and 45 minutes' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH a AS (
        SELECT (e.ord - 1)::int AS i,
               ARRAY(SELECT jsonb_array_elements_text(e.x -> 'vertices')::bigint) AS vertices,
               ARRAY(SELECT jsonb_array_elements_text(e.x -> 'seconds')::float8) AS seconds,
               e.x ->> 'mode' AS mode,
               coalesce((e.x ->> 'reverse')::boolean, false) AS reverse,
               (e.x ->> 'max_seconds')::float8 AS max_seconds
        FROM jsonb_array_elements(p_anchors) WITH ORDINALITY AS e (x, ord)
    ),
    per AS (
        SELECT a.i, c.h3, c.seconds
        FROM a
        CROSS JOIN LATERAL analytics.reach_cells(a.vertices, a.seconds, a.mode, a.max_seconds, a.reverse, p_resolution) c
    ),
    common AS MATERIALIZED (
        SELECT per.h3, array_agg(per.seconds ORDER BY per.i) AS seconds
        FROM per
        GROUP BY per.h3
        HAVING count(*) = n
    ),
    candidates AS (
        SELECT DISTINCT ON (h3_cell_to_parent(s.h3, 8))
               s.h3, s.score, c.seconds,
               (SELECT max(x) FROM unnest(c.seconds) x) AS worst
        FROM common c
        JOIN analytics.cell_scores(p_weights, p_score_mode) s
          ON h3_get_resolution(c.h3) >= 9
         AND s.h3 = h3_cell_to_parent(c.h3, 9)
         AND c.h3 = h3_cell_to_center_child(s.h3, p_resolution)
        ORDER BY h3_cell_to_parent(s.h3, 8), s.score DESC, worst
    ),
    best AS (
        SELECT * FROM candidates ORDER BY score DESC, worst LIMIT p_limit
    )
    SELECT (SELECT ST_Multi(h3_cells_to_multi_polygon_geometry(array_agg(c.h3))) FROM common c),
           (SELECT count(*)::int FROM common),
           coalesce((SELECT jsonb_agg(jsonb_build_object(
                                'h3', b.h3::text,
                                'lon', ST_X(h3_cell_to_geometry(b.h3)),
                                'lat', ST_Y(h3_cell_to_geometry(b.h3)),
                                'score', b.score,
                                'seconds', to_jsonb(b.seconds))
                            ORDER BY b.score DESC, b.worst)
                     FROM best b), '[]'::jsonb);
END
$$;

-- Better nearby: hexagons within p_max_seconds' walk of a point that score higher than the
-- point's own hexagon, for people who like an area but not its exact street. At most one per
-- resolution-8 parent (spread over the area), best score first, then the shorter walk. The walk
-- counts to the hexagon's centre child (resolution 10), like the common-ground spots.
CREATE OR REPLACE FUNCTION analytics.better_nearby(
    p_lon double precision,
    p_lat double precision,
    p_weights jsonb,
    p_score_mode text DEFAULT 'walk',
    p_max_seconds double precision DEFAULT 600,
    p_limit integer DEFAULT 3)
RETURNS TABLE (h3 h3index, lon double precision, lat double precision, score double precision,
               seconds double precision, here_score double precision)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s      record;
    v_here h3index;
BEGIN
    IF p_max_seconds IS NULL OR p_max_seconds NOT BETWEEN 60 AND 1800 THEN
        RAISE EXCEPTION 'the walk must be between 1 and 30 minutes' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO s FROM analytics.snap_seed(p_lon, p_lat);
    v_here := h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 9);

    RETURN QUERY
    WITH scores AS MATERIALIZED (
        SELECT * FROM analytics.cell_scores(p_weights, p_score_mode)
    ),
    here AS (
        SELECT coalesce((SELECT x.score FROM scores x WHERE x.h3 = v_here), 0) AS score
    ),
    reached AS (
        SELECT r.h3, r.seconds
        -- Step-free scores are for people who cannot take steps: the walk there avoids them too.
        FROM analytics.reach_cells(ARRAY[s.vertex_id], ARRAY[s.seconds],
                                   CASE WHEN p_score_mode = 'stepfree' THEN 'stepfree' ELSE 'walk' END,
                                   p_max_seconds, false, 10) r
    ),
    candidates AS (
        SELECT DISTINCT ON (h3_cell_to_parent(x.h3, 8)) x.h3, x.score, r.seconds
        FROM reached r
        JOIN scores x
          ON x.h3 = h3_cell_to_parent(r.h3, 9)
         AND r.h3 = h3_cell_to_center_child(x.h3, 10)
        WHERE x.h3 <> v_here
        ORDER BY h3_cell_to_parent(x.h3, 8), x.score DESC, r.seconds
    )
    SELECT c.h3, ST_X(h3_cell_to_geometry(c.h3)), ST_Y(h3_cell_to_geometry(c.h3)), c.score, c.seconds, here.score
    FROM candidates c, here
    -- A point or more: smaller differences are noise from the median of a hexagon's streets.
    WHERE c.score >= here.score + 1
    ORDER BY c.score DESC, c.seconds
    LIMIT p_limit;
END
$$;
