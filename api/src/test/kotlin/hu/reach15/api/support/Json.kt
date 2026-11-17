package hu.reach15.api.support

import tools.jackson.databind.JsonNode

/** Elements of a JSON array as a Kotlin list. */
fun JsonNode.items(): List<JsonNode> = (0 until size()).map { get(it) }
