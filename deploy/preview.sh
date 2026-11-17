#!/usr/bin/env bash
# Per-pull-request preview environments on the preview host (ADR 0006).
#
#   TAG=pr-42 REGISTRY=ghcr.io/<owner>/reach15 PREVIEW_DOMAIN=preview.example.org \
#     deploy/preview.sh up 42     build reach15_pr_42 with this checkout's migrations and the PR's
#                                 ETL image, start API/web/tiles, route https://pr-42.<domain>
#   deploy/preview.sh down 42     remove containers, database, route and checkout
#   deploy/preview.sh list        previews on this host (port, last deploy, database size)
#   deploy/preview.sh prune 7 [--open 12 42 ...]
#                                 remove previews not deployed for 7 days and, with --open, the
#                                 previews of PRs that are not in the list of open PRs
#
# `up` runs from the PR's own checkout (/opt/reach15-previews/pr-<n>, prepared by the workflow),
# so PRs that change migrations, tiles config or this script preview correctly. The shared
# Postgres is the reach15-core stack of /opt/reach15. up/down/prune take a host-wide lock: previews
# build one at a time and a teardown never races a build of the same PR. `up` is idempotent.
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."
ROOT=$PWD

REACH15_HOME=${REACH15_HOME:-/opt/reach15}          # core stack checkout (shared Postgres)
DATA_DIR=${DATA_DIR:-$REACH15_HOME/data}            # cached OSM extract, GTFS feed, basemap
PREVIEWS_DIR=${PREVIEWS_DIR:-/opt/reach15-previews} # one checkout per PR
CADDY_DIR=${CADDY_DIR:-/etc/caddy/previews}         # imported by deploy/edge.Caddyfile
MAX_PREVIEWS=${MAX_PREVIEWS:-5}                     # each database is ~2 GB

die() { echo "preview: $*" >&2; exit 1; }
usage() { die "usage: preview.sh up <pr> | down <pr> | list | prune <days> [--open <pr>...]"; }

if [[ -z ${POSTGRES_USER:-} && -f $REACH15_HOME/.env ]]; then
  set -a; . "$REACH15_HOME/.env"; set +a
fi
: "${POSTGRES_USER:?POSTGRES_USER is required}" "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

core() { docker compose -f "$REACH15_HOME/docker-compose.yml" -p reach15-core "$@"; }
psql_admin() { core exec -T db psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d postgres -c "$1"; }
reload_caddy() { caddy reload --config /etc/caddy/Caddyfile; }
port_of() { echo $((9000 + $1 % 1000)); }

# preview <pr> <compose args...>: the reach15-pr-<pr> project
preview() {
  local n=$1; shift
  PR=$n PORT=$(port_of "$n") DATA_DIR=$DATA_DIR TAG=${TAG:-none} REGISTRY=${REGISTRY:-none} \
    docker compose -f "$ROOT/deploy/compose.preview.yml" "$@"
}

# PR numbers with anything left on this host: database, containers, route or checkout
numbers() {
  {
    psql_admin "SELECT substr(datname, 12) FROM pg_database WHERE datname ~ '^reach15_pr_[0-9]+$'"
    docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sed -n 's/^reach15-pr-//p'
    for f in "$CADDY_DIR"/pr-*.caddy "$PREVIEWS_DIR"/pr-*; do basename "$f" .caddy; done | sed 's/^pr-//'
  } | { grep -xE '[0-9]+' || true; } | sort -nu
}

# epoch of the last successful `up` (route file), else of the checkout, else 0
deployed_at() {
  stat -c %Y "$CADDY_DIR/pr-$1.caddy" 2>/dev/null || stat -c %Y "$PREVIEWS_DIR/pr-$1" 2>/dev/null || echo 0
}

# route <pr> <port>: https://pr-<pr>.<domain> -> 127.0.0.1:<port> on the edge Caddy
route() {
  local file=$CADDY_DIR/pr-$1.caddy
  cat > "$file.tmp" <<EOF
# managed by deploy/preview.sh (removed by: deploy/preview.sh down $1)
pr-$1.$PREVIEW_DOMAIN {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
	reverse_proxy 127.0.0.1:$2
}
EOF
  mv "$file.tmp" "$file"
  # A broken snippet must not stay behind: it would fail the next production reload too.
  reload_caddy || { rm -f "$file"; reload_caddy; die "caddy rejected the route for pr-$1"; }
}

