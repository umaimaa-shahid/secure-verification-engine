require("dotenv").config();

/**
 * Configuration for the QR generation service.
 *
 * Two separate base URLs live here and they are NOT interchangeable:
 *
 *   verificationBaseUrl - Frontend Squad A's portal. This is the URL encoded
 *                         into the QR image itself, because a scanning end user
 *                         must land on the human-readable verification page,
 *                         not on our JSON API.
 *   publicBaseUrl       - This service's own public origin. Used to build the
 *                         `qrImageUrl` we hand back so the portal can render the
 *                         PNG remotely instead of reaching for a local file path.
 *
 * Anything secret is read from the environment and never defaulted.
 */

const hashSecret = process.env.QR_HASH_SECRET;
if (!hashSecret) {
  throw new Error(
    "QR_HASH_SECRET is required. Refusing to start with a default signing secret."
  );
}
if (hashSecret.length < 32) {
  throw new Error(
    "QR_HASH_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32"
  );
}

const VALID_ERROR_CORRECTION = ["L", "M", "Q", "H"];
const errorCorrectionLevel = process.env.QR_ERROR_CORRECTION || "M";
if (!VALID_ERROR_CORRECTION.includes(errorCorrectionLevel)) {
  throw new Error(
    `QR_ERROR_CORRECTION must be one of ${VALID_ERROR_CORRECTION.join(", ")} (got "${errorCorrectionLevel}").`
  );
}

const width = Number(process.env.QR_SIZE) || 300;
if (!Number.isInteger(width) || width < 100 || width > 2000) {
  throw new Error(`QR_SIZE must be an integer between 100 and 2000 (got "${process.env.QR_SIZE}").`);
}

/**
 * Fallback token lifetime, in hours, used ONLY when Squad A's document carries
 * no expiryDate of its own. Their Document.expiryDate is nullable, and a
 * certificate that never expires still should not have an unbounded token, so
 * we cap it. Default is one year — deliberately long, because a 24h QR printed
 * onto a certificate would be useless. See docs/qr-payload-spec.md, "Expiry".
 */
const defaultExpiryHours = Number(process.env.QR_EXPIRY_HOURS) || 8760;
if (!Number.isFinite(defaultExpiryHours) || defaultExpiryHours <= 0) {
  throw new Error("QR_EXPIRY_HOURS must be a positive number of hours.");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Point it at the shared Supabase Postgres, including ?schema=voyager"
  );
}
if (!/[?&]schema=/.test(databaseUrl)) {
  // Failing here is far kinder than discovering at migrate time that we have
  // written our tables into Squad A's `public` schema.
  throw new Error(
    "DATABASE_URL must name a schema, e.g. ...?schema=voyager — see .env.example"
  );
}

const stripTrailingSlash = (url) => url.replace(/\/+$/, "");

const qrConfig = {
  // HMAC-SHA256 secret used to sign verification hashes
  hashSecret,

  // Shared secret Backend Squad A presents on the internal API.
  // Undefined is tolerated here (the CLI path does not need it); app.js
  // refuses to boot the HTTP server without it.
  internalApiKey: process.env.INTERNAL_API_KEY,

  defaultExpiryHours,
  errorCorrectionLevel,
  width,

  // Local disk cache for rendered PNGs. Not the source of truth: any missing
  // file is re-rendered on demand from the stored verification URL.
  outputDir: process.env.QR_OUTPUT_DIR || "./generated/qrcodes",

  // Frontend Squad A's verification portal — appended with /<qrCodeId>
  verificationBaseUrl: stripTrailingSlash(
    process.env.VERIFICATION_BASE_URL || "http://localhost:3000/verify"
  ),

  // This service's own origin, used to build absolute image URLs
  publicBaseUrl: stripTrailingSlash(
    process.env.PUBLIC_BASE_URL || "http://localhost:4000"
  ),

  port: Number(process.env.PORT) || 4000,

  /**
   * Supabase Postgres connection string, shared with Backend Squad A.
   *
   * It must carry `?schema=voyager` (or whatever schema this module owns).
   * Prisma writes its `_prisma_migrations` table into the schema named here, so
   * without it our migrations would land in `public` alongside Squad A's and the
   * two squads would overwrite each other's migration history.
   */
  databaseUrl,
};

module.exports = { qrConfig };
