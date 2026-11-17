-- osm2pgsql flex mapping, checked against the synthetic grid fixture.
BEGIN;
SELECT plan(10);

SELECT is((SELECT count(*)::int FROM osm.walk_ways), 22, 'walkable ways: 20 grid streets + island + steps');
SELECT is((SELECT count(*)::int FROM osm.walk_ways WHERE way_id = 30), 0, 'foot=no footway is not walkable');
SELECT is((SELECT count(*)::int FROM osm.walk_ways WHERE way_id = 31), 0, 'motorway is not walkable');
SELECT is((SELECT cardinality(nodes) FROM osm.walk_ways WHERE way_id = 1), 10, 'node id list is stored');

SELECT results_eq(
    $$ SELECT category, count(*)::int FROM osm.pois GROUP BY category ORDER BY category $$,
    $$ VALUES ('food', 1), ('grocery', 1), ('park', 1), ('pharmacy', 1), ('school', 1), ('transit', 1) $$,
    'POIs are mapped to categories');
SELECT isnt((SELECT area_geom FROM osm.pois WHERE category = 'park'), NULL, 'park keeps its outline');
SELECT is((SELECT area_geom FROM osm.pois WHERE category = 'grocery'), NULL, 'point POIs have no outline');

SELECT results_eq(
    $$ SELECT street, housenumber, postcode FROM osm.addresses $$,
    $$ VALUES ('Andrássy út', '1', '1061') $$,
    'address is imported with accents intact');

SELECT results_eq(
    $$ SELECT name, admin_level FROM osm.districts $$,
    $$ VALUES ('Test District', 9) $$,
    'district boundary relation is imported');
SELECT ok((SELECT ST_IsValid(geom) FROM osm.districts), 'district geometry is valid');

SELECT * FROM finish();
ROLLBACK;
