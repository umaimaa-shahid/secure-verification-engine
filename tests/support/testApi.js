const path = require("path");
const { spawn } = require("child_process");

const { BASE_URL, PORT, TEST_ENV } = require("./testEnv");

/**
 * Lifecycle for the API server the over-the-wire specs drive.
 *
 * Playwright's own `webServer` option cannot be used here. It waits for the
 * server's health URL to respond *before* running globalSetup — but the server
 * cannot start until globalSetup has created and migrated the database, so the
 * two deadlock. Owning the ordering explicitly is the fix: globalSetup brings up
 * the database, then this starts the server against it.
 *
 * Still a real child process rather than an in-process app, so the specs
 * exercise the same startup path production uses.
 */

let child = null;

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`Test API server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet — keep waiting.
    }

    if (Date.now() > deadline) {
      throw new Error(`Test API server did not become healthy within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startTestApi() {
  child = spawn(
    process.execPath,
    [path.join(__dirname, "testServer.js")],
    {
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, ...TEST_ENV, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // Surface the server's output when a run fails, without interleaving it into
  // the reporter on a healthy run.
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth();
  } catch (err) {
    console.error(output.join(""));
    throw err;
  }
}

async function stopTestApi() {
  if (!child) return;
  child.kill();
  child = null;
}

module.exports = { startTestApi, stopTestApi };
