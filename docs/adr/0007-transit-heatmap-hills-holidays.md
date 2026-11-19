# ADR 0007: Public transport heatmap, hill-aware cycling, public holidays

- Status: accepted
- Date: 2026-11-19

## Context

Phase 6 added public transport per place only: the heatmap and the district ranking stayed walk
and bike, so a visitor choosing "Transit" saw walking colours. Cycling treated Buda's hills like
Pest's flat streets. "When?" ignored public holidays, although many shops keep different hours
then. Flat-hunters asked to compare the flats they are viewing side by side.

## Decisions

**Public transport heatmap, per H3 cell, for one departure.** After each data build the API image
runs once as a batch job (`--reach15.precompute=transit-heatmap`) and, for every cell, walks from
the street vertex nearest the cell centre to the stops within 15 minutes (an in-memory Dijkstra
over the walking graph), runs RAPTOR for up to 30 minutes, and walks on from every stop reached.
The walk from a stop to the nearest place of a category is already precomputed
(`analytics.vertex_category_time`), so it is a lookup, not a search. A direct walk counts too: the
result is never worse than walking. The departure is 08:00 on the next Tuesday, an ordinary weekday.

The job lives in the API because RAPTOR does (Kotlin, ADR 0005); porting it to the Python ETL
would mean two implementations of the timetable search. The serving connection pool is read-only,
so the job writes through its own connection with the pool's settings. Results go to
`analytics.h3_category_time` (mode `transit`) and the `transit_*` keys of `h3_cell.times`; the
heatmap (`/api/v1/cells`) and the ranking read them like walk and bike.

Considered: computing transit per vertex like walk and bike (189k RAPTOR runs instead of 8.5k);
a range query over a time window (better for "how frequent is the service", several times the
cost). One fixed departure is the honest, explainable choice, and the legend says it.

**Hills: a DEM, sampled along every edge, turned into cycling time.** The ETL reads the Budapest
window of Copernicus DEM GLO-30 (two 1° tiles, read by HTTP range requests: ~4 MB written),
samples each edge every 15 m, and stores the height gained and lost from source to target.
`routing.bike_hill_cost` adds 3.5 s per metre climbed and takes off 1.2 s per metre descended,
never faster than 30 km/h. Walking is unchanged.

Copernicus is a surface model: in a city it sees roofs and tree tops. The first version sampled it
as is, and the Budapest build showed the cost: inner Pest's narrow streets between 20 m roofs read
as constant climbs, so cycling in flat District V came out 48 % slower than on the flat, more than
hilly District XII (+30 %). Now a ground model comes first (a 7x7 minimum filter keeps the street
and courtyard pixels between buildings, a 5x5 mean smooths the rest), climbs count only past 1 m
(hysteresis) and grades are capped at 20 %. Result, as cycling time over flat on the streets of each
district: flat Pest +2..10 % (bridge ramps and embankments are real), the Buda hills (II, XII)
+17..19 % on average, far more on the steep streets. The drift gate compares walking scores, so the
first release with hills is not blocked.

**Public holidays: in the database, from the Labour Code.** `analytics.hu_holiday(date)` names
the 13 statutory holidays (fixed dates, plus Good Friday, Easter and Whit Sunday/Monday from the
Easter date). 24 December is not on the list: a bill to add it was before Parliament in autumn
2026; it is one line to add. The ETL parses `PH` rules of `opening_hours` into a second
multirange; values that never name `PH` keep their weekly hours on holidays, as the
specification reads. BKK's GTFS already models holiday service (`calendar_dates`).

**Compare places: front end only.** Up to three pinned places, one `/access` request each (the
same query key as the place panel, so a pinned place that is also selected is fetched once),
shared in the URL as `c=lat,lon;...`.

## Consequences

- The data release has one more step and needs the API image of the release.
- Without a GTFS feed there is no transit heatmap; the ranking answers 422 for `mode=transit`
  and the map's transit colours are empty.
- Cycling times in Buda grow by minutes, which is the point; the flat model remains for edges
  outside the DEM.
- Holidays are Hungarian only, like the rest of the product.
