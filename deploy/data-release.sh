#!/usr/bin/env bash
# Weekly data release ("blue/green for data").
#
# Builds the next release into a separate database, gates it, and swaps it in:
#   1. download the latest OSM extract, GTFS timetable and DEM, migrate + import + precompute into
#      reach15_next, then the public transport heatmap (the API image, with the release's TAG)
#   2. quality gates (inside `etl run`) and score drift against production (`etl drift`)
#   3. swap: reach15 -> reach15_prev, reach15_next -> reach15 (a few seconds of reconnects)
#   4. restart the tile server so it drops cached tiles; API caches expire within the hour
#
# The previous release stays as reach15_prev for rollback: deploy/data-release.sh rollback
set -euo pipefail
cd "$(dirname "$0")/.."

# The ETL container runs as this user, so downloads and reports in ./data belong to them.
export HOST_UID="$(id -u)" HOST_GID="$(id -g)"
mkdir -p data
core() { docker compose -p reach15-core "$@"; }
psql_admin() { core exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "$1"; }

# swap <incoming> <outgoing>: <incoming> becomes reach15, the current reach15 becomes <outgoing>
swap() {
  psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('reach15', '$1') AND pid <> pg_backend_pid();"
  psql_admin "ALTER DATABASE reach15 RENAME TO reach15_swap;"
  psql_admin "ALTER DATABASE $1 RENAME TO reach15;"
  psql_admin "ALTER DATABASE reach15_swap RENAME TO $2;"
  core restart martin
}

if [[ "${1:-}" == "rollback" ]]; then
  swap reach15_prev reach15_prev
  echo "rolled back to the previous data release"
  exit 0
fi

psql_admin "DROP DATABASE IF EXISTS reach15_next WITH (FORCE);"
psql_admin "CREATE DATABASE reach15_next;"
DB_NAME=reach15_next core run --rm flyway
DB_NAME=reach15_next core run --rm etl download --refresh
DB_NAME=reach15_next core run --rm etl gtfs-download                   # BKK timetable (GTFS)
DB_NAME=reach15_next core run --rm etl dem-download                    # Copernicus DEM, Budapest window
DB_NAME=reach15_next core run --rm etl run /data/budapest.osm.pbf   --gtfs /data/budapest_gtfs.zip --dem /data/budapest-dem.tif                                         # fails on quality gates
# Public transport heatmap: RAPTOR per H3 cell, run by the API image against the new database.
docker run --rm --network reach15-core_default   -e REACH15_DB_URL=jdbc:postgresql://db:5432/reach15_next   -e REACH15_DB_USER="$POSTGRES_USER" -e REACH15_DB_PASSWORD="$POSTGRES_PASSWORD"   "$REGISTRY/api:$TAG" --spring.main.web-application-type=none --reach15.precompute=transit-heatmap
DB_NAME=reach15_next core run --rm etl drift --baseline reach15 --candidate reach15_next \
  --report "/data/drift-$(date +%F).json"                                # fails on score drift

psql_admin "DROP DATABASE IF EXISTS reach15_prev WITH (FORCE);"
swap reach15_next reach15_prev
echo "data release swapped in; previous release kept as reach15_prev"
