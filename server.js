
require("dotenv").config();

const express = require("express");
const emailRoutes = require("./routes/emailroutes");
const { startListening: startImapListener,
 } = require("./services/imapservices");
const {
  startEmailWorker,
} = require("./services/emailworker");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Email Engine is running" });
});

// Email routes
app.use("/api/email", emailRoutes);

async function start() {
  try {
    const prisma = require("./lib/prisma");
    await prisma.$connect();
    console.log("Prisma configured for Supabase PostgreSQL");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
    // Start email queue worker
    startEmailWorker();
  
    if (process.env.ENABLE_IMAP === "true") {
      startImapListener().catch((err) => {
        console.error("Failed to start IMAP listener:", err.message);
      });
    }
  } catch (err) {
    console.error("Failed to connect to Supabase PostgreSQL:", err.message);
    process.exit(1);
  }
}

start();
