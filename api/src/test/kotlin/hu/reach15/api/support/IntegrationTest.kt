package hu.reach15.api.support

import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.client.RestClient
import org.testcontainers.postgresql.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import kotlin.io.path.exists

/**
 * Boots the API against a throw-away PostgreSQL built from db/Dockerfile and restored from the
 * synthetic grid fixture (tests/fixtures/db/grid.sql, produced by `python tasks.py test-db`).
 * One container is shared by every test class through Spring's context cache.
 *
 * Grid vertex (row, col) has id 1000 + 10 * row + col; one block is 100 m = 75 s on foot.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(IntegrationTest.Containers::class)
abstract class IntegrationTest {
    @LocalServerPort
    private var port: Int = 0

    @Autowired
    protected lateinit var jdbc: JdbcClient

    protected lateinit var http: RestClient

    @BeforeEach
    fun client() {
        http = RestClient.builder().baseUrl("http://localhost:$port").build()
    }

    /** (lon, lat) of a grid vertex. */
    protected fun vertex(id: Long): Pair<Double, Double> =
        jdbc.sql("SELECT ST_X(geom), ST_Y(geom) FROM routing.vertices WHERE id = ?")
            .param(id)
            .query { rs, _ -> rs.getDouble(1) to rs.getDouble(2) }
            .single()

    @TestConfiguration(proxyBeanMethods = false)
    class Containers {
        @Bean
        @ServiceConnection
        fun postgres(): PostgreSQLContainer {
            val dump = RepoFiles.path("tests/fixtures/db/grid.sql")
            check(dump.exists()) { "$dump is missing: run `python tasks.py test-db` first" }
            val image = System.getenv("REACH15_DB_IMAGE") ?: "reach15-db:latest"
            return PostgreSQLContainer(DockerImageName.parse(image).asCompatibleSubstituteFor("postgres"))
                .withCopyFileToContainer(MountableFile.forHostPath(dump), "/docker-entrypoint-initdb.d/10-grid.sql")
        }
    }
}
