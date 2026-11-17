import math
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from reach15_etl import fixtures

COMMITTED = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "osm" / "grid.osm"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@pytest.fixture(scope="module")
def osm() -> ET.Element:
    return ET.fromstring(fixtures.build_grid_fixture())


def node_pos(osm: ET.Element, node_id: int) -> tuple[float, float]:
    node = osm.find(f"node[@id='{node_id}']")
    assert node is not None, f"node {node_id} missing"
    return float(node.get("lat")), float(node.get("lon"))


def test_committed_fixture_is_up_to_date():
    assert COMMITTED.read_text(encoding="utf-8") == fixtures.build_grid_fixture(), (
        "tests/fixtures/osm/grid.osm is stale: regenerate it with "
        "`python -m reach15_etl.cli fixture --out ../tests/fixtures/osm/grid.osm`"
    )


@pytest.mark.parametrize(("a", "b"), [((0, 0), (0, 1)), ((0, 0), (1, 0)), ((9, 8), (9, 9)), ((4, 4), (5, 4))])
def test_grid_spacing_is_100_m(osm, a, b):
    d = haversine_m(*node_pos(osm, fixtures.grid_id(*a)), *node_pos(osm, fixtures.grid_id(*b)))
    assert d == pytest.approx(fixtures.SPACING_M, rel=0.005)


def test_every_way_references_existing_nodes(osm):
    node_ids = {n.get("id") for n in osm.iter("node")}
    for way in osm.iter("way"):
        for nd in way.iter("nd"):
            assert nd.get("ref") in node_ids, f"way {way.get('id')} references missing node {nd.get('ref')}"


def test_ids_are_unique(osm):
    for kind in ("node", "way", "relation"):
        ids = [e.get("id") for e in osm.iter(kind)]
        assert len(ids) == len(set(ids)), f"duplicate {kind} ids"


def test_grid_has_expected_size(osm):
    rows_and_cols = [w for w in osm.iter("way") if int(w.get("id")) <= 2 * fixtures.GRID]
    assert len(rows_and_cols) == 2 * fixtures.GRID
    assert all(len(w.findall("nd")) == fixtures.GRID for w in rows_and_cols)


def test_committed_gtfs_fixture_is_up_to_date():
    gtfs_dir = COMMITTED.parents[1] / "gtfs"
    for name, text in fixtures.build_gtfs_fixture().items():
        assert (gtfs_dir / name).read_text(encoding="utf-8") == text, (
            f"tests/fixtures/gtfs/{name} is stale: regenerate it with `python -m reach15_etl.cli fixture "
            "--out ../tests/fixtures/osm/grid.osm --gtfs-dir ../tests/fixtures/gtfs`"
        )


def test_gtfs_tram_runs_every_ten_minutes_both_ways():
    feed = fixtures.build_gtfs_fixture()
    trips = feed["trips.txt"].strip().splitlines()[1:]
    per_direction = (fixtures.TRAM_LAST - fixtures.TRAM_FIRST) // fixtures.TRAM_HEADWAY_MINUTES + 1
    assert len(trips) == 2 * per_direction
    assert "T1-0-0800,08:03:00,08:03:00,far,2" in feed["stop_times.txt"]
