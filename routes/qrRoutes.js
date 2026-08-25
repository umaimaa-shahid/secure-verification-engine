const express = require("express");

const { getQrImage } = require("../controllers/qrController");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * Public QR routes, mounted at /api/qr.
 *
 * Only the rendered image lives here. Everything that reveals document data or
 * accepts input requires the internal API key - see routes/qrInternalRoutes.js.
 */
const router = express.Router();

// GET /api/qr/image/:qrCodeId.png
router.get("/image/:filename", asyncHandler(getQrImage));

module.exports = router;
