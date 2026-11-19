from reach15_etl import elevation


def test_flat_profile_has_no_climb():
    assert elevation.climb_descent([100.0] * 5, 60) == (0.0, 0.0)


def test_steady_climb_counts_once_each_way():
    z = [100.0, 101.5, 103.0, 104.5, 106.0]
    climb, descent = elevation.climb_descent(z, 60)
    assert climb == 6.0
    assert descent == 0.0


def test_small_wobbles_do_not_add_up_and_grades_are_capped():
    # Half-metre noise along a flat street: no climb at all.
    assert elevation.climb_descent([100.0, 100.5, 100.0, 100.4, 100.0, 100.5], 75) == (0.0, 0.0)
    # Up 3 m and down again: both count once the change passes 1 m.
    assert elevation.climb_descent([100.0, 101.5, 103.0, 101.5, 100.0], 60) == (3.0, 3.0)
    # A 50 % "grade" over 20 m is a bridge or a wall, not a street: capped at 20 %.
    assert elevation.climb_descent([100.0, 110.0], 20) == (4.0, 0.0)


def test_ground_model_removes_buildings_but_keeps_hills():
    import numpy as np

    # A slope of 1 m per pixel (30 m: 3.3 %) with a 20 m "building" of 3x3 pixels on it.
    rows, cols = np.mgrid[0:30, 0:30]
    terrain = 100.0 + cols.astype(float)
    surface = terrain.copy()
    surface[13:16, 13:16] += 20
    g = elevation.ground(surface)
    assert abs(g[14, 14] - terrain[14, 14]) < 4  # the roof is gone (the minimum lowers a slope a little)
    assert g[14, 20] - g[14, 8] > 10  # the hill is still there


def test_tiles_cover_the_budapest_bbox():
    urls = elevation.tile_urls((18.91, 47.34, 19.35, 47.62))
    assert len(urls) == 2
    assert "N47_00_E018_00" in urls[0] and "N47_00_E019_00" in urls[1]
