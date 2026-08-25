const crypto = require("crypto");

const { qrConfig } = require("../config/qr");
const logger = require("../utils/logger");
const { UnauthorizedError } = require("../utils/errors");

const HEADER = "x-internal-api-key";

/**
 * Guards the service-to-service routes that Backend Squad A calls.
 *
 * This is a shared-secret check, not user authentication: the caller is another
 * backend, so there is no JWT and no session. Squad A holds the same secret and
 * presents it on every trigger call.
 *
 * The comparison is constant-time. Both sides are hashed first so that
 * timingSafeEqual always receives equal-length buffers - it throws on a length
 * mismatch, and that thrown/not-thrown difference would itself leak the length
 * of the configured key.
 */
function internalAuth(req, _res, next) {
  const provided = req.get(HEADER);

  if (!provided) {
    logger.warn("Internal API call rejected: missing key", { path: req.path });
    return next(new UnauthorizedError(`Missing ${HEADER} header.`));
  }

  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto
    .createHash("sha256")
    .update(qrConfig.internalApiKey)
    .digest();

  if (!crypto.timingSafeEqual(providedDigest, expectedDigest)) {
    // Never log the key itself, not even truncated - a fingerprint is enough to
    // tell "the same wrong key again" from "a new wrong key".
    logger.warn("Internal API call rejected: invalid key", {
      path: req.path,
      presentedFp: logger.fingerprint(provided),
    });
    return next(new UnauthorizedError());
  }

  return next();
}

module.exports = { internalAuth, INTERNAL_AUTH_HEADER: HEADER };
