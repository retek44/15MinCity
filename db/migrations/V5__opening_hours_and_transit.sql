-- Opening hours, parsed by the ETL from osm.pois.opening_hours (reach15_etl/hours.py).
-- Minutes since Monday 00:00 local time, [0, 10080). A POI without a row has unknown hours.
CREATE TABLE analytics.poi_hours (
    poi_type     char(1)        NOT NULL,
    poi_id       bigint         NOT NULL,
    open_minutes int4multirange NOT NULL,
    PRIMARY KEY (poi_type, poi_id)
);

-- Public transport timetable, imported from a GTFS feed (BKK) by `reach15-etl gtfs`.
-- Integer surrogate keys keep the 5-6 million stop_times rows small; GTFS ids are kept for tracing.
CREATE SCHEMA IF NOT EXISTS transit;

CREATE TABLE transit.feed (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    source_file text        NOT NULL,
    version     text,
    start_date  date,
    end_date    date,
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transit.stops (
    stop_idx integer PRIMARY KEY,
    stop_id  text    NOT NULL UNIQUE,
    name     text    NOT NULL,
    geom     geometry(Point, 4326) NOT NULL
);
CREATE INDEX stops_geom_idx ON transit.stops USING gist (geom);

CREATE TABLE transit.routes (
    route_id   text PRIMARY KEY,
    short_name text,
    long_name  text,
    route_type integer NOT NULL,
    color      text
);

CREATE TABLE transit.trips (
    trip_idx   integer PRIMARY KEY,
    trip_id    text    NOT NULL UNIQUE,
    route_id   text    NOT NULL,
    service_id text    NOT NULL,
    headsign   text
);
CREATE INDEX trips_service_idx ON transit.trips (service_id);

-- Seconds after midnight of the service day; GTFS allows > 24 h for trips running past midnight.
CREATE TABLE transit.stop_times (
    trip_idx      integer  NOT NULL,
    stop_sequence integer  NOT NULL,
    stop_idx      integer  NOT NULL,
    arrival_s     integer  NOT NULL,
    departure_s   integer  NOT NULL,
    PRIMARY KEY (trip_idx, stop_sequence)
);

CREATE TABLE transit.calendar (
    service_id text PRIMARY KEY,
    -- ISO weekdays 1 (Monday) .. 7 (Sunday) on which the service runs
    weekdays   smallint[] NOT NULL,
    start_date date NOT NULL,
    end_date   date NOT NULL
);

CREATE TABLE transit.calendar_dates (
    service_id     text     NOT NULL,
    date           date     NOT NULL,
    exception_type smallint NOT NULL CHECK (exception_type IN (1, 2)),
    PRIMARY KEY (service_id, date)
);
CREATE INDEX calendar_dates_date_idx ON transit.calendar_dates (date);

-- Stop -> nearest main-component street vertex, filled after every graph build.
CREATE TABLE transit.stop_vertex (
    stop_idx   integer PRIMARY KEY,
    vertex_id  bigint  NOT NULL REFERENCES routing.vertices (id) ON DELETE CASCADE,
    distance_m double precision NOT NULL
);
CREATE INDEX stop_vertex_vertex_idx ON transit.stop_vertex (vertex_id);

-- Walking transfers between nearby stops (RAPTOR footpaths).
CREATE TABLE transit.transfers (
    from_stop integer NOT NULL,
    to_stop   integer NOT NULL,
    seconds   integer NOT NULL,
    PRIMARY KEY (from_stop, to_stop)
);
