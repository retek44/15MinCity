-- Phase 8: step-free walking, an evening public transport heatmap.

-- Step-free walking (pushchair, wheelchair, a heavy suitcase): the walking costs, but steps and
-- ways tagged wheelchair=no cannot be used. -1 = not traversable, like the cycling costs.
-- routing.build_graph() fills them; existing graphs get the steps rule until the next build.
ALTER TABLE routing.edges
    ADD COLUMN cost_stepfree_s         double precision,
    ADD COLUMN reverse_cost_stepfree_s double precision;
UPDATE routing.edges
SET cost_stepfree_s         = CASE WHEN highway = 'steps' THEN -1 ELSE cost_walk_s END,
    reverse_cost_stepfree_s = CASE WHEN highway = 'steps' THEN -1 ELSE reverse_cost_walk_s END;
ALTER TABLE routing.edges
    ALTER COLUMN cost_stepfree_s SET NOT NULL,
    ALTER COLUMN reverse_cost_stepfree_s SET NOT NULL;

ALTER TABLE analytics.vertex_category_time DROP CONSTRAINT vertex_category_time_mode_check;
ALTER TABLE analytics.vertex_category_time
    ADD CONSTRAINT vertex_category_time_mode_check CHECK (mode IN ('walk', 'bike', 'stepfree'));

-- transit:         weekday 08:00 departure (Phase 7)
-- transit_evening: Sunday 20:00 departure, when service is at its thinnest outside the night
ALTER TABLE analytics.h3_category_time DROP CONSTRAINT h3_category_time_mode_check;
ALTER TABLE analytics.h3_category_time
    ADD CONSTRAINT h3_category_time_mode_check
    CHECK (mode IN ('walk', 'bike', 'stepfree', 'transit', 'transit_evening'));
