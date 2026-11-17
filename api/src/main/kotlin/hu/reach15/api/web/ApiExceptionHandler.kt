package hu.reach15.api.web

import org.postgresql.util.PSQLException
import org.springframework.dao.DataAccessException
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException

/** Maps domain and database validation errors to RFC 9457 problem details. */
@RestControllerAdvice
class ApiExceptionHandler {
    @ExceptionHandler(IllegalArgumentException::class)
    fun badRequest(e: IllegalArgumentException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.message ?: "invalid request")

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun typeMismatch(e: MethodArgumentTypeMismatchException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "parameter '${e.name}' has an invalid value")

    /**
     * The SQL functions raise SQLSTATE 22023 (invalid_parameter_value) for requests that are
     * well-formed but cannot be answered, e.g. a point far from any street.
     */
    @ExceptionHandler(DataAccessException::class)
    fun database(e: DataAccessException): ProblemDetail {
        val psql = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<PSQLException>().firstOrNull()
        if (psql?.sqlState == INVALID_PARAMETER_VALUE) {
            val server = psql.serverErrorMessage
            return ProblemDetail.forStatusAndDetail(
                HttpStatus.UNPROCESSABLE_CONTENT,
                listOfNotNull(server?.message, server?.detail).joinToString(": "),
            )
        }
        throw e
    }

    private companion object {
        const val INVALID_PARAMETER_VALUE = "22023"
    }
}
