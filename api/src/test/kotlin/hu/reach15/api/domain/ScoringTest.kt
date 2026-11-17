package hu.reach15.api.domain

import hu.reach15.api.support.RepoFiles
import hu.reach15.api.support.items
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals

class ScoringTest {
    @TestFactory
    fun `shared scoring vectors`(): List<DynamicTest> {
        val vectors: JsonNode = JsonMapper.builder().build().readTree(RepoFiles.read("tests/fixtures/scoring-vectors.json"))
        val tolerance = vectors["tolerance"].asDouble()
        return vectors["cases"].items().map { case ->
            DynamicTest.dynamicTest(case["name"].asString()) {
                val times = case["times"].properties().associate { Category.parse(it.key) to it.value.asDouble() }
                val weights = Weights(case["weights"].properties().associate { Category.parse(it.key) to it.value.asDouble() })
                assertEquals(case["score"].asDouble(), Scoring.score(times, weights), tolerance)
            }
        }
    }

    @Test
    fun `category score decays linearly and clamps`() {
        assertEquals(1.0, Scoring.categoryScore(0.0))
        assertEquals(0.5, Scoring.categoryScore(450.0))
        assertEquals(0.0, Scoring.categoryScore(900.0))
        assertEquals(0.0, Scoring.categoryScore(5000.0))
        assertEquals(0.0, Scoring.categoryScore(null))
    }

    @Test
    fun `weights parse from query syntax`() {
        val w = Weights.parse("grocery:3, park:1.5,transit:0")
        assertEquals(mapOf(Category.GROCERY to 3.0, Category.PARK to 1.5, Category.TRANSIT to 0.0), w.values)
        assertEquals(mapOf("grocery" to 3.0, "park" to 1.5), w.toJson())
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "grocery", "grocery:x", "pizza:1", "grocery:0", "grocery:-1", "grocery:1:2"])
    fun `invalid weights are rejected`(spec: String) {
        assertThrows<IllegalArgumentException> { Weights.parse(spec) }
    }

    @Test
    fun `modes parse case-insensitively and reject unknown values`() {
        assertEquals(Mode.BIKE, Mode.parse(" Bike "))
        assertThrows<IllegalArgumentException> { Mode.parse("car") }
    }
}
