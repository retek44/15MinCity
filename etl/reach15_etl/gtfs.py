"""GTFS import: a zip file or a directory of .txt files into the `transit` schema.

Stops and trips get dense integer indexes (stop_idx, trip_idx): the API loads one service day of
stop_times into arrays indexed by them, and the BKK feed has ~6 million stop_times rows.
Only boarding stops are kept (location_type 0 or empty); stations, entrances and nodes are not
needed by the timetable search.
"""

from __future__ import annotations

import csv
import datetime
import io
import logging
import os
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg

log = logging.getLogger("reach15")

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def seconds(hms: str) -> int | None:
    """GTFS time (may exceed 24:00:00) as seconds after midnight of the service day."""
    hms = hms.strip()
    if not hms:
        return None
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def gtfs_date(value: str) -> datetime.date:
    return datetime.datetime.strptime(value.strip(), "%Y%m%d").date()


class Feed:
    """Reads GTFS tables from a zip archive or a directory."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._zip = zipfile.ZipFile(self.path) if self.path.is_file() else None

    def has(self, table: str) -> bool:
        name = f"{table}.txt"
        if self._zip:
            return name in self._zip.namelist()
        return (self.path / name).exists()

    @contextmanager
    def rows(self, table: str) -> Iterator[Iterator[dict[str, str]]]:
        name = f"{table}.txt"
        if self._zip:
            raw = self._zip.open(name)
            handle = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        else:
            handle = (self.path / name).open(encoding="utf-8-sig", newline="")
        try:
            yield csv.DictReader(handle)
        finally:
            handle.close()


def load(conn: psycopg.Connection, path: str | os.PathLike[str]) -> dict[str, int]:
    """Replaces the transit schema's timetable with the feed at `path`. Returns row counts."""
    feed = Feed(path)
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        cur.execute(
            "TRUNCATE transit.feed, transit.stops, transit.routes, transit.trips, transit.stop_times,"
            " transit.calendar, transit.calendar_dates, transit.stop_vertex, transit.transfers"
        )

        stop_idx: dict[str, int] = {}
        with (
            feed.rows("stops") as rows,
            cur.copy("COPY transit.stops (stop_idx, stop_id, name, geom) FROM STDIN") as copy,
        ):
            for row in rows:
                if row.get("location_type", "").strip() not in ("", "0"):
                    continue
                idx = len(stop_idx)
                stop_idx[row["stop_id"]] = idx
                point = f"SRID=4326;POINT({float(row['stop_lon'])} {float(row['stop_lat'])})"
                copy.write_row((idx, row["stop_id"], row.get("stop_name") or row["stop_id"], point))
        counts["stops"] = len(stop_idx)

        n = 0
        with (
            feed.rows("routes") as rows,
            cur.copy(
                "COPY transit.routes (route_id, short_name, long_name, route_type, color) FROM STDIN"
            ) as copy,
        ):
            for row in rows:
                copy.write_row(
                    (
                        row["route_id"],
                        row.get("route_short_name") or None,
                        row.get("route_long_name") or None,
                        int(row["route_type"]),
                        row.get("route_color") or None,
                    )
                )
                n += 1
        counts["routes"] = n

        trip_idx: dict[str, int] = {}
        with (
            feed.rows("trips") as rows,
            cur.copy(
                "COPY transit.trips (trip_idx, trip_id, route_id, service_id, headsign) FROM STDIN"
            ) as copy,
        ):
            for row in rows:
                idx = len(trip_idx)
                trip_idx[row["trip_id"]] = idx
                copy.write_row(
                    (
                        idx,
                        row["trip_id"],
                        row["route_id"],
                        row["service_id"],
                        row.get("trip_headsign") or None,
                    )
                )
        counts["trips"] = len(trip_idx)

        n = skipped = 0
        previous: tuple[int, int] | None = None  # (trip_idx, last known time) for untimed stops
        with (
            feed.rows("stop_times") as rows,
            cur.copy(
                "COPY transit.stop_times (trip_idx, stop_sequence, stop_idx, arrival_s, departure_s)"
                " FROM STDIN"
            ) as copy,
        ):
            for row in rows:
                trip = trip_idx.get(row["trip_id"])
                stop = stop_idx.get(row["stop_id"])
                if trip is None or stop is None:
                    skipped += 1
                    continue
                arr, dep = seconds(row.get("arrival_time", "")), seconds(row.get("departure_time", ""))
                arr = arr if arr is not None else dep
                dep = dep if dep is not None else arr
                if arr is None:
                    if previous is None or previous[0] != trip:
                        skipped += 1
                        continue
                    arr = dep = previous[1]  # untimed stop: no earlier than the previous one
                previous = (trip, dep)
                copy.write_row((trip, int(row["stop_sequence"]), stop, arr, dep))
                n += 1
        counts["stop_times"] = n
        if skipped:
            log.warning("skipped %d stop_times rows (unknown trip/stop or untimed)", skipped)

        n = 0
        if feed.has("calendar"):
            with (
                feed.rows("calendar") as rows,
                cur.copy(
                    "COPY transit.calendar (service_id, weekdays, start_date, end_date) FROM STDIN"
                ) as copy,
            ):
                for row in rows:
                    weekdays = [i + 1 for i, day in enumerate(DAYS) if row.get(day, "0").strip() == "1"]
                    copy.write_row(
                        (
                            row["service_id"],
                            weekdays,
                            gtfs_date(row["start_date"]),
                            gtfs_date(row["end_date"]),
                        )
                    )
                    n += 1
        counts["calendar"] = n

        n = 0
        if feed.has("calendar_dates"):
            with (
                feed.rows("calendar_dates") as rows,
                cur.copy("COPY transit.calendar_dates (service_id, date, exception_type) FROM STDIN") as copy,
            ):
                for row in rows:
                    copy.write_row((row["service_id"], gtfs_date(row["date"]), int(row["exception_type"])))
                    n += 1
        counts["calendar_dates"] = n

        version = start = end = None
        if feed.has("feed_info"):
            with feed.rows("feed_info") as rows:
                info = next(iter(rows), {})
                version = info.get("feed_version") or None
                start = gtfs_date(info["feed_start_date"]) if info.get("feed_start_date") else None
                end = gtfs_date(info["feed_end_date"]) if info.get("feed_end_date") else None
        cur.execute(
            "INSERT INTO transit.feed (source_file, version, start_date, end_date) VALUES (%s, %s, %s, %s)",
            (Path(path).name, version, start, end),
        )
        for table in ("stops", "trips", "stop_times", "calendar_dates"):
            cur.execute(f"ANALYZE transit.{table}")
    return counts
