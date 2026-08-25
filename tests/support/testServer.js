const { waitForDatabaseUrl } = require("./testDatabase");
const { applyToProcess, PORT } = require("./testEnv");

/**
 * Boots the API for the over-the-wire specs, against the same throwaway
 * PostgreSQL that globalSetup started and migrated.
 *
 * Nothing here reaches the shared Supabase project, so a test run cannot collide
 * with a teammate or leave rows behind.
 *
 * Note the deliberate ordering. Playwright launches this process BEFORE it runs
 * globalSetup, so the database may not exist yet — hence the wait, and hence the
 * lazy requires inside main(). config/qr.js validates DATABASE_URL at module
 * load, so nothing that reaches it may be required at the top of this file.
 */
async function main() {
  await waitForDatabaseUrl();
  applyToProcess();

  const {
    connectDatabase,
    disconnectDatabase,
  } = require("../../config/db");
  const { createApp } = require("../../app");

  await connectDatabase(process.env.DATABASE_URL);

  const server = createApp().listen(PORT, "127.0.0.1", () => {
    // Plain console rather than the JSON logger: Playwright surfaces this when a
    // run fails to start, and a readable line saves a round of guessing.
    console.log(`[test-server] listening on http://127.0.0.1:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[test-server] failed to start:", err);
  process.exit(1);
});
