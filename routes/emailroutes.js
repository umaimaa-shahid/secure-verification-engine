
const express = require("express");
const router = express.Router();
const {
  sendAssetEmail,
  sendNotificationEmail,
  handleWebhook,
} = require("../controllers/emailcontroller");

// POST /api/email/send
router.post("/send", sendAssetEmail);

// POST /api/email/notify
router.post("/notify", sendNotificationEmail);

// POST /api/email/webhook
router.post("/webhook", handleWebhook);

module.exports = router;
