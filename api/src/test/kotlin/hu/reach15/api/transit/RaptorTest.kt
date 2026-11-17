package hu.reach15.api.transit

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Hand-made timetable, times as hh:mm:
 *
 *   line 1: stop 0 -> 1 -> 2, leaving 0 at 08:00 and 08:20, 5 minutes per hop
 *   line 2: stop 3 -> 4, leaving 3 at 08:12 and 08:30, 8 minutes
 *   footpath: 2 <-> 3, 60 s
 */
class RaptorTest {
    private fun t(h: Int, m: Int) = h * 3600 + m * 60

    private fun trip(vararg stopsAndTimes: Pair<Int, Int>) =
        Timetable.Trip(
            stopsAndTimes.map { it.first }.toIntArray(),
            stopsAndTimes.map { it.second }.toIntArray(),
            stopsAndTimes.map { it.second }.toIntArray(),
        )

    private fun timetable(trips: List<Timetable.Trip>, transfers: Map<Int, List<Pair<Int, Int>>> = emptyMap(), stops: Int = 5) =
        Timetable(
            LongArray(stops) { it.toLong() },
            DoubleArray(stops),
            Timetable.patterns(trips),
            Array(stops) { s -> transfers[s].orEmpty().flatMap { listOf(it.first, it.second) }.toIntArray() },
        )

    private val network =
        timetable(
            listOf(
                trip(0 to t(8, 0), 1 to t(8, 5), 2 to t(8, 10)),
                trip(0 to t(8, 20), 1 to t(8, 25), 2 to t(8, 30)),
                trip(3 to t(8, 12), 4 to t(8, 20)),
                trip(3 to t(8, 30), 4 to t(8, 38)),
            ),
            transfers = mapOf(2 to listOf(3 to 60), 3 to listOf(2 to 60)),
        )

    @Test
    fun `rides, walks a transfer and catches the connecting line`() {
        val best = Raptor.earliestArrivals(network, mapOf(0 to 0), t(8, 0), budget = 3600)
        assertEquals(listOf(0, 300, 600, 660, 1200), best.toList())
    }

    @Test
    fun `missing the first trip means waiting for the next one`() {
        val best = Raptor.earliestArrivals(network, mapOf(0 to 60), t(8, 0), budget = 3600)
        assertEquals(t(8, 30) - t(8, 0), best[2])
        assertEquals(Raptor.UNREACHED, best[4], "08:31 at stop 3 is a minute too late for the last 08:30 trip")
    }

    @Test
    fun `one round allows only one vehicle`() {
        val best = Raptor.earliestArrivals(network, mapOf(0 to 0), t(8, 0), budget = 3600, rounds = 1)
        assertEquals(600, best[2])
        assertEquals(Raptor.UNREACHED, best[4])
    }

    @Test
    fun `arrivals beyond the budget are dropped`() {
        val best = Raptor.earliestArrivals(network, mapOf(0 to 0), t(8, 0), budget = 900)
        assertEquals(600, best[2])
        assertEquals(Raptor.UNREACHED, best[4])
    }

    @Test
    fun `nothing runs before the first departure is missed entirely`() {
        val best = Raptor.earliestArrivals(network, mapOf(0 to 0), t(9, 0), budget = 3600)
        assertEquals(listOf(0, Raptor.UNREACHED, Raptor.UNREACHED, Raptor.UNREACHED, Raptor.UNREACHED), best.toList())
    }

    @Test
    fun `an overtaking express gets its own pattern and is found`() {
        val slow = trip(0 to t(8, 0), 1 to t(8, 30))
        val express = trip(0 to t(8, 5), 1 to t(8, 10))
        val tt = timetable(listOf(slow, express), stops = 2)
        assertEquals(2, tt.patterns.size, "FIFO split")
        assertEquals(600, Raptor.earliestArrivals(tt, mapOf(0 to 0), t(8, 0), budget = 3600)[1])
    }
}
