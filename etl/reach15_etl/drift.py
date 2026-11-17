"""Score drift between two data releases.

A new OSM import should move scores a little (a shop opened, a path was mapped), not a lot.
A large shift usually means a broken import or a tagging change upstream, so the weekly data
release compares the candidate database with the one in production before swapping them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import psycopg

MAX_SECONDS = 900.0
CATEGORIES = (
    "grocery",
    "pharmacy",
    "doctor",
    "school",
    "kindergarten",
    "park",
    "transit",
    "food",
    "gym",
    "library",
)

# A cell "moved" if its balanced walking score changed by more than this many points.
CELL_THRESHOLD = 10.0
# The release is blocked if more than this share of the common cells moved...
MAX_MOVED_SHARE = 0.05
# ...or if the number of cells changed by more than this share.
MAX_CELL_COUNT_CHANGE = 0.05


def balanced_score(times: dict[str, Any], mode: str = "walk") -> float:
    """Equal-weight score, 0..100 (same formula as analytics.access_score)."""
    total = 0.0
    for category in CATEGORIES:
        seconds = times.get(f"{mode}_{category}")
        if seconds is not None:
            total += max(0.0, min(1.0, 1.0 - float(seconds) / MAX_SECONDS))
    return 100.0 * total / len(CATEGORIES)


@dataclass
class DriftReport:
    baseline_cells: int
    candidate_cells: int
    common_cells: int
    moved_cells: int
    mean_delta: float
    largest: list[tuple[str, float, float]] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def as_json(self) -> dict[str, Any]:
        return {
            "baseline_cells": self.baseline_cells,
            "candidate_cells": self.candidate_cells,
            "common_cells": self.common_cells,
            "moved_cells": self.moved_cells,
            "mean_delta": round(self.mean_delta, 3),
            "largest": [{"h3": h, "before": round(b, 1), "after": round(a, 1)} for h, b, a in self.largest],
            "failures": self.failures,
            "passed": self.passed,
        }


def compare(baseline: dict[str, dict[str, Any]], candidate: dict[str, dict[str, Any]]) -> DriftReport:
    """Pure comparison of {h3: times} maps, so the gate is unit tested without databases."""
    common = baseline.keys() & candidate.keys()
    deltas = {h: (balanced_score(baseline[h]), balanced_score(candidate[h])) for h in common}
    moved = [h for h, (b, a) in deltas.items() if abs(a - b) > CELL_THRESHOLD]
    mean_delta = sum(a - b for b, a in deltas.values()) / len(deltas) if deltas else 0.0
    largest = sorted(((h, b, a) for h, (b, a) in deltas.items()), key=lambda x: -abs(x[2] - x[1]))[:10]

    report = DriftReport(
        baseline_cells=len(baseline),
        candidate_cells=len(candidate),
        common_cells=len(common),
        moved_cells=len(moved),
        mean_delta=mean_delta,
        largest=largest,
    )
    if baseline:
        change = abs(len(candidate) - len(baseline)) / len(baseline)
        if change > MAX_CELL_COUNT_CHANGE:
            report.failures.append(
                f"cell count changed by {change:.1%} ({len(baseline)} -> {len(candidate)}), "
                f"limit {MAX_CELL_COUNT_CHANGE:.0%}"
            )
    if common and len(moved) / len(common) > MAX_MOVED_SHARE:
        report.failures.append(
            f"{len(moved)} of {len(common)} cells ({len(moved) / len(common):.1%}) moved more than "
            f"{CELL_THRESHOLD:.0f} points, limit {MAX_MOVED_SHARE:.0%}"
        )
    return report


def load(conninfo: str) -> dict[str, dict[str, Any]]:
    with psycopg.connect(conninfo) as conn:
        rows = conn.execute("SELECT h3::text, times FROM analytics.h3_cell").fetchall()
    return {h3: times for h3, times in rows}
