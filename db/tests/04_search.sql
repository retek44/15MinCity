-- Geocoding on the synthetic grid fixture.
BEGIN;
SELECT plan(8);

SELECT is((SELECT count(*)::int FROM search.place WHERE kind = 'address'), 1, 'one address indexed');
SELECT is((SELECT count(*)::int FROM search.place WHERE kind = 'poi'), 6, 'named POIs indexed');

SELECT results_eq(
    $$ SELECT kind, label FROM search.search('andrassy 1') LIMIT 1 $$,
    $$ VALUES ('address', 'Andrássy út 1') $$,
    'house number query finds the address, without accents');
SELECT results_eq(
    $$ SELECT kind, label FROM search.search('Andrasy ut') LIMIT 1 $$,
    $$ VALUES ('street', 'Andrássy út') $$,
    'typo without house number prefers the street');
SELECT results_eq(
    $$ SELECT kind, label, category FROM search.search('grid pharm') LIMIT 1 $$,
    $$ VALUES ('poi', 'Grid Pharmacy', 'pharmacy') $$,
    'POIs are searchable by name prefix');
SELECT is_empty($$ SELECT * FROM search.search('x') $$, 'one-letter queries return nothing');

SELECT results_eq(
    $$ SELECT r.label FROM routing.vertices v, search.reverse(ST_X(v.geom), ST_Y(v.geom)) r WHERE v.id = 1022 $$,
    $$ VALUES ('Andrássy út 1') $$,
    'reverse geocoding finds the address at the same spot');
SELECT is_empty($$ SELECT * FROM search.reverse(19.2, 47.6) $$, 'reverse returns nothing far from any address');

SELECT * FROM finish();
ROLLBACK;
