const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const { imapConfig } = require("../config/email");
const EmailLog = require("../models/emaillog");
const ImapState = require("../models/imapstate");

const MAX_RECONNECT_ATTEMPTS = 12;
const RECONNECT_BASE_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MESSAGE_PROCESS_TIMEOUT_MS = 30000;
const STALE_SENT_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 20000;
const MAX_IDLE_TIME_MS = 2 * 60 * 1000;
const MAX_UID_ATTEMPTS = 3;

let client = null;
let lastUid = 0;
let reconnectAttempts = 0;
let stopped = false;
let isConnecting = false;
let isProcessing = false;
let reconnectTimer = null;
let pollInterval = null;
let sweepInterval = null;

// Counts consecutive failures per UID across reconnects, so one persistently
// broken message (e.g. a fetch that always times out) can't wedge the
// listener in an endless close/reconnect/retry loop on that single UID.
const uidFailureCounts = new Map();

function maskEmail(email) {
  if (!email) return "(not set)";
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

function normalizeMessageId(messageId) {
  if (!messageId) return null;
  const value = String(messageId).trim();
  if (!value) return null;
  if (value.startsWith("<") && value.endsWith(">")) return value;
  return `<${value}>`;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadState() {
  const state = await ImapState.findOneAndUpdate(
    { key: "bounce-listener" },
    {},
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
  return { lastUid: state?.lastUid || 0, uidValidity: state?.uidValidity || null };
}

async function saveLastUid(uid, uidValidity) {
  const update = { lastUid: uid };
  if (uidValidity !== undefined) update.uidValidity = uidValidity;

  await ImapState.findOneAndUpdate(
    { key: "bounce-listener" },
    { $set: update },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

function isBounceMessage(parsedMail) {
  const from = (parsedMail.from?.value?.[0]?.address || "").toLowerCase();
  const subject = (parsedMail.subject || "").toLowerCase();
  const contentType = (parsedMail.headers?.get("content-type") || "").toString().toLowerCase();

  const fromLooksLikeDaemon = from.includes("mailer-daemon") || from.includes("postmaster");
  const isDeliveryStatus =
    contentType.includes("report-type=delivery-status") || contentType.includes("multipart/report");
  const subjectLooksLikeBounce =
    subject.includes("undelivered mail") ||
    subject.includes("delivery status notification") ||
    subject.includes("mail delivery failed") ||
    subject.includes("returned to sender") ||
    subject.includes("failure notice") ||
    subject.includes("address not found") ||
    subject.includes("delivery incomplete") ||
    subject.includes("delivery failed");

  return fromLooksLikeDaemon || isDeliveryStatus || subjectLooksLikeBounce;
}

async function extractOriginalMessageId(parsedMail) {
  const inReplyTo = parsedMail.headers?.get("in-reply-to");
  if (inReplyTo) {
    const normalized = normalizeMessageId(inReplyTo);
    if (normalized) return normalized;
  }

  const references = parsedMail.headers?.get("references");
  if (references) {
    const matches = String(references).match(/<[^>]+>/g);
    if (matches?.length) return normalizeMessageId(matches[matches.length - 1]);
  }

  const rfc822Part = (parsedMail.attachments || []).find(
    (attachment) =>
      attachment.contentType === "message/rfc822" || attachment.contentType === "text/rfc822-headers"
  );

  if (rfc822Part?.content) {
    try {
      const embedded = await simpleParser(rfc822Part.content);
      if (embedded.messageId) return normalizeMessageId(embedded.messageId);

      const embeddedInReplyTo = embedded.headers?.get("in-reply-to");
      if (embeddedInReplyTo) return normalizeMessageId(embeddedInReplyTo);
    } catch (err) {
      console.warn("Could not parse embedded original message:", err.message);
    }
  }

  const text = parsedMail.text || "";
  let match = text.match(/Message-ID:\s*(<[^>]+>)/i);
  if (match) return normalizeMessageId(match[1]);

  const html = parsedMail.html || "";
  match = html.match(/Message-ID:\s*(<[^>]+>)/i);
  if (match) return normalizeMessageId(match[1]);

  return null;
}

async function recordBounce(originalMessageId) {
  const normalizedId = normalizeMessageId(originalMessageId);

  if (!normalizedId) {
    console.warn("Bounce detected but original Message-ID could not be extracted");
    return false;
  }

  const existing = await EmailLog.findOne({ messageId: normalizedId });

  if (!existing) {
    console.warn(`Bounce received but no EmailLog exists for Message-ID: ${normalizedId}`);
    return false;
  }

  if (existing.status === "bounced") {
    console.log(`Bounce already recorded for Message-ID: ${normalizedId}`);
    return true;
  }

  existing.status = "bounced";
  await existing.save();

  console.log(`EmailLog status changed to bounced for recipient: ${existing.recipient}`);
  return true;
}

// Fetches and parses the full raw message body. This is the expensive path -
// it has stalled indefinitely on some messages in testing (first with
// client.download(), then with fetch(..., {source:true})) - so it's only
// used as a fallback once header-only data isn't enough.
async function fetchFullMessage(uid, currentClient) {
  let rawMessage = null;

  for await (const message of currentClient.fetch(uid, { uid: true, source: true }, { uid: true })) {
    rawMessage = message.source;
    break;
  }

  if (!rawMessage) {
    throw new Error(`No message source received for UID ${uid}`);
  }

  return simpleParser(rawMessage);
}

// -----------------------------------------------------------------------
// Process one IMAP message.
// Fetches headers only first (cheap, fast) to decide if it's a bounce and,
// where possible, extract the original Message-ID from In-Reply-To/References.
// The full body is only fetched when headers alone aren't enough (e.g. the
// original Message-ID is nested in an embedded message/rfc822 attachment) -
// this avoids the large-body fetch, which has been the actual point of
// failure/timeouts, for every non-bounce message and for bounces that carry
// enough info in their headers.
// -----------------------------------------------------------------------
async function processMessage(uid, currentClient) {
  if (!currentClient) {
    throw new Error("IMAP client unavailable");
  }

  try {
    let headerBuffer = null;

    for await (const message of currentClient.fetch(uid, { uid: true, headers: true }, { uid: true })) {
      headerBuffer = message.headers;
      break;
    }

    if (!headerBuffer) {
      throw new Error(`No message headers received for UID ${uid}`);
    }

    const headerOnlyMail = await simpleParser(headerBuffer);

    console.log("IMAP message received:", {
      uid,
      subject: headerOnlyMail.subject,
      from: headerOnlyMail.from?.value?.[0]?.address,
    });

    if (!isBounceMessage(headerOnlyMail)) {
      console.log(`UID ${uid}: Not a bounce`);
      return { processed: true, bounce: false };
    }

    console.log(`UID ${uid}: Bounce message detected`);

    let originalMessageId = await extractOriginalMessageId(headerOnlyMail);

    if (!originalMessageId) {
      console.log(`UID ${uid}: Original Message-ID not in headers, fetching full message body`);
      const parsedMail = await fetchFullMessage(uid, currentClient);
      originalMessageId = await extractOriginalMessageId(parsedMail);
    }

    if (!originalMessageId) {
      console.warn(`UID ${uid}: Bounce detected but original Message-ID was not found`);
      return { processed: true, bounce: true, matched: false };
    }

    console.log(`UID ${uid}: Original Message-ID extracted: ${originalMessageId}`);

    const updated = await recordBounce(originalMessageId);

    return { processed: true, bounce: true, matched: updated };
  } catch (err) {
    console.error(`IMAP message processing failed for UID ${uid}:`, err.message);
    throw err;
  }
}

async function processNewMessages() {
  const currentClient = client;

  if (stopped || isProcessing || !currentClient?.mailbox) {
    return;
  }

  isProcessing = true;

  // Safety valve: if the enumeration fetch below ever hangs (no per-item timeout
  // wraps it, unlike processMessage()), isProcessing would otherwise stay stuck
  // true forever and silently block every future poll/exists trigger with no logs.
  const watchdog = setTimeout(() => {
    console.error("processNewMessages watchdog fired - enumeration fetch appears stuck. Resetting isProcessing.");
    isProcessing = false;
  }, MESSAGE_PROCESS_TIMEOUT_MS * 2);

  try {
    const startUid = lastUid + 1;
    const range = `${startUid}:*`;

    console.log(
      `Polling for new mail: range=${range}, mailbox.exists=${currentClient.mailbox.exists}, lastUid=${lastUid}`
    );

    for await (const message of currentClient.fetch(range, { uid: true }, { uid: true })) {
      const uid = message.uid;

      if (uid <= lastUid) continue;

      if (client !== currentClient) {
        console.warn("IMAP client changed during processing. Stopping old fetch loop.");
        break;
      }

      console.log(`Processing new IMAP UID: ${uid}`);

      try {
        await withTimeout(
          processMessage(uid, currentClient),
          MESSAGE_PROCESS_TIMEOUT_MS,
          `processMessage(uid=${uid})`
        );

        uidFailureCounts.delete(uid);
        lastUid = uid;
        await saveLastUid(uid);

        console.log(`UID ${uid} processed successfully. lastUid=${lastUid}`);
      } catch (err) {
        console.error(`IMAP message processing failed for UID ${uid}:`, err.message);

        const attempts = (uidFailureCounts.get(uid) || 0) + 1;
        uidFailureCounts.set(uid, attempts);

        if (attempts >= MAX_UID_ATTEMPTS) {
          console.error(
            `UID ${uid}: giving up after ${attempts} failed attempts. Skipping this message and moving on.`
          );
          uidFailureCounts.delete(uid);
          lastUid = uid;
          await saveLastUid(uid);
          continue; // keep processing any later UIDs in this same batch
        }

        throw err; // still under the retry limit - abort this batch, retried after reconnect
      }
    }
  } catch (err) {
    console.error("IMAP message processing error:", err.message);
    if (client === currentClient) {
      try {
        currentClient.close();
      } catch {}
    }
  } finally {
    clearTimeout(watchdog);
    isProcessing = false;
  }
}

async function sweepStaleSentEmails() {
  const cutoff = new Date(Date.now() - STALE_SENT_THRESHOLD_MS);
  const result = await EmailLog.updateMany(
    { status: "sent", sentAt: { $lt: cutoff } },
    { $set: { status: "unknown" } }
  );

  if (result.modifiedCount > 0) {
    console.log(`Marked ${result.modifiedCount} stale sent email(s) as unknown`);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function clearSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

async function cleanupConnection() {
  clearPolling();
  clearSweep();

  if (client) {
    const oldClient = client;
    client = null;

    try {
      await oldClient.logout();
    } catch {
      try {
        oldClient.close();
      } catch {}
    }
  }
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;

  reconnectAttempts += 1;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error("IMAP reconnect limit reached. Starting a new retry cycle in 60 seconds.");
    reconnectAttempts = 0;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) scheduleReconnect();
    }, 60 * 1000);

    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1),
    MAX_RECONNECT_DELAY_MS
  );

  console.warn(
    `IMAP disconnected. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
  );

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (stopped) return;

    try {
      await startListening();
    } catch (err) {
      console.error("IMAP reconnect failed:", err.message);
      scheduleReconnect();
    }
  }, delay);
}

async function startListening() {
  if (stopped || isConnecting) return;

  isConnecting = true;

  try {
    clearReconnectTimer();
    await cleanupConnection();

    const newClient = new ImapFlow({
      host: imapConfig.host,
      port: imapConfig.port,
      secure: imapConfig.secure,
      auth: { user: imapConfig.auth.user, pass: imapConfig.auth.pass },
      logger: false,
      // Restarts IDLE every MAX_IDLE_TIME_MS - acts as both a keepalive and a
      // safety-net re-check of the mailbox, on top of the exists event and poll.
      maxIdleTime: MAX_IDLE_TIME_MS,
    });

    client = newClient;
    console.log(`IMAP connecting as ${maskEmail(imapConfig.auth.user)}`);

    newClient.on("error", (err) => {
      console.error("IMAP connection error:", err.message);
    });

    newClient.on("close", () => {
      if (client !== newClient) return;
      if (!stopped) {
        console.warn("IMAP connection closed.");
        client = null;
        scheduleReconnect();
      }
    });

    await newClient.connect();
    if (client !== newClient) return;

    // A held getMailboxLock() lock keeps ImapFlow's connection "busy" for as
    // long as it's open, which permanently blocks its auto-IDLE from ever
    // starting (see imapflow's connectionBusy()/autoidle()) - so the "exists"
    // event below would never fire. mailboxOpen() selects the mailbox without
    // taking a lock, so auto-IDLE can engage normally. A lock isn't needed
    // here anyway since this client is never shared with concurrent callers.
    await newClient.mailboxOpen("INBOX", { readOnly: true });

    // UIDs are only meaningful relative to the mailbox's UIDVALIDITY. If the
    // server ever reassigns it, a saved lastUid from the old validity epoch
    // no longer corresponds to real messages - fetching "oldLastUid+1:*" would
    // then clamp to the (unrelated) current last message and, if its UID
    // happens to be <= oldLastUid, get skipped forever, silently stalling
    // detection with no error. Track uidValidity so we can detect that and
    // reset lastUid instead of resuming against stale numbering.
    const currentUidValidity = String(newClient.mailbox.uidValidity);
    const state = await loadState();
    lastUid = state.lastUid;

    if (lastUid !== 0 && state.uidValidity && state.uidValidity !== currentUidValidity) {
      console.warn(
        `IMAP UIDVALIDITY changed (was ${state.uidValidity}, now ${currentUidValidity}). Resetting lastUid.`
      );
      lastUid = 0;
    }

    if (lastUid === 0) {
      lastUid = newClient.mailbox.uidNext - 1;
      await saveLastUid(lastUid, currentUidValidity);
      console.log(`First run - starting from UID ${lastUid} (uidValidity=${currentUidValidity})`);
    } else {
      if (!state.uidValidity) {
        await saveLastUid(lastUid, currentUidValidity);
      }
      console.log(`Resuming from lastUid ${lastUid} (uidValidity=${currentUidValidity})`);
    }

    await processNewMessages();

    newClient.on("exists", () => {
      if (client !== newClient || stopped) return;
      processNewMessages().catch((err) => {
        console.error("IMAP EXISTS processing error:", err.message);
      });
    });

    pollInterval = setInterval(() => {
      if (!stopped && client === newClient && newClient.mailbox) {
        processNewMessages().catch((err) => {
          console.error("IMAP polling error:", err.message);
        });
      }
    }, POLL_INTERVAL_MS);

    sweepStaleSentEmails().catch((err) => {
      console.error("Initial stale-sent sweep failed:", err.message);
    });

    sweepInterval = setInterval(() => {
      sweepStaleSentEmails().catch((err) => {
        console.error("Stale-sent sweep failed:", err.message);
      });
    }, SWEEP_INTERVAL_MS);

    reconnectAttempts = 0;

    console.log("IMAP bounce listener connected and watching INBOX (read-only)");
  } catch (err) {
    console.error("IMAP connection failed:", err.message);
    await cleanupConnection();
    throw err;
  } finally {
    isConnecting = false;
  }
}

async function stopListening() {
  stopped = true;
  clearReconnectTimer();
  clearPolling();
  clearSweep();
  await cleanupConnection();
}

module.exports = { startListening, stopListening };
