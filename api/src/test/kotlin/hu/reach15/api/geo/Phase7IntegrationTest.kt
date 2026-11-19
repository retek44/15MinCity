package hu.reach15.api.geo

import hu.reach15.api.support.IntegrationTest
import hu.reach15.api.support.items
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import tools.jackson.databind.JsonNode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Public holidays, and the public transport heatmap, on the synthetic grid. Corner Market (at
 * vertex 1000) opens Mo-Sa 07:00-21:00 and 08:00-12:00 on public holidays. 2026-12-25 is a
 * Friday and Christmas Day.
 */
class Phase7IntegrationTest : IntegrationTest() {
    private fun get(uri: String): JsonNode = http.get().uri(uri).retrieve().body(JsonNode::class.java)!!

    private fun JsonNode.category(id: String) = this["categories"].items().first { it["category"].asString() == id }

    @Nested
    inner class Holidays {
        @Test
        fun `on Christmas afternoon the market keeps its holiday hours`() {
            val (lon, lat) = vertex(1000)
            val body = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk&at=2026-12-25T13:00")
            assertEquals("christmas", body["holiday"].asString())
            assertTrue(body.category("grocery")["seconds"].isNull, "closed from 12:00 on holidays")
            assertEquals(true, body.category("food")["open"].asBoolean(), "no PH rule: weekly hours")
        }

        @Test
        fun `on Christmas morning it is open, and an ordinary Friday is no holiday`() {
            val (lon, lat) = vertex(1000)
            val christmas = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk&at=2026-12-25T10:00")
            assertEquals(true, christmas.category("grocery")["open"].asBoolean())
            val friday = get("/api/v1/access?lon=$lon&lat=$lat&mode=walk&at=2026-12-18T13:00")
            assertTrue(friday["holiday"].isNull)
            assertEquals(true, friday.category("grocery")["open"].asBoolean())
        }
    }

    @Nested
    inner class TransitHeatmap {
        private val cells by lazy { get("/api/v1/cells") }

        private fun column(mode: String, category: String): List<JsonNode> {
            val c = cells["categories"].items().map { it.asString() }.indexOf(category)
            return cells[mode][c].items().toList()
        }

        private fun cellOf(vertex: Long): Int {
            val h3 = jdbc.sql("SELECT h3_latlng_to_cell(geom, 9)::text FROM routing.vertices WHERE id = ?")
                .param(vertex).query(String::class.java).single()
            return cells["h3"].items().map { it.asString() }.indexOf(h3)
        }

        @Test
        fun `the tram brings the far corner within reach of the market`() {
            val far = cellOf(1099)
            val walk = column("walk", "grocery")[far].asInt()
            val transit = column("transit", "grocery")[far].asInt()
            assertTrue(walk > 1200, "18 blocks on foot: $walk s")
            // Walk to the stop, wait for the 08:10 tram (it leaves the far corner at :10), ride 3 minutes.
            assertTrue(transit < walk - 300, "by tram: $transit s")
        }

        @Test
        fun `public transport is never slower than walking`() {
            for (category in cells["categories"].items().map { it.asString() }) {
                val walk = column("walk", category)
                val transit = column("transit", category)
                walk.indices.filter { !walk[it].isNull }.forEach {
                    assertTrue(!transit[it].isNull && transit[it].asInt() <= walk[it].asInt() + 1, "$category, cell $it")
                }
            }
        }

        @Test
        fun `districts rank by public transport too`() {
            val ranking = get("/api/v1/districts/ranking?mode=transit&weights=grocery:1")
            assertTrue(ranking.items().toList().isNotEmpty())
            val walking = get("/api/v1/districts/ranking?mode=walk&weights=grocery:1")
            assertTrue(ranking[0]["score"].asDouble() >= walking[0]["score"].asDouble())
        }
    }
}
