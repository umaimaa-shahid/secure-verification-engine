const express = require("express");

const { generateQr, getQrReference } = require("../controllers/qrController");
const { internalAuth } = require("../middleware/internalAuth");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * Service-to-service QR routes, mounted at /api/internal/qr.
 *
 * Every route here requires the shared internal API key. The guard is applied
 * router-wide rather than per route so a new endpoint cannot be added
 * unauthenticated by omission.
 */
const router = express.Router();

router.use(internalAuth);

// POST /api/internal/qr/generate - Squad A trigger, idempotent on documentId
router.post("/generate", asyncHandler(generateQr));

// GET /api/internal/qr/:qrCodeId - reference lookup
router.get("/:qrCodeId", asyncHandler(getQrReference));

module.exports = router;
