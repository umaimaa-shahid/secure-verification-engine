const { getPrisma } = require("../config/db");

/**
 * Data access for the qr_assets table.
 *
 * Every Prisma-specific detail lives here — field selection, error codes, column
 * naming — so services/qrService.js can stay a pure module that knows nothing
 * about the driver underneath it. That boundary is what made the move from
 * MongoDB to Supabase a contained change rather than a rewrite, and it is worth
 * preserving for the same reason.
 */

/**
 * Default projection: everything EXCEPT the signature.
 *
 * Mongoose had `select: false` to make a field opt-in. Prisma has no equivalent —
 * a bare findUnique returns every column — so the protection has to be an
 * explicit allowlist. Anything added to the table stays invisible until it is
 * added here, which is the safe direction for that mistake to fail in.
 */
const DEFAULT_SELECT = Object.freeze({
  id: true,
  documentId: true,
  qrCodeId: true,
  documentType: true,
  title: true,
  referenceNumber: true,
  recipientName: true,
  recipientEmail: true,
  issuedAt: true,
  expiresAt: true,
  qrCodePath: true,
  verificationUrl: true,
  status: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
});

/** Opt-in projection for the integrity check. Never used to build a response. */
const SELECT_WITH_HASH = Object.freeze({
  ...DEFAULT_SELECT,
  verificationHash: true,
});

function selectFor({ withHash = false } = {}) {
  return withHash ? SELECT_WITH_HASH : DEFAULT_SELECT;
}

// -- Derived values ---------------------------------------------------------

/**
 * Status with expiry applied.
 *
 * `status` is the stored lifecycle flag; expiry is a function of the clock, so
 * deriving it on read avoids needing a sweeper job to keep rows honest. A revoked
 * document stays revoked even after its expiry passes — revocation is the more
 * important fact to report.
 *
 * @param {Object} row
 * @returns {"active"|"expired"|"revoked"}
 */
function effectiveStatus(row) {
  if (row.status !== "active") return row.status;
  return row.expiresAt.getTime() < Date.now() ? "expired" : "active";
}

/**
 * The shape callers are given for an issued QR.
 *
 * Deliberately excludes the signature, the local filesystem path and the
 * recipient's details: a caller gets URLs it can fetch, not internals it would
 * have to reimplement or PII it did not ask for. This is the single definition
 * of that shape, so the CLI and the HTTP API cannot drift apart.
 *
 * @param {Object} row
 * @param {string} publicBaseUrl - this service's own origin, for the image URL
 */
function toReferenceJSON(row, publicBaseUrl) {
  return {
    documentId: row.documentId,
    qrCodeId: row.qrCodeId,
    verificationUrl: row.verificationUrl,
    qrImageUrl: `${publicBaseUrl}/api/qr/image/${row.qrCodeId}.png`,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: effectiveStatus(row),
  };
}

// -- Queries ----------------------------------------------------------------

function findByDocumentId(documentId, options) {
  return getPrisma().qrAsset.findUnique({
    where: { documentId },
    select: selectFor(options),
  });
}

function findByQrCodeId(qrCodeId, options) {
  return getPrisma().qrAsset.findUnique({
    where: { qrCodeId },
    select: selectFor(options),
  });
}

function countByDocumentId(documentId) {
  return getPrisma().qrAsset.count({ where: { documentId } });
}

function insert(data) {
  return getPrisma().qrAsset.create({ data, select: DEFAULT_SELECT });
}

// -- Constraint violations --------------------------------------------------

/**
 * Postgres column names, as Prisma reports them in a P2002, mapped back to the
 * field names the rest of the codebase speaks.
 */
const CONSTRAINT_FIELDS = Object.freeze({
  document_id: "documentId",
  documentId: "documentId",
  qr_code_id: "qrCodeId",
  qrCodeId: "qrCodeId",
});

/**
 * Identify which unique constraint a write violated.
 *
 * Prisma raises P2002 for a unique violation (Postgres SQLSTATE 23505) and names
 * the offending column in `meta.target`. Returning the field name rather than the
 * raw error lets the service decide what a collision *means* without knowing
 * anything about Prisma — which is the same job `duplicateKeyField` did for
 * MongoDB's E11000.
 *
 * @returns {string|null} "documentId", "qrCodeId", or null when this is not a
 *                        unique violation at all
 */
function uniqueViolationField(err) {
  if (err?.code !== "P2002") return null;

  const target = err.meta?.target;
  const columns = Array.isArray(target) ? target : [target].filter(Boolean);

  for (const column of columns) {
    const field = CONSTRAINT_FIELDS[column];
    if (field) return field;
  }
  return null;
}

module.exports = {
  DEFAULT_SELECT,
  SELECT_WITH_HASH,
  effectiveStatus,
  toReferenceJSON,
  findByDocumentId,
  findByQrCodeId,
  countByDocumentId,
  insert,
  uniqueViolationField,
};
