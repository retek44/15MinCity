-- POI -> vertex mapping keeps the POI identity, so on-demand queries can name the nearest
-- grocery instead of just timing it. category_sources becomes a view over it.
DROP TABLE analytics.category_sources;

CREATE TABLE analytics.poi_vertex (
    poi_type  char(1) NOT NULL,
    poi_id    bigint  NOT NULL,
    category  text    NOT NULL,
    vertex_id bigint  NOT NULL REFERENCES routing.vertices (id) ON DELETE CASCADE,
    PRIMARY KEY (poi_type, poi_id, vertex_id)
);
CREATE INDEX poi_vertex_vertex_idx ON analytics.poi_vertex (vertex_id);

CREATE VIEW analytics.category_sources AS
SELECT DISTINCT category, vertex_id FROM analytics.poi_vertex;

-- One row per H3 cell that contains graph vertices, with its district (by cell centre).
CREATE TABLE analytics.h3_cell (
    h3          h3index PRIMARY KEY,
    district_id bigint,
    geom        geometry(Polygon, 4326) NOT NULL,
    times       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX h3_cell_geom_idx ON analytics.h3_cell USING gist (geom);
CREATE INDEX h3_cell_district_idx ON analytics.h3_cell (district_id);

-- Geocoding index, rebuilt after every import by search.build_index().
CREATE SCHEMA IF NOT EXISTS search;

CREATE TABLE search.place (
    id          bigserial PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('address', 'street', 'poi')),
    label       text NOT NULL,
    sublabel    text,
    category    text,
    housenumber text,
    norm        text NOT NULL,
    geom        geometry(Point, 4326) NOT NULL
);
CREATE INDEX place_norm_trgm_idx ON search.place USING gin (norm gin_trgm_ops);
CREATE INDEX place_geom_idx ON search.place USING gist (geom);
CREATE INDEX place_address_geom_idx ON search.place USING gist (geom) WHERE kind = 'address';
