const { applyToProcess } = require("./testEnv");

// Must run before config/qr.js is pulled in transitively — it reads and
// validates the environment, DATABASE_URL included, at module load time.
applyToProcess();

const { connectDatabase, disconnectDatabase, getPrisma } = require("../../config/db");

/**
 * Per-worker connection to the throwaway Postgres that globalSetup started.
 *
 * Connects through the production connectDatabase(), not a test-only substitute.
 * If that function were broken the suite would break with it, which is the point:
 * a harness that bypasses the real startup path can pass while production fails.
 */

async function startTestDatabase() {
  await connectDatabase(process.env.DATABASE_URL);
}

async function stopTestDatabase() {
  await disconnectDatabase();
}

/**
 * Empty the table between spec files.
 *
 * Specs mint fresh UUIDs so they do not actually collide, but a clean table
 * makes a failure easier to read and stops one file's rows inflating another
 * file's counts.
 */
async function truncateQrAssets() {
  await getPrisma().qrAsset.deleteMany({});
}

module.exports = { startTestDatabase, stopTestDatabase, truncateQrAssets };
