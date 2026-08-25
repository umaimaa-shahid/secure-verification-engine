const { randomUUID } = require("crypto");
const { test, expect } = require("@playwright/test");

const {
  GENERATE_PATH,
  authHeaders,
  newDocumentPayload,
} = require("../../support/fixtures");

/**
 * GET /api/internal/qr/:qrCodeId
 *
 * The lookup Squad A and our own email module use to fetch an issued QR without
 * re-triggering generation.
 */

test.describe("QR reference lookup", () => {
  test("requires the internal API key", async ({ request }) => {
    const payload = newDocumentPayload();
    await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    const response = await request.get(`/api/internal/qr/${payload.qrCodeId}`);

    expect(response.status()).toBe(401);
  });

  test("returns the same reference the generate call handed back", async ({
    request,
  }) => {
    const payload = newDocumentPayload();
    const created = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    const response = await request.get(`/api/internal/qr/${payload.qrCodeId}`, {
      headers: authHeaders(),
    });

    expect(response.status()).toBe(200);
    expect((await response.json()).data).toEqual((await created.json()).data);
  });

  test("withholds the hash, the file path and the recipient", async ({
    request,
  }) => {
    const payload = newDocumentPayload();
    await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    const raw = await (
      await request.get(`/api/internal/qr/${payload.qrCodeId}`, {
        headers: authHeaders(),
      })
    ).text();

    expect(raw).not.toContain("verificationHash");
    expect(raw).not.toContain("qrCodePath");
    // Recipient PII is stored for the email module but is not part of the
    // reference contract, so it must not leak into a lookup response.
    expect(raw).not.toContain(payload.recipientEmail);
  });

  test("returns 404 for an unknown qrCodeId", async ({ request }) => {
    const response = await request.get(`/api/internal/qr/${randomUUID()}`, {
      headers: authHeaders(),
    });

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe("DOCUMENT_QR_NOT_FOUND");
  });

  test("returns 404 rather than an error for a non-UUID id", async ({
    request,
  }) => {
    const response = await request.get("/api/internal/qr/whatever", {
      headers: authHeaders(),
    });

    expect(response.status()).toBe(404);
  });
});

test.describe("Health check", () => {
  test("answers without auth and without touching the database", async ({
    request,
  }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect((await response.json()).success).toBe(true);
  });
});
