const { ValidationError } = require("../utils/errors");

/**
 * Validation for the QR generation payload sent by Backend Squad A.
 *
 * Runs inside the service rather than as HTTP middleware, so the CLI script and
 * a direct `require()` of the service get exactly the same guarantees as the
 * API. The brief is explicit that partial or malformed asset data must be
 * rejected *before* anything is signed — signing garbage produces a token that
 * looks authentic and is not.
 *
 * Unknown fields are ignored rather than rejected: Squad A's document model is
 * still moving, and a new column on their side should not start returning 422s
 * on ours.
 */

// RFC 4122, any version. Squad A mints these with Prisma's uuid() default.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Deliberately loose: we are catching typos and empty strings, not policing
// the full RFC 5322 grammar.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_TEXT_LENGTH = 512;
const MAX_METADATA_BYTES = 8 * 1024;

const OPTIONAL_TEXT_FIELDS = [
  "documentType",
  "title",
  "referenceNumber",
  "recipientName",
];

function isPlainObject(value) {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * @param {Object} payload - raw request body / CLI arguments
 * @returns {Object} normalised payload, safe to sign and persist
 * @throws {ValidationError} with every problem found, not just the first
 */
function validateQrPayload(payload) {
  const fields = [];

  if (!isPlainObject(payload)) {
    throw new ValidationError([
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  // ── Required identifiers ───────────────────────────────────────────────
  for (const field of ["documentId", "qrCodeId"]) {
    const value = payload[field];
    if (value === undefined || value === null || value === "") {
      fields.push({ field, message: `${field} is required.` });
    } else if (typeof value !== "string") {
      fields.push({ field, message: `${field} must be a string.` });
    } else if (!UUID_PATTERN.test(value)) {
      fields.push({ field, message: `${field} must be a valid UUID.` });
    }
  }

  // ── Optional text ──────────────────────────────────────────────────────
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      fields.push({ field, message: `${field} must be a string.` });
    } else if (value.length > MAX_TEXT_LENGTH) {
      fields.push({
        field,
        message: `${field} must be at most ${MAX_TEXT_LENGTH} characters.`,
      });
    }
  }

  // ── Recipient email ────────────────────────────────────────────────────
  if (payload.recipientEmail !== undefined && payload.recipientEmail !== null) {
    if (
      typeof payload.recipientEmail !== "string" ||
      !EMAIL_PATTERN.test(payload.recipientEmail)
    ) {
      fields.push({
        field: "recipientEmail",
        message: "recipientEmail must be a valid email address.",
      });
    }
  }

  // ── Dates ──────────────────────────────────────────────────────────────
  const parsedDates = {};
  for (const field of ["issuanceDate", "expiryDate"]) {
    const value = payload[field];
    if (value === undefined || value === null) continue;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      fields.push({
        field,
        message: `${field} must be a valid ISO 8601 date string.`,
      });
    } else {
      parsedDates[field] = parsed;
    }
  }

  // A QR that is born expired is a caller bug, not a state worth persisting.
  if (parsedDates.expiryDate && parsedDates.expiryDate.getTime() <= Date.now()) {
    fields.push({
      field: "expiryDate",
      message: "expiryDate must be in the future.",
    });
  }

  // ── Metadata ───────────────────────────────────────────────────────────
  let metadata = {};
  if (payload.metadata !== undefined && payload.metadata !== null) {
    if (!isPlainObject(payload.metadata)) {
      fields.push({
        field: "metadata",
        message: "metadata must be a JSON object.",
      });
    } else if (
      Buffer.byteLength(JSON.stringify(payload.metadata), "utf8") >
      MAX_METADATA_BYTES
    ) {
      fields.push({
        field: "metadata",
        message: `metadata must serialise to at most ${MAX_METADATA_BYTES} bytes.`,
      });
    } else {
      metadata = payload.metadata;
    }
  }

  if (fields.length > 0) {
    throw new ValidationError(fields);
  }

  return {
    // Lower-cased deliberately. Postgres normalises uuid columns, so a payload
    // sent with upper-case hex would come back lower-case and the idempotency
    // comparison against a stored qrCodeId would spuriously report a conflict.
    // Normalising at the boundary keeps one canonical form everywhere.
    documentId: payload.documentId.toLowerCase(),
    qrCodeId: payload.qrCodeId.toLowerCase(),
    documentType: payload.documentType ?? null,
    title: payload.title ?? null,
    referenceNumber: payload.referenceNumber ?? null,
    recipientName: payload.recipientName ?? null,
    recipientEmail: payload.recipientEmail ?? null,
    issuanceDate: parsedDates.issuanceDate ?? null,
    expiryDate: parsedDates.expiryDate ?? null,
    metadata,
  };
}

module.exports = { validateQrPayload, UUID_PATTERN };
