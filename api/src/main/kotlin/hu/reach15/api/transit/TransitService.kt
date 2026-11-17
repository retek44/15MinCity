package hu.reach15.api.transit

import com.github.benmanes.caffeine.cache.Caffeine
import org.slf4j.LoggerFactory
import org.springframework.cache.annotation.Cacheable
import org.springframework.jdbc.core.RowCallbackHandler
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.min

/**
 * Street vertices with the time already spent reaching them: the start of every on-demand
 * street search (see `analytics.reach_seeded`). A clicked point is one seed; a public transport
 * journey adds one per stop reached.
 */
data class Seeds(val vertices: List<Long>, val seconds: List<Double>) {
    fun vertexArray(): String = vertices.joinToString(",", "{", "}")

    fun secondsArray(): String = seconds.joinToString(",", "{", "}") { "%.1f".format(java.util.Locale.ROOT, it) }
}

data class TransitSeeds(
    val seeds: Seeds,
    val departure: LocalDateTime,
    /** Stops reached within the budget, including those reached on foot. */
    val stopsReached: Int,
    /** Trips running on the service day; 0 when the feed has no service (or no feed). */
    val tripsRunning: Int,
)

/**
 * Public transport on top of the street search: walk to nearby stops (database), ride with
 * RAPTOR over an in-memory timetable of the service day, walk on from every stop reached
 * (database again, one Dijkstra from all of them).
 */
@Service
class TransitService(private val jdbc: JdbcClient) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Timetables are ~10-30 MB for Budapest; keep a few service days. */
    private val timetables =
        Caffeine.newBuilder().maximumSize(3).expireAfterWrite(java.time.Duration.ofHours(6)).build<LocalDate, Timetable>()

    fun timetable(date: LocalDate): Timetable = timetables.get(date, ::load)

    @Cacheable("transitSeeds")
    fun seeds(lon: Double, lat: Double, at: LocalDateTime, budgetSeconds: Int): TransitSeeds {
        val origin =
            jdbc.sql("SELECT vertex_id, seconds FROM analytics.snap_seed(?, ?)")
                .params(lon, lat)
                .query { rs, _ -> rs.getLong(1) to rs.getDouble(2) }
                .single()
        val access =
            jdbc.sql("SELECT stop_idx, seconds FROM transit.access_stops(?, ?, ?)")
                .params(lon, lat, min(budgetSeconds, MAX_ACCESS_WALK_S).toDouble())
                .query { rs, _ -> rs.getInt(1) to Math.ceil(rs.getDouble(2)).toInt() }
                .list()
                .toMap()

        val timetable = timetable(at.toLocalDate())
        val best =
            Raptor.earliestArrivals(timetable, access, at.toLocalTime().toSecondOfDay(), budgetSeconds)

        val vertices = arrayListOf(origin.first)
        val seconds = arrayListOf(origin.second)
        var reached = 0
        for (stop in best.indices) {
            if (best[stop] == Raptor.UNREACHED || timetable.stopVertex[stop] < 0) continue
            reached++
            vertices += timetable.stopVertex[stop]
            seconds += best[stop] + timetable.stopOffset[stop]
        }
        return TransitSeeds(Seeds(vertices, seconds), at, reached, timetable.tripCount)
    }

    private fun load(date: LocalDate): Timetable {
        val started = System.nanoTime()
        val stops =
            jdbc.sql(
                """
                SELECT s.stop_idx, coalesce(sv.vertex_id, -1), coalesce(sv.distance_m, 0)
                FROM transit.stops s LEFT JOIN transit.stop_vertex sv USING (stop_idx)
                ORDER BY s.stop_idx
                """.trimIndent(),
            ).query { rs, _ -> Triple(rs.getInt(1), rs.getLong(2), rs.getDouble(3)) }.list()
        val count = (stops.maxOfOrNull { it.first } ?: -1) + 1
        val vertex = LongArray(count) { -1 }
        val offset = DoubleArray(count)
        for ((idx, v, distance) in stops) {
            vertex[idx] = v
            offset[idx] = distance / WALK_SPEED_MPS
        }

        val transferLists = Array(count) { ArrayList<Int>() }
        jdbc.sql("SELECT from_stop, to_stop, seconds FROM transit.transfers").query(RowCallbackHandler { rs ->
            transferLists[rs.getInt(1)].apply {
                add(rs.getInt(2))
                add(rs.getInt(3))
            }
        })

        // One row per trip: the service day's trips, plus the previous day's trips still running
        // after midnight (shifted by -24 h).
        val trips =
            jdbc.sql(
                """
                WITH days AS (
                    SELECT ?::date AS d, 0 AS shift
                    UNION ALL
                    SELECT ?::date - 1, -86400
                ),
                trips AS (
                    SELECT t.trip_idx, days.shift
                    FROM days
                    JOIN transit.trips t ON t.service_id IN (SELECT transit.services_on(days.d))
                )
                SELECT array_agg(st.stop_idx ORDER BY st.stop_sequence),
                       array_agg(st.arrival_s + tr.shift ORDER BY st.stop_sequence),
                       array_agg(st.departure_s + tr.shift ORDER BY st.stop_sequence)
                FROM trips tr
                JOIN transit.stop_times st USING (trip_idx)
                GROUP BY tr.trip_idx, tr.shift
                HAVING tr.shift = 0 OR max(st.arrival_s) >= 86400
                """.trimIndent(),
            ).params(date, date)
                .query { rs, _ ->
                    fun ints(i: Int) = (rs.getArray(i).array as Array<*>).map { (it as Number).toInt() }.toIntArray()
                    Timetable.Trip(ints(1), ints(2), ints(3))
                }.list()

        val timetable = Timetable(vertex, offset, Timetable.patterns(trips), Array(count) { transferLists[it].toIntArray() })
        log.info(
            "timetable for {}: {} stops, {} trips, {} patterns in {} ms",
            date, count, trips.size, timetable.patterns.size, (System.nanoTime() - started) / 1_000_000,
        )
        return timetable
    }

    companion object {
        /** Walking speed of the street graph (80 m/min), see routing.walk_cost_s. */
        const val WALK_SPEED_MPS = 80.0 / 60.0

        /** Longest walk to the first stop. */
        const val MAX_ACCESS_WALK_S = 900

        private val BUDAPEST = ZoneId.of("Europe/Budapest")

        /** Local time in Budapest, to the minute (requests within a minute share cache entries). */
        fun now(): LocalDateTime = LocalDateTime.now(BUDAPEST).truncatedTo(ChronoUnit.MINUTES)
    }
}
