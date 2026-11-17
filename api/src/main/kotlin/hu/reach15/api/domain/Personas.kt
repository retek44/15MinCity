package hu.reach15.api.domain

import org.springframework.boot.context.properties.ConfigurationProperties

/** Preset category weights, configured under `reach15.personas` in application.yml. */
@ConfigurationProperties("reach15")
data class PersonaProperties(val personas: Map<String, PersonaConfig> = emptyMap()) {
    data class PersonaConfig(val label: String, val weights: Map<String, Double>)

    fun all(): List<Persona> =
        personas.map { (id, cfg) ->
            Persona(id, cfg.label, Weights(cfg.weights.mapKeys { Category.parse(it.key) }))
        }

    fun find(id: String): Persona =
        all().firstOrNull { it.id == id }
            ?: throw IllegalArgumentException("unknown persona '$id', expected one of ${personas.keys}")
}

data class Persona(val id: String, val label: String, val weights: Weights)
