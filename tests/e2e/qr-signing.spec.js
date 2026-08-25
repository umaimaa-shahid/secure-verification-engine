const { randomUUID } = require("crypto");
const { test, expect } = require("@playwright/test");

const { applyToProcess } = require("../support/testEnv");

// config/qr.js validates the environment at module load, so this has to run
// before the service is pulled in.
applyToProcess();

const {
  signVerificationHash,
  verifyVerificationHash,
  resolveExpiry,
  buildVerificationUrl,
} = require("../../services/qrService");
const { qrConfig } = require("../../config/qr");

/**
 * Signing behaviour, exercised in-process rather than over HTTP.
 *
 * The hash never crosses the wire, so these properties are not observable from
 * an API test - and they are the properties the whole scheme rests on.
 */

function binding(overrides = {}) {
  const issuedAt = new Date("2026-08-20T10:00:00.000Z");
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    qrCodeId: "22222222-2222-4222-8222-222222222222",
    issuedAt,
    expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    ...overrides,
  };
}

test.describe("Verification hash", () => {
  test("is deterministic for the same binding", async () => {
    // Determinism is what lets a stored record be re-verified later, and what
    // makes the idempotency guard checkable rather than merely asserted.
    expect(signVerificationHash(binding())).toBe(
      signVerificationHash(binding())
    );
  });

  test("is a 64-character SHA-256 hex digest", async () => {
    expect(signVerificationHash(binding())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when any bound field changes", async () => {
    const base = signVerificationHash(binding());

    const variants = [
      binding({ documentId: randomUUID() }),
      binding({ qrCodeId: randomUUID() }),
      binding({ issuedAt: new Date("2026-08-20T10:00:01.000Z") }),
      binding({ expiresAt: new Date("2027-01-01T00:00:00.000Z") }),
    ];

    for (const variant of variants) {
      expect(signVerificationHash(variant)).not.toBe(base);
    }
  });

  test("verifies a record that has not been touched", async () => {
    const asset = binding();
    asset.verificationHash = signVerificationHash(asset);

    expect(verifyVerificationHash(asset)).toBe(true);
  });

  test("detects tampering with the document binding", async () => {
    const asset = binding();
    asset.verificationHash = signVerificationHash(asset);

    // Someone edits the row to point the QR at a different document.
    asset.documentId = randomUUID();
    expect(verifyVerificationHash(asset)).toBe(false);
  });

  test("detects an extended expiry", async () => {
    const asset = binding();
    asset.verificationHash = signVerificationHash(asset);

    // Expiry is inside the signature specifically so it cannot be pushed out
    // without invalidating the record.
    asset.expiresAt = new Date("2099-01-01T00:00:00.000Z");
    expect(verifyVerificationHash(asset)).toBe(false);
  });

  test("rejects a record with no hash at all", async () => {
    expect(verifyVerificationHash(binding())).toBe(false);
    expect(verifyVerificationHash(null)).toBe(false);
  });
});

test.describe("Expiry policy", () => {
  test("uses Squad A's expiry date when they supply one", async () => {
    const expiryDate = new Date("2027-06-01T00:00:00.000Z");

    expect(
      resolveExpiry({ issuedAt: new Date("2026-08-20T00:00:00.000Z"), expiryDate })
    ).toEqual(expiryDate);
  });

  test("falls back to a bounded default when their expiry is null", async () => {
    // Their Document.expiryDate is nullable. A null must not become a token
    // that is valid forever.
    const issuedAt = new Date("2026-08-20T00:00:00.000Z");
    const resolved = resolveExpiry({ issuedAt, expiryDate: null });

    const expectedMs =
      issuedAt.getTime() + qrConfig.defaultExpiryHours * 60 * 60 * 1000;
    expect(resolved.getTime()).toBe(expectedMs);
    expect(resolved.getTime()).toBeGreaterThan(issuedAt.getTime());
  });
});

test.describe("Verification URL", () => {
  test("points at the portal, carrying the qrCodeId as the token", async () => {
    const qrCodeId = randomUUID();

    // Frontend Squad A resolves /verify/[token]; the token is Squad A's
    // qrCodeId, never our internal hash.
    expect(buildVerificationUrl(qrCodeId)).toBe(
      `${qrConfig.verificationBaseUrl}/${qrCodeId}`
    );
  });

  test("never embeds the verification hash", async () => {
    const bound = binding();
    const hash = signVerificationHash(bound);

    expect(buildVerificationUrl(bound.qrCodeId)).not.toContain(hash);
  });
});
