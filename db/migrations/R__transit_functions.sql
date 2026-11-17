-- Repeatable migration: public transport helpers. The timetable search itself (RAPTOR) runs in
-- the API over an in-memory copy of one service day; the database snaps stops to the street
-- graph, finds the stops a point can walk to, and walks on from the stops a journey reaches.

-- Snaps every stop to the nearest main-component street vertex (within p_max_snap_m).
CREATE OR REPLACE FUNCTION transit.snap_stops(p_max_snap_m double precision DEFAULT 300)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    TRUNCATE transit.stop_vertex;
    INSERT INTO transit.stop_vertex (stop_idx, vertex_id, distance_m)
    SELECT s.stop_idx, nv.id, ST_Distance(nv.geom::geography, s.geom::geography)
    FROM transit.stops s
    CROSS JOIN LATERAL (
        SELECT v.id, v.geom
        FROM routing.vertices v
        WHERE v.in_main_component
        ORDER BY v.geom <-> s.geom
        LIMIT 1
    ) nv
    WHERE ST_DWithin(nv.geom::geography, s.geom::geography, p_max_snap_m);
    ANALYZE transit.stop_vertex;
    SELECT count(*) INTO n FROM transit.stop_vertex;
    RETURN n;
END
$$;

-- RAPTOR footpaths: walking transfers between stops at most p_max_m apart, timed as the straight
-- line times p_detour at walking speed. Transfers are short (mostly between the platforms of one
-- interchange), so the street graph would add little but minutes of pipeline time.
CREATE OR REPLACE FUNCTION transit.build_transfers(
    p_max_m double precision DEFAULT 250,
    p_detour double precision DEFAULT 1.3)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    TRUNCATE transit.transfers;
    INSERT INTO transit.transfers (from_stop, to_stop, seconds)
    SELECT a.stop_idx, b.stop_idx,
           ceil(ST_Distance(a.geom::geography, b.geom::geography) * p_detour / analytics.mode_speed('walk'))::int
    FROM transit.stops a
    JOIN transit.stops b
      ON b.stop_idx <> a.stop_idx
     AND b.geom && ST_Expand(a.geom, 0.005)
     AND ST_DWithin(a.geom::geography, b.geom::geography, p_max_m);
    SELECT count(*) INTO n FROM transit.transfers;
    RETURN n;
END
$$;

-- Stops reachable on foot from a point, with the walking time (including the stop's own snap
-- distance). The start of every public transport journey.
CREATE OR REPLACE FUNCTION transit.access_stops(
    p_lon double precision,
    p_lat double precision,
    p_max_seconds double precision DEFAULT 900)
RETURNS TABLE (stop_idx integer, seconds double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    SELECT sv.stop_idx, r.seconds + sv.distance_m / analytics.mode_speed('walk')
    FROM analytics.reach(p_lon, p_lat, 'walk', p_max_seconds) r
    JOIN transit.stop_vertex sv ON sv.vertex_id = r.node
    WHERE r.seconds + sv.distance_m / analytics.mode_speed('walk') <= p_max_seconds;
END
$$;

-- GTFS services running on a date: calendar.txt weekdays, plus added dates, minus removed dates.
CREATE OR REPLACE FUNCTION transit.services_on(p_date date)
RETURNS SETOF text
LANGUAGE sql STABLE AS $$
    SELECT c.service_id FROM transit.calendar c
    WHERE p_date BETWEEN c.start_date AND c.end_date
      AND extract(isodow FROM p_date)::smallint = ANY (c.weekdays)
    UNION
    SELECT d.service_id FROM transit.calendar_dates d WHERE d.date = p_date AND d.exception_type = 1
    EXCEPT
    SELECT d.service_id FROM transit.calendar_dates d WHERE d.date = p_date AND d.exception_type = 2
$$;
