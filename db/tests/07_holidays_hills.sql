-- Phase 7: public holidays and hill-aware cycling.
-- Grid: one block is 75 s on foot and 24 s by bike (80 m). Corner Market (at 1000) opens
-- Mo-Sa 07:00-21:00 and 08:00-12:00 on public holidays; Island Cafe has no PH rule.
BEGIN;
SELECT plan(19);

CREATE FUNCTION pg_temp.v(p_id bigint) RETURNS geometry LANGUAGE sql AS $$
    SELECT geom FROM routing.vertices WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.open_at(p_from bigint, p_category text, p_at timestamp) RETURNS boolean LANGUAGE sql AS $$
    SELECT a.open
    FROM analytics.point_access(ST_X(pg_temp.v(p_from)), ST_Y(pg_temp.v(p_from)), 'walk', 1800, p_at) a
    WHERE a.category = p_category
$$;

-- holiday calendar
SELECT is(analytics.easter_sunday(2026), '2026-04-05'::date, 'Easter Sunday 2026');
SELECT is(analytics.easter_sunday(2027), '2027-03-28'::date, 'Easter Sunday 2027');
SELECT is(analytics.hu_holiday('2027-03-26'), 'good_friday', 'Good Friday 2027');
SELECT is(analytics.hu_holiday('2027-05-17'), 'whit_monday', 'Whit Monday 2027 (Easter + 50 days)');
SELECT is(analytics.hu_holiday('2026-10-23'), 'revolution_1956', '23 October');
SELECT is(analytics.hu_holiday('2026-12-24'), NULL, '24 December is not a statutory holiday');
SELECT is(analytics.hu_holiday('2026-11-17'), NULL, 'an ordinary Tuesday');

-- holiday hours
SELECT is((SELECT holiday_minutes::text FROM analytics.poi_hours h JOIN osm.pois p
           ON p.osm_type = h.poi_type AND p.osm_id = h.poi_id WHERE p.name = 'Corner Market'),
          '{[480,720)}', 'PH 08:00-12:00 is stored in minutes of the day');
SELECT is(pg_temp.open_at(1000, 'grocery', '2026-12-25 10:00'), true,
          'Christmas (a Friday) 10:00: the market keeps its holiday hours');
SELECT is((SELECT count(*)::int FROM analytics.point_access(ST_X(pg_temp.v(1000)), ST_Y(pg_temp.v(1000)), 'walk', 1800,
                                                            '2026-12-25 13:00') WHERE category = 'grocery'), 0,
          'Christmas 13:00: closed, although a Friday afternoon is open');
SELECT is(pg_temp.open_at(1000, 'grocery', '2026-12-18 13:00'), true, 'the Friday before: weekly hours');
SELECT is(pg_temp.open_at(1000, 'food', '2026-12-25 13:00'), true,
          'a place without a PH rule keeps its weekly hours on a holiday');

-- hills: a climb makes cycling slower uphill and faster downhill, never faster than 30 km/h
SELECT is(round(routing.bike_hill_cost(24, 80, 0, 0))::int, 24, 'flat: unchanged');
SELECT cmp_ok(routing.bike_hill_cost(24, 80, 8, 0), '>', 50::double precision, '10 % up: more than twice as long');
SELECT cmp_ok(routing.bike_hill_cost(24, 80, 0, 8), '<', 24::double precision, '10 % down: faster');
SELECT is(round(routing.bike_hill_cost(24, 80, 0, 40))::int, round(80 / (30 / 3.6))::int,
          'steep descent: capped at 30 km/h');

-- applying a DEM: edge 1000 -> 1001 climbs 8 m
CREATE TEMP TABLE e AS SELECT id, cost_bike_s, reverse_cost_bike_s FROM routing.edges
    WHERE (source, target) IN ((1000, 1001), (1001, 1000)) LIMIT 1;
INSERT INTO routing.edge_elevation (edge_id, climb_m, descent_m)
SELECT id, CASE WHEN (SELECT source FROM routing.edges x WHERE x.id = e.id) = 1000 THEN 8 ELSE 0 END,
       CASE WHEN (SELECT source FROM routing.edges x WHERE x.id = e.id) = 1000 THEN 0 ELSE 8 END
FROM e;
SELECT is(routing.apply_elevation(), 1::bigint, 'elevation applied to one edge');
SELECT cmp_ok((SELECT round(agg_cost)::int FROM pgr_dijkstraCost(analytics.edges_sql('bike'), 1000, 1001)), '>', 50,
              'cycling 1000 -> 1001 now climbs');
SELECT throws_ok($$ SELECT routing.apply_elevation() $$, 'P0001',
                 'elevation is already applied to this graph; rebuild it first', 'elevation is applied once per build');

SELECT * FROM finish();
ROLLBACK;
