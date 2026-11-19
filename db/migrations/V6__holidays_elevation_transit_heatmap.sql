-- Phase 7: public holidays, hill-aware cycling, a public transport heatmap.

-- Opening hours on a public holiday, in minutes from the holiday's midnight (the end may pass
-- midnight). NULL: the value does not name PH, so the weekly hours apply on holidays too.
ALTER TABLE analytics.poi_hours ADD COLUMN holiday_minutes int4multirange;

-- Height gained and lost along an edge from source to target, in metres, sampled from a
-- digital elevation model by the ETL (reach15_etl/elevation.py). 0 without elevation data.
ALTER TABLE routing.edges
    ADD COLUMN climb_m   double precision NOT NULL DEFAULT 0,
    ADD COLUMN descent_m double precision NOT NULL DEFAULT 0;

-- Public transport times are precomputed per H3 cell only (by the API's timetable search,
-- for one weekday morning departure), not per street vertex.
ALTER TABLE analytics.h3_category_time DROP CONSTRAINT h3_category_time_mode_check;
ALTER TABLE analytics.h3_category_time
    ADD CONSTRAINT h3_category_time_mode_check CHECK (mode IN ('walk', 'bike', 'transit'));

-- Staging for the ETL's elevation step: one row per edge, applied by routing.apply_elevation().
CREATE UNLOGGED TABLE routing.edge_elevation (
    edge_id   bigint PRIMARY KEY,
    climb_m   double precision NOT NULL,
    descent_m double precision NOT NULL
);
