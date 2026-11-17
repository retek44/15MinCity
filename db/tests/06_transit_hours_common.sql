-- Phase 6: opening hours, public transport helpers, seeded search and "where should we live?".
-- Grid: one block is 75 s on foot and 24 s by bike; row 0 is oneway eastwards. The GTFS fixture
-- runs tram T1 from Corner (1000) to Far Corner (1099) in 3 minutes on weekdays.
BEGIN;
SELECT plan(26);

CREATE FUNCTION pg_temp.v(p_id bigint) RETURNS geometry LANGUAGE sql AS $$
    SELECT geom FROM routing.vertices WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.access_at(p_from bigint, p_at timestamp)
RETURNS TABLE (category text, seconds int, poi_name text, open boolean) LANGUAGE sql AS $$
    SELECT a.category, round(a.seconds)::int, a.poi_name, a.open
    FROM analytics.point_access(ST_X(pg_temp.v(p_from)), ST_Y(pg_temp.v(p_from)), 'walk', 1800, p_at) a
$$;
CREATE FUNCTION pg_temp.anchor(p_vertex bigint, p_mode text, p_minutes int) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('vertices', jsonb_build_array(p_vertex), 'seconds', jsonb_build_array(0),
                              'mode', p_mode, 'reverse', true, 'max_seconds', p_minutes * 60)
$$;

-- opening hours
SELECT is(analytics.minute_of_week('2026-11-17 08:30'), 1950, 'minute of week: Tuesday 08:30');
SELECT is((SELECT count(*)::int FROM analytics.poi_hours), 3, 'hours: every tagged fixture POI is parsed');
SELECT is((SELECT category FROM pg_temp.access_at(1000, '2026-11-22 12:00') WHERE category = 'grocery'), NULL,
          'hours: the only grocery is closed on Sunday, so none is reachable');
SELECT is((SELECT seconds FROM pg_temp.access_at(1000, '2026-11-17 10:00') WHERE category = 'grocery'), 0,
          'hours: it is open on Tuesday morning');
SELECT is((SELECT open FROM pg_temp.access_at(1000, '2026-11-17 10:00') WHERE category = 'grocery'), true,
          'hours: and reported as open');
SELECT is((SELECT open FROM pg_temp.access_at(1000, '2026-11-22 03:00') WHERE category = 'pharmacy'), true,
          'hours: 24/7 pharmacy is open at night');
SELECT is((SELECT open FROM pg_temp.access_at(1000, '2026-11-22 12:00') WHERE category = 'park'), NULL,
          'hours: places without opening_hours stay in, as unknown');
SELECT is((SELECT count(*)::int FROM pg_temp.access_at(1000, '2026-11-22 12:00') WHERE category = 'food'), 0,
          'hours: weekday-only cafe is skipped on Sunday');
SELECT is((SELECT open FROM pg_temp.access_at(1000, NULL) WHERE category = 'grocery'), NULL,
          'hours: without a time nothing is filtered or judged');

-- transit
SELECT set_eq($$ SELECT vertex_id FROM transit.stop_vertex $$, ARRAY[1000, 1099]::bigint[],
               'stops snap to their street vertices');
SELECT set_eq($$ SELECT * FROM transit.services_on('2026-11-17') $$, ARRAY['WD'], 'service runs on a Tuesday');
SELECT is_empty($$ SELECT * FROM transit.services_on('2026-11-21') $$, 'no service on Saturday');
SELECT is_empty($$ SELECT * FROM transit.services_on('2026-12-25') $$, 'calendar_dates removes Christmas');
SELECT results_eq(
    $$ SELECT s.stop_id, round(a.seconds)::int FROM transit.access_stops(ST_X(pg_temp.v(1001)), ST_Y(pg_temp.v(1001)), 900) a
       JOIN transit.stops s USING (stop_idx) $$,
    $$ VALUES ('corner', 75) $$,
    'access stops: Corner is one block away, Far Corner is beyond 15 minutes');

