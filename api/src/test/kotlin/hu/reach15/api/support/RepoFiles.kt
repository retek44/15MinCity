package hu.reach15.api.support

import java.nio.file.Path
import kotlin.io.path.readText

/** Files shared across the monorepo (fixtures, snapshots), resolved from the repository root. */
object RepoFiles {
    val root: Path = Path.of(System.getProperty("reach15.repoRoot") ?: "..").toAbsolutePath().normalize()

    fun path(relative: String): Path = root.resolve(relative)

    fun read(relative: String): String = path(relative).readText()
}
