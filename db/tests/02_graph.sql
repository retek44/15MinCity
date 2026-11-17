-- routing.build_graph() and routing.snap_sources() on the synthetic grid fixture.
-- Grid vertex (row, col) has id 1000 + 10 * row + col.
BEGIN;
SELECT plan(15);

SELECT is((SELECT count(*)::int FROM routing.edges), 182, 'edges: 180 grid blocks + island + steps');
SELECT is((SELECT count(*)::int FROM routing.vertices), 103, 'vertices: 100 grid + island pair + steps end');
SELECT ok((SELECT bool_and(abs(length_m - 100) < 0.5) FROM routing.edges),
          'every edge is ~100 m (ways are split at junctions)');
SELECT is_empty(
    $$ SELECT id FROM routing.edges e
       WHERE NOT EXISTS (SELECT 1 FROM routing.vertices v WHERE v.id = e.source)
          OR NOT EXISTS (SELECT 1 FROM routing.vertices v WHERE v.id = e.target) $$,
    'every edge endpoint is a vertex');
SELECT ok((SELECT bool_and(ST_IsValid(geom)) FROM routing.edges), 'edge geometries are valid');

-- connected components
SELECT is((SELECT count(*)::int FROM routing.vertices WHERE in_main_component), 101,
          'main component: grid + steps end');
SELECT is((SELECT count(*)::int FROM routing.vertices WHERE id IN (3001, 3002) AND in_main_component), 0,
          'island is not in the main component');

-- costs
SELECT ok((SELECT abs(cost_walk_s - 150) < 1 FROM routing.edges WHERE highway = 'steps'),
          'steps: 100 m costs 150 s on foot');
SELECT ok((SELECT cost_bike_s > 0 AND reverse_cost_bike_s = -1
           FROM routing.edges WHERE source = 1000 AND target = 1001),
          'oneway row 0 is one-directional for bikes');
SELECT ok((SELECT cost_walk_s = reverse_cost_walk_s FROM routing.edges WHERE source = 1000 AND target = 1001),
          'oneway does not restrict walking');

-- POI sources
SELECT results_eq(
    $$ SELECT category, vertex_id FROM analytics.category_sources WHERE category <> 'park' ORDER BY category $$,
    $$ VALUES ('food', 1059::bigint), ('grocery', 1000), ('pharmacy', 1099), ('school', 3101), ('transit', 1009) $$,
    'point POIs snap to their nearest vertex');
SELECT is((SELECT vertex_id FROM analytics.category_sources WHERE category = 'food'), 1059::bigint,
          'cafe on the island snaps to the main component, not to the island');
SELECT set_eq(
    $$ SELECT vertex_id FROM analytics.category_sources WHERE category = 'park' $$,
    ARRAY[1033, 1034, 1035, 1043, 1044, 1045, 1053, 1054, 1055]::bigint[],
    'park is reachable from every vertex on or inside its outline');
SELECT is_empty(
    $$ SELECT s.vertex_id FROM analytics.category_sources s
       JOIN routing.vertices v ON v.id = s.vertex_id WHERE NOT v.in_main_component $$,
    'no source outside the main component');

SELECT is((SELECT (routing.build_graph()).skipped_ways), 0::bigint, 'no way is skipped while building');

SELECT * FROM finish();
ROLLBACK;
