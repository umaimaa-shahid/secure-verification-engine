const path = require("path");

const { readDatabaseUrl } = require("./testDatabase");

/**
 * Single source of truth for the test environment.
 *
 * Read by playwright.config.js (which spawns the server) and by the specs
 * themselves (which need the API key and the QR cache directory), so the two
 * processes cannot drift apart.
 */

const PORT = Number(process.env.TEST_PORT) || 4310;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Fixed rather than random so a failed run leaves inspectable artifacts.
const QR_OUTPUT_DIR = path.join(__dirname, "..", ".tmp", "qrcodes");

/**
 * Test-only values. Real secrets never appear in the repository — these exist
 * purely so the service will boot in CI, and they are long enough to satisfy the
 * 32-character minimum enforced in config/qr.js.
 *
 * DATABASE_URL is deliberately absent: it is not known until globalSetup starts
 * the throwaway Postgres. See applyToProcess below.
 */
const TEST_ENV = {
  NODE_ENV: "test",
  PORT: String(PORT),
  QR_HASH_SECRET: "test-hash-secret-not-for-production-0123456789",
  INTERNAL_API_KEY: "test-internal-api-key-not-for-production-0123",
  QR_OUTPUT_DIR,
  QR_SIZE: "300",
  QR_ERROR_CORRECTION: "M",
  PUBLIC_BASE_URL: BASE_URL,
  VERIFICATION_BASE_URL: "http://localhost:3000/verify",
  LOG_LEVEL: "warn",
};

/**
 * Apply the test environment to the current process.
 *
 * Must run before anything requires config/qr.js, which reads and validates the
 * environment — DATABASE_URL included — at module load.
 *
 * DATABASE_URL comes from the state file globalSetup writes, because the
 * throwaway server's port is not known until it starts and neither the workers
 * nor the spawned API server can inherit a variable set in the runner process.
 *
 * Existing values win, so anything here can be overridden from the shell.
 */
function applyToProcess() {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] ??= value;
  }

  if (!process.env.DATABASE_URL) {
    const databaseUrl = readDatabaseUrl();
    if (!databaseUrl) {
      throw new Error(
        "No test database. globalSetup should have started one — run the suite with `npm test` rather than invoking Playwright directly."
      );
    }
    process.env.DATABASE_URL = databaseUrl;
  }
}

module.exports = { PORT, BASE_URL, QR_OUTPUT_DIR, TEST_ENV, applyToProcess };
