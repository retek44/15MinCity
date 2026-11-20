package hu.reach15.api.geo

import hu.reach15.api.support.IntegrationTest
import hu.reach15.api.support.items
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.web.client.HttpClientErrorException
import tools.jackson.databind.JsonNode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Step-free walking, the Sunday evening public transport heatmap and "better nearby", on the
 * synthetic grid: the school (3101) is reached only by the steps north of the far corner (1099),
 * and the fixture timetable runs on weekdays only.
 */
class Phase8IntegrationTest : IntegrationTest() {
    private fun get(uri: String): JsonNode = http.get().uri(uri).retrieve().body(JsonNode::class.java)!!

    private fun JsonNode.category(id: String) = this["categories"].items().first { it["category"].asString() == id }

    private fun statusOf(uri: String): HttpStatus =
        try {
            http.get().uri(uri).retrieve().toBodilessEntity()
            HttpStatus.OK
        } catch (e: HttpClientErrorException) {
            HttpStatus.valueOf(e.statusCode.value())
        }

    @Nested
    inner class StepFree {
        @Test
        fun `the school behind the steps is out of reach step-free, not on foot`() {
            val (lon, lat) = vertex(1099)
            val walk = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk")
            val stepFree = get("/api/v1/access?lon=$lon&lat=$lat&mode=stepfree")
            assertEquals("stepfree", stepFree["mode"].asString())
            assertTrue(!walk.category("school")["seconds"].isNull)
            assertTrue(stepFree.category("school")["seconds"].isNull)
            assertTrue(stepFree["score"].asDouble() < walk["score"].asDouble())
        }

        @Test
        fun `step-free isochrones and rankings work like walking`() {
            val (lon, lat) = vertex(1000)
            assertEquals(HttpStatus.OK, statusOf("/api/v1/isochrone?lon=$lon&lat=$lat&mode=stepfree&minutes=5,10"))
            assertTrue(get("/api/v1/districts/ranking?mode=stepfree&weights=grocery:1").items().toList().isNotEmpty())
        }
    }

    @Nested
    inner class EveningTransit {
        @Test
        fun `on Sunday evening the weekday tram does not run, so the heatmap falls back to walking`() {
            val categories = get("/api/v1/cells?mode=walk")["categories"].items().map { it.asString() }
            val grocery = categories.indexOf("grocery")
            val walk = get("/api/v1/cells?mode=walk")["times"][grocery].items().toList()
            val evening = get("/api/v1/cells?mode=transit_evening")["times"][grocery].items().toList()
            val morning = get("/api/v1/cells?mode=transit")["times"][grocery].items().toList()
            walk.indices.filter { !walk[it].isNull }.forEach {
                assertTrue(!evening[it].isNull && evening[it].asInt() <= walk[it].asInt() + 1, "never worse than walking")
                assertTrue(evening[it].asInt() >= morning[it].asInt() - 1, "never better than with the tram")
            }
            assertTrue(walk.indices.any { !morning[it].isNull && morning[it].asInt() < evening[it].asInt() - 300 })
        }

        @Test
        fun `districts rank by the evening departure too`() {
            assertTrue(get("/api/v1/districts/ranking?mode=transit_evening&weights=grocery:1").items().toList().isNotEmpty())
        }
    }

    @Nested
    inner class BetterNearby {
        @Test
        fun `from the far corner, hexagons closer to the market score higher within a walk`() {
            val (lon, lat) = vertex(1099)
            val body = get("/api/v1/nearby?lon=$lon&lat=$lat&weights=grocery:1&minutes=10")
            assertEquals("walk", body["mode"].asString())
            assertEquals(10, body["minutes"].asInt())
            val places = body["places"].items().toList()
            assertTrue(places.isNotEmpty())
            places.forEach {
                assertTrue(it["score"].asDouble() >= body["hereScore"].asDouble() + 1)
                assertTrue(it["seconds"].asDouble() <= 600)
            }
            assertEquals(places.map { it["score"].asDouble() }.sortedDescending(), places.map { it["score"].asDouble() })
        }

        @Test
        fun `rejects an unknown mode and an overlong walk`() {
            val (lon, lat) = vertex(1099)
            assertEquals(HttpStatus.BAD_REQUEST, statusOf("/api/v1/nearby?lon=$lon&lat=$lat&mode=car"))
            assertEquals(HttpStatus.BAD_REQUEST, statusOf("/api/v1/nearby?lon=$lon&lat=$lat&minutes=90"))
        }
    }
}
