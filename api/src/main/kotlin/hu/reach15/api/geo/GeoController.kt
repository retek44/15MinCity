package hu.reach15.api.geo

import hu.reach15.api.domain.Category
import hu.reach15.api.domain.LonLat
import hu.reach15.api.domain.Mode
import hu.reach15.api.domain.PersonaProperties
import hu.reach15.api.domain.Scoring
import hu.reach15.api.domain.Weights
import hu.reach15.api.transit.Seeds
import hu.reach15.api.transit.TransitService
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import jakarta.validation.constraints.DecimalMax
import jakarta.validation.constraints.DecimalMin
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Duration
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.round

@RestController
@RequestMapping("/api/v1", produces = ["application/json"])
class GeoController(
    private val repo: GeoRepository,
    private val personas: PersonaProperties,
    private val transit: TransitService,
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
        @Parameter(description = "Departure by public transport, local time in Budapest (default: now)")
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) at: LocalDateTime?,
    ): FeatureCollection {
        require(minutes.size in 1..6) { "between 1 and 6 time limits are allowed" }
        val limits = minutes.distinct().sorted()
        val travel = Mode.parse(mode)
        if (travel == Mode.TRANSIT) {
            require(limits.all { it in 1..30 }) { "minutes must be between 1 and 30" }
            val seeds = transit.seeds(snap(lon), snap(lat), minute(at) ?: TransitService.now(), limits.last() * 60)
            return repo.isochroneSeeded(seeds.seeds, limits, travel)
        }
        return repo.isochrone(snap(lon), snap(lat), travel, limits)
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
        @Parameter(
            description = "Local time in Budapest, e.g. 2026-11-22T20:00: only places open then count " +
                "(unknown hours count as open), and public transport departs then (default: now)",
        )
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) at: LocalDateTime?,
    ): AccessResponse {
        val travel = Mode.parse(mode)
        val w = resolveWeights(persona, weights)
        val time = minute(at)
        var summary: TransitSummary? = null
        val hits =
            if (travel == Mode.TRANSIT) {
                val departure = time ?: TransitService.now()
                val seeds = transit.seeds(snap(lon), snap(lat), departure, ACCESS_BUDGET_S)
                summary = TransitSummary(departure, seeds.stopsReached, seeds.tripsRunning)
                repo.pointAccessSeeded(seeds.seeds, time)
            } else {
                repo.pointAccess(snap(lon), snap(lat), travel, time)
            }
        val nearest = hits.associateBy { it.category }
        val categories =
            Category.entries.map { category ->
                val hit = nearest[category]
                CategoryAccess(
                    category = category,
                    seconds = hit?.seconds,
                    score = Scoring.categoryScore(hit?.seconds),
                    weight = w.values[category] ?: 0.0,
                    poi = hit?.poi,
                    open = hit?.open,
                )
            }
        return AccessResponse(
            point = LonLat(lon, lat),
            mode = travel,
            address = repo.reverse(lon, lat),
            score = Scoring.score(nearest.mapValues { it.value.seconds }, w),
            categories = categories,
            at = time,
            transit = summary,
        )
    }

    @Operation(summary = "Districts ranked by mean accessibility score")
    @GetMapping("/districts/ranking")
    fun districtRanking(
        @RequestParam(defaultValue = "walk") mode: String,
        @RequestParam(defaultValue = "balanced") persona: String,
        @RequestParam(required = false) weights: String?,
    ): List<DistrictScore> = repo.districtRanking(resolveWeights(persona, weights), precomputed(Mode.parse(mode)))

    @Operation(
        summary = "Where should we live? The area from which every place can be reached in its own limit",
        description = "Each place is lon,lat,mode,minutes (mode walk, bike or transit; 1..45 minutes), separated by " +
            "semicolons, e.g. 19.0402,47.4979,transit,30;19.0700,47.5100,bike,15. Times are from home to the place " +
            "(by public transport: from the place, leaving at `at`). Spots are the best-scoring hexagons inside.",
    )
    @GetMapping("/common-ground")
    fun commonGround(
        @RequestParam @Size(min = 7, max = 400) places: String,
        @Parameter(description = "Travel mode the spots are scored for (walk or bike)")
        @RequestParam(defaultValue = "walk") mode: String,
        @RequestParam(defaultValue = "balanced") persona: String,
        @RequestParam(required = false) weights: String?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) at: LocalDateTime?,
        @RequestParam(defaultValue = "5") @Min(1) @Max(10) limit: Int,
    ): CommonGroundResponse {
        val anchors = parseAnchors(places)
        val departure = minute(at) ?: TransitService.now()
        val json =
            anchors.map { anchor ->
                val lon = snap(anchor.lon)
                val lat = snap(anchor.lat)
                val budget = anchor.minutes * 60
                val (seeds: Seeds, searchMode, reverse) =
                    if (anchor.mode == Mode.TRANSIT) {
                        Triple(transit.seeds(lon, lat, departure, budget).seeds, Mode.WALK, false)
                    } else {
                        Triple(repo.snapSeed(lon, lat), anchor.mode, true)
                    }
                mapOf(
                    "vertices" to seeds.vertices,
                    "seconds" to seeds.seconds,
                    "mode" to searchMode.id,
                    "reverse" to reverse,
                    "max_seconds" to budget,
                )
            }
        val result = repo.commonGround(json, resolveWeights(persona, weights), precomputed(Mode.parse(mode)), limit)
        return CommonGroundResponse(
            anchors = anchors,
            area = result.area,
            areaM2 = result.areaM2,
            spots = result.spots.map { Spot(it.lon, it.lat, it.score, it.seconds, repo.reverse(it.lon, it.lat)) },
            at = if (anchors.any { it.mode == Mode.TRANSIT }) departure else null,
        )
    }

    @Operation(summary = "Travel times of every heatmap hexagon (the inputs of the map's colours)")
    @GetMapping("/cells")
    fun cells(): ResponseEntity<CellTimes> =
        // Changes only with a data release; the browser may keep it for an hour.
        ResponseEntity.ok().cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic()).body(repo.cellTimes())

    @Operation(summary = "The data release currently served")
    @GetMapping("/meta")
    fun meta(): ResponseEntity<DataRelease> =
        repo.latestRelease()?.let { ResponseEntity.ok(it) } ?: ResponseEntity.notFound().build()

    private fun resolveWeights(persona: String, weights: String?): Weights =
        if (weights.isNullOrBlank()) personas.find(persona).weights else Weights.parse(weights)

    private fun precomputed(mode: Mode): Mode {
        require(mode.precomputed) { "the heatmap and ranking are precomputed for walk and bike only" }
        return mode
    }

    /** ~1 m precision: nearby clicks share cache entries. */
    private fun snap(coordinate: Double): Double = round(coordinate * 100_000) / 100_000

    private fun minute(at: LocalDateTime?): LocalDateTime? = at?.truncatedTo(ChronoUnit.MINUTES)

    companion object {
        /** Search budget for the nearest places: twice the 15-minute scoring horizon. */
        const val ACCESS_BUDGET_S = 1800

        /** `lon,lat,mode,minutes;...` */
        fun parseAnchors(places: String): List<Anchor> {
            val anchors =
                places.split(';').filter { it.isNotBlank() }.map { part ->
                    val p = part.split(',').map { it.trim() }
                    require(p.size == 4) { "place '$part' must look like lon,lat,mode,minutes" }
                    val lon = p[0].toDoubleOrNull()?.takeIf { it in -180.0..180.0 }
                    val lat = p[1].toDoubleOrNull()?.takeIf { it in -90.0..90.0 }
                    require(lon != null && lat != null) { "place '$part' has invalid coordinates" }
                    val minutes = p[3].toIntOrNull()
                    require(minutes != null && minutes in 1..45) { "each limit must be between 1 and 45 minutes" }
                    Anchor(lon, lat, Mode.parse(p[2]), minutes)
                }
            require(anchors.size in 1..4) { "between 1 and 4 places are allowed" }
            return anchors
        }
    }
}
