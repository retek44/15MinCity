from reach15_etl.quality import evaluate

HEALTHY = {
    "edges": 182,
    "main_component_share": 0.98,
    "invalid_edge_geoms": 0,
    "pois_by_category": {"grocery": 1, "park": 1},
    "sources_by_category": {"grocery": 1, "park": 9},
    "h3_cells": 14,
    "h3_cells_in_district": 10,
}


def test_healthy_build_passes():
    assert evaluate(HEALTHY) == []


def test_empty_graph_fails():
    assert "routing graph is empty" in evaluate({**HEALTHY, "edges": 0})


def test_fragmented_graph_fails():
    failures = evaluate({**HEALTHY, "main_component_share": 0.80})
    assert any("main component" in f for f in failures)


def test_invalid_geometry_fails():
    failures = evaluate({**HEALTHY, "invalid_edge_geoms": 3})
    assert any("invalid geometry" in f for f in failures)


def test_cells_outside_every_district_fail():
    failures = evaluate({**HEALTHY, "h3_cells_in_district": 0})
    assert failures == ["no H3 cell lies inside a district boundary"]


def test_category_without_sources_fails():
    failures = evaluate({**HEALTHY, "sources_by_category": {"grocery": 1}})
    assert failures == ["category 'park' has POIs but no routable source"]
