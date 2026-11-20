package hu.reach15.api.geo

import hu.reach15.api.support.IntegrationTest
import hu.reach15.api.support.items
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import tools.jackson.databind.JsonNode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GeoApiIntegrationTest : IntegrationTest() {
    private fun get(uri: String): JsonNode = http.get().uri(uri).retrieve().body(JsonNode::class.java)!!

    private fun status(uri: String): Pair<HttpStatusCode, JsonNode?> =
        http.get().uri(uri).exchange<Pair<HttpStatusCode, JsonNode?>> { _, response ->
            response.statusCode to runCatching { response.bodyTo(JsonNode::class.java) }.getOrNull()
        }

    @Nested
    inner class Reference {
        @Test
        fun `categories and personas`() {
            val categories = get("/api/v1/categories").items().map { it["id"].asString() }
            assertEquals(10, categories.size)
            assertTrue("grocery" in categories)

            val personas = get("/api/v1/personas").items().associateBy { it["id"].asString() }
            assertEquals(setOf("balanced", "family", "student", "senior", "active"), personas.keys)
            assertEquals(3.0, personas.getValue("family")["weights"]["school"].asDouble())
        }

        @Test
        fun `meta reports the data release`() {
            val meta = get("/api/v1/meta")
            assertEquals("grid.osm", meta["sourceFile"].asString())
            assertEquals("succeeded", meta["status"].asString())
        }

        @Test
        fun `cells carry every hexagon's travel times column by column, one mode per request`() {
            val walk = get("/api/v1/cells")
            val categories = walk["categories"].items().map { it.asString() }
            val hexagons = walk["h3"].items().map { it.asString() }
            assertEquals(10, categories.size)
            assertTrue(hexagons.isNotEmpty())
            assertEquals(hexagons.size, hexagons.toSet().size)
            assertEquals("walk", walk["mode"].asString())
            for (mode in listOf("walk", "bike", "stepfree", "transit", "transit_evening")) {
                val cells = get("/api/v1/cells?mode=$mode")
                assertEquals(mode, cells["mode"].asString())
                assertEquals(hexagons, cells["h3"].items().map { it.asString() }, "same hexagon order for $mode")
                assertEquals(categories.size, cells["times"].size())
                cells["times"].items().forEach { column -> assertEquals(hexagons.size, column.size()) }
            }
            // The grid fixture's hexagons reach its Corner Market on foot.
            val grocery = walk["times"][categories.indexOf("grocery")].items().toList()
            assertTrue(grocery.any { !it.isNull && it.asInt() in 0..1800 })
        }

        @Test
        fun `cells reject an unknown mode`() {
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/cells?mode=car").first)
        }
    }

    @Nested
    inner class Search {
        @Test
        fun `finds an address without accents`() {
            val results = get("/api/v1/search?q=andrassy 1")
            assertEquals("Andrássy út 1", results[0]["label"].asString())
            assertEquals("address", results[0]["kind"].asString())
        }

        @Test
        fun `reverse geocodes a point next to an address`() {
            val (lon, lat) = vertex(1022)
            assertEquals("Andrássy út 1", get("/api/v1/reverse?lon=$lon&lat=$lat")["label"].asString())
        }

        @Test
        fun `reverse returns 404 far from addresses`() {
            assertEquals(HttpStatus.NOT_FOUND, status("/api/v1/reverse?lon=19.2&lat=47.6").first)
        }

        @Test
        fun `rejects a one-letter query`() {
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/search?q=x").first)
        }
    }

    @Nested
    inner class Isochrone {
        @Test
        fun `returns one GeoJSON polygon per limit`() {
            val (lon, lat) = vertex(1044)
            val fc = get("/api/v1/isochrone?lon=$lon&lat=$lat&mode=walk&minutes=10,5")
            assertEquals("FeatureCollection", fc["type"].asString())
            assertEquals(listOf(5, 10), fc["features"].items().map { it["properties"]["minutes"].asInt() })
            fc["features"].items().forEach {
                assertEquals("MultiPolygon", it["geometry"]["type"].asString())
                assertTrue(it["properties"]["areaM2"].asDouble() > 0)
            }
            val (small, large) = fc["features"].items().map { it["properties"]["areaM2"].asDouble() }
            assertTrue(small < large, "5 min area $small should be smaller than 10 min area $large")
        }

        @Test
        fun `rejects invalid limits and modes with 400`() {
            val (lon, lat) = vertex(1044)
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/isochrone?lon=$lon&lat=$lat&mode=car").first)
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/isochrone?lon=$lon&lat=$lat&minutes=abc").first)
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/isochrone?lon=500&lat=$lat").first)
        }

        @Test
        fun `rejects limits the database refuses with 422 problem details`() {
            val (lon, lat) = vertex(1044)
            val (code, body) = status("/api/v1/isochrone?lon=$lon&lat=$lat&minutes=45")
            assertEquals(HttpStatus.UNPROCESSABLE_CONTENT, code)
            assertEquals("minutes must be between 1 and 30", body!!["detail"].asString())
        }

        @Test
        fun `points away from the street network are 422`() {
            val (code, body) = status("/api/v1/isochrone?lon=19.2&lat=47.6")
            assertEquals(HttpStatus.UNPROCESSABLE_CONTENT, code)
            assertTrue(body!!["detail"].asString().startsWith("point is not near the street network"))
        }
    }

    @Nested
    inner class Access {
        @Test
        fun `names the nearest POI of each category with its walking time`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk&weights=grocery:1,pharmacy:1")
            val byCategory = body["categories"].items().associateBy { it["category"].asString() }

            assertEquals(0.0, byCategory.getValue("grocery")["seconds"].asDouble(), 0.5)
            assertEquals("Corner Market", byCategory.getValue("grocery")["poi"]["name"].asString())
            assertEquals(1350.0, byCategory.getValue("pharmacy")["seconds"].asDouble(), 15.0)
            assertTrue(byCategory.getValue("gym")["seconds"].isNull, "no gym in the fixture")
            // grocery scores 1, pharmacy (22.5 min) scores 0 -> 50
            assertEquals(50.0, body["score"].asDouble(), 0.5)
        }

        @Test
        fun `bike times follow oneway streets`() {
            val (lon, lat) = vertex(1005)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=bike")
            val grocery = body["categories"].items().first { it["category"].asString() == "grocery" }
            assertEquals(168.0, grocery["seconds"].asDouble(), 3.0) // 7 blocks via the detour
        }

        @Test
        fun `unknown persona is a 400`() {
            val (lon, lat) = vertex(1000)
            assertEquals(HttpStatus.BAD_REQUEST, status("/api/v1/access?lon=$lon&lat=$lat&persona=astronaut").first)
        }
    }

    @Nested
    inner class Districts {
        @Test
        fun `ranks the fixture district`() {
            val ranking = get("/api/v1/districts/ranking?persona=family")
            assertEquals(1, ranking.size())
            assertEquals("Test District", ranking[0]["name"].asString())
            assertEquals(1, ranking[0]["rank"].asInt())
            assertTrue(ranking[0]["score"].asDouble() in 0.0..100.0)
            val bbox = ranking[0]["bbox"].items().map { it.asDouble() }
            assertEquals(4, bbox.size)
            assertTrue(bbox[0] < bbox[2] && bbox[1] < bbox[3], "bbox is west, south, east, north")
        }
    }

    @Test
    fun `actuator health is up`() {
        assertEquals("UP", get("/actuator/health")["status"].asString())
    }
}
