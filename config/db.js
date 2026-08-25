const { PrismaClient } = require("@prisma/client");

const { qrConfig } = require("./qr");
const logger = require("./../utils/logger");

/**
 * Database lifecycle for the QR module.
 *
 * Kept separate from app.js so the service can be imported and tested without a
 * server, and so the CLI script shares the exact same connect logic instead of
 * hand-rolling its own.
 *
 * One PrismaClient per process, deliberately. Each instance owns a connection
 * pool; constructing them per request exhausts Postgres connections, which on a
 * shared Supabase project would take Squad A down with us.
 */

let prisma = null;

/**
 * Connect and verify the database is actually reachable.
 *
 * Note what is NOT here: the Mongoose version had to await an index build before
 * serving traffic, because Mongoose creates indexes lazily in the background and
 * the idempotency guarantee depends on the unique index existing. In Postgres a
 * UNIQUE constraint is DDL applied by a migration, so it either exists before the
 * process starts or the migration has not been run. The startup race is gone.
 *
 * @param {string} [url] - overrides the configured URL (used by the test harness)
 */
async function connectDatabase(url = qrConfig.databaseUrl) {
  if (prisma) return prisma;

  prisma = new PrismaClient({
    datasources: { db: { url } },
    // Never "query": Prisma's query log prints bound parameters, which for us
    // includes verification hashes.
    //
    // The error channel is dropped under test because the idempotency guard
    // provokes unique violations on purpose and handles them; Prisma reports
    // every one as an error, which buries real failures in expected noise.
    // Genuine problems still surface as thrown AppErrors and through our own
    // logger. (Same conditional shape Squad A uses in their database.js.)
    log: process.env.NODE_ENV === "test" ? ["warn"] : ["error", "warn"],
  });

  await prisma.$connect();

  // The URL carries credentials and is shared with Squad A; never log it.
  logger.info("Database connected");

  return prisma;
}

async function disconnectDatabase() {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = null;
  logger.info("Database disconnected");
}

/**
 * The active client.
 *
 * Throws rather than lazily connecting: a module reaching for the database
 * before startup has finished is a wiring bug, and silently opening a second
 * pool would hide it.
 */
function getPrisma() {
  if (!prisma) {
    throw new Error(
      "Database not connected. Call connectDatabase() during startup."
    );
  }
  return prisma;
}

module.exports = { connectDatabase, disconnectDatabase, getPrisma };
