const crypto = require("crypto");
const path = require("path");
const fsp = require("fs/promises");
const QRCode = require("qrcode");

const { qrConfig } = require("../config/qr");
const QRAsset = require("../models/qrAsset");
const logger = require("../utils/logger");
const { ConflictError, NotFoundError } = require("../utils/errors");
const { validateQrPayload, UUID_PATTERN } = require("../validators/qrPayload");

/**
 * QR generation service.
 *
 * Pure module: no Express, no request objects, no process.exit. It is driven
 * identically by the HTTP controller, the CLI script and any future queue
 * consumer, which is what lets the brief's "independently testable and callable"
 * requirement actually hold.
 *
 * Identifier ownership: Backend Squad A mints both documentId and qrCodeId
 * (Prisma uuid() defaults on their documents table). We never invent our own
 * identifier - we sign theirs. Full rationale in docs/qr-payload-spec.md.
 */

/**
 * Signing scheme version. Prefixed into every hash so the scheme can be
 * rotated later without silently accepting old-format signatures.
 */
const HASH_SCHEME = "v1";

// -- Signing ---------------------------------------------------------------

/**
 * Build the exact byte string that gets signed.
 *
 * Every component is stored on the record, so the hash is recomputable - which
 * is what makes it a signature rather than an opaque random identifier. Change
 * any bound field and verification fails.
 */
function buildSigningMessage({ documentId, qrCodeId, issuedAt, expiresAt }) {
  return [
    HASH_SCHEME,
    documentId,
    qrCodeId,
    issuedAt.toISOString(),
    expiresAt.toISOString(),
  ].join(":");
}

/**
 * Sign a document QR binding with HMAC-SHA256.
 *
 * Deterministic: the same inputs always produce the same hash, which is what
 * makes the idempotency guard verifiable rather than merely hopeful.
 *
 * @returns {string} hex digest
 */
function signVerificationHash({ documentId, qrCodeId, issuedAt, expiresAt }) {
  return crypto
    .createHmac("sha256", qrConfig.hashSecret)
    .update(buildSigningMessage({ documentId, qrCodeId, issuedAt, expiresAt }))
    .digest("hex");
}

/**
 * Recompute a stored record signature and compare it in constant time.
 *
 * @param {Object} asset - a row loaded WITH verificationHash. The default
 *                         projection omits it, so load it with
 *                         findByDocumentId(id, { withHash: true })
 * @returns {boolean} true when the record has not been tampered with
 */