-- seeded search
SELECT is((SELECT round(seconds)::int FROM analytics.reach_seeded(ARRAY[1000, 1099]::bigint[], ARRAY[0, 180]::float8[], 'walk', 1800)
           WHERE node = 1098), 255, 'seeded: a later seed (tram arrival) wins where it is closer');
SELECT is((SELECT round(seconds)::int FROM analytics.reach_seeded(ARRAY[1000]::bigint[], ARRAY[0]::float8[], 'bike', 600, true)
           WHERE node = 1005), 168, 'seeded reverse: by bike from 1005 to 1000 takes the oneway detour');
SELECT is((SELECT round(seconds)::int FROM analytics.reach_seeded(ARRAY[1000]::bigint[], ARRAY[0]::float8[], 'bike', 600, false)
           WHERE node = 1005), 120, 'seeded forward: from 1000 to 1005 runs with the oneway');
SELECT ok(ST_Contains((SELECT geom FROM analytics.isochrone_seeded(ARRAY[1000, 1099]::bigint[], ARRAY[0, 180]::float8[], 'walk', ARRAY[5])),
                      pg_temp.v(1098)), 'seeded isochrone: 5 minutes reach past the tram stop');
SELECT throws_ok($$ SELECT * FROM analytics.reach_seeded(ARRAY[1000]::bigint[], ARRAY[]::float8[], 'walk', 60) $$,
                 '22023', NULL, 'seeded: mismatched seed arrays are rejected');

-- where should we live?
CREATE TEMP TABLE cg AS
SELECT * FROM analytics.common_ground(
    jsonb_build_array(pg_temp.anchor(1000, 'walk', 5), pg_temp.anchor(1004, 'walk', 5)), '{"grocery": 1}');
SELECT ok((SELECT ST_Contains(area, pg_temp.v(1002)) FROM cg), 'common ground: 2 blocks from both places is in');
SELECT ok((SELECT NOT ST_Intersects(area, pg_temp.v(1020)) FROM cg), 'common ground: 6 blocks from one place is out');
SELECT ok((SELECT cells > 0 AND jsonb_typeof(spots) = 'array' FROM cg), 'common ground: cells and spots');
SELECT ok((SELECT bool_and(jsonb_array_length(s -> 'seconds') = 2
                           AND (SELECT max(x::float8) FROM jsonb_array_elements_text(s -> 'seconds') x) <= 300
                           AND (s ->> 'score')::float8 BETWEEN 0 AND 100)
           FROM cg, jsonb_array_elements(cg.spots) s) IS NOT FALSE,
          'common ground: every spot is within both limits and scored');
SELECT results_eq(
    $$ SELECT area IS NULL, cells, spots FROM analytics.common_ground(
           jsonb_build_array(pg_temp.anchor(1000, 'walk', 2), pg_temp.anchor(1099, 'walk', 2)), '{"grocery": 1}') $$,
    $$ VALUES (true, 0, '[]'::jsonb) $$,
    'common ground: far apart places with short limits share nothing');
SELECT throws_ok(
    $$ SELECT * FROM analytics.common_ground(jsonb_build_array(pg_temp.anchor(1000, 'walk', 5), pg_temp.anchor(1000, 'walk', 5),
           pg_temp.anchor(1000, 'walk', 5), pg_temp.anchor(1000, 'walk', 5), pg_temp.anchor(1000, 'walk', 5)), '{"grocery": 1}') $$,
    '22023', 'between 1 and 4 places are allowed', 'common ground: at most four places');
SELECT throws_ok(
    $$ SELECT * FROM analytics.common_ground(jsonb_build_array(pg_temp.anchor(1000, 'walk', 60)), '{"grocery": 1}') $$,
    '22023', 'each limit must be between 1 and 45 minutes', 'common ground: limits are capped');

SELECT * FROM finish();
ROLLBACK;
