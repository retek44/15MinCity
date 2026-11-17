-- Precomputed travel times on the synthetic grid. Expected values are derived by hand:
-- one 100 m block is 75 s on foot and 24 s by bike.
BEGIN;
SELECT plan(14);

CREATE FUNCTION pg_temp.t(p_mode text, p_category text, p_vertex bigint)
RETURNS double precision LANGUAGE sql AS $$
    SELECT seconds FROM analytics.vertex_category_time
    WHERE mode = p_mode AND category = p_category AND vertex_id = p_vertex
$$;

CREATE FUNCTION pg_temp.near(got double precision, want double precision)
RETURNS boolean LANGUAGE sql AS $$ SELECT abs(got - want) <= 0.01 * want + 0.5 $$;

-- walking
SELECT is(pg_temp.t('walk', 'grocery', 1000), 0::float8, 'walk: grocery is 0 s from its own vertex');
SELECT ok(pg_temp.near(pg_temp.t('walk', 'grocery', 1099), 1350), 'walk: far corner is 18 blocks from grocery');
SELECT ok(pg_temp.near(pg_temp.t('walk', 'pharmacy', 1000), 1350), 'walk: and the other way round');
SELECT is_empty(
    $$ SELECT v.id FROM routing.vertices v
       JOIN analytics.vertex_category_time t ON t.vertex_id = v.id AND t.mode = 'walk' AND t.category = 'grocery'
       WHERE v.id BETWEEN 1000 AND 1099
         AND abs(t.seconds - ((v.id - 1000) / 10 + (v.id - 1000) % 10) * 75) > 0.01 * t.seconds + 0.5 $$,
    'walk: every grid vertex matches the Manhattan distance to grocery');
SELECT ok(pg_temp.near(pg_temp.t('walk', 'school', 1099), 150), 'walk: steps to the school count double');
SELECT ok(pg_temp.near(pg_temp.t('walk', 'park', 1000), 450), 'walk: park is reached at its nearest edge');
SELECT ok(pg_temp.near(pg_temp.t('walk', 'food', 1000), 1050), 'walk: island cafe is reached via its snap vertex');
SELECT is((SELECT count(*)::int FROM analytics.vertex_category_time WHERE vertex_id IN (3001, 3002)), 0,
          'walk: island vertices are unreachable');
SELECT is((SELECT count(*)::int FROM analytics.vertex_category_time WHERE seconds > 1800), 0,
          'no time beyond the 30 min precompute limit');

-- cycling: row 0 is oneway eastwards, so going west to the grocery takes a detour via row 1
SELECT ok(pg_temp.near(pg_temp.t('bike', 'grocery', 1005), 7 * 24), 'bike: oneway forces a 2-block detour');
SELECT ok(pg_temp.near(pg_temp.t('bike', 'pharmacy', 1000), 18 * 24), 'bike: eastwards along the oneway is fine');

-- H3 aggregation
SELECT is((SELECT count(*)::int FROM analytics.h3_category_time WHERE h3_get_resolution(h3) <> 9), 0,
          'h3: every cell has resolution 9');
SELECT is(
    (SELECT sum(vertices)::int FROM analytics.h3_category_time WHERE mode = 'walk' AND category = 'grocery'),
    (SELECT count(*)::int FROM analytics.vertex_category_time WHERE mode = 'walk' AND category = 'grocery'),
    'h3: every reachable vertex is counted in exactly one cell');
SELECT is((SELECT status FROM meta.data_release ORDER BY id DESC LIMIT 1), 'succeeded',
          'release passed its quality gates');

SELECT * FROM finish();
ROLLBACK;
