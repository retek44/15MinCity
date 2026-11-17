package hu.reach15.api.transit

/**
 * One service day of a GTFS feed in the shape RAPTOR scans: trips grouped into patterns (trips
 * that serve the same stops in the same order), each pattern's times in flat arrays.
 *
 * Times are seconds after midnight of the service day. Trips of the previous service day that run
 * past midnight are included with their times shifted by -24 h, so a 00:30 departure finds them.
 */
class Timetable(
    /** Street vertex each stop is snapped to, or -1 if it is off the street graph. */
    val stopVertex: LongArray,
    /** Walking time between the stop and its vertex, seconds. */
    val stopOffset: DoubleArray,
    val patterns: List<Pattern>,
    /** Footpaths per stop: interleaved (to stop, seconds). */
    val transfers: Array<IntArray>,
) {
    val stopCount: Int get() = stopVertex.size

    /** Patterns serving each stop: interleaved (pattern index, position in the pattern). */
    val stopPatterns: Array<IntArray> =
        run {
            val lists = Array(stopCount) { ArrayList<Int>() }
            patterns.forEachIndexed { p, pattern ->
                pattern.stops.forEachIndexed { pos, stop ->
                    lists[stop].add(p)
                    lists[stop].add(pos)
                }
            }
            Array(stopCount) { lists[it].toIntArray() }
        }

    val tripCount: Int get() = patterns.sumOf { it.tripCount }

    /**
     * Trips that serve the same stop sequence, ordered so that no trip overtakes another
     * (FIFO): then "the first trip departing after t" is a binary search at every stop.
     */
    class Pattern(val stops: IntArray, val arrivals: IntArray, val departures: IntArray) {
        val tripCount: Int = if (stops.isEmpty()) 0 else departures.size / stops.size

        fun arrival(trip: Int, pos: Int) = arrivals[trip * stops.size + pos]

        fun departure(trip: Int, pos: Int) = departures[trip * stops.size + pos]

        /** First trip leaving position [pos] at or after [time], or -1. */
        fun firstTripFrom(pos: Int, time: Int): Int {
            var lo = 0
            var hi = tripCount
            while (lo < hi) {
                val mid = (lo + hi) ushr 1
                if (departure(mid, pos) < time) lo = mid + 1 else hi = mid
            }
            return if (lo < tripCount) lo else -1
        }
    }

    /** A trip as loaded from the database. */
    class Trip(val stops: IntArray, val arrivals: IntArray, val departures: IntArray)

    companion object {
        /** Groups trips into FIFO patterns. */
        fun patterns(trips: Collection<Trip>): List<Pattern> {
            val bySequence = trips.filter { it.stops.size >= 2 }.groupBy { it.stops.toList() }
            val result = ArrayList<Pattern>()
            for ((sequence, group) in bySequence) {
                // Greedy split: each trip joins the first sub-pattern it does not overtake.
                val lanes = ArrayList<ArrayList<Trip>>()
                for (trip in group.sortedBy { it.departures[0] }) {
                    val lane =
                        lanes.firstOrNull { lane ->
                            val last = lane.last()
                            trip.departures.indices.all {
                                trip.departures[it] >= last.departures[it] && trip.arrivals[it] >= last.arrivals[it]
                            }
                        }
                    if (lane != null) lane.add(trip) else lanes.add(arrayListOf(trip))
                }
                val stops = sequence.toIntArray()
                for (lane in lanes) {
                    result +=
                        Pattern(
                            stops,
                            lane.flatMap { it.arrivals.asIterable() }.toIntArray(),
                            lane.flatMap { it.departures.asIterable() }.toIntArray(),
                        )
                }
            }
            return result
        }
    }
}
