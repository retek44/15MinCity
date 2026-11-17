package hu.reach15.api.web

import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.info.License
import io.swagger.v3.oas.models.media.Schema
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class OpenApiConfig {
    @Bean
    fun openApi(): OpenAPI =
        OpenAPI().info(
            Info()
                .title("Reach15 API")
                .version("v1")
                .description("15-minute city accessibility for Budapest: isochrones, scores, search.")
                .license(License().name("Map data © OpenStreetMap contributors, ODbL").url("https://www.openstreetmap.org/copyright")),
        )

    /**
     * springdoc marks every property optional. Kotlin already says which ones can be null
     * (they are emitted as `type: [x, "null"]` or `oneOf: [..., {type: null}]`), so every other
     * property is required. The generated TypeScript client then needs no defensive `?.`.
     */
    @Bean
    fun requiredUnlessNullable(): OpenApiCustomizer =
        OpenApiCustomizer { api ->
            api.components?.schemas?.values?.forEach { schema ->
                val properties = schema.properties ?: return@forEach
                schema.required = properties.filterValues { !it.isNullable() }.keys.sorted().ifEmpty { null }
            }
        }

    private fun Schema<*>.isNullable(): Boolean =
        nullable == true ||
            types?.contains("null") == true ||
            (oneOf.orEmpty() + anyOf.orEmpty()).any { it.types?.contains("null") == true || it.type == "null" }
}
