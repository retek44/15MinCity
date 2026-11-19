"""Elevation for hill-aware cycling.

The DEM is Copernicus DEM GLO-30 (30 m, free and open; attribution: "Produced using Copernicus
WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under
COPERNICUS by the European Union and ESA; all rights reserved"). Its tiles are cloud-optimised
GeoTIFFs on a public bucket, so only the Budapest window is read, by HTTP range requests.

Copernicus is a surface model: it sees roofs and tree tops, not only the ground. Sampled as is,
the narrow streets of inner Pest between 20 m roofs read as constant climbs (cycling in District
V came out 48 % slower than flat, more than hilly District XII). So a ground model comes first:
a 7x7 minimum filter (210 m) keeps the street and courtyard pixels between buildings, and a 5x5
mean smooths what is left. Every edge is then sampled every 15 m (bilinear), and climbs and
descents count only once they exceed 1 m (hysteresis), with grades capped at 20 %. Measured on
Budapest, as cycling time over flat on each district's streets: flat Pest +2..10 % (bridge ramps,
embankments), the Buda hills (II, XII) +17..19 % on average, far more on the steep streets.

The height gained and lost from source to target goes to routing.edge_elevation;
routing.apply_elevation() turns it into cycling costs.
"""

from __future__ import annotations

import logging
from pathlib import Path

import psycopg

log = logging.getLogger("reach15")

TILE_URL = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
)
DEM_FILE = "budapest-dem.tif"
SAMPLE_M = 15
MAX_GRADE = 0.2  # steeper streets exist, but over 20 % is a roof edge or a bridge in the DSM
HYSTERESIS_M = 1.0
GROUND_MIN_PX = 7
GROUND_MEAN_PX = 5


def tile_urls(bbox: tuple[float, float, float, float]) -> list[str]:
    """The 1x1 degree tiles covering a bbox (west, south, east, north)."""
    west, south, east, north = bbox
    return [
        TILE_URL.format(lat=lat, lon=lon)
        for lat in range(int(south), int(north) + 1)
        for lon in range(int(west), int(east) + 1)
    ]


def download(data_dir: str, bbox: tuple[float, float, float, float]) -> Path:
    """Reads the bbox window of the covering tiles and writes one compressed GeoTIFF."""
    import rasterio
    from rasterio.merge import merge

    out = Path(data_dir) / DEM_FILE
    sources = [rasterio.open(f"/vsicurl/{url}") for url in tile_urls(bbox)]
    try:
        mosaic, transform = merge(sources, bounds=bbox)
        profile = {
            "driver": "GTiff",
            "dtype": "float32",
            "count": 1,
            "height": mosaic.shape[1],
            "width": mosaic.shape[2],
            "crs": sources[0].crs,
            "transform": transform,
            "compress": "deflate",
            "predictor": 3,
            "nodata": sources[0].nodata,
        }
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(mosaic.astype("float32"))
    finally:
        for s in sources:
            s.close()
    log.info("DEM %dx%d written to %s", mosaic.shape[2], mosaic.shape[1], out)
    return out


def climb_descent(z: list[float], length_m: float) -> tuple[float, float]:
    """Height gained and lost along a profile, counting changes of more than HYSTERESIS_M only,
    capped at MAX_GRADE."""
    if len(z) < 2 or length_m <= 0:
        return 0.0, 0.0
    climb = descent = 0.0
    anchor = z[0]
    for v in z[1:]:
        if v - anchor > HYSTERESIS_M:
            climb += v - anchor
            anchor = v
        elif anchor - v > HYSTERESIS_M:
            descent += anchor - v
            anchor = v
    cap = MAX_GRADE * length_m
    return round(min(climb, cap), 2), round(min(descent, cap), 2)


def _filter(a, k: int, reduce):
    """Separable k x k window filter (min and mean are both separable)."""
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view

    p = k // 2
    a = np.pad(a, ((p, p), (0, 0)), mode="edge")
    a = reduce(sliding_window_view(a, k, axis=0), axis=-1)
    a = np.pad(a, ((0, 0), (p, p)), mode="edge")
    return reduce(sliding_window_view(a, k, axis=1), axis=-1)


def ground(z):
    """An approximate terrain model from a surface model: minimum, then mean filter."""
    import numpy as np

    return _filter(_filter(z, GROUND_MIN_PX, np.min), GROUND_MEAN_PX, np.mean)


class Dem:
    """A DEM held in memory, sampled bilinearly at lon/lat points."""

    def __init__(self, path: str | Path):
        import numpy as np
        import rasterio

        with rasterio.open(path) as src:
            self.z = src.read(1).astype("float64")
            nodata = src.nodata
            self.inverse = ~src.transform
        if nodata is not None:
            self.z[self.z == nodata] = np.nan
        self.z = ground(self.z)
        self.np = np

    def sample(self, lons: list[float], lats: list[float]) -> list[float]:
        np = self.np
        a, b, c, d, e, f = self.inverse[:6]
        x = np.asarray(lons)
        y = np.asarray(lats)
        # pixel coordinates relative to pixel centres
        col = a * x + b * y + c - 0.5
        row = d * x + e * y + f - 0.5
        h, w = self.z.shape
        col = np.clip(col, 0, w - 1.001)
        row = np.clip(row, 0, h - 1.001)
        c0 = np.floor(col).astype(int)
        r0 = np.floor(row).astype(int)
        dc = col - c0
        dr = row - r0
        z = self.z
        top = z[r0, c0] * (1 - dc) + z[r0, c0 + 1] * dc
        bottom = z[r0 + 1, c0] * (1 - dc) + z[r0 + 1, c0 + 1] * dc
        return list(top * (1 - dr) + bottom * dr)


def load(conn: psycopg.Connection, dem_path: str | Path) -> int:
    """Samples every edge and applies the climbs to the cycling costs; returns edges updated."""
    dem = Dem(dem_path)
    rows = conn.execute(
        f"""
        SELECT e.id, e.length_m,
               array_agg(ST_X(p.geom) ORDER BY p.path), array_agg(ST_Y(p.geom) ORDER BY p.path)
        FROM routing.edges e
        CROSS JOIN LATERAL ST_DumpPoints(ST_Segmentize(e.geom::geography, {SAMPLE_M})::geometry) p
        GROUP BY e.id, e.length_m
        """
    ).fetchall()
    skipped = 0
    with conn.cursor() as cur:
        cur.execute("TRUNCATE routing.edge_elevation")
        with cur.copy("COPY routing.edge_elevation (edge_id, climb_m, descent_m) FROM STDIN") as copy:
            for edge_id, length_m, lons, lats in rows:
                z = dem.sample(lons, lats)
                if any(v != v for v in z):  # NaN: outside the DEM or no data
                    skipped += 1
                    continue
                climb, descent = climb_descent(z, length_m)
                if climb or descent:
                    copy.write_row((edge_id, climb, descent))
    if skipped:
        log.warning("%d edges outside the DEM keep flat cycling costs", skipped)
    return conn.execute("SELECT routing.apply_elevation()").fetchone()[0]
