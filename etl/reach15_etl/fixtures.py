"""Synthetic OSM fixture with known answers, used by the database tests.

A 10 x 10 street grid with 100 m spacing. Grid node (row, col) has id 1000 + 10 * row + col,
row grows northwards, col grows eastwards. Walking along the grid takes 75 s per block,
so every expected travel time can be computed by hand.

Extras, each there to exercise one rule of the import / graph build:
  * row 0 is oneway west -> east            (bike graph must be reversed for precompute)
  * diagonal footway with foot=no            (must not be walkable)
  * motorway                                 (must not be walkable)
  * steps north of (9, 9) to node 3101       (walk cost x2)
  * footway island east of the grid          (separate component, never a snap target)
  * POIs: grocery (0,0), pharmacy (9,9), school at 3101, bus stop (0,9),
          cafe on the island (must snap to the grid, 150 m away), park area (3,3)-(5,5)
  * an address node and a district boundary relation around the grid
"""

from __future__ import annotations

import math
from xml.sax.saxutils import quoteattr

ORIGIN_LAT = 47.5
ORIGIN_LON = 19.05
SPACING_M = 100.0
GRID = 10

# WGS84 ellipsoid
_A = 6378137.0
_E2 = 0.00669437999014


def metres_per_degree(lat: float) -> tuple[float, float]:
    """Length of one degree of latitude and longitude at `lat`, in metres."""
    phi = math.radians(lat)
    lat_m = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    lon_m = math.pi / 180 * _A * math.cos(phi) / math.sqrt(1 - _E2 * math.sin(phi) ** 2)
    return lat_m, lon_m


LAT_M, LON_M = metres_per_degree(ORIGIN_LAT)


def position(x_m: float, y_m: float) -> tuple[float, float]:
    """(lat, lon) of a point x_m east and y_m north of the grid origin."""
    return ORIGIN_LAT + y_m / LAT_M, ORIGIN_LON + x_m / LON_M


def grid_id(row: int, col: int) -> int:
    return 1000 + GRID * row + col


class _Builder:
    def __init__(self) -> None:
        self.nodes: list[str] = []
        self.ways: list[str] = []
        self.relations: list[str] = []

    @staticmethod
    def _tags(tags: dict[str, str]) -> str:
        return "".join(f"<tag k={quoteattr(k)} v={quoteattr(v)}/>" for k, v in tags.items())

    def node(self, node_id: int, x_m: float, y_m: float, tags: dict[str, str] | None = None) -> None:
        lat, lon = position(x_m, y_m)
        body = self._tags(tags or {})
        attrs = f'id="{node_id}" version="1" lat="{lat:.8f}" lon="{lon:.8f}"'
        self.nodes.append(f"  <node {attrs}>{body}</node>" if body else f"  <node {attrs}/>")

    def way(self, way_id: int, node_ids: list[int], tags: dict[str, str]) -> None:
        refs = "".join(f'<nd ref="{n}"/>' for n in node_ids)
        self.ways.append(f'  <way id="{way_id}" version="1">{refs}{self._tags(tags)}</way>')

    def relation(self, rel_id: int, outer_way_ids: list[int], tags: dict[str, str]) -> None:
        members = "".join(f'<member type="way" ref="{w}" role="outer"/>' for w in outer_way_ids)
        self.relations.append(f'  <relation id="{rel_id}" version="1">{members}{self._tags(tags)}</relation>')

    def xml(self) -> str:
        lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="reach15-fixtures">']
        lines += self.nodes + self.ways + self.relations
        lines.append("</osm>")
        return "\n".join(lines) + "\n"


def build_grid_fixture() -> str:
    b = _Builder()
    s = SPACING_M
    last = GRID - 1

    for row in range(GRID):
        for col in range(GRID):
            b.node(grid_id(row, col), col * s, row * s)

    # Extra network nodes
    b.node(2001, 0, -2 * s)  # motorway
    b.node(2002, last * s, -2 * s)
    b.node(3001, last * s + 150, 5 * s)  # island
    b.node(3002, last * s + 250, 5 * s)
    b.node(3101, last * s, (last + 1) * s, {"amenity": "school", "name": "Steps School"})

    # POIs
    b.node(5001, 0, 0, {"shop": "supermarket", "name": "Corner Market"})
    b.node(5002, last * s, last * s, {"amenity": "pharmacy", "name": "Grid Pharmacy"})
    b.node(5004, last * s + 150, 5 * s, {"amenity": "cafe", "name": "Island Cafe"})
    b.node(5005, last * s, 0, {"highway": "bus_stop", "name": "Grid Stop"})
    b.node(
        5006, 2 * s, 2 * s, {"addr:street": "Andrássy út", "addr:housenumber": "1", "addr:postcode": "1061"}
    )

    # Park outline (3,3)-(5,5) and district outline around the whole grid
    b.node(6001, 3 * s, 3 * s)
    b.node(6002, 5 * s, 3 * s)
    b.node(6003, 5 * s, 5 * s)
    b.node(6004, 3 * s, 5 * s)
    b.node(7001, -s, -3 * s)
    b.node(7002, (last + 3) * s, -3 * s)
    b.node(7003, (last + 3) * s, (last + 2) * s)
    b.node(7004, -s, (last + 2) * s)

    for row in range(GRID):
        tags = {"highway": "residential", "name": f"Row {row}"}
        if row == 0:
            tags["oneway"] = "yes"
        b.way(1 + row, [grid_id(row, col) for col in range(GRID)], tags)
    for col in range(GRID):
        b.way(11 + col, [grid_id(row, col) for row in range(GRID)], {"highway": "residential"})

    b.way(30, [grid_id(0, 0), grid_id(1, 1)], {"highway": "footway", "foot": "no"})
    b.way(31, [2001, 2002], {"highway": "motorway"})
    b.way(32, [3001, 3002], {"highway": "footway"})
    b.way(33, [grid_id(last, last), 3101], {"highway": "steps"})
    b.way(34, [6001, 6002, 6003, 6004, 6001], {"leisure": "park", "name": "Grid Park"})
    b.way(40, [7001, 7002, 7003, 7004, 7001], {})

    b.relation(
        1,
        [40],
        {"type": "boundary", "boundary": "administrative", "admin_level": "9", "name": "Test District"},
    )
    return b.xml()
