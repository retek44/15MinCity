package hu.reach15.api.domain

/**
 * Accessibility scoring. Must stay in sync with `analytics.access_score` / `analytics.cell_scores`
 * in SQL and the MapLibre expression in the web client; all three are checked against
 * `tests/fixtures/scoring-vectors.json`.
 */
object Scoring {
    /** A category reached at [maxSeconds] or later (or never) scores 0. */
    const val DEFAULT_MAX_SECONDS = 900.0

    /** Linear decay from 1 at the doorstep to 0 at [maxSeconds]; null (unreachable) is 0. */
    fun categoryScore(seconds: Double?, maxSeconds: Double = DEFAULT_MAX_SECONDS): Double =
        if (seconds == null) 0.0 else (1.0 - seconds / maxSeconds).coerceIn(0.0, 1.0)

    /** Weighted mean of category scores, 0..100. Categories with weight <= 0 are ignored. */
    fun score(
        times: Map<Category, Double?>,
        weights: Weights,
        maxSeconds: Double = DEFAULT_MAX_SECONDS,
    ): Double {
        val active = weights.values.filterValues { it > 0 }
        val total = active.values.sum()
        return 100 * active.entries.sumOf { (category, weight) -> weight * categoryScore(times[category], maxSeconds) } / total
    }
}

/** Category weights; at least one must be positive. */
@JvmInline
value class Weights(val values: Map<Category, Double>) {
    init {
        require(values.values.all { it >= 0 && it.isFinite() }) { "weights must be non-negative numbers" }
        require(values.values.any { it > 0 }) { "at least one weight must be positive" }
    }

    fun toJson(): Map<String, Double> = values.filterValues { it > 0 }.mapKeys { it.key.id }

    companion object {
        /** Parses `grocery:3,park:1`. */
        fun parse(spec: String): Weights {
            val values =
                spec.split(',').filter { it.isNotBlank() }.associate { part ->
                    val pieces = part.split(':')
                    require(pieces.size == 2) { "weight '$part' must look like category:number" }
                    val weight =
                        pieces[1].trim().toDoubleOrNull()
                            ?: throw IllegalArgumentException("weight '${pieces[1]}' is not a number")
                    Category.parse(pieces[0]) to weight
                }
            return Weights(values)
        }
    }
}
