package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.LonLat
import hu.reach15.api.domain.Mode
import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.JsonNode
import java.time.OffsetDateTime

data class SearchResult(
    val kind: String,
    val label: String,
    val sublabel: String?,
    val category: String?,
    val lon: Double,
    val lat: Double,
)

data class ReverseResult(
    val label: String,
    val sublabel: String?,
    val lon: Double,
    val lat: Double,
    val distanceM: Double,
)

data class FeatureCollection(val features: List<Feature>) {
    val type = "FeatureCollection"
}

data class Feature(
    val properties: Map<String, Any>,
    @get:Schema(description = "GeoJSON geometry (WGS84)")
    val geometry: JsonNode,
) {
    val type = "Feature"
}

data class Poi(val name: String?, val lon: Double, val lat: Double)

data class CategoryAccess(
    val category: Category,
    @get:Schema(description = "Travel time to the nearest POI, null if none within 30 minutes")
    val seconds: Double?,
    @get:Schema(description = "0..1, linear decay to 0 at 15 minutes")
    val score: Double,
    val weight: Double,
    val poi: Poi?,
)

data class AccessResponse(
    val point: LonLat,
    val mode: Mode,
    val address: ReverseResult?,
    @get:Schema(description = "Weighted accessibility score, 0..100")
    val score: Double,
    val categories: List<CategoryAccess>,
)

data class DistrictScore(
    val rank: Int,
    val districtId: Long,
    val name: String,
    val score: Double,
    val cells: Long,
    val p25: Double,
    val p75: Double,
    @get:Schema(description = "Bounding box of the district: west, south, east, north (WGS84)")
    val bbox: List<Double>,
)

data class PersonaDto(val id: String, val label: String, val weights: Map<String, Double>)

data class CategoryDto(val id: String, val label: String)

data class DataRelease(val sourceFile: String, val importedAt: OffsetDateTime, val status: String)
