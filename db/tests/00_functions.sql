-- Unit tests for pure SQL functions (no OSM data needed).
BEGIN;
SELECT plan(25);

CREATE FUNCTION pg_temp.near(got double precision, want double precision, tol double precision DEFAULT 1e-6)
RETURNS boolean LANGUAGE sql AS $$ SELECT abs(got - want) <= tol $$;

-- walking
SELECT ok(pg_temp.near(routing.walk_cost_s(80, 'residential'), 60), 'walk: 80 m takes 60 s');
SELECT ok(pg_temp.near(routing.walk_cost_s(80, 'steps'), 120), 'walk: steps take twice as long');
SELECT ok(pg_temp.near(routing.walk_cost_s(0, 'footway'), 0), 'walk: zero length is free');

-- cycling
SELECT ok(pg_temp.near((routing.bike_costs(150, 'residential', '{}')).cost, 36), 'bike: 15 km/h on roads');
SELECT ok(pg_temp.near((routing.bike_costs(150, 'residential', '{}')).reverse_cost, 36), 'bike: two-way by default');
SELECT ok(pg_temp.near((routing.bike_costs(110, 'footway', '{}')).cost, 100), 'bike: pushed on footways (1.1 m/s)');
SELECT ok(pg_temp.near((routing.bike_costs(150, 'footway', '{"bicycle":"designated"}')).cost, 36),
          'bike: rides on footways with bicycle=designated');
SELECT is((routing.bike_costs(100, 'steps', '{}')).cost, -1::float8, 'bike: no steps (forward)');
SELECT is((routing.bike_costs(100, 'steps', '{}')).reverse_cost, -1::float8, 'bike: no steps (reverse)');
SELECT is((routing.bike_costs(100, 'path', '{"bicycle":"no"}')).cost, -1::float8, 'bike: bicycle=no is respected');
SELECT ok(pg_temp.near((routing.bike_costs(110, 'pedestrian', '{"bicycle":"no"}')).cost, 100),
          'bike: pushed through pedestrian streets with bicycle=no');
SELECT is((routing.bike_costs(100, 'residential', '{"oneway":"yes"}')).reverse_cost, -1::float8,
          'bike: oneway=yes blocks the reverse direction');
SELECT is((routing.bike_costs(100, 'residential', '{"oneway":"-1"}')).cost, -1::float8,
          'bike: oneway=-1 blocks the forward direction');
SELECT is((routing.bike_costs(100, 'residential', '{"junction":"roundabout"}')).reverse_cost, -1::float8,
          'bike: roundabouts are oneway');
SELECT ok((routing.bike_costs(100, 'residential', '{"oneway":"yes","oneway:bicycle":"no"}')).reverse_cost > 0,
          'bike: oneway:bicycle=no allows contraflow');

-- scoring
SELECT is(analytics.access_score(0), 1::float8, 'score: 1 at the doorstep');
SELECT is(analytics.access_score(450), 0.5::float8, 'score: 0.5 at half the limit');
SELECT is(analytics.access_score(2000), 0::float8, 'score: 0 beyond the limit');
SELECT is(analytics.access_score(NULL), 0::float8, 'score: 0 when unreachable');

SELECT throws_ok($$ SELECT analytics.edges_sql('car') $$, '22023', 'unknown travel mode: car',
                 'edges_sql rejects unknown modes');
SELECT matches(analytics.edges_sql('bike', true), 'reverse_cost_bike_s AS cost, cost_bike_s AS reverse_cost',
               'edges_sql reverses the graph for precompute');
SELECT matches(analytics.edges_sql('walk', false, ST_MakeEnvelope(19, 47, 20, 48, 4326)), 'WHERE geom && ',
               'edges_sql applies the bbox filter');

-- geocoding normalisation
SELECT is(search.normalize('Andrássy u. 12/B'), 'andrassy utca 12/b', 'normalize: accents, case, u. -> utca');
SELECT is(search.normalize('Szent István krt.'), 'szent istvan korut', 'normalize: krt. -> korut');
SELECT is(search.normalize('  Váci   út, 1 '), 'vaci ut 1', 'normalize: punctuation and spaces');

SELECT * FROM finish();
ROLLBACK;
