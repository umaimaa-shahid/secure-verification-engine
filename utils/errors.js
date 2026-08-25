/**
 * Typed application errors.
 *
 * Every error carries an `code` and `status` so the central error handler can
 * translate it into the shared error envelope agreed with Backend Squad A
 * (their Technical Specification, section 8.1) without any `instanceof`
 * ladders in the controllers.
 *
 * Error codes are reused from Squad A's table (section 8.3) wherever one
 * already exists, so both services speak the same vocabulary.
 */

class AppError extends Error {
  /**
   * @param {string} code    - stable machine-readable code, e.g. "QR_NOT_FOUND"
   * @param {string} message - human-readable, safe to show a developer
   * @param {number} status  - HTTP status code
   * @param {Object} [details] - optional structured context (never secrets)
   */
  constructor(code, message, status, details) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.expected = true; // distinguishes handled errors from genuine crashes
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * The caller sent a payload we cannot act on. Developer-facing (Squad A), 422.
 * `details.fields` is an array of { field, message } so the caller can fix it
 * in one round trip instead of discovering problems one at a time.
 */
class ValidationError extends AppError {
  constructor(fields) {
    super(
      "VALIDATION_INVALID_INPUT",
      "The request payload failed validation.",
      422,
      { fields }
    );
  }
}

/**
 * The request is well-formed but contradicts state we already hold — e.g. a
 * second generate call for a documentId we have already issued, carrying a
 * different qrCodeId. Returning the stored record would hand back a QR that
 * does not match what Squad A now believes, so we refuse instead.
 */
class ConflictError extends AppError {
  constructor(message, details) {
    super("QR_CODE_ID_CONFLICT", message, 409, details);
  }
}

/** No QR asset exists for the given identifier. */
class NotFoundError extends AppError {
  constructor(message = "QR code not found.") {
    super("DOCUMENT_QR_NOT_FOUND", message, 404);
  }
}

/** Caller did not present a valid internal API key. */
class UnauthorizedError extends AppError {
  constructor(message = "A valid internal API key is required.") {
    super("AUTH_INVALID_CREDENTIALS", message, 401);
  }
}

module.exports = {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
};
