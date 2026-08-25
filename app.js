const express = require("express");

const { qrConfig } = require("./config/qr");
const qrRoutes = require("./routes/qrRoutes");
const qrInternalRoutes = require("./routes/qrInternalRoutes");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

/**
 * Express application for the Squad Voyager generation service.
 *
 * Exported without calling listen() so tests can mount it directly and
 * server.js stays responsible for process concerns (ports, signals, database
 * connections).
 */
function createApp() {
  // Fail at boot, not on the first authenticated request. A service that starts
  // happily and then rejects every call from Squad A is far harder to diagnose.
  if (!qrConfig.internalApiKey) {
    throw new Error(
      "INTERNAL_API_KEY is required to serve the internal API. Generate one with: openssl rand -hex 32"
    );
  }

  const app = express();

  // Do not advertise the framework version to anyone probing the service.
  app.disable("x-powered-by");

  // 256kb is generous for a document payload whose metadata is capped at 8kb,
  // and small enough that an oversized body is rejected before it is parsed.
  app.use(express.json({ limit: "256kb" }));

  // Liveness probe. No auth and no database round trip on purpose - it answers
  // "is this process up", which is what an orchestrator needs to know.
  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, service: "qr-generation" });
  });

  app.use("/api/qr", qrRoutes);
  app.use("/api/internal/qr", qrInternalRoutes);

  // Extension point: the email notification routes (Voyager task 5.2, "Expose
  // Email Notification API") mount here as app.use("/api/email", emailRoutes).
  // Left unmounted because controllers/emailcontroller.js does not currently
  // parse - see README, "Known issues outside this module".

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
