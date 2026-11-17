-- On-demand queries used by the API: reach, isochrone, point access, scoring, tiles.
-- One block is 75 s on foot and 24 s by bike; row 0 is oneway eastwards.
BEGIN;
SELECT plan(22);

CREATE FUNCTION pg_temp.v(p_id bigint) RETURNS geometry LANGUAGE sql AS $$
    SELECT geom FROM routing.vertices WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.iso(p_from bigint, p_mode text, p_minutes int) RETURNS geometry LANGUAGE sql AS $$
    SELECT i.geom FROM analytics.isochrone(ST_X(pg_temp.v(p_from)), ST_Y(pg_temp.v(p_from)), p_mode, ARRAY[p_minutes]) i
$$;

-- reach
SELECT set_eq(
    $$ SELECT node FROM analytics.reach(ST_X(pg_temp.v(1000)), ST_Y(pg_temp.v(1000)), 'walk', 160) $$,
    ARRAY[1000, 1001, 1002, 1010, 1011, 1020]::bigint[],
    'reach: vertices within two blocks on foot');
SELECT throws_ok(
    $$ SELECT * FROM analytics.reach(19.2, 47.6, 'walk', 600) $$,
    '22023', 'point is not near the street network', 'reach: rejects points far from any street');

-- isochrone geometry
SELECT ok(ST_Contains(pg_temp.iso(1000, 'walk', 5), pg_temp.v(1003)), 'isochrone 5 min contains 3 blocks east');
SELECT ok(ST_Contains(pg_temp.iso(1000, 'walk', 5), pg_temp.v(1021)), 'isochrone 5 min contains 2+1 blocks diagonal');
SELECT ok(NOT ST_Contains(pg_temp.iso(1000, 'walk', 5), pg_temp.v(1006)), 'isochrone 5 min excludes 6 blocks east');
SELECT ok(NOT ST_Contains(pg_temp.iso(1000, 'walk', 5), pg_temp.v(1033)), 'isochrone 5 min excludes 3+3 blocks');
SELECT ok(ST_IsValid(pg_temp.iso(1000, 'walk', 15)), 'isochrone polygon is valid');
SELECT is(GeometryType(pg_temp.iso(1000, 'walk', 1)), 'MULTIPOLYGON', 'isochrone is always a MultiPolygon');
SELECT is((SELECT array_agg(minutes ORDER BY minutes) FROM analytics.isochrone(
               ST_X(pg_temp.v(1044)), ST_Y(pg_temp.v(1044)), 'walk', ARRAY[10, 5, 15])),
          ARRAY[5, 10, 15], 'one polygon per limit, sorted');
SELECT ok(ST_Area(ST_Difference(pg_temp.iso(1044, 'walk', 5), pg_temp.iso(1044, 'walk', 10)))
          < 0.01 * ST_Area(pg_temp.iso(1044, 'walk', 5)),
          'property: the 5 min polygon lies inside the 10 min one');
-- H3 res 10 cells are <= 132 m across, so the excluded vertices below are >= 141 m from anything reached.
SELECT ok(ST_Contains(pg_temp.iso(1005, 'bike', 2), pg_temp.v(1009)), 'bike: 4 blocks east along the oneway (96 s)');
SELECT ok(NOT ST_Contains(pg_temp.iso(1005, 'bike', 2), pg_temp.v(1000)), 'bike: not 5 blocks west against it (168 s detour)');
SELECT throws_ok(
    $$ SELECT * FROM analytics.isochrone(19.05, 47.5, 'walk', ARRAY[0]) $$,
    '22023', 'minutes must be between 1 and 30', 'isochrone: rejects 0 minutes');
SELECT throws_ok(
    $$ SELECT * FROM analytics.isochrone(19.05, 47.5, 'walk', ARRAY[31]) $$,
    '22023', 'minutes must be between 1 and 30', 'isochrone: rejects more than 30 minutes');

-- point access
SELECT results_eq(
    $$ SELECT category, round(seconds)::int, poi_name
       FROM analytics.point_access(ST_X(pg_temp.v(1000)), ST_Y(pg_temp.v(1000)), 'walk') ORDER BY category $$,
    $$ VALUES ('food', 1050, 'Island Cafe'), ('grocery', 0, 'Corner Market'), ('park', 450, 'Grid Park'),
              ('pharmacy', 1350, 'Grid Pharmacy'), ('school', 1500, 'Steps School'), ('transit', 675, 'Grid Stop') $$,
    'point access: nearest POI of every category, named');
SELECT is((SELECT round(seconds)::int FROM analytics.point_access(ST_X(pg_temp.v(1000)) - 0.00133, ST_Y(pg_temp.v(1000)), 'walk')
           WHERE category = 'grocery'), 75,
          'point access: walking from the point to the street counts (100 m off the grid)');

-- scoring
SELECT ok((SELECT bool_and(score BETWEEN 0 AND 100) FROM analytics.cell_scores('{"grocery": 2, "park": 1}')),
          'cell scores are within 0..100');
SELECT throws_ok($$ SELECT * FROM analytics.cell_scores('{}') $$, '22023', NULL, 'scoring rejects empty weights');
SELECT results_eq(
    $$ SELECT name, cells > 0 FROM analytics.district_ranking('{"grocery": 1}') $$,
    $$ VALUES ('Test District', true) $$,
    'district ranking covers the district');
SELECT ok((SELECT west < 19.0553 AND east > 19.0553 AND south < 47.5036 AND north > 47.5036
           FROM analytics.district_ranking('{"grocery": 1}')),
          'district ranking returns a bounding box around the district');

-- vector tiles (z14 tile containing the grid origin)
SELECT ok(length(analytics.h3_tiles(14,
              floor((19.05 + 180) / 360 * 16384)::int,
              floor((1 - ln(tan(radians(47.5)) + 1 / cos(radians(47.5))) / pi()) / 2 * 16384)::int)) > 0,
          'h3_tiles returns a non-empty tile for the grid');
SELECT ok((SELECT times ? 'walk_grocery' AND times ? 'bike_grocery'
           FROM analytics.h3_cell WHERE h3 = h3_latlng_to_cell(pg_temp.v(1000), 9)),
          'cell properties carry per-mode, per-category times');

SELECT * FROM finish();
ROLLBACK;
