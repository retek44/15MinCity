package hu.reach15.api

import hu.reach15.api.support.IntegrationTest
import hu.reach15.api.support.RepoFiles
import org.junit.jupiter.api.Test
import tools.jackson.databind.JsonNode
import tools.jackson.databind.SerializationFeature
import tools.jackson.databind.json.JsonMapper
import kotlin.io.path.exists
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.fail

/**
 * The OpenAPI document is a reviewed contract: the web client's types are generated from
 * openapi/openapi.json. Any API change shows up as a diff of that file in the pull request.
 * Run `./gradlew test -PupdateSnapshots` to accept a change.
 */
class OpenApiContractTest : IntegrationTest() {
    private val mapper =
        JsonMapper.builder()
            .enable(SerializationFeature.INDENT_OUTPUT)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .build()

    @Test
    fun `generated OpenAPI document matches the committed contract`() {
        val live = http.get().uri("/api/openapi.json").retrieve().body(JsonNode::class.java)!!
        // The server URL contains the random test port.
        (live as tools.jackson.databind.node.ObjectNode).remove("servers")
        val generated = mapper.writeValueAsString(mapper.treeToValue(live, Any::class.java)) + "\n"

        val snapshot = RepoFiles.path("openapi/openapi.json")
        if (System.getProperty("reach15.updateSnapshots") == "true") {
            snapshot.parent.toFile().mkdirs()
            snapshot.writeText(generated)
            return
        }
        if (!snapshot.exists()) fail("$snapshot is missing: run ./gradlew test -PupdateSnapshots")
        assertEquals(RepoFiles.read("openapi/openapi.json"), generated, "API contract changed; review and run ./gradlew test -PupdateSnapshots")
    }
}
