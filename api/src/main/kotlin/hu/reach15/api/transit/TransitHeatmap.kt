package hu.reach15.api.transit

import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.jdbc.core.RowCallbackHandler
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import com.zaxxer.hikari.HikariDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters
import java.util.PriorityQueue
import java.util.stream.IntStream
import javax.sql.DataSource
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Public transport heatmap: for every H3 cell, the time to the nearest place of each category when
 * leaving at a fixed [Slot] (08:00 on a weekday, 20:00 on a Sunday), by walking and public
 * transport (a direct walk counts too, so the result is never worse than walking).
 *
 * Per cell: walk from the street vertex nearest the cell centre to the stops within 15 minutes
 * (an in-memory Dijkstra over the walking graph), ride with RAPTOR for up to 30 minutes, then walk
 * on from every stop reached: the walking time from a stop to the nearest place of a category is
 * already precomputed (analytics.vertex_category_time), so it is a lookup. About 8,500 cells,
 * run in parallel; the timetable search is the expensive part.
 *
 * Writes analytics.h3_category_time rows with the slot's mode ('transit', 'transit_evening') and
 * the matching keys of analytics.h3_cell.times, which the heatmap (/api/v1/cells) and the district
 * ranking read.
 */
@Service
class TransitHeatmap(
    private val jdbc: JdbcClient,
    private val transit: TransitService,
    private val dataSource: DataSource,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    // Loaded once for all slots: the graph does not change while the precompute runs.
    private val graph by lazy { WalkGraph.load(jdbc) }

    /** A precomputed departure: [mode] is the heatmap mode it is stored and served as. */
    enum class Slot(val mode: String, val day: DayOfWeek, val departure: Int) {
        WEEKDAY_MORNING("transit", DayOfWeek.TUESDAY, 8 * 3600),
        SUNDAY_EVENING("transit_evening", DayOfWeek.SUNDAY, 20 * 3600),
        ;

        /** The next such day on or after [from] (a Tuesday: never a Monday after a long weekend). */
        fun date(from: LocalDate): LocalDate = from.with(TemporalAdjusters.nextOrSame(day))
    }

    data class Result(val slot: Slot, val date: LocalDate, val cells: Int, val rows: Int, val millis: Long)

    fun compute(slot: Slot = Slot.WEEKDAY_MORNING, date: LocalDate = slot.date(defaultDate())): Result {
        val departure = slot.departure
        val started = System.nanoTime()
        val timetable = transit.timetable(date)
        val categories = jdbc.sql("SELECT DISTINCT category FROM analytics.poi_vertex ORDER BY category")
            .query(String::class.java).list().filterNotNull()

        // Walking time from every stop to the nearest place of each category (stop offset included).
        val egress = Array(categories.size) { IntArray(timetable.stopCount) { UNREACHABLE } }
        val categoryIndex = categories.withIndex().associate { (i, c) -> c to i }
        jdbc.sql(
            """
            SELECT sv.stop_idx, t.category, t.seconds + sv.distance_m / ?
            FROM transit.stop_vertex sv
            JOIN analytics.vertex_category_time t ON t.vertex_id = sv.vertex_id AND t.mode = 'walk'
            """.trimIndent(),
        ).param(TransitService.WALK_SPEED_MPS).query(RowCallbackHandler { rs ->
            val c = categoryIndex[rs.getString(2)] ?: return@RowCallbackHandler
            egress[c][rs.getInt(1)] = rs.getDouble(3).roundToInt()
        })

        // Stops by street vertex, for the access walk.
        val stopsAt = HashMap<Int, MutableList<Pair<Int, Int>>>()
        for (stop in 0 until timetable.stopCount) {
            val v = graph.index[timetable.stopVertex[stop]] ?: continue
            stopsAt.getOrPut(v) { ArrayList() } += stop to timetable.stopOffset[stop].roundToInt()
        }

        val cells = jdbc.sql(
            """
            SELECT c.h3::text, v.id, ST_Distance(v.geom::geography, h3_cell_to_geometry(c.h3)::geography)
            FROM analytics.h3_cell c
            CROSS JOIN LATERAL (
                SELECT id, geom FROM routing.vertices
                WHERE in_main_component
                ORDER BY geom <-> h3_cell_to_geometry(c.h3)
                LIMIT 1
            ) v
            ORDER BY c.h3
            """.trimIndent(),
        ).query { rs, _ -> Cell(rs.getString(1), rs.getLong(2), rs.getDouble(3)) }.list()

        // Walking times per cell (median of its vertices): a journey never does worse than walking.
        val walk = HashMap<String, IntArray>()
        jdbc.sql("SELECT h3::text, category, seconds FROM analytics.h3_category_time WHERE mode = 'walk'")
            .query(RowCallbackHandler { rs ->
                val c = categoryIndex[rs.getString(2)] ?: return@RowCallbackHandler
                walk.getOrPut(rs.getString(1)) { IntArray(categories.size) { UNREACHABLE } }[c] = rs.getDouble(3).roundToInt()
            })

        val results = arrayOfNulls<IntArray>(cells.size)
        val workspace = ThreadLocal.withInitial { graph.workspace() }
        IntStream.range(0, cells.size).parallel().forEach { i ->
            val cell = cells[i]
            val times = walk[cell.h3]?.copyOf() ?: IntArray(categories.size) { UNREACHABLE }
            val origin = graph.index[cell.vertex]
            if (origin != null) {
                val start = (cell.distanceM / TransitService.WALK_SPEED_MPS).roundToInt()
                val access = HashMap<Int, Int>()
                workspace.get().reach(origin, start, TransitService.MAX_ACCESS_WALK_S) { v, seconds ->
                    stopsAt[v]?.forEach { (stop, offset) ->
                        val t = seconds + offset
                        if (t <= TransitService.MAX_ACCESS_WALK_S && t < (access[stop] ?: Int.MAX_VALUE)) access[stop] = t
                    }
                }
                val best = Raptor.earliestArrivals(timetable, access, departure, BUDGET_S)
                for (stop in best.indices) {
                    if (best[stop] == Raptor.UNREACHED) continue
                    for (c in categories.indices) {
                        val e = egress[c][stop]
                        if (e != UNREACHABLE) times[c] = min(times[c], best[stop] + e)
                    }
                }
            }
            results[i] = times
        }

        // The serving pool is read-only; the precompute writes through its own connection to the
        // same database (the pool's settings, which Testcontainers and the environment decide).
        val pool = dataSource.unwrap(HikariDataSource::class.java)
        val writable = DriverManagerDataSource(pool.jdbcUrl, pool.username, pool.password)
        val write = JdbcClient.create(writable)
        val rows = TransactionTemplate(DataSourceTransactionManager(writable)).execute {
            write.sql("DELETE FROM analytics.h3_category_time WHERE mode = ?").param(slot.mode).update()
            val batch = ArrayList<Row>()
            for ((i, cell) in cells.withIndex()) {
                val times = results[i]!!
                for (c in categories.indices) {
                    if (times[c] <= BUDGET_S) batch.add(Row(cell.h3, categories[c], times[c]))
                }
            }
            batch.chunked(5000).forEach { chunk ->
                write.sql(
                    """
                    INSERT INTO analytics.h3_category_time (h3, mode, category, seconds, vertices)
                    SELECT x.h3::h3index, ?, x.category, x.seconds, 1
                    FROM unnest(?::text[], ?::text[], ?::float8[]) AS x (h3, category, seconds)
                    """.trimIndent(),
                ).params(
                    slot.mode,
                    chunk.joinToString(",", "{", "}") { it.h3 },
                    chunk.joinToString(",", "{", "}") { it.category },
                    chunk.joinToString(",", "{", "}") { it.seconds.toString() },
                ).update()
            }
            write.sql(
                """
                UPDATE analytics.h3_cell c
                SET times = (c.times - ?::text[])
                         || coalesce((SELECT jsonb_object_agg(t.mode || '_' || t.category, round(t.seconds)::int)
                                      FROM analytics.h3_category_time t
                                      WHERE t.h3 = c.h3 AND t.mode = ?), '{}'::jsonb)
                """.trimIndent(),
            ).params(categories.joinToString(",", "{", "}") { "${slot.mode}_$it" }, slot.mode).update()
            batch.size
        }!!
        val result = Result(slot, date, cells.size, rows, (System.nanoTime() - started) / 1_000_000)
        log.info(
            "transit heatmap {} for {} {}: {} cells, {} rows in {} ms",
            slot.mode, date, java.time.LocalTime.ofSecondOfDay(departure.toLong()), result.cells, result.rows, result.millis,
        )
        return result
    }

    private data class Cell(val h3: String, val vertex: Long, val distanceM: Double)

    private data class Row(val h3: String, val category: String, val seconds: Int)

    companion object {
        const val BUDGET_S = 1800
        private const val UNREACHABLE = Int.MAX_VALUE / 2

        /** Tomorrow: every slot's date is the next such day from here. */
        fun defaultDate(today: LocalDate = TransitService.now().toLocalDate()): LocalDate = today.plusDays(1)
    }
}

