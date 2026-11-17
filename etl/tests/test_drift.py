import pytest

from reach15_etl.drift import CATEGORIES, balanced_score, compare


def cell(seconds: float | None) -> dict:
    """Times for one cell: every category at the same walking time (None = unreachable)."""
    return {} if seconds is None else {f"walk_{c}": seconds for c in CATEGORIES}


def city(n: int, seconds: float = 300) -> dict:
    return {f"cell{i}": cell(seconds) for i in range(n)}


def test_balanced_score_matches_the_scoring_formula():
    assert balanced_score(cell(0)) == 100
    assert balanced_score(cell(450)) == pytest.approx(50)
    assert balanced_score(cell(None)) == 0
    assert balanced_score({"walk_grocery": 0}) == pytest.approx(10)  # 1 of 10 categories


def test_identical_releases_pass():
    report = compare(city(100), city(100))
    assert report.passed
    assert report.moved_cells == 0
    assert report.mean_delta == 0


def test_small_local_changes_pass():
    candidate = city(100)
    for i in range(4):  # 4% of cells change a lot
        candidate[f"cell{i}"] = cell(0)
    report = compare(city(100), candidate)
    assert report.passed
    assert report.moved_cells == 4
    assert report.largest[0][0] in {"cell0", "cell1", "cell2", "cell3"}


def test_widespread_change_blocks_the_release():
    candidate = city(100, seconds=900)  # every score drops by ~67 points
    report = compare(city(100), candidate)
    assert not report.passed
    assert "moved more than" in report.failures[0]


def test_losing_cells_blocks_the_release():
    report = compare(city(100), city(90))
    assert not report.passed
    assert "cell count changed by 10.0%" in report.failures[0]


def test_first_release_has_nothing_to_compare():
    assert compare({}, city(10)).passed
