-- Phase 8: step-free walking and better nearby. On the grid, the school (3101) is reached only by the steps north
-- of the far corner (1099): on foot it is 150 s from there, step-free it cannot be reached.
BEGIN;
SELECT plan(14);

CREATE FUNCTION pg_temp.t(p_mode text, p_category text, p_vertex bigint)
RETURNS double precision LANGUAGE sql AS $$
    SELECT seconds FROM analytics.vertex_category_time
    WHERE mode = p_mode AND category = p_category AND vertex_id = p_vertex
$$;

-- cost function
SELECT is(routing.stepfree_cost_s(100, 'steps', '{}'), -1::float8, 'step-free: steps cannot be used');
SELECT is(routing.stepfree_cost_s(100, 'footway', '{"wheelchair":"no"}'), -1::float8,
          'step-free: wheelchair=no cannot be used');
SELECT is(routing.stepfree_cost_s(80, 'footway', '{}'), routing.walk_cost_s(80, 'footway'),
          'step-free: otherwise the walking time');
SELECT is(analytics.mode_speed('stepfree'), analytics.mode_speed('walk'), 'step-free: walking speed');

-- graph and precompute
SELECT is((SELECT count(*) FROM routing.edges WHERE highway = 'steps' AND cost_stepfree_s <> -1), 0::bigint,
          'every steps edge is closed step-free');
SELECT is(pg_temp.t('stepfree', 'grocery', 1099), pg_temp.t('walk', 'grocery', 1099),
          'without steps on the way, step-free equals walking');
SELECT is(pg_temp.t('stepfree', 'school', 1099), NULL, 'step-free: the school behind the steps is out of reach');
SELECT ok(pg_temp.t('walk', 'school', 1099) IS NOT NULL, 'on foot the school is reachable');

-- on demand
SELECT is((SELECT a.seconds FROM analytics.point_access(
               (SELECT ST_X(geom) FROM routing.vertices WHERE id = 1099),
               (SELECT ST_Y(geom) FROM routing.vertices WHERE id = 1099), 'stepfree') a
           WHERE a.category = 'school'), NULL,
          'point access step-free: no school');

-- better nearby: from the far corner (1099), 18 blocks from the only grocery, hexagons closer to it
CREATE TEMP TABLE nearby AS
SELECT * FROM analytics.better_nearby(
    (SELECT ST_X(geom) FROM routing.vertices WHERE id = 1099),
    (SELECT ST_Y(geom) FROM routing.vertices WHERE id = 1099),
    '{"grocery": 1}', 'walk', 600, 3);
SELECT ok((SELECT count(*) FROM nearby) BETWEEN 1 AND 3, 'better nearby: up to three hexagons');
SELECT is((SELECT count(*) FROM nearby WHERE score < here_score + 1), 0::bigint, 'each scores higher than here');
SELECT is((SELECT count(*) FROM nearby WHERE seconds > 600), 0::bigint, 'each is within the walk');
SELECT is((SELECT count(DISTINCT h3_cell_to_parent(h3, 8)) FROM nearby), (SELECT count(*) FROM nearby),
          'spread: one per resolution-8 parent');
SELECT throws_ok($$SELECT * FROM analytics.better_nearby(19.05, 47.5, '{"grocery": 1}', 'walk', 5000)$$,
                 '22023', NULL, 'better nearby: the walk is limited to 30 minutes');

SELECT * FROM finish();
ROLLBACK;
