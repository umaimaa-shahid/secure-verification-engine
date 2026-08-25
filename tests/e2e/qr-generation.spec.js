const { test, expect } = require("@playwright/test");

const {
  startTestDatabase,
  stopTestDatabase,
  truncateQrAssets,
} = require("../support/db");
const { newDocumentPayload } = require("../support/fixtures");

const { createVerificationQR } = require("../../services/qrService");
const { qrConfig } = require("../../config/qr");
const QRAsset = require("../../models/qrAsset");

/**
 * Payload validation and the generation contract.
 *
 * Validation lives in the service rather than in HTTP middleware, so these
 * properties hold for the CLI and for any future queue consumer, not only for
 * the HTTP API. The API-level counterparts live in tests/e2e/api/.
 */

test.beforeAll(async () => {
  await startTestDatabase();
  await truncateQrAssets();
});

test.afterAll(async () => {
  await stopTestDatabase();
});

async function expectRejection(payload) {
  let error = null;
  try {
    await createVerificationQR(payload);
  } catch (err) {
    error = err;
  }
  expect(error, "expected the payload to be rejected").not.toBeNull();
  return error;
}

test.describe("Validation", () => {
  test("reports every missing required field at once", async () => {
    const error = await expectRejection({ title: "No identifiers at all" });

    expect(error.code).toBe("VALIDATION_INVALID_INPUT");
    expect(error.status).toBe(422);

    // One round trip should tell the caller about both problems, not just the
    // first one we happened to hit.
    const failedFields = error.details.fields.map((f) => f.field);
    expect(failedFields).toContain("documentId");
    expect(failedFields).toContain("qrCodeId");
  });

  test("rejects identifiers that are not UUIDs", async () => {
    const error = await expectRejection(
      newDocumentPayload({ documentId: "doc-42" })
    );

    expect(error.details.fields).toContainEqual(
      expect.objectContaining({ field: "documentId" })
    );
  });

  test("rejects an expiry date in the past", async () => {
    // A QR that is born expired is a caller bug, not a state worth persisting.
    const error = await expectRejection(
      newDocumentPayload({ expiryDate: "2020-01-01T00:00:00Z" })
    );

    expect(error.details.fields).toContainEqual(
      expect.objectContaining({ field: "expiryDate" })
    );
  });

  test("rejects a malformed recipient email", async () => {
    const error = await expectRejection(
      newDocumentPayload({ recipientEmail: "not-an-email" })
    );

    expect(error.details.fields).toContainEqual(
      expect.objectContaining({ field: "recipientEmail" })
    );
  });

  test("rejects oversized metadata", async () => {
    const error = await expectRejection(
      newDocumentPayload({ metadata: { blob: "x".repeat(9000) } })
    );

    expect(error.details.fields).toContainEqual(
      expect.objectContaining({ field: "metadata" })
    );
  });

  test("ignores unknown fields instead of rejecting them", async () => {
    // Squad A's document model is still moving; a new column on their side must
    // not start failing generation on ours.
    const { asset } = await createVerificationQR(
      newDocumentPayload({ somethingSquadAAddedLater: "value" })
    );

    expect(asset.status).toBe("active");
  });

  test("persists nothing when validation fails", async () => {
    // The brief is explicit that incomplete asset data must be refused BEFORE
    // anything is signed - a signed partial payload is a token that looks
    // authentic and is not.
    const payload = newDocumentPayload({ recipientEmail: "broken" });

    await expectRejection(payload);

    expect(await QRAsset.countByDocumentId(payload.documentId)).toBe(0);
  });
});

test.describe("Generation contract", () => {
  test("binds the record to Squad A's identifiers", async () => {
    const payload = newDocumentPayload();
    const { asset, idempotent } = await createVerificationQR(payload);

    expect(idempotent).toBe(false);
    expect(asset.documentId).toBe(payload.documentId);
    expect(asset.qrCodeId).toBe(payload.qrCodeId);
  });

  test("encodes a deep link to the portal, not to this service", async () => {
    const payload = newDocumentPayload();
    const { asset } = await createVerificationQR(payload);

    // A person scanning a printed certificate must land on a readable page.
    expect(asset.verificationUrl).toBe(
      `${qrConfig.verificationBaseUrl}/${payload.qrCodeId}`
    );
  });

  test("writes a PNG to the cache directory", async () => {
    const payload = newDocumentPayload();
    const { asset } = await createVerificationQR(payload);

    expect(asset.qrCodePath).toContain(`${payload.qrCodeId}.png`);
  });

  test("honours Squad A's expiry date over our default", async () => {
    const expiryDate = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const { asset } = await createVerificationQR(
      newDocumentPayload({ expiryDate: expiryDate.toISOString() })
    );

    expect(asset.expiresAt.getTime()).toBe(expiryDate.getTime());
  });

  test("falls back to the bounded default when no expiry is supplied", async () => {
    const { asset } = await createVerificationQR(newDocumentPayload());

    const expected =
      asset.issuedAt.getTime() + qrConfig.defaultExpiryHours * 3600 * 1000;
    expect(asset.expiresAt.getTime()).toBe(expected);
  });

  test("keeps the signature out of the reference shape", async () => {
    const { asset } = await createVerificationQR(newDocumentPayload());
    const reference = QRAsset.toReferenceJSON(asset, qrConfig.publicBaseUrl);

    expect(reference).not.toHaveProperty("verificationHash");
    expect(reference).not.toHaveProperty("qrCodePath");
    expect(reference).not.toHaveProperty("recipientEmail");

    // The caller gets a URL it can fetch, never a path inside our container.
    expect(reference.qrImageUrl).toBe(
      `${qrConfig.publicBaseUrl}/api/qr/image/${asset.qrCodeId}.png`
    );
  });

  test("reports an elapsed expiry as expired without a sweeper job", async () => {
    const payload = newDocumentPayload();
    const { asset } = await createVerificationQR(payload);

    // Expiry is derived from the clock on read, so a row does not go stale
    // waiting for a background job to notice.
    asset.expiresAt = new Date(Date.now() - 1000);
    expect(QRAsset.effectiveStatus(asset)).toBe("expired");

    // Revocation is the more important fact, so it survives expiry.
    asset.status = "revoked";
    expect(QRAsset.effectiveStatus(asset)).toBe("revoked");
  });
});
