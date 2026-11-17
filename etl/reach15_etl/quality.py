"""Data quality report and release gates, evaluated after every build."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import psycopg

MIN_MAIN_COMPONENT_SHARE = 0.95
MIN_STOP_SNAP_SHARE = 0.9

_METRICS = {
    "walk_ways": "SELECT count(*) FROM osm.walk_ways",
    "edges": "SELECT count(*) FROM routing.edges",
    "vertices": "SELECT count(*) FROM routing.vertices",
    "main_component_share": "SELECT coalesce(avg(in_main_component::int), 0)::float FROM routing.vertices",
    "invalid_edge_geoms": "SELECT count(*) FROM routing.edges WHERE NOT ST_IsValid(geom)",
    "pois_by_category": """
        SELECT coalesce(jsonb_object_agg(category, n), '{}')
        FROM (SELECT category, count(*) AS n FROM osm.pois GROUP BY category) s""",
    "sources_by_category": """
        SELECT coalesce(jsonb_object_agg(category, n), '{}')
        FROM (SELECT category, count(*) AS n FROM analytics.category_sources GROUP BY category) s""",
    "h3_cells": "SELECT count(*) FROM analytics.h3_cell",
    "h3_cells_in_district": "SELECT count(*) FROM analytics.h3_cell WHERE district_id IS NOT NULL",
    "search_places": "SELECT count(*) FROM search.place",
    "opening_hours_known": "SELECT count(*) FROM analytics.poi_hours",
    "transit_stops": "SELECT count(*) FROM transit.stops",
    # Stops inside the street graph's extent that could be snapped (the feed also covers suburbs).
    "transit_stops_snapped_share": """
        SELECT coalesce(avg((sv.stop_idx IS NOT NULL)::int), 0)::float
        FROM transit.stops s
        LEFT JOIN transit.stop_vertex sv USING (stop_idx)
        WHERE s.geom && (SELECT ST_SetSRID(ST_Extent(geom), 4326) FROM routing.vertices)""",
}


@dataclass
class QualityReport:
    metrics: dict[str, Any]
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def as_json(self) -> dict[str, Any]:
        return {"metrics": self.metrics, "failures": self.failures, "passed": self.passed}


def evaluate(metrics: dict[str, Any]) -> list[str]:
    """Release gates. Pure function, so it is unit tested without a database."""
    failures = []
    if metrics.get("edges", 0) == 0:
        failures.append("routing graph is empty")
    share = metrics.get("main_component_share", 0.0)
    if share < MIN_MAIN_COMPONENT_SHARE:
        failures.append(f"main component holds {share:.1%} of vertices (< {MIN_MAIN_COMPONENT_SHARE:.0%})")
    if metrics.get("invalid_edge_geoms", 0) > 0:
        failures.append(f"{metrics['invalid_edge_geoms']} edges have invalid geometry")
    if metrics.get("h3_cells", 0) > 0 and metrics.get("h3_cells_in_district", 0) == 0:
        failures.append("no H3 cell lies inside a district boundary")
    if metrics.get("transit_stops", 0) > 0:
        stops = metrics.get("transit_stops_snapped_share", 0.0)
        if stops < MIN_STOP_SNAP_SHARE:
            failures.append(
                f"only {stops:.1%} of transit stops reach the street graph (< {MIN_STOP_SNAP_SHARE:.0%})"
            )
    sources = metrics.get("sources_by_category", {})
    for category in sorted(metrics.get("pois_by_category", {})):
        if not sources.get(category):
            failures.append(f"category '{category}' has POIs but no routable source")
    return failures


def collect(conn: psycopg.Connection, extra: dict[str, Any] | None = None) -> QualityReport:
    metrics: dict[str, Any] = dict(extra or {})
    with conn.cursor() as cur:
        for name, sql in _METRICS.items():
            cur.execute(sql)
            metrics[name] = cur.fetchone()[0]
    return QualityReport(metrics=metrics, failures=evaluate(metrics))
