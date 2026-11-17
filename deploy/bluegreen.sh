#!/usr/bin/env bash
# Blue/green release of the API + web images.
#
#   TAG=<git sha> REGISTRY=ghcr.io/<owner>/reach15 deploy/bluegreen.sh
#
# 1. start the idle colour with the new images, next to the live one
# 2. wait for health checks, then smoke test it on its own port
# 3. point the edge proxy at it (zero-downtime Caddy reload)
# 4. keep the previous colour running for an instant rollback: deploy/bluegreen.sh rollback
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=deploy/.active-color
declare -A PORTS=([blue]=8081 [green]=8082)
active=$(cat "$STATE" 2>/dev/null || echo none)

switch_edge() {
  local color=$1
  echo "reverse_proxy 127.0.0.1:${PORTS[$color]}" > /etc/caddy/upstream.caddy
  caddy reload --config /etc/caddy/Caddyfile
  echo "$color" > "$STATE"
  echo "edge -> $color (:${PORTS[$color]})"
}

if [[ "${1:-}" == "rollback" ]]; then
  previous=$([[ "$active" == blue ]] && echo green || echo blue)
  docker compose -p "reach15-$previous" ps --status running --quiet | grep -q . \
    || { echo "no running $previous stack to roll back to" >&2; exit 1; }
  switch_edge "$previous"
  exit 0
fi

: "${TAG:?TAG is required}" "${REGISTRY:?REGISTRY is required}"
next=$([[ "$active" == blue ]] && echo green || echo blue)
port=${PORTS[$next]}
echo "live: $active, deploying $TAG to $next (:$port)"

COLOR=$next PORT=$port docker compose -f deploy/compose.prod.yml pull
COLOR=$next PORT=$port docker compose -f deploy/compose.prod.yml up -d --wait --remove-orphans

echo "smoke testing $next"
base="http://127.0.0.1:$port"
curl -fsS "$base/healthz" > /dev/null
curl -fsS "$base/api/v1/meta" | grep -q '"status":"succeeded"'
curl -fsS "$base/api/v1/search?q=deak%20ter" | grep -q 'Deák tér'
curl -fsS "$base/api/v1/access?lon=19.0546&lat=47.4979" | grep -q '"score"'
curl -fsS -o /dev/null -w '%{http_code}' "$base/tiles/h3/14/9059/5731" | grep -qE '200|204'

switch_edge "$next"
echo "released $TAG on $next; previous colour ($active) kept for rollback"
