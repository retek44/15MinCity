-- Graph vertices are OSM node ids, so a vertex can always be traced back to OSM.
CREATE TABLE routing.vertices (
    id                bigint PRIMARY KEY,
    component         bigint,
    in_main_component boolean NOT NULL DEFAULT false,
    geom              geometry(Point, 4326) NOT NULL
);
CREATE INDEX vertices_geom_idx ON routing.vertices USING gist (geom);
CREATE INDEX vertices_main_geom_idx ON routing.vertices USING gist (geom) WHERE in_main_component;

-- Costs are in seconds. A negative cost means "not traversable in that direction"
-- (pgRouting convention).
CREATE TABLE routing.edges (
    id                  bigserial PRIMARY KEY,
    way_id              bigint NOT NULL,
    source              bigint NOT NULL,
    target              bigint NOT NULL,
    highway             text NOT NULL,
    length_m            double precision NOT NULL,
    cost_walk_s         double precision NOT NULL,
    reverse_cost_walk_s double precision NOT NULL,
    cost_bike_s         double precision NOT NULL,
    reverse_cost_bike_s double precision NOT NULL,
    geom                geometry(LineString, 4326) NOT NULL
);
CREATE INDEX edges_source_idx ON routing.edges (source);
CREATE INDEX edges_target_idx ON routing.edges (target);
CREATE INDEX edges_geom_idx ON routing.edges USING gist (geom);
