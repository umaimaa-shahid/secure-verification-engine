require("dotenv").config();

const { createApp } = require("./app");
const { qrConfig } = require("./config/qr");
const { connectDatabase, disconnectDatabase } = require("./config/db");
const logger = require("./utils/logger");

/**
 * Process entry point.
 *
 * Order matters: the database (and its unique indexes) must be ready before the
 * first request can be accepted, otherwise the idempotency guard is not yet in
 * force. See config/db.js.
 */
async function start() {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(qrConfig.port, () => {
    logger.info("QR generation service listening", {
      port: qrConfig.port,
      publicBaseUrl: qrConfig.publicBaseUrl,
    });
  });

  /**
   * Stop accepting new connections, let in-flight requests finish, then close
   * the database. A hard exit here would drop a request mid-generation and
   * leave Squad A without the response to a call we already acted on.
   */
  async function shutdown(signal) {
    logger.info("Shutting down", { signal });
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });

    // Backstop: if a connection refuses to drain, do not hang the deploy.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 10000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error("Failed to start QR generation service", { reason: err.message });
  process.exit(1);
});