cmd_up() {
  local n=$1 port db=reach15_pr_$1 p others=()
  port=$(port_of "$n")
  : "${TAG:?TAG is required}" "${REGISTRY:?REGISTRY is required}" "${PREVIEW_DOMAIN:?PREVIEW_DOMAIN is required}"
  [[ $PREVIEW_DOMAIN =~ ^[a-z0-9.-]+$ ]] || die "invalid PREVIEW_DOMAIN: $PREVIEW_DOMAIN"
  [[ -f $DATA_DIR/budapest.osm.pbf ]] || die "missing $DATA_DIR/budapest.osm.pbf (run the data release once)"
  [[ -d $CADDY_DIR && -w $CADDY_DIR ]] || die "$CADDY_DIR must exist and be writable by $(id -un)"

  for p in $(numbers); do [[ $p == "$n" ]] || others+=("$p"); done
  (( ${#others[@]} < MAX_PREVIEWS )) \
    || die "$MAX_PREVIEWS previews already exist (${others[*]/#/pr-}); close a PR or run deploy/preview.sh down <pr>"
  for p in "${others[@]}"; do
    [[ $(port_of "$p") != "$port" ]] || die "port $port is already used by pr-$p"
  done

  local etl_args=(run /data/budapest.osm.pbf)
  [[ -f $DATA_DIR/budapest_gtfs.zip ]] && etl_args+=(--gtfs /data/budapest_gtfs.zip)

  echo "preview pr-$n: $REGISTRY/{api,web,etl}:$TAG -> database $db, port $port"
  preview "$n" --profile tools pull --quiet
  preview "$n" down --remove-orphans            # replaces an earlier deploy of this PR
  psql_admin "DROP DATABASE IF EXISTS $db WITH (FORCE);"
  psql_admin "CREATE DATABASE $db;"
  preview "$n" run --rm flyway                  # this checkout's db/migrations
  preview "$n" run --rm etl "${etl_args[@]}"    # this PR's pipeline; fails on quality gates
  preview "$n" up -d --wait --remove-orphans

  local base=http://127.0.0.1:$port
  curl -fsS --retry 5 --retry-all-errors "$base/healthz" > /dev/null
  curl -fsS "$base/api/v1/meta" | grep -q '"status":"succeeded"'

  route "$n" "$port"
  echo "preview pr-$n ready: https://pr-$n.$PREVIEW_DOMAIN"
}

cmd_down() {
  local n=$1
  preview "$n" down --volumes --remove-orphans
  psql_admin "DROP DATABASE IF EXISTS reach15_pr_$n WITH (FORCE);"
  if [[ -f $CADDY_DIR/pr-$n.caddy ]]; then
    rm -f "$CADDY_DIR/pr-$n.caddy"
    reload_caddy
  fi
  rm -rf "${PREVIEWS_DIR:?}/pr-$n"
  echo "preview pr-$n removed"
}

cmd_list() {
  local p at size
  printf '%-9s %-6s %-17s %s\n' PREVIEW PORT DEPLOYED DATABASE
  for p in $(numbers); do
    at=$(deployed_at "$p")
    (( at > 0 )) && at=$(date -d "@$at" '+%F %H:%M') || at=-
    size=$(psql_admin "SELECT pg_size_pretty(pg_database_size('reach15_pr_$p'))" 2>/dev/null) || size=-
    printf '%-9s %-6s %-17s %s\n' "pr-$p" "$(port_of "$p")" "$at" "$size"
  done
}

cmd_prune() {
  local days=${1:-} p open=" " check_open=false
  [[ $days =~ ^[0-9]+$ ]] || usage
  shift
  if [[ ${1:-} == --open ]]; then
    shift; check_open=true; open=" $* "
  fi
  local cutoff=$(( $(date +%s) - days * 86400 ))
  for p in $(numbers); do
    if (( $(deployed_at "$p") < cutoff )); then
      echo "pruning pr-$p: not deployed for $days days"
    elif $check_open && [[ $open != *" $p "* ]]; then
      echo "pruning pr-$p: PR is not open"
    else
      continue
    fi
    cmd_down "$p"
  done
}

lock() {
  mkdir -p "$PREVIEWS_DIR"
  exec 9> "$PREVIEWS_DIR/.lock"
  flock -w 3600 9 || die "timed out waiting for another preview operation"
}

case "${1:-}" in
  up | down)
    [[ ${2:-} =~ ^[0-9]+$ ]] || usage
    lock
    "cmd_$1" "$2"
    ;;
  list) cmd_list ;;
  prune)
    shift
    lock
    cmd_prune "$@"
    ;;
  *) usage ;;
esac
