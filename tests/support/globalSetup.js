const { startTestDatabase } = require("./testDatabase");
const { startTestApi } = require("./testApi");

/**
 * Runs once before the whole suite, in this order and for this reason:
 *
 *   1. Bring up a throwaway PostgreSQL and apply the committed migrations.
 *   2. Start the API server against it.
 *
 * The API cannot start without the database, which is why Playwright's own
 * `webServer` option is not used — it waits for the server to be healthy before
 * running this file, and the two would deadlock.
 */
module.exports = async () => {
  await startTestDatabase();
  await startTestApi();
};
