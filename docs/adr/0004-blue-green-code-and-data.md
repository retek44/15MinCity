# ADR 0004: Blue/green for the application and for the data

- Status: accepted
- Date: 2026-11-17

## Context

Two things change independently:

- **Code** (API and web images), on every merge to `main`.
- **Data** (OpenStreetMap), weekly. A rebuild takes minutes and must never leave users with a
  half-imported database, and a bad upstream edit (for example a mass retagging of shops) must not
  silently change every score in the city.

The target is a single small VM, so Kubernetes-style rollouts are out of scope.

## Decision

**Code: two colours behind an edge Caddy.** `deploy/bluegreen.sh` starts the idle colour
(`blue` on :8081 or `green` on :8082) with the new image tag, waits for container health checks,
smoke-tests it on its own port (health, data release, search, score, a tile), then rewrites the
edge upstream and reloads Caddy, which does not drop open connections. The previous colour keeps
running, so `deploy/bluegreen.sh rollback` is instant. Images are signed with cosign in CI and
the staging job verifies the signatures before deploying.

**Data: build aside, gate, rename.** `deploy/data-release.sh` builds the next release into
`reach15_next` (migrations, import, graph, precompute, search index), then runs two gates:

1. *Quality gates* (inside the ETL run): graph size, main component share, valid geometry,
   every category routable, cells inside districts.
2. *Score drift* against production (`etl drift`): fail if more than 5 % of cells move more than
   10 points, or the cell count changes by more than 5 %. The JSON report is kept per release.

If both pass, the databases are swapped with `ALTER DATABASE ... RENAME` (a few seconds of
reconnects), and the old one stays as `reach15_prev` for `data-release.sh rollback`.

## Consequences

- No in-place data mutation in production; every release is a complete, tested database.
- The drift gate needs a human decision when a legitimate large change happens (for example a
  new metro line). The intended path is a manual `workflow_dispatch` after reviewing the report.
- Disk needs room for three databases (current, next, previous) during a release (~2 GB for Budapest).
- API caches are not invalidated by the swap; they expire within the hour. Martin is restarted
  so tile caches are dropped.
