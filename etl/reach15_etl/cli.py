"""reach15-etl: download, import and precompute pipeline.

Connection settings come from the standard libpq environment variables
(PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE), for both psycopg and osm2pgsql.
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from . import drift, quality
from .fixtures import build_grid_fixture

log = logging.getLogger("reach15")

HUNGARY_URL = "https://download.geofabrik.de/europe/hungary-latest.osm.pbf"
PROTOMAPS_BUILD = "https://build.protomaps.com/{date}.pmtiles"
USER_AGENT = "reach15-etl/0.1 (+https://github.com/)"
# Budapest city limits plus ~1 km margin, so isochrones near the border are not cut off.
BUDAPEST_BBOX = "18.91,47.34,19.35,47.62"
MODES = ("walk", "bike")


def connect() -> psycopg.Connection:
    return psycopg.connect("")


def timed(timings: dict[str, float], name: str, fn: Callable[[], object]) -> object:
    start = time.perf_counter()
    result = fn()
    timings[name] = round(time.perf_counter() - start, 3)
    log.info("%-28s %8.2fs  %s", name, timings[name], result)
    return result


def run(cmd: list[str]) -> None:
    log.info("$ %s", " ".join(cmd))
    subprocess.run(cmd, check=True)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_download(args: argparse.Namespace) -> int:
    out_dir = Path(args.data_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    country = out_dir / "hungary-latest.osm.pbf"
    if country.exists() and not args.refresh:
        log.info("using cached %s", country)
    else:
        log.info("downloading %s", HUNGARY_URL)
        urllib.request.urlretrieve(HUNGARY_URL, country)
    target = out_dir / "budapest.osm.pbf"
    run(["osmium", "extract", "--bbox", args.bbox, "--overwrite", "-o", str(target), str(country)])
    log.info("extract written to %s (%.1f MB)", target, target.stat().st_size / 1e6)
    return 0


def latest_protomaps_build(today: datetime.date | None = None, days: int = 7) -> str:
    """URL of the newest Protomaps daily build (they are kept for a few days only)."""
    today = today or datetime.date.today()
    for back in range(days):
        url = PROTOMAPS_BUILD.format(date=(today - datetime.timedelta(days=back)).strftime("%Y%m%d"))
        probe = urllib.request.Request(url, headers={"Range": "bytes=0-0", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(probe, timeout=20):
                return url
        except urllib.error.HTTPError as e:
            log.info("%s: HTTP %s", url, e.code)
    raise SystemExit(f"no Protomaps build found in the last {days} days")


def cmd_basemap(args: argparse.Namespace) -> int:
    source = args.source or latest_protomaps_build()
    target = Path(args.data_dir) / "budapest-basemap.pmtiles"
    run(
        [
            "pmtiles",
            "extract",
            source,
            str(target),
            f"--bbox={args.bbox}",
            f"--maxzoom={args.maxzoom}",
            "--download-threads=4",
        ]
    )
    log.info("basemap written to %s (%.1f MB)", target, target.stat().st_size / 1e6)
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    style = os.environ.get("REACH15_LUA", str(Path(__file__).parent.parent / "lua" / "reach15.lua"))
    database = os.environ.get("PGDATABASE", "reach15")
    start = time.perf_counter()
    run(
        [
            "osm2pgsql",
            "--create",
            "--output=flex",
            f"--style={style}",
            f"--database={database}",
            "--log-level=warn",
            args.file,
        ]
    )
    with connect() as conn:
        conn.execute(
            "INSERT INTO meta.data_release (source_file, step_timings) VALUES (%s, %s)",
            (os.path.basename(args.file), Jsonb({"import": round(time.perf_counter() - start, 3)})),
        )
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    unknown = set(modes) - set(MODES)
    if unknown:
        raise SystemExit(f"unknown mode(s): {', '.join(sorted(unknown))}")

    timings: dict[str, float] = {}
    with connect() as conn:
        conn.autocommit = True

        def scalar(sql: str, params: tuple = ()) -> object:
            return conn.execute(sql, params).fetchone()

        graph = timed(timings, "build_graph", lambda: scalar("SELECT * FROM routing.build_graph()"))
        timed(timings, "snap_sources", lambda: scalar("SELECT routing.snap_sources()")[0])
        for mode in modes:
            timed(
                timings,
                f"category_times_{mode}",
                lambda m=mode: scalar("SELECT analytics.compute_category_times(%s)", (m,))[0],
            )
        timed(
            timings,
            "h3_cells",
            lambda: scalar("SELECT analytics.compute_h3_cells(%s)", (args.h3_resolution,))[0],
        )
        timed(timings, "search_index", lambda: scalar("SELECT search.build_index()")[0])

        report = quality.collect(conn, extra={"skipped_ways": graph[2]})
        conn.execute(
            """
            UPDATE meta.data_release
            SET status = %s, quality_report = %s, step_timings = step_timings || %s
            WHERE id = (SELECT max(id) FROM meta.data_release)
            """,
            ("succeeded" if report.passed else "failed", Jsonb(report.as_json()), Jsonb(timings)),
        )

    print(json.dumps(report.as_json(), indent=2, ensure_ascii=False))
    if not report.passed:
        log.error("quality gate failed: %s", "; ".join(report.failures))
        return 1
    return 0


def cmd_drift(args: argparse.Namespace) -> int:
    report = drift.compare(drift.load(f"dbname={args.baseline}"), drift.load(f"dbname={args.candidate}"))
    print(json.dumps(report.as_json(), indent=2))
    if args.report:
        Path(args.report).write_text(json.dumps(report.as_json(), indent=2), encoding="utf-8")
    if not report.passed:
        log.error("drift gate failed: %s", "; ".join(report.failures))
        return 1
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    return cmd_import(args) or cmd_build(args)


def cmd_fixture(args: argparse.Namespace) -> int:
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(build_grid_fixture(), encoding="utf-8", newline="\n")
    log.info("fixture written to %s", args.out)
    return 0


def cmd_prove(args: argparse.Namespace) -> int:
    files = sorted(glob.glob(os.path.join(args.tests_dir, "*.sql")))
    if not files:
        raise SystemExit(f"no pgTAP tests found in {args.tests_dir}")
    database = os.environ.get("PGDATABASE", "reach15")
    return subprocess.run(["pg_prove", "--verbose", "-d", database, *files]).returncode


# ---------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reach15-etl", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("download", help="download Hungary and cut the Budapest extract")
    d.add_argument("--data-dir", default="/data")
    d.add_argument("--bbox", default=BUDAPEST_BBOX)
    d.add_argument("--refresh", action="store_true", help="re-download even if cached")
    d.set_defaults(fn=cmd_download)

    m = sub.add_parser("basemap", help="cut the Budapest basemap from the Protomaps daily build")
    m.add_argument("--data-dir", default="/data")
    m.add_argument("--bbox", default=BUDAPEST_BBOX)
    m.add_argument("--maxzoom", type=int, default=15)
    m.add_argument("--source", help="PMTiles URL or path (default: newest daily build)")
    m.set_defaults(fn=cmd_basemap)

    def add_build_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--modes", default="walk,bike", help="comma separated: walk,bike")
        sp.add_argument("--h3-resolution", type=int, default=9)

    i = sub.add_parser("import", help="load an OSM file with osm2pgsql")
    i.add_argument("file")
    i.set_defaults(fn=cmd_import)

    b = sub.add_parser("build", help="build graph, precompute accessibility, run quality gates")
    add_build_args(b)
    b.set_defaults(fn=cmd_build)

    r = sub.add_parser("run", help="import + build")
    r.add_argument("file")
    add_build_args(r)
    r.set_defaults(fn=cmd_run)

    dr = sub.add_parser("drift", help="compare scores of two data releases (release gate)")
    dr.add_argument("--baseline", default="reach15", help="database currently in production")
    dr.add_argument("--candidate", default="reach15_next", help="freshly built database")
    dr.add_argument("--report", help="also write the JSON report to this file")
    dr.set_defaults(fn=cmd_drift)

    f = sub.add_parser("fixture", help="write the synthetic grid fixture")
    f.add_argument("--out", required=True)
    f.set_defaults(fn=cmd_fixture)

    t = sub.add_parser("prove", help="run pgTAP tests with pg_prove")
    t.add_argument("tests_dir")
    t.set_defaults(fn=cmd_prove)
    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
