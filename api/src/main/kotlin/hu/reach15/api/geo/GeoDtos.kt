package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.HeatMode
import hu.reach15.api.domain.LonLat
import hu.reach15.api.domain.Mode
import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.JsonNode
import java.time.LocalDateTime
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

data class Poi(
    val name: String?,
    val lon: Double,
    val lat: Double,
    @get:Schema(description = "OSM opening_hours tag as mapped, if any")
    val openingHours: String? = null,
)

data class CategoryAccess(
    val category: Category,
    @get:Schema(description = "Travel time to the nearest POI, null if none within 30 minutes")
    val seconds: Double?,
    @get:Schema(description = "0..1, linear decay to 0 at 15 minutes")
    val score: Double,
    val weight: Double,
    val poi: Poi?,
    @get:Schema(description = "Whether the place is open at the requested time; null when no time was given or its hours are unknown")
    val open: Boolean? = null,
)

data class AccessResponse(
    val point: LonLat,
    val mode: Mode,
    val address: ReverseResult?,
    @get:Schema(description = "Weighted accessibility score, 0..100")
    val score: Double,
    val categories: List<CategoryAccess>,
    @get:Schema(description = "Local time (Europe/Budapest) whose opening hours were applied; null when none was requested")
    val at: LocalDateTime? = null,
    val transit: TransitSummary? = null,
    @get:Schema(
        description = "Hungarian public holiday on the day of `at` (or of the transit departure), e.g. " +
            "easter_monday: holiday opening hours (PH) apply where mapped; null on other days",
    )
    val holiday: String? = null,
)

data class TransitSummary(
    val departure: LocalDateTime,
    @get:Schema(description = "Stops reached within the time budget, on foot or by public transport")
    val stopsReached: Int,
    @get:Schema(description = "Trips running on the service day; 0 means no timetable for that day")
    val tripsRunning: Int,
)

data class Anchor(
    val lon: Double,
    val lat: Double,
    val mode: Mode,
    val minutes: Int,
)

@Schema(description = "Hexagons within a short walk that score higher than the point's own hexagon")
data class NearbyResponse(
    val mode: HeatMode,
    @get:Schema(description = "Walking limit, minutes")
    val minutes: Int,
    @get:Schema(description = "Score of the point's own hexagon for the requested profile, 0..100")
    val hereScore: Double,
    val places: List<NearbyPlace>,
)

data class NearbyPlace(
    val h3: String,
    val lon: Double,
    val lat: Double,
    @get:Schema(description = "Score of the hexagon for the requested profile, 0..100")
    val score: Double,
    @get:Schema(description = "Walking time from the point to the hexagon's centre, seconds")
    val seconds: Double,
    val address: ReverseResult?,
)

data class Spot(
    val lon: Double,
    val lat: Double,
    @get:Schema(description = "Accessibility score of the spot's hexagon for the requested profile, 0..100")
    val score: Double,
    @get:Schema(description = "Travel time to each place, in the order of the request, seconds")
    val seconds: List<Double>,
    val address: ReverseResult?,
)

data class CommonGroundResponse(
    val anchors: List<Anchor>,
    @get:Schema(description = "GeoJSON MultiPolygon (WGS84) from which every place is reachable in its limit; null if none")
    val area: JsonNode?,
    val areaM2: Double,
    @get:Schema(description = "Best-scoring spots inside the area, spread out, best first")
    val spots: List<Spot>,
    val at: LocalDateTime? = null,
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

@Schema(
    description = "Travel times of every heatmap hexagon, column by column. walk[c][i] is the walking " +
        "time in seconds from hexagon h3[i] to the nearest place of categories[c]; null means not " +
        "reachable within 30 minutes. The map scores hexagons from these in the browser.",
)
data class CellTimes(
    val categories: List<String>,
    val h3: List<String>,
    val mode: HeatMode,
    @get:Schema(description = "Per category (in `categories` order), seconds per hexagon (in `h3` order); null = over 30 minutes or not computed")
    val times: List<List<Int?>>,
)
