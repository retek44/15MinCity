package hu.reach15.api.transit

/**
 * RAPTOR (Delling, Pajor, Werneck: Round-Based Public Transit Routing, 2012): earliest arrival at
 * every stop from a set of access stops, leaving at a given time.
 *
 * Round k scans every pattern serving a stop improved in round k-1, boards the first trip that can
 * be caught and records the arrivals it improves; footpaths then relax transfers between stops.
 * After [rounds] rounds a journey has used at most that many vehicles. Arrivals are kept in one
 * array across rounds (local pruning), which is what the earliest-arrival question needs.
 */
object Raptor {
    const val UNREACHED = Int.MAX_VALUE

    /**
     * @param access stop index -> seconds after [departure] at which the stop is reached on foot
     * @param departure seconds after midnight of the timetable's service day
     * @param budget arrivals later than [departure] + [budget] are dropped
     * @return per stop, seconds after [departure] of the earliest arrival, or [UNREACHED]
     */
    fun earliestArrivals(
        timetable: Timetable,
        access: Map<Int, Int>,
        departure: Int,
        budget: Int,
        rounds: Int = 4,
    ): IntArray {
        val best = IntArray(timetable.stopCount) { UNREACHED }
        var marked = HashSet<Int>()
        for ((stop, seconds) in access) {
            if (seconds <= budget && seconds < best[stop]) {
                best[stop] = seconds
                marked += stop
            }
        }
        marked = relaxFootpaths(timetable, best, marked, budget)

        val start = IntArray(timetable.patterns.size) { -1 }
        repeat(rounds) {
            if (marked.isEmpty()) return best
            // Earliest marked position of every pattern that serves a marked stop.
            val queued = ArrayList<Int>()
            for (stop in marked) {
                val serving = timetable.stopPatterns[stop]
                for (i in serving.indices step 2) {
                    val p = serving[i]
                    val pos = serving[i + 1]
                    if (start[p] == -1) queued += p
                    if (start[p] == -1 || pos < start[p]) start[p] = pos
                }
            }

            val improved = HashSet<Int>()
            for (p in queued) {
                val pattern = timetable.patterns[p]
                var trip = -1
                for (pos in start[p] until pattern.stops.size) {
                    val stop = pattern.stops[pos]
                    if (trip >= 0) {
                        val arrival = pattern.arrival(trip, pos) - departure
                        if (arrival < best[stop] && arrival <= budget) {
                            best[stop] = arrival
                            improved += stop
                        }
                    }
                    // Catch an earlier trip here if this stop is reached before the current one leaves.
                    if (best[stop] != UNREACHED && pos < pattern.stops.size - 1) {
                        val readyAt = departure + best[stop]
                        if (trip < 0 || pattern.departure(trip, pos) > readyAt) {
                            val earlier = pattern.firstTripFrom(pos, readyAt)
                            if (earlier >= 0 && (trip < 0 || earlier < trip)) trip = earlier
                        }
                    }
                }
                start[p] = -1
            }
            marked = relaxFootpaths(timetable, best, improved, budget)
        }
        return best
    }

    /** Walks from every stop in [from] to its neighbours; returns [from] plus the stops improved. */
    private fun relaxFootpaths(
        timetable: Timetable,
        best: IntArray,
        from: HashSet<Int>,
        budget: Int,
    ): HashSet<Int> {
        val result = HashSet(from)
        for (stop in from) {
            val paths = timetable.transfers[stop]
            for (i in paths.indices step 2) {
                val to = paths[i]
                val arrival = best[stop] + paths[i + 1]
                if (arrival < best[to] && arrival <= budget) {
                    best[to] = arrival
                    result += to
                }
            }
        }
        return result
    }
}
