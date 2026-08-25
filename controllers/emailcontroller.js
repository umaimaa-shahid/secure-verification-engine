
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

module.exports = { sendAssetEmail, handleWebhook };
