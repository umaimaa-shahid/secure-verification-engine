const { qrConfig } = require("../config/qr");
const qrService = require("../services/qrService");
const { toReferenceJSON } = require("../models/qrAsset");
const { NotFoundError } = require("../utils/errors");

/**
 * HTTP layer for the QR generation service.
 *
 * Thin on purpose: validation, idempotency and signing all live in
 * services/qrService.js so the CLI script and any future queue consumer get the
 * same behaviour. Controllers translate between HTTP and that service, nothing
 * more.
 */

/**
 * POST /api/internal/qr/generate
 *
 * Called by Backend Squad A after a document is created (their Technical
 * Specification section 6.1.1). Idempotent on documentId.
 *
 * 201 - a new QR was generated
 * 200 - this document already had one; the stored record is returned unchanged
 */
async function generateQr(req, res) {
  const { asset, idempotent } = await qrService.createVerificationQR(req.body);

  return res.status(idempotent ? 200 : 201).json({
    success: true,
    // Explicit rather than inferred from the status code, so a caller that only
    // checks res.ok can still tell a fresh issue from a replay.
    idempotent,
    message: idempotent
      ? "QR code already issued for this document."
      : "QR code generated successfully.",
    data: toReferenceJSON(asset, qrConfig.publicBaseUrl),
  });
}

/**
 * GET /api/internal/qr/:qrCodeId
 *
 * Reference lookup for Squad A and for our own email module, which needs the
 * image URL and expiry when composing a delivery message.
 *
 * Public verification stays with Squad A (their POST /verify/qr-code) - they own
 * the document record, so they are the only ones who can answer what a token
 * actually resolves to.
 */
async function getQrReference(req, res) {
  const asset = await qrService.findByQrCodeId(req.params.qrCodeId);

  return res.status(200).json({
    success: true,
    data: toReferenceJSON(asset, qrConfig.publicBaseUrl),
  });
}

/**
 * GET /api/qr/image/:filename
 *
 * Serves the PNG so Frontend Squad A can render it with a plain <img src>
 * instead of needing filesystem access to this container.
 *
 * Public by design. The qrCodeId is an unguessable v4 UUID and the image
 * encodes only the verification URL, which is itself public - the same
 * information a person gets by pointing a phone at the printed code. No
 * signature or internal identifier is reachable through this route.
 */
async function getQrImage(req, res) {
  // Matched as :filename rather than :qrCodeId.png because router path syntax
  // varies on the dot across Express/path-to-regexp versions. Parsing here is
  // stable regardless.
  const { filename } = req.params;
  if (!filename.endsWith(".png")) {
    throw new NotFoundError("QR images are served as .png.");
  }

  const qrCodeId = filename.slice(0, -".png".length);
  const buffer = await qrService.getQrImageBuffer(qrCodeId);

  res.set({
    "Content-Type": "image/png",
    "Content-Length": String(buffer.length),
    // The render is deterministic for a given qrCodeId, so this is safe to
    // cache hard. Revocation is reflected on the verification page, not by
    // changing the image.
    "Cache-Control": "public, max-age=86400, immutable",
    // The image must be embeddable from the verification portal origin.
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  return res.send(buffer);
}

module.exports = { generateQr, getQrReference, getQrImage };
