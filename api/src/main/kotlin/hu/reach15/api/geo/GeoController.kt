package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.LonLat
import hu.reach15.api.domain.Mode
import hu.reach15.api.domain.PersonaProperties
import hu.reach15.api.domain.Scoring
import hu.reach15.api.domain.Weights
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import jakarta.validation.constraints.DecimalMax
import jakarta.validation.constraints.DecimalMin
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import kotlin.math.round

@RestController
@RequestMapping("/api/v1", produces = ["application/json"])
class GeoController(
    private val repo: GeoRepository,
    private val personas: PersonaProperties,
) {
    @Operation(summary = "POI categories")
    @GetMapping("/categories")
    fun categories(): List<CategoryDto> = Category.entries.map { CategoryDto(it.id, it.label) }

    @Operation(summary = "Preset category weights")
    @GetMapping("/personas")
    fun personas(): List<PersonaDto> = personas.all().map { PersonaDto(it.id, it.label, it.weights.toJson()) }

    @Operation(summary = "Search addresses, streets and named places (typo tolerant)")
    @GetMapping("/search")
    fun search(
        @RequestParam @Size(min = 2, max = 100) q: String,
        @RequestParam(defaultValue = "8") @Min(1) @Max(50) limit: Int,
        @Parameter(description = "Map centre longitude, ranks nearby results higher")
        @RequestParam(required = false) @DecimalMin("-180") @DecimalMax("180") lon: Double?,
        @RequestParam(required = false) @DecimalMin("-90") @DecimalMax("90") lat: Double?,
    ): List<SearchResult> = repo.search(q, limit, if (lon != null && lat != null) lon to lat else null)

    @Operation(summary = "Nearest address to a point (within 150 m)")
    @GetMapping("/reverse")
    fun reverse(
        @RequestParam @DecimalMin("-180") @DecimalMax("180") lon: Double,
        @RequestParam @DecimalMin("-90") @DecimalMax("90") lat: Double,
    ): ResponseEntity<ReverseResult> =
        repo.reverse(lon, lat)?.let { ResponseEntity.ok(it) } ?: ResponseEntity.notFound().build()

    @Operation(summary = "Isochrones: the area reachable within each time limit, as GeoJSON")
    @GetMapping("/isochrone")
    fun isochrone(
        @RequestParam @DecimalMin("-180") @DecimalMax("180") lon: Double,
        @RequestParam @DecimalMin("-90") @DecimalMax("90") lat: Double,
        @RequestParam(defaultValue = "walk") mode: String,
        @Parameter(description = "Comma separated limits in minutes, each 1..30")
        @RequestParam(defaultValue = "5,10,15") minutes: List<Int>,
    ): FeatureCollection {
        require(minutes.size in 1..6) { "between 1 and 6 time limits are allowed" }
        return repo.isochrone(snap(lon), snap(lat), Mode.parse(mode), minutes.distinct().sorted())
    }

    @Operation(summary = "Accessibility of a point: nearest POI per category and weighted score")
    @GetMapping("/access")
    fun access(
        @RequestParam @DecimalMin("-180") @DecimalMax("180") lon: Double,
        @RequestParam @DecimalMin("-90") @DecimalMax("90") lat: Double,
        @RequestParam(defaultValue = "walk") mode: String,
        @RequestParam(defaultValue = "balanced") persona: String,
        @Parameter(description = "Custom weights, e.g. grocery:3,park:1 (overrides persona)")
        @RequestParam(required = false) weights: String?,
    ): AccessResponse {
        val travel = Mode.parse(mode)
        val w = resolveWeights(persona, weights)
        val nearest = repo.pointAccess(snap(lon), snap(lat), travel).associateBy { it.category }
        val categories =
            Category.entries.map { category ->
                val hit = nearest[category]
                CategoryAccess(
                    category = category,
                    seconds = hit?.seconds,
                    score = Scoring.categoryScore(hit?.seconds),
                    weight = w.values[category] ?: 0.0,
                    poi = hit?.poi,
                )
            }
        return AccessResponse(
            point = LonLat(lon, lat),
            mode = travel,
            address = repo.reverse(lon, lat),
            score = Scoring.score(nearest.mapValues { it.value.seconds }, w),
            categories = categories,
        )
    }

    @Operation(summary = "Districts ranked by mean accessibility score")
    @GetMapping("/districts/ranking")
    fun districtRanking(
        @RequestParam(defaultValue = "walk") mode: String,
        @RequestParam(defaultValue = "balanced") persona: String,
        @RequestParam(required = false) weights: String?,
    ): List<DistrictScore> = repo.districtRanking(resolveWeights(persona, weights), Mode.parse(mode))

    @Operation(summary = "The data release currently served")
    @GetMapping("/meta")
    fun meta(): ResponseEntity<DataRelease> =
        repo.latestRelease()?.let { ResponseEntity.ok(it) } ?: ResponseEntity.notFound().build()

    private fun resolveWeights(persona: String, weights: String?): Weights =
        if (weights.isNullOrBlank()) personas.find(persona).weights else Weights.parse(weights)

    /** ~1 m precision: nearby clicks share cache entries. */
    private fun snap(coordinate: Double): Double = round(coordinate * 100_000) / 100_000
}
