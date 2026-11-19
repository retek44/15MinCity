package hu.reach15.api.domain

import com.fasterxml.jackson.annotation.JsonValue

/**
 * Travel modes; [id] is the value used in URLs, JSON and the database. Walking and cycling are
 * precomputed per street vertex; public transport per H3 cell for a weekday 08:00 departure
 * (TransitHeatmap), and searched on demand for a place at any time.
 */
enum class Mode(@get:JsonValue val id: String) {
    WALK("walk"),
    BIKE("bike"),
    TRANSIT("transit"),
    ;

    companion object {
        fun parse(value: String): Mode =
            entries.firstOrNull { it.id.equals(value.trim(), ignoreCase = true) }
                ?: throw IllegalArgumentException("unknown mode '$value', expected one of ${entries.map { it.id }}")
    }
}

/** POI categories, matching the categories produced by the OSM import. */
enum class Category(@get:JsonValue val id: String, val label: String) {
    GROCERY("grocery", "Grocery"),
    PHARMACY("pharmacy", "Pharmacy"),
    DOCTOR("doctor", "Doctor"),
    SCHOOL("school", "School"),
    KINDERGARTEN("kindergarten", "Kindergarten"),
    PARK("park", "Park"),
    TRANSIT("transit", "Public transport"),
    FOOD("food", "Café & restaurant"),
    GYM("gym", "Gym"),
    LIBRARY("library", "Library"),
    ;

    companion object {
        private val byId = entries.associateBy { it.id }

        fun parse(value: String): Category =
            byId[value.trim().lowercase()]
                ?: throw IllegalArgumentException("unknown category '$value', expected one of ${byId.keys}")

        fun fromDb(value: String): Category? = byId[value]
    }
}

data class LonLat(val lon: Double, val lat: Double)
