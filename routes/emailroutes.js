const express = require("express");
const router = express.Router();
const { sendAssetEmail, handleWebhook } = require("../controllers/emailcontroller");

function verifyWebhookSecret(req, res, next) {
  const secret = req.headers["x-webhook-secret"];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// POST /api/email/send
router.post("/send", sendAssetEmail);

// POST /api/email/webhook
router.post("/webhook", verifyWebhookSecret, handleWebhook);

module.exports = router;
