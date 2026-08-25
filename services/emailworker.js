const EmailLog = require("../models/emaillog");
const { sendEmail } = require("./emailservices");

const MAX_ATTEMPTS = 3;
const WORKER_INTERVAL_MS = 5000;

let workerInterval = null;
let isRunning = false;

async function processQueuedEmails() {
  if (isRunning) return;

  isRunning = true;

  try {
    const now = new Date();

    // Get one email ready to be sent
    const email = await EmailLog.findOne({
      status: "queued",
      $or: [
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: now } },
      ],
    }).sort({ createdAt: 1 });

    if (!email) {
      return;
    }

    console.log(
      `Processing queued email: ${email._id} → ${email.recipient}`
    );

    // Attempt the SMTP send
    const result = await sendEmail({
      to: email.recipient,
      subject: email.subject,
      html: email.html,
    });

    if (result.success) {
      await EmailLog.findByIdAndUpdate(email._id, {
        $set: {
          status: "sent",
          messageId: result.messageId,
          sentAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
          error: null,
        },
      });

      console.log(
        `Queued email sent successfully: ${email.recipient}`
      );

      return;
    }

    // SMTP failed
    const attempts = (email.attempts || 0) + 1;
    const errorMessage = result.error || "Unknown SMTP error";

    if (attempts >= MAX_ATTEMPTS) {
      await EmailLog.findByIdAndUpdate(email._id, {
        $set: {
          status: "failed",
          attempts,
          error: errorMessage,
          lastError: errorMessage,
          nextAttemptAt: null,
        },
      });

      console.error(
        `Email permanently failed after ${attempts} attempts: ${email.recipient}`
      );

      return;
    }

    // Exponential backoff:
    // attempt 1 → 10 seconds
    // attempt 2 → 30 seconds
    const delay =
      attempts === 1
        ? 10 * 1000
        : 30 * 1000;

    const nextAttemptAt = new Date(Date.now() + delay);

    await EmailLog.findByIdAndUpdate(email._id, {
      $set: {
        status: "queued",
        attempts,
        error: errorMessage,
        lastError: errorMessage,
        nextAttemptAt,
      },
    });

    console.warn(
      `mail send failed. Retry ${attempts + 1}/${MAX_ATTEMPTS} scheduled for ${nextAttemptAt.toISOString()}`
    );
  } catch (err) {
    console.error("Email worker error:", err.message);
  } finally {
    isRunning = false;
  }
}

function startEmailWorker() {
  if (workerInterval) {
    console.log("Email worker already running");
    return;
  }

  console.log(" Email queue worker started");

  // Process immediately
  processQueuedEmails();

  // Then check every 5 seconds
  workerInterval = setInterval(() => {
    processQueuedEmails();
  }, WORKER_INTERVAL_MS);
}

function stopEmailWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }

  console.log(" Email queue worker stopped");
}

module.exports = {
  startEmailWorker,
  stopEmailWorker,
};