-- Graph vertices from which a POI category can be reached
-- (nearest vertex of each POI, every vertex on the edge of a park).
CREATE TABLE analytics.category_sources (
    category  text   NOT NULL,
    vertex_id bigint NOT NULL REFERENCES routing.vertices (id) ON DELETE CASCADE,
    PRIMARY KEY (category, vertex_id)
);

-- Travel time from every vertex to the nearest source of a category.
-- Vertices further than the precompute limit have no row (= unreachable).
CREATE TABLE analytics.vertex_category_time (
    mode      text             NOT NULL CHECK (mode IN ('walk', 'bike')),
    category  text             NOT NULL,
    vertex_id bigint           NOT NULL,
    seconds   double precision NOT NULL,
    PRIMARY KEY (mode, category, vertex_id)
);

-- Per H3 cell aggregate of vertex_category_time (median of the vertices in the cell).
CREATE TABLE analytics.h3_category_time (
    h3        h3index          NOT NULL,
    mode      text             NOT NULL CHECK (mode IN ('walk', 'bike')),
    category  text             NOT NULL,
    seconds   double precision NOT NULL,
    vertices  integer          NOT NULL,
    PRIMARY KEY (h3, mode, category)
);

CREATE TABLE meta.data_release (
    id             bigserial PRIMARY KEY,
    source_file    text        NOT NULL,
    imported_at    timestamptz NOT NULL DEFAULT now(),
    status         text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    step_timings   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    quality_report jsonb
);
