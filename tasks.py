#!/usr/bin/env python3
"""Developer task runner: a cross-platform wrapper around docker compose.

    python tasks.py up          start the database
    python tasks.py migrate     apply Flyway migrations to the dev database
    python tasks.py test-db     fresh test database + fixture import + pgTAP tests + fixture dump
    python tasks.py test-api    API unit + integration tests (Testcontainers, restores the fixture dump)
    python tasks.py e2e         fixture DB + production-like containers + Playwright end-to-end tests
    python tasks.py app         run the whole stack in containers (http://localhost:8088)
    python tasks.py download    download Hungary and cut the Budapest extract into ./data
    python tasks.py gtfs        download the BKK public transport timetable (GTFS) into ./data
    python tasks.py dem         read the Budapest window of the Copernicus elevation model into ./data
    python tasks.py basemap     cut the Budapest basemap (PMTiles) from the Protomaps daily build
    python tasks.py tiles       start the Martin tile server (localhost:3000)
    python tasks.py pipeline    import ./data/budapest.osm.pbf (+ budapest_gtfs.zip, budapest-dem.tif) and precompute everything
    python tasks.py api         run the API against the dev database (localhost:8080)
    python tasks.py down        stop the stack (add --volumes to drop the database)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEV_DB = "reach15"
TEST_DB = "reach15_test"
FIXTURE_DUMP = ROOT / "tests" / "fixtures" / "db" / "grid.sql"


# The ETL container runs as the host user, so what it writes to ./data belongs to them. On Windows
# and macOS Docker Desktop maps bind mount ownership itself; the image's own uid is fine there.
HOST_IDS = {"HOST_UID": str(os.getuid()), "HOST_GID": str(os.getgid())} if hasattr(os, "getuid") else {}


def compose(*args: str, db: str = DEV_DB, env: dict[str, str] | None = None) -> None:
    cmd = ["docker", "compose", *args]
    print("+", " ".join(cmd), flush=True)
    (ROOT / "data").mkdir(exist_ok=True)  # else Docker creates the bind mount source as root
    subprocess.run(cmd, env={**os.environ, **HOST_IDS, "DB_NAME": db, **(env or {})}, check=True)


E2E_ENV = {"APP_DB": TEST_DB, "MARTIN_CONFIG": "martin.e2e.yaml", "WEB_PORT": "8088"}


def transit_heatmap(env: dict[str, str] | None = None, date: str | None = None) -> None:
    """Public transport heatmap: the API image runs RAPTOR per H3 cell against APP_DB, then exits."""
    compose(
        "--profile", "app", "run", "--rm", "--build", "--no-deps", "api",
        "--spring.main.web-application-type=none", "--reach15.precompute=transit-heatmap",
        *([f"--reach15.transit-date={date}"] if date else []),
        env=env,
    )


def e2e() -> None:
    """Production-like stack (API + Caddy + Martin images) on the fixture database, then Playwright."""
    test_db()
    # Tuesday 2026-11-17: the GTFS fixture runs on weekdays, and tests pin their dates.
    transit_heatmap(E2E_ENV, "2026-11-17")
    compose("--profile", "app", "up", "-d", "--build", "--wait", "--force-recreate", "martin", "api", "web", env=E2E_ENV)
    npx = "npx.cmd" if os.name == "nt" else "npx"
    subprocess.run(
        [npx, "playwright", "test"], cwd=ROOT / "web", check=True,
        env={**os.environ, "E2E_BASE_URL": "http://localhost:8088"},
    )


def psql(db: str, sql: str) -> None:
    compose("exec", "-T", "db", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "reach15", "-d", db, "-c", sql)


def etl(db: str, *args: str) -> None:
    compose("run", "--rm", "--build", "etl", *args, db=db)


def up() -> None:
    compose("up", "-d", "--build", "--wait", "db")


def migrate(db: str = DEV_DB) -> None:
    compose("run", "--rm", "flyway", db=db)


def test_db() -> None:
    up()
    psql("postgres", f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
    psql("postgres", f"CREATE DATABASE {TEST_DB}")
    migrate(TEST_DB)
    psql(TEST_DB, "CREATE EXTENSION IF NOT EXISTS pgtap")
    etl(TEST_DB, "run", "/fixtures/osm/grid.osm", "--gtfs", "/fixtures/gtfs")
    etl(TEST_DB, "prove", "/db-tests")
    fixture_dump()


def fixture_dump() -> None:
    """Dump the built test database; the API integration tests restore it into Testcontainers."""
    FIXTURE_DUMP.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "docker", "compose", "exec", "-T", "db", "pg_dump", "-U", "reach15", "-d", TEST_DB,
        "--no-owner", "--no-privileges", "--exclude-extension=pgtap",
    ]
    print("+", " ".join(cmd), f"> {FIXTURE_DUMP}", flush=True)
    with FIXTURE_DUMP.open("wb") as out:
        subprocess.run(cmd, stdout=out, check=True)


def gradle(*args: str) -> None:
    wrapper = "gradlew.bat" if os.name == "nt" else "./gradlew"
    cmd = [wrapper, *args]
    print("+ (api)", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT / "api", check=True, shell=os.name == "nt")


def main() -> int:
    p = argparse.ArgumentParser(description="Reach15 developer tasks")
    p.add_argument(
        "task",
        choices=[
            "up", "migrate", "test-db", "test-api", "e2e", "download", "gtfs", "dem", "basemap", "pipeline", "api", "tiles",
            "app", "down",
        ],
    )
    p.add_argument("--volumes", action="store_true", help="down: also remove the database volume")
    args = p.parse_args()

    try:
        if args.task == "up":
            up()
        elif args.task == "migrate":
            up()
            migrate()
        elif args.task == "test-db":
            test_db()
        elif args.task == "test-api":
            if not FIXTURE_DUMP.exists():
                test_db()
            gradle("test")
        elif args.task == "e2e":
            e2e()
        elif args.task == "app":
            up()
            migrate()
            compose("--profile", "app", "up", "-d", "--build", "--wait", "martin", "api", "web")
        elif args.task == "api":
            up()
            migrate()
            gradle("bootRun")
        elif args.task == "download":
            etl(DEV_DB, "download")
        elif args.task == "gtfs":
            etl(DEV_DB, "gtfs-download")
        elif args.task == "dem":
            etl(DEV_DB, "dem-download")
        elif args.task == "basemap":
            etl(DEV_DB, "basemap")
        elif args.task == "tiles":
            compose("up", "-d", "--build", "--wait", "--force-recreate", "martin")
        elif args.task == "pipeline":
            up()
            migrate()
            gtfs = ["--gtfs", "/data/budapest_gtfs.zip"] if (ROOT / "data" / "budapest_gtfs.zip").exists() else []
            dem = ["--dem", "/data/budapest-dem.tif"] if (ROOT / "data" / "budapest-dem.tif").exists() else []
            etl(DEV_DB, "run", "/data/budapest.osm.pbf", *gtfs, *dem)
            if gtfs:
                transit_heatmap()
        elif args.task == "down":
            compose("--profile", "tools", "down", *(["--volumes"] if args.volumes else []))
    except subprocess.CalledProcessError as e:
        return e.returncode or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
