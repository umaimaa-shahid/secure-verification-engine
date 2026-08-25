
const { sendEmail, renderTemplate } = require("../services/emailservices");
const EmailLog = require("../models/emaillog");

async function sendAssetEmail(req, res) {
  const { to, name, assetName, assetUrl } = req.body;

  // 1. Validate
  if (!to || !name || !assetName || !assetUrl) {
    return res.status(400).json({
      success: false,
      message: "to, name, assetName, and assetUrl are all required",
    });
  }

  const subject = `Your ${assetName} Is Ready`;

  try {
    // 2. Render template
    const html = renderTemplate("assetDelivery.html", { name, assetName, assetUrl });

    // 3. Send through SMTP
    const result = await sendEmail({ to, subject, html });

    // 4. Save EmailLog
    if (result.success) {
      await EmailLog.create({
        recipient: to,
        subject,
        status: "sent",
        messageId: result.messageId,
      });

      // 5. Respond
      return res.status(200).json({
        success: true,
        message: "Email sent successfully",
        messageId: result.messageId,
      });
    } else {
      await EmailLog.create({
        recipient: to,
        subject,
        status: "failed",
        error: result.error,
      });

      console.error("SMTP Send Failure:", result.error);
      return res.status(500).json({
        success: false,
        message: "Email failed to send. Please try again later.",
      });
    }
  } catch (err) {
    // Catches template read errors, DB errors, etc.
    await EmailLog.create({
      recipient: to,
      subject,
      status: "failed",
      error: err.message,
    }).catch(() => {}); // don't let a logging failure crash the response

    console.error("SMTP Send Failure:", err.message);
    
  return res.status(500).json({
    success: false,
    message: "Something went wrong. Please try again later.",
});
  }
}


async function handleWebhook(req, res) {
  const { messageId, event } = req.body; // e.g. event: "delivered" | "bounced" | "failed"

  if (!messageId || !event) {
    return res.status(400).json({ success: false, message: "messageId and event are required" });
  }

  const statusMap = {
    delivered: "delivered",
    bounced: "bounced",
    failed: "failed",
  };

  const status = statusMap[event];
  if (!status) {
    return res.status(400).json({ success: false, message: "Unsupported event" });
  }

  try {
    const updated = await EmailLog.findOneAndUpdate(
      { messageId },
      { status },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "No matching EmailLog found" });
    }

    return res.status(200).json({ success: true, message: "EmailLog updated", data: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to update EmailLog" });
  }
}
async function sendNotificationEmail(req, res) {
  const { recipientEmail, document, timestamp } = req.body;

  // Validate Squad A payload
  if (
    !recipientEmail ||
    !document ||
    !document.id ||
    !document.title ||
    !document.referenceNumber ||
    !document.qrCodeUrl ||
    !timestamp
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid notification payload",
    });
  }

  const {
    id: documentId,
    title,
    referenceNumber,
    qrCodeUrl,
  } = document;

  const subject = `Your ${title} Is Ready`;

  try {
    
    const existingEmail = await EmailLog.findOne({
      documentId,
      recipient: recipientEmail,
      status: {
        $in: ["queued", "sent", "delivered"],
      },
    });

    if (existingEmail) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "Notification already processed",
        messageId: existingEmail.messageId || null,
      });
    }

    const html = renderTemplate("assetDelivery.html", {
      name: recipientEmail,
      assetName: title,
      assetUrl: qrCodeUrl,
      referenceNumber,
    });

    
    const queuedEmail = await EmailLog.create({
      recipient: recipientEmail,
      subject,
      status: "queued",
      documentId,
      referenceNumber,
      sentAt: null,
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,

      
      html,
    });

    return res.status(200).json({
      success: true,
      duplicate: false,
      message: "Notification email queued successfully",
      queueId: queuedEmail._id,
    });
  } catch (err) {
    console.error("Notification queue error:", err.message);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while queuing notification email",
    });
  }
}
module.exports = {
  sendAssetEmail,
  sendNotificationEmail,
  handleWebhook,
};