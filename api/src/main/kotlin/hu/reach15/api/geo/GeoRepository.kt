package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.Mode
import hu.reach15.api.domain.Weights
import org.springframework.cache.annotation.Cacheable
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
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
    fun isochrone(lon: Double, lat: Double, mode: Mode, minutes: List<Int>): FeatureCollection {
        val features =
            jdbc.sql(
                """
                SELECT minutes, ST_AsGeoJSON(geom, 6) AS geometry, ST_Area(geom::geography) AS area_m2
                FROM analytics.isochrone(?, ?, ?, ?::int[])
                """.trimIndent(),
            ).params(lon, lat, mode.id, minutes.joinToString(",", "{", "}"))
                .query { rs, _ ->
                    Feature(
                        mapOf("minutes" to rs.getInt("minutes"), "mode" to mode.id, "areaM2" to rs.getDouble("area_m2")),
                        json.readTree(rs.getString("geometry")),
                    )
                }.list()
        return FeatureCollection(features)
    }

    data class NearestPoi(val category: Category, val seconds: Double, val poi: Poi)

    @Cacheable("access")
    fun pointAccess(lon: Double, lat: Double, mode: Mode): List<NearestPoi> =
        jdbc.sql("SELECT * FROM analytics.point_access(?, ?, ?)")
            .params(lon, lat, mode.id)
            .query { rs, _ ->
                Category.fromDb(rs.getString("category"))?.let { category ->
                    NearestPoi(
                        category,
                        rs.getDouble("seconds"),
                        Poi(rs.getString("poi_name"), rs.getDouble("poi_lon"), rs.getDouble("poi_lat")),
                    )
                }
            }.list().filterNotNull()

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
