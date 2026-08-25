const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Test database lifecycle, shared by Playwright's globalSetup and globalTeardown.
 *
 * The real database is a shared Supabase project, which is the wrong thing to
 * point a test suite at: runs would collide between developers, leave rows
 * behind, and depend on the network. So the suite brings its own Postgres.
 *
 * By default that is `embedded-postgres` — a real PostgreSQL server binary run
 * from a temp directory, no Docker required. It is the closest analogue to the
 * mongodb-memory-server this replaced, and it means `npm test` works on a fresh
 * clone with nothing installed.
 *
 * Set TEST_DATABASE_URL to use an existing Postgres instead (a local install, a
 * Supabase branch, or CI's service container). The suite then creates and drops
 * its own throwaway schema inside it rather than starting a server.
 */

const STATE_FILE = path.join(__dirname, "..", ".tmp", "test-db.json");
const TEST_SCHEMA = "voyager_test";
const EMBEDDED_PORT = Number(process.env.TEST_PG_PORT) || 55433;

let embedded = null;

function withSchema(baseUrl, schema) {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

/**
 * Apply the committed migrations to the throwaway database.
 *
 * `migrate deploy` rather than `db push`, so every run exercises the exact SQL
 * that will run against Supabase. A hand-written fixture could drift from the
 * schema, and `db push` would paper over a migration that is missing or wrong.
 */
function pushSchema(databaseUrl) {
  const projectRoot = path.join(__dirname, "..", "..");

  // Invoke Prisma's JS entrypoint with this Node binary rather than shelling out
  // to `npx`. Node 22+ on Windows refuses to spawn a .cmd shim without
  // shell: true (EINVAL), and enabling a shell to work around that would mean
  // interpolating a credential-bearing URL through a command line.
  const prismaCli = require.resolve("prisma/build/index.js", {
    paths: [projectRoot],
  });

  execFileSync(
    process.execPath,
    [prismaCli, "migrate", "deploy"],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    }
  );
}

async function startTestDatabase() {
  let databaseUrl;

  if (process.env.TEST_DATABASE_URL) {
    databaseUrl = withSchema(process.env.TEST_DATABASE_URL, TEST_SCHEMA);
  } else {
    const mod = require("embedded-postgres");
    const EmbeddedPostgres = mod.default || mod;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "voyager-pg-"));
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "postgres",
      port: EMBEDDED_PORT,
      persistent: false,
    });

    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("voyager_test");

    databaseUrl = withSchema(
      `postgresql://postgres:postgres@127.0.0.1:${EMBEDDED_PORT}/voyager_test`,
      TEST_SCHEMA
    );
  }

  pushSchema(databaseUrl);

  // Workers are separate processes and cannot inherit a variable set here, so
  // the connection string is handed over on disk.
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ databaseUrl }), "utf8");

  return databaseUrl;
}

async function stopTestDatabase() {
  if (embedded) {
    await embedded.stop();
    embedded = null;
  }
  fs.rmSync(STATE_FILE, { force: true });
}

/** Read the connection string a worker should use. */
function readDatabaseUrl() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).databaseUrl;
}

/**
 * Wait for globalSetup to publish the connection string.
 *
 * Playwright launches `webServer` BEFORE it runs globalSetup, so the API server
 * process starts life without a database to connect to. Rather than reimplement
 * process supervision and readiness polling to control that ordering, the server
 * simply waits here — it has Playwright's full webServer startup budget, and
 * globalSetup publishes within a few seconds.
 *
 * @param {number} timeoutMs
 * @returns {Promise<string>} the connection string
 */
async function waitForDatabaseUrl(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const databaseUrl = readDatabaseUrl();
    if (databaseUrl) return databaseUrl;

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for globalSetup to start the test database.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = {
  startTestDatabase,
  stopTestDatabase,
  readDatabaseUrl,
  waitForDatabaseUrl,
};