/** The walking graph in memory (CSR), for many short searches. */
class WalkGraph private constructor(
    val index: Map<Long, Int>,
    private val offsets: IntArray,
    private val targets: IntArray,
    private val costs: IntArray,
) {
    val size get() = offsets.size - 1

    fun workspace() = Workspace()

    /** Per-thread Dijkstra state, reset in O(vertices touched). */
    inner class Workspace {
        private val dist = IntArray(size) { Int.MAX_VALUE }
        private val touched = ArrayList<Int>()

        fun reach(origin: Int, start: Int, limit: Int, visit: (vertex: Int, seconds: Int) -> Unit) {
            val queue = PriorityQueue<Long>()
            dist[origin] = start
            touched += origin
            queue += pack(start, origin)
            while (queue.isNotEmpty()) {
                val top = queue.poll()
                val d = (top ushr 32).toInt()
                val v = top.toInt()
                if (d > dist[v]) continue
                visit(v, d)
                for (e in offsets[v] until offsets[v + 1]) {
                    val nd = d + costs[e]
                    val w = targets[e]
                    if (nd <= limit && nd < dist[w]) {
                        if (dist[w] == Int.MAX_VALUE) touched += w
                        dist[w] = nd
                        queue += pack(nd, w)
                    }
                }
            }
            for (v in touched) dist[v] = Int.MAX_VALUE
            touched.clear()
        }

        private fun pack(d: Int, v: Int) = (d.toLong() shl 32) or v.toLong()
    }

    companion object {
        fun load(jdbc: JdbcClient): WalkGraph {
            val index = HashMap<Long, Int>()
            val from = ArrayList<Int>()
            val to = ArrayList<Int>()
            val cost = ArrayList<Int>()
            fun id(v: Long) = index.getOrPut(v) { index.size }
            jdbc.sql("SELECT source, target, cost_walk_s, reverse_cost_walk_s FROM routing.edges")
                .query(RowCallbackHandler { rs ->
                    val s = id(rs.getLong(1))
                    val t = id(rs.getLong(2))
                    val c = rs.getDouble(3)
                    val r = rs.getDouble(4)
                    if (c >= 0) { from += s; to += t; cost += c.roundToInt() }
                    if (r >= 0) { from += t; to += s; cost += r.roundToInt() }
                })
            val n = index.size
            val offsets = IntArray(n + 1)
            for (s in from) offsets[s + 1]++
            for (i in 0 until n) offsets[i + 1] += offsets[i]
            val fill = offsets.copyOf()
            val targets = IntArray(from.size)
            val costs = IntArray(from.size)
            for (i in from.indices) {
                val slot = fill[from[i]]++
                targets[slot] = to[i]
                costs[slot] = cost[i]
            }
            return WalkGraph(index, offsets, targets, costs)
        }
    }
}

/**
 * `java -jar app.jar --spring.main.web-application-type=none --reach15.precompute=transit-heatmap`:
 * computes the public transport heatmap after a data build, then exits.
 */
@Component
@ConditionalOnProperty("reach15.precompute", havingValue = "transit-heatmap")
class TransitHeatmapRunner(private val heatmap: TransitHeatmap) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        // --reach15.transit-date: the first day to consider (tests pin it); each slot takes the
        // next matching day from there.
        val from = args.getOptionValues("reach15.transit-date")?.firstOrNull()?.let(LocalDate::parse)
            ?: TransitHeatmap.defaultDate()
        TransitHeatmap.Slot.entries.forEach { heatmap.compute(it, it.date(from)) }
    }
}
