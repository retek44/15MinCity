# ADR 0006: A preview environment per pull request

- Status: accepted
- Date: 2026-11-17

## Context

CI proves that a change builds and passes the fixture-based tests, but reviewers cannot see what
it does to the map on real data before it reaches staging. The changes that most need a look are
the ones the fixture grid hides: a new category in the Lua style, a reworked migration, a scoring
or tiles tweak. Staging is shared and only gets `main`.

The hosts are small VMs (ADR 0004), so previews must reuse what is already there and be capped.

## Decision

**One preview per same-repository pull request, at `https://pr-<n>.<PREVIEW_DOMAIN>`.**
`.github/workflows/preview.yml` builds the `api`, `web` and `etl` images as `pr-<n>` (amd64 only,
no signing), then runs `deploy/preview.sh up <n>` on the preview host from a shallow checkout of the
PR head in `/opt/reach15-previews/pr-<n>`. The staging checkout in `/opt/reach15` is never touched.

- **Data:** a database `reach15_pr_<n>` on the shared core Postgres, built from scratch with the
  PR's own migrations (Flyway) and the PR's own ETL image against the Budapest extract that the
  weekly data release keeps on the host (plus the GTFS feed when it is there). Previews never
  download anything, and a PR that breaks the quality gates fails its preview.
- **Code:** compose project `reach15-pr-<n>` (`deploy/compose.preview.yml`) with its own API, web
  and Martin (config from the PR's `tiles/`). Only web is published, on `127.0.0.1:9000 + n % 1000`.
- **Routing:** the script writes `/etc/caddy/previews/pr-<n>.caddy` and reloads the edge Caddy,
  which imports that directory next to the production site. Previews send `noindex`.
- **Lifecycle:** a sticky PR comment carries the URL. Closing the PR runs `down` (containers,
  database, route, checkout); a daily job runs `prune`, which removes previews not deployed for
  7 days and previews of PRs that are no longer open (missed close events). At most 5 previews
  exist at a time; `up` refuses a sixth with a clear error. A host-wide lock makes previews build
  one at a time, so a teardown never races a build of the same PR.

## Consequences

- Disk: about 2 GB per preview database, so up to ~10 GB next to the three production-size
  databases of a data release. The cap is `MAX_PREVIEWS` in `deploy/preview.sh`.
- Time: images take ~2-3 minutes with the GitHub Actions cache; the preview then spends a few
  more minutes importing and precomputing Budapest on the host. The ETL load competes with the
  core Postgres, so a preview build during a staging release can make the k6 budgets flaky.
- Pull requests from forks get no preview: they get no secrets, and the workflow skips them.
- Previews show real, current data (the extract of the last data release), not the fixture grid,
  so what reviewers see matches what staging will show after merge.
- Host prerequisites: wildcard DNS for `*.PREVIEW_DOMAIN`, `/opt/reach15-previews` and
  `/etc/caddy/previews` writable by the deploy user. Caddy gets one certificate per preview,
  which stays far below Let's Encrypt's rate limits at this cap.
- `pr-<n>` image tags are not deleted from GHCR on teardown; a registry retention policy cleans
  them up.
