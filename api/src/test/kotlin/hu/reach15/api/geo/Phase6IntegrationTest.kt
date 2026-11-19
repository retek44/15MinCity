package hu.reach15.api.geo

import hu.reach15.api.support.IntegrationTest
import hu.reach15.api.support.items
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import tools.jackson.databind.JsonNode
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Public transport, opening hours and "where should we live?" on the synthetic grid.
 * The GTFS fixture runs tram T1 from Corner (vertex 1000) to Far Corner (1099) in 3 minutes,
 * every 10 minutes on weekdays; 2026-11-17 is a Tuesday, 2026-11-22 a Sunday.
 */
class Phase6IntegrationTest : IntegrationTest() {
    private fun get(uri: String): JsonNode = http.get().uri(uri).retrieve().body(JsonNode::class.java)!!

    private fun status(uri: String): HttpStatusCode =
        http.get().uri(uri).exchange<HttpStatusCode> { _, response -> response.statusCode }

    private fun JsonNode.category(id: String) = this["categories"].items().first { it["category"].asString() == id }

    @Nested
    inner class Transit {
        @Test
        fun `the tram beats an 18-block walk to the far corner`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=transit&at=2026-11-17T08:00")
            assertEquals("transit", body["mode"].asString())
            assertEquals(180.0, body.category("pharmacy")["seconds"].asDouble(), 3.0) // board at 08:00, 3 min ride
            assertEquals(330.0, body.category("school")["seconds"].asDouble(), 5.0) // + steps (150 s)
            assertEquals(0.0, body.category("grocery")["seconds"].asDouble(), 0.5) // walking still counts
            assertEquals(192, body["transit"]["tripsRunning"].asInt())
            assertEquals("2026-11-17T08:00:00", body["at"].asString())
        }

        @Test
        fun `a minute late means waiting for the next tram`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=transit&at=2026-11-17T08:01")
            assertEquals(720.0, body.category("pharmacy")["seconds"].asDouble(), 3.0) // 08:10 tram, arrives 08:13 = 12 min after 08:01
        }

        @Test
        fun `no trams on Sunday, so it is the walk again`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=transit&at=2026-11-22T10:00")
            assertEquals(0, body["transit"]["tripsRunning"].asInt())
            assertEquals(1350.0, body.category("pharmacy")["seconds"].asDouble(), 15.0)
        }

        @Test
        fun `transit isochrones reach further than walking ones`() {
            val (lon, lat) = vertex(1000)
            fun area(mode: String) =
                get("/api/v1/isochrone?lon=$lon&lat=$lat&mode=$mode&minutes=10&at=2026-11-17T08:00")["features"][0]["properties"]["areaM2"].asDouble()
            assertTrue(area("transit") > area("walk") * 1.2, "the tram adds the area around the far corner")
        }

        @Test
        fun `the ranking also covers public transport`() {
            assertEquals(HttpStatus.OK, status("/api/v1/districts/ranking?mode=transit"))
        }
    }

    @Nested
    inner class OpeningHours {
        @Test
        fun `on Sunday the only grocery is closed and the pharmacy is open`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk&at=2026-11-22T12:00")
            assertTrue(body.category("grocery")["seconds"].isNull)
            assertEquals(true, body.category("pharmacy")["open"].asBoolean())
            assertEquals("24/7", body.category("pharmacy")["poi"]["openingHours"].asString())
            assertTrue(body.category("park")["open"].isNull, "parks have no hours: unknown")
        }

        @Test
        fun `without a time nothing is filtered`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk")
            assertEquals(0.0, body.category("grocery")["seconds"].asDouble(), 0.5)
            assertTrue(body.category("grocery")["open"].isNull)
        }

        @Test
        fun `malformed times are a 400`() {
            val (lon, lat) = vertex(1000)
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/access?lon=$lon&lat=$lat&at=sunday"))
        }
    }

    @Nested
    inner class CommonGround {
        @Test
        fun `finds the area between two places and spots inside it`() {
            val (lon0, lat0) = vertex(1000)
            val (lon4, lat4) = vertex(1004)
            val body = get("/api/v1/common-ground?places=$lon0,$lat0,walk,10;$lon4,$lat4,bike,5&persona=family")
            assertEquals("MultiPolygon", body["area"]["type"].asString())
            assertTrue(body["areaM2"].asDouble() > 0)
            assertEquals(listOf("walk", "bike"), body["anchors"].items().map { it["mode"].asString() })
            val spots = body["spots"].items()
            assertTrue(spots.isNotEmpty())
            spots.forEach { spot ->
                val (walk, bike) = spot["seconds"].items().map { it.asDouble() }
                assertTrue(walk <= 600 && bike <= 300, "spot ${spot["lon"]},${spot["lat"]} within both limits")
                assertTrue(spot["score"].asDouble() in 0.0..100.0)
            }
        }

        @Test
        fun `a transit place uses the timetable`() {
            val (lon0, lat0) = vertex(1000)
            val (lon9, lat9) = vertex(1099)
            val body = get("/api/v1/common-ground?places=$lon0,$lat0,transit,6;$lon9,$lat9,walk,3&at=2026-11-17T08:00")
            assertNotNull(body["area"].takeUnless { it.isNull }, "the tram makes the far corner reachable in 6 minutes")
            assertEquals("2026-11-17T08:00:00", body["at"].asString())
        }

        @Test
        fun `places too far apart share nothing`() {
            val (lon0, lat0) = vertex(1000)
            val (lon9, lat9) = vertex(1099)
            val body = get("/api/v1/common-ground?places=$lon0,$lat0,walk,2;$lon9,$lat9,walk,2")
            assertTrue(body["area"].isNull)
            assertEquals(0, body["spots"].size())
        }

        @Test
        fun `rejects malformed places`() {
            val (lon, lat) = vertex(1000)
            val one = "$lon,$lat,walk,10"
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/common-ground?places=$one;$one;$one;$one;$one"))
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/common-ground?places=$lon,$lat,walk,60"))
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/common-ground?places=$lon,$lat,car,10"))
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/common-ground?places=$lon,$lat,walk"))
        }
    }
}
