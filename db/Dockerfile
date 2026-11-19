# PostgreSQL 17 with the extensions Reach15 needs, all from the PGDG apt repository
# (already configured in the official image): PostGIS, pgRouting (graph search),
# h3-pg (hexagon grid) and pgTAP (SQL unit tests).
FROM postgres:17-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-17-postgis-3 \
        postgresql-17-postgis-3-scripts \
        postgresql-17-pgrouting \
        postgresql-17-h3 \
        postgresql-17-pgtap \
    && rm -rf /var/lib/apt/lists/*

# The entrypoint supports a non-root start: the data directory and socket directory already
# belong to postgres (uid 999 in the official image), and a fresh volume copies that ownership.
USER 999:999
