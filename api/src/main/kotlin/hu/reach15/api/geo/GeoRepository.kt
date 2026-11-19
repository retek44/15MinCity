package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.Mode
import hu.reach15.api.domain.Weights
import org.springframework.cache.annotation.Cacheable
import org.springframework.jdbc.core.simple.JdbcClient
import hu.reach15.api.transit.Seeds
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.LocalDateTime
import tools.jackson.databind.json.JsonMapper

/** Thin wrapper over the SQL functions in db/migrations; all spatial logic lives in the database. */
@Repository
class GeoRepository(
    private val jdbc: JdbcClient,
    private val json: JsonMapper,
) {
    fun search(query: String, limit: Int, near: Pair<Double, Double>?): List<SearchResult> =
        jdbc.sql("SELECT kind, label, sublabel, category, lon, lat FROM search.search(?, ?, ?, ?)")
            .param(query)
            .param(limit)
            .param(near?.first)
            .param(near?.second)
            .query { rs, _ ->
                SearchResult(
                    rs.getString("kind"), rs.getString("label"), rs.getString("sublabel"),
                    rs.getString("category"), rs.getDouble("lon"), rs.getDouble("lat"),
                )
            }.list()

    fun reverse(lon: Double, lat: Double): ReverseResult? =
        jdbc.sql("SELECT * FROM search.reverse(?, ?)")
            .params(lon, lat)
            .query { rs, _ ->
                ReverseResult(
                    rs.getString("label"), rs.getString("sublabel"),
                    rs.getDouble("lon"), rs.getDouble("lat"), rs.getDouble("distance_m"),
                )
            }.optional().orElse(null)

    @Cacheable("isochrone")
    fun isochrone(lon: Double, lat: Double, mode: Mode, minutes: List<Int>): FeatureCollection =
        isochrones(
            jdbc.sql(
                """
                SELECT minutes, ST_AsGeoJSON(geom, 6) AS geometry, ST_Area(geom::geography) AS area_m2
                FROM analytics.isochrone(?, ?, ?, ?::int[])
                """.trimIndent(),
            ).params(lon, lat, mode.id, intArray(minutes)),
            mode,
        )

    /** Isochrones on foot from seeds (public transport: the stops a journey reaches). */
    fun isochroneSeeded(seeds: Seeds, minutes: List<Int>, mode: Mode): FeatureCollection =
        isochrones(
            jdbc.sql(
                """
                SELECT minutes, ST_AsGeoJSON(geom, 6) AS geometry, ST_Area(geom::geography) AS area_m2
                FROM analytics.isochrone_seeded(?::bigint[], ?::float8[], 'walk', ?::int[])
                """.trimIndent(),
            ).params(seeds.vertexArray(), seeds.secondsArray(), intArray(minutes)),
            mode,
        )

    private fun isochrones(statement: JdbcClient.StatementSpec, mode: Mode) =
        FeatureCollection(
            statement.query { rs, _ ->
                Feature(
                    mapOf("minutes" to rs.getInt("minutes"), "mode" to mode.id, "areaM2" to rs.getDouble("area_m2")),
                    json.readTree(rs.getString("geometry")),
                )
            }.list(),
        )

    data class NearestPoi(val category: Category, val seconds: Double, val poi: Poi, val open: Boolean?)

    @Cacheable("access")
    fun pointAccess(lon: Double, lat: Double, mode: Mode, at: LocalDateTime?): List<NearestPoi> =
        jdbc.sql("SELECT * FROM analytics.point_access(?, ?, ?, 1800, ?::timestamp)")
            .param(lon).param(lat).param(mode.id).param(at)
            .query(::nearestPoi).list().filterNotNull()

    /** Nearest places on foot from seeds (public transport: the stops a journey reaches). */
    fun pointAccessSeeded(seeds: Seeds, at: LocalDateTime?): List<NearestPoi> =
        jdbc.sql("SELECT * FROM analytics.point_access_seeded(?::bigint[], ?::float8[], 'walk', 1800, ?::timestamp)")
            .param(seeds.vertexArray()).param(seeds.secondsArray()).param(at)
            .query(::nearestPoi).list().filterNotNull()

    private fun nearestPoi(rs: ResultSet, @Suppress("UNUSED_PARAMETER") row: Int): NearestPoi? =
        Category.fromDb(rs.getString("category"))?.let { category ->
            NearestPoi(
                category,
                rs.getDouble("seconds"),
                Poi(rs.getString("poi_name"), rs.getDouble("poi_lon"), rs.getDouble("poi_lat"), rs.getString("opening_hours")),
                rs.getObject("open") as Boolean?,
            )
        }

    /** Start of a street search from a point: nearest vertex and the walk to it. */
    fun snapSeed(lon: Double, lat: Double): Seeds =
        jdbc.sql("SELECT vertex_id, seconds FROM analytics.snap_seed(?, ?)")
            .params(lon, lat)
            .query { rs, _ -> Seeds(listOf(rs.getLong(1)), listOf(rs.getDouble(2))) }
            .single()

    data class CommonGround(val area: tools.jackson.databind.JsonNode?, val areaM2: Double, val spots: List<RawSpot>)

    data class RawSpot(val lon: Double, val lat: Double, val score: Double, val seconds: List<Double>)

    /** [anchors]: the JSON accepted by analytics.common_ground. */
    fun commonGround(anchors: List<Map<String, Any>>, weights: Weights, scoreMode: Mode, limit: Int): CommonGround =
        jdbc.sql(
            """
            SELECT ST_AsGeoJSON(area, 6) AS area, coalesce(ST_Area(area::geography), 0) AS area_m2, spots
            FROM analytics.common_ground(?::jsonb, ?::jsonb, ?, ?)
            """.trimIndent(),
        ).params(json.writeValueAsString(anchors), json.writeValueAsString(weights.toJson()), scoreMode.id, limit)
            .query { rs, _ ->
                CommonGround(
                    rs.getString("area")?.let(json::readTree),
                    rs.getDouble("area_m2"),
                    json.readTree(rs.getString("spots")).let { a -> (0 until a.size()).map(a::get) }.map { spot ->
                        RawSpot(
                            spot["lon"].asDouble(),
                            spot["lat"].asDouble(),
                            spot["score"].asDouble(),
                            spot["seconds"].let { a -> (0 until a.size()).map { a[it].asDouble() } },
                        )
                    },
                )
            }.single()

    private fun intArray(values: List<Int>) = values.joinToString(",", "{", "}")

    @Cacheable("ranking")
    fun districtRanking(weights: Weights, mode: Mode): List<DistrictScore> =
        jdbc.sql("SELECT * FROM analytics.district_ranking(?::jsonb, ?)")
            .params(json.writeValueAsString(weights.toJson()), mode.id)
            .query { rs, row ->
                DistrictScore(
                    rank = row + 1,
                    districtId = rs.getLong("district_id"),
                    name = rs.getString("name"),
                    score = rs.getDouble("score"),
                    cells = rs.getLong("cells"),
                    p25 = rs.getDouble("p25"),
                    p75 = rs.getDouble("p75"),
                    bbox = listOf("west", "south", "east", "north").map(rs::getDouble),
                )
            }.list()

    /** One query, one array per column: about 9,000 hexagons x 20 times for Budapest. */
    @Cacheable("cells")
    fun cellTimes(): CellTimes {
        val modes = listOf(Mode.WALK, Mode.BIKE, Mode.TRANSIT)
        val columns = modes.flatMap { m -> Category.entries.map { c -> "${m.id}_${c.id}" } }
        val select = columns.joinToString(", ") { "array_agg((times ->> '$it')::int ORDER BY h3) AS $it" }
        return jdbc.sql("SELECT array_agg(h3::text ORDER BY h3) AS h3, $select FROM analytics.h3_cell")
            .query { rs, _ ->
                fun ints(column: String): List<Int?> =
                    (rs.getArray(column)?.array as Array<*>? ?: emptyArray<Any?>()).map { (it as Number?)?.toInt() }
                val byMode = modes.associateWith { m -> Category.entries.map { c -> ints("${m.id}_${c.id}") } }
                CellTimes(
                    categories = Category.entries.map { it.id },
                    h3 = (rs.getArray("h3")?.array as Array<*>? ?: emptyArray<Any?>()).map { it as String },
                    walk = byMode.getValue(Mode.WALK),
                    bike = byMode.getValue(Mode.BIKE),
                    transit = byMode.getValue(Mode.TRANSIT),
                )
            }.single()
    }

    /** Key of the Hungarian public holiday on a date (analytics.hu_holiday), or null. */
    fun holiday(date: java.time.LocalDate): String? =
        jdbc.sql("SELECT analytics.hu_holiday(?)").param(date).query(String::class.java).optional().orElse(null)

    fun latestRelease(): DataRelease? =
        jdbc.sql("SELECT source_file, imported_at, status FROM meta.data_release ORDER BY id DESC LIMIT 1")
            .query { rs, _ ->
                DataRelease(
                    rs.getString("source_file"),
                    rs.getObject("imported_at", java.time.OffsetDateTime::class.java),
                    rs.getString("status"),
                )
            }.optional().orElse(null)
}
