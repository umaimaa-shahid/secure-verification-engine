const logger = require("../utils/logger");
const { AppError, NotFoundError } = require("../utils/errors");

/**
 * Central error handling.
 *
 * The response envelope matches Backend Squad A Technical Specification
 * section 8.1, so a client that already handles their errors handles ours
 * without a second code path.
 *
 * The brief calls for three distinct outcomes and they map as follows:
 *   - expected, caller-fixable  -> 4xx with a specific code and field details
 *   - expected, not caller-fixable -> 4xx/409 with enough context to reconcile
 *   - unexpected                -> 500 with a deliberately generic message
 *
 * Stack traces and driver messages never cross the wire. They go to the log,
 * where the operator can correlate them by path and timestamp.
 */

function buildEnvelope({ code, message, details, path }) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  error.timestamp = new Date().toISOString();
  error.path = path;
  return { success: false, error };
}

/** Terminal 404 for unmatched routes. Runs before the error handler. */
function notFoundHandler(req, _res, next) {
  next(new NotFoundError(`No route matches ${req.method} ${req.path}.`));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error
// middleware by arity; the 4th parameter must stay even though it is unused.
function errorHandler(err, req, res, next) {
  // A malformed JSON body surfaces from express.json() as a SyntaxError with a
  // status already attached. Treat it as caller-fixable rather than a crash.
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json(
      buildEnvelope({
        code: "VALIDATION_INVALID_INPUT",
        message: "Request body is not valid JSON.",
        path: req.originalUrl,
      })
    );
  }

  if (err instanceof AppError) {
    // 4xx is the caller informing us of a problem; only 5xx is our problem.
    const level = err.status >= 500 ? "error" : "warn";
    logger[level]("Request failed", {
      code: err.code,
      status: err.status,
      path: req.originalUrl,
    });

    return res.status(err.status).json(
      buildEnvelope({
        code: err.code,
        message: err.message,
        details: err.details,
        path: req.originalUrl,
      })
    );
  }

  // Anything reaching here is a genuine defect. Log it in full, tell the caller
  // nothing that could help an attacker map our internals.
  logger.error("Unhandled error", {
    path: req.originalUrl,
    name: err?.name,
    reason: err?.message,
    stack: err?.stack,
  });

  return res.status(500).json(
    buildEnvelope({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred. Please try again later.",
      path: req.originalUrl,
    })
  );
}

module.exports = { errorHandler, notFoundHandler };
