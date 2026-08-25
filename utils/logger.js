const crypto = require("crypto");

/**
 * Minimal structured logger with redaction built in.
 *
 * The implementation brief treats logs as an untrusted boundary: verification
 * hashes, qrCodeIds, secrets and full verification URLs must never be written
 * out in the clear. Rather than relying on every call site to remember that,
 * the only way to put a sensitive value into a log line here is `fingerprint()`,
 * which is deliberately one-way.
 *
 * Kept dependency-free on purpose — this module is meant to be liftable into
 * other client projects without dragging a logging framework along.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/**
 * Reduce a secret-ish value to a short, stable, non-reversible tag.
 *
 * Two log lines about the same qrCodeId share a fingerprint, so an operator can
 * still correlate a request across the log, but the fingerprint cannot be turned
 * back into a working token.
 *
 * @param {string|null|undefined} value
 * @returns {string} 12 hex chars, or "-" when there is nothing to fingerprint
 */
function fingerprint(value) {
  if (value === null || value === undefined || value === "") return "-";
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 12);
}

function emit(level, message, context = {}) {
  if (LEVELS[level] > activeLevel) return;

  const line = {
    level,
    time: new Date().toISOString(),
    service: "qr-generation",
    message,
    ...context,
  };

  // error/warn to stderr, everything else to stdout, so container log routing
  // and `2>` redirection behave the way operators expect.
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(JSON.stringify(line));
}

module.exports = {
  fingerprint,
  error: (message, context) => emit("error", message, context),
  warn: (message, context) => emit("warn", message, context),
  info: (message, context) => emit("info", message, context),
  debug: (message, context) => emit("debug", message, context),
};
