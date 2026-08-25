const { defineConfig } = require("@playwright/test");

const { BASE_URL } = require("./tests/support/testEnv");

/**
 * Playwright configuration for the QR generation service.
 *
 * No browser is ever launched. Playwright is used as the test runner, an HTTP
 * client, and a process supervisor, so that the in-process service specs and the
 * over-the-wire API specs can share one suite instead of needing two frameworks.
 *
 * globalSetup owns the whole startup sequence: a throwaway PostgreSQL, the
 * committed migrations applied to it, then the API server booted against it.
 * Playwright's `webServer` option cannot be used, because it waits for the
 * server to be healthy before running globalSetup and the two would deadlock —
 * see tests/support/testApi.js.
 */
module.exports = defineConfig({
  testDir: "./tests/e2e",

  globalSetup: require.resolve("./tests/support/globalSetup"),
  globalTeardown: require.resolve("./tests/support/globalTeardown"),

  // The suite shares one database and one server. Concurrency is exercised
  // deliberately inside the idempotency specs; letting Playwright add its own on
  // top would make a failure hard to attribute.
  fullyParallel: false,
  workers: 1,

  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Fail the run if a .only was committed by accident.
  forbidOnly: !!process.env.CI,
  retries: 0,

  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: { "Content-Type": "application/json" },
  },

});
