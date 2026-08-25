const { randomUUID } = require("crypto");

const { TEST_ENV } = require("./testEnv");

/**
 * Shared helpers for the API specs.
 *
 * Every test mints fresh UUIDs rather than sharing fixture rows, so specs stay
 * independent without needing a database reset between them - and so the
 * idempotency tests are proving real behaviour rather than a cleanup artifact.
 */

const GENERATE_PATH = "/api/internal/qr/generate";

function authHeaders(overrides = {}) {
  return {
    "x-internal-api-key": TEST_ENV.INTERNAL_API_KEY,
    ...overrides,
  };
}

/**
 * A payload shaped like the one Backend Squad A sends after creating a
 * document (their Technical Specification, sections 4.4.1 and 6.1.1).
 */
function newDocumentPayload(overrides = {}) {
  return {
    documentId: randomUUID(),
    qrCodeId: randomUUID(),
    documentType: "Internship Offer",
    title: "Internship Offer Letter",
    referenceNumber: `DL-TEST-${Date.now()}`,
    recipientName: "Jane Smith",
    recipientEmail: "jane@example.com",
    ...overrides,
  };
}

/** PNG files always begin with these eight bytes. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer) {
  return buffer.subarray(0, 8).equals(PNG_MAGIC);
}

module.exports = {
  GENERATE_PATH,
  authHeaders,
  newDocumentPayload,
  isPng,
  PNG_MAGIC,
};