function verifyVerificationHash(asset) {
  if (!asset || !asset.verificationHash) return false;

  const expected = signVerificationHash({
    documentId: asset.documentId,
    qrCodeId: asset.qrCodeId,
    issuedAt: asset.issuedAt,
    expiresAt: asset.expiresAt,
  });

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(asset.verificationHash, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -- Expiry policy ---------------------------------------------------------

/**
 * Resolve when this QR stops being valid.
 *
 * Squad A document expiry wins when present - a certificate valid until 2027
 * must not carry a QR that dies tomorrow. When their expiryDate is null (their
 * column is nullable) we fall back to a bounded default rather than issuing a
 * token that is valid forever.
 */
function resolveExpiry({ issuedAt, expiryDate }) {
  if (expiryDate) return expiryDate;
  return new Date(
    issuedAt.getTime() + qrConfig.defaultExpiryHours * 60 * 60 * 1000
  );
}

// -- URL building ----------------------------------------------------------

/**
 * The deep link encoded into the QR image: Frontend Squad A portal, not our
 * API. A person scanning a certificate must land on a readable result page.
 */
function buildVerificationUrl(qrCodeId) {
  return `${qrConfig.verificationBaseUrl}/${qrCodeId}`;
}

/** Absolute, remotely-fetchable URL for the rendered PNG. */
function buildQrImageUrl(qrCodeId) {
  return `${qrConfig.publicBaseUrl}/api/qr/image/${qrCodeId}.png`;
}

// -- Image rendering -------------------------------------------------------

const QR_RENDER_OPTIONS = {
  errorCorrectionLevel: qrConfig.errorCorrectionLevel,
  width: qrConfig.width,
  margin: 2,
  color: { dark: "#000000", light: "#FFFFFF" },
};

/**
 * Guard every filesystem path built from caller-supplied input.
 *
 * qrCodeId arrives from a URL parameter on the public image route, so it is
 * checked against the UUID pattern before it is ever joined onto a path.
 */
function assertSafeQrCodeId(qrCodeId) {
  if (typeof qrCodeId !== "string" || !UUID_PATTERN.test(qrCodeId)) {
    throw new NotFoundError();
  }
}

function cachePathFor(qrCodeId) {
  assertSafeQrCodeId(qrCodeId);
  return path.join(path.resolve(qrConfig.outputDir), `${qrCodeId}.png`);
}

/**
 * Render the QR PNG and write it to the local cache.
 *
 * Rendering is deterministic for a given verification URL, so the file on disk
 * is a cache and never the source of truth. A failed write is logged and
 * swallowed: the record is still valid and the image route will re-render on
 * the next request.
 *
 * @returns {Promise<{ buffer: Buffer, filePath: string|null }>}
 */
async function renderQrPng(verificationUrl, qrCodeId) {
  const buffer = await QRCode.toBuffer(verificationUrl, QR_RENDER_OPTIONS);

  let filePath = null;
  try {
    const outputDir = path.resolve(qrConfig.outputDir);
    await fsp.mkdir(outputDir, { recursive: true });
    filePath = cachePathFor(qrCodeId);
    await fsp.writeFile(filePath, buffer);
  } catch (err) {
    filePath = null;
    logger.warn("QR image cache write failed; will render on demand", {
      qrCodeFp: logger.fingerprint(qrCodeId),
      reason: err.message,
    });
  }

  return { buffer, filePath };
}

/**
 * Fetch the PNG bytes for an already-issued QR, for the public image route.
 *
 * Serves from the disk cache when present and re-renders from the stored
 * verification URL when it is not - so a wiped generated/ directory, an
 * ephemeral container filesystem or a fresh deploy degrades to a slower
 * response rather than a broken image.
 *
 * @returns {Promise<Buffer>}
 * @throws {NotFoundError} when no QR was ever issued for this id
 */
async function getQrImageBuffer(qrCodeId) {
  assertSafeQrCodeId(qrCodeId);

  const asset = await QRAsset.findByQrCodeId(qrCodeId);
  if (!asset) throw new NotFoundError();

  const filePath = cachePathFor(qrCodeId);
  try {
    return await fsp.readFile(filePath);
  } catch {
    logger.info("QR image cache miss; re-rendering", {
      qrCodeFp: logger.fingerprint(qrCodeId),
    });
    const { buffer } = await renderQrPng(asset.verificationUrl, qrCodeId);
    return buffer;
  }
}

// -- Generation ------------------------------------------------------------

function conflictForMismatch(existing, requestedQrCodeId) {
  return new ConflictError(
    "This documentId was already issued a QR code with a different qrCodeId.",
    {
      field: "qrCodeId",
      documentId: existing.documentId,
      issuedQrCodeId: existing.qrCodeId,
      requestedQrCodeId,
    }
  );
}

/**
 * Generate - or return the already-generated - QR for one of Squad A documents.
 *
 * Idempotent on documentId. A retried webhook, a duplicate queue delivery or
 * two concurrent calls all converge on a single QR asset: the first call
 * creates it, every later call gets that same record back with
 * idempotent: true. The guarantee rests on a UNIQUE constraint in Postgres
 * rather than on a read-then-write check, which two concurrent requests would
 * both pass.
 *
 * The one case we refuse rather than absorb: the same documentId arriving with
 * a different qrCodeId. Silently returning the stored QR would hand Squad A a
 * code that does not match what their database now says.
 *
 * @param {Object} payload - see docs/qr-payload-spec.md
 * @returns {Promise<{ asset: Object, idempotent: boolean }>}
 * @throws {ValidationError|ConflictError}
 */
async function createVerificationQR(payload) {
  const input = validateQrPayload(payload);
  const { documentId, qrCodeId } = input;

  // Fast path: already issued. Cheap, and covers the overwhelming majority of
  // duplicate triggers without touching the QR renderer.
  const existing = await QRAsset.findByDocumentId(documentId);
  if (existing) {
    if (existing.qrCodeId !== qrCodeId) {
      throw conflictForMismatch(existing, qrCodeId);
    }
    logger.info("QR generation skipped; already issued", {
      documentId,
      idempotent: true,
    });
    return { asset: existing, idempotent: true };
  }

  const issuedAt = input.issuanceDate ?? new Date();
  const expiresAt = resolveExpiry({ issuedAt, expiryDate: input.expiryDate });
  const verificationUrl = buildVerificationUrl(qrCodeId);
  const verificationHash = signVerificationHash({
    documentId,
    qrCodeId,
    issuedAt,
    expiresAt,
  });

  const { filePath } = await renderQrPng(verificationUrl, qrCodeId);

  try {
    const asset = await QRAsset.insert({
      documentId,
      qrCodeId,
      verificationHash,
      documentType: input.documentType,
      title: input.title,
      referenceNumber: input.referenceNumber,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail,
      issuedAt,
      expiresAt,
      qrCodePath: filePath,
      verificationUrl,
      status: "active",
      metadata: input.metadata,
    });

    logger.info("QR generated", {
      documentId,
      qrCodeFp: logger.fingerprint(qrCodeId),
      expiresAt: expiresAt.toISOString(),
    });

    return { asset, idempotent: false };
  } catch (err) {
    const field = QRAsset.uniqueViolationField(err);

    // Lost a race against a concurrent identical request. The winner record is
    // the canonical one; return it and report the call as idempotent.
    if (field === "documentId") {
      const winner = await QRAsset.findByDocumentId(documentId);
      if (winner) {
        if (winner.qrCodeId !== qrCodeId) {
          throw conflictForMismatch(winner, qrCodeId);
        }
        logger.info("QR generation raced; returning stored record", {
          documentId,
          idempotent: true,
        });
        return { asset: winner, idempotent: true };
      }
    }

    // A different document already owns this qrCodeId - genuinely bad input.
    if (field === "qrCodeId") {
      throw new ConflictError(
        "This qrCodeId is already bound to a different documentId.",
        { field: "qrCodeId", requestedDocumentId: documentId }
      );
    }

    throw err;
  }
}

/**
 * Look up an issued QR by its public token.
 * @returns {Promise<Object>} the QRAsset
 * @throws {NotFoundError}
 */
async function findByQrCodeId(qrCodeId) {
  assertSafeQrCodeId(qrCodeId);
  const asset = await QRAsset.findByQrCodeId(qrCodeId);
  if (!asset) throw new NotFoundError();
  return asset;
}

module.exports = {
  createVerificationQR,
  findByQrCodeId,
  getQrImageBuffer,
  signVerificationHash,
  verifyVerificationHash,
  buildVerificationUrl,
  buildQrImageUrl,
  resolveExpiry,
  renderQrPng,
  HASH_SCHEME,
};
