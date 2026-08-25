/**
 * CLI wrapper around the QR generation service.
 *
 * Same code path as POST /api/internal/qr/generate - including validation and
 * the idempotency guard - so anything proven here holds over HTTP too.
 *
 * Usage:
 *   node scripts/generateQR.js --documentId <uuid> --qrCodeId <uuid>
 *   node scripts/generateQR.js --documentId <uuid> --qrCodeId <uuid> \
 *     --title "Internship Offer Letter" --recipientEmail jane@example.com
 *
 * Both identifiers are minted by Backend Squad A. For local smoke tests you may
 * omit --qrCodeId and one will be generated, which is fine for checking the
 * pipeline and wrong for anything that has to match their database.
 *
 * Requires DATABASE_URL and QR_HASH_SECRET (see .env.example).
 */

require("dotenv").config();

const { randomUUID } = require("crypto");

const { connectDatabase, disconnectDatabase } = require("../config/db");
const { qrConfig } = require("../config/qr");
const { createVerificationQR } = require("../services/qrService");
const { toReferenceJSON } = require("../models/qrAsset");
const { AppError } = require("../utils/errors");

const TEXT_FLAGS = [
  "documentId",
  "qrCodeId",
  "documentType",
  "title",
  "referenceNumber",
  "recipientName",
  "recipientEmail",
  "issuanceDate",
  "expiryDate",
];

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) parsed[key] = value;
  }
  return parsed;
}

function usage() {
  console.error(`
  Usage:
    node scripts/generateQR.js --documentId <uuid> [--qrCodeId <uuid>] [options]

  Options:
    --documentType     e.g. "Certificate"
    --title            e.g. "Internship Offer Letter"
    --referenceNumber  e.g. "DL-2026-001"
    --recipientName    e.g. "Jane Smith"
    --recipientEmail   e.g. "jane@example.com"
    --issuanceDate     ISO 8601, defaults to now
    --expiryDate       ISO 8601, defaults to QR_EXPIRY_HOURS from now
    --metadata         JSON object string
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.documentId) {
    console.error("\n  Error: --documentId is required.");
    usage();
    process.exit(1);
  }

  if (!args.qrCodeId) {
    args.qrCodeId = randomUUID();
    console.warn(
      `\n  Warning: no --qrCodeId given, generated ${args.qrCodeId} for local testing.` +
        "\n  In the real flow Backend Squad A mints this value and we sign theirs.\n"
    );
  }

  let metadata;
  if (args.metadata) {
    try {
      metadata = JSON.parse(args.metadata);
    } catch {
      console.error("\n  Error: --metadata must be valid JSON.\n");
      process.exit(1);
    }
  }

  const payload = { metadata };
  for (const flag of TEXT_FLAGS) {
    if (args[flag] !== undefined) payload[flag] = args[flag];
  }

  await connectDatabase();

  try {
    const { asset, idempotent } = await createVerificationQR(payload);
    const reference = toReferenceJSON(asset, qrConfig.publicBaseUrl);

    console.log(
      idempotent
        ? "\n  QR code already existed for this document (idempotent hit)."
        : "\n  QR code generated."
    );
    console.log("  ---------------------------------------------------------");
    console.log(`  Document ID:       ${reference.documentId}`);
    console.log(`  QR Code ID:        ${reference.qrCodeId}`);
    console.log(`  Verification URL:  ${reference.verificationUrl}`);
    console.log(`  QR Image URL:      ${reference.qrImageUrl}`);
    console.log(`  Issued At:         ${reference.issuedAt}`);
    console.log(`  Expires At:        ${reference.expiresAt}`);
    console.log(`  Status:            ${reference.status}`);
    console.log("  ---------------------------------------------------------");
    // The verification hash is deliberately not printed. It is the signing
    // output, and a terminal scrollback is not a secure boundary.
    console.log();
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`\n  ${err.code}: ${err.message}`);
      for (const field of err.details?.fields ?? []) {
        console.error(`    - ${field.field}: ${field.message}`);
      }
      console.error();
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error("\n  Fatal error:", err.message, "\n");
  process.exit(1);
});
