const { randomUUID } = require("crypto");
const { test, expect } = require("@playwright/test");

const {
  GENERATE_PATH,
  authHeaders,
  newDocumentPayload,
} = require("../../support/fixtures");
const { TEST_ENV } = require("../../support/testEnv");

/**
 * POST /api/internal/qr/generate - authentication, validation and the success
 * contract. Idempotency has its own spec.
 */

test.describe("QR generation - authentication", () => {
  test("rejects a call with no API key", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      data: newDocumentPayload(),
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  test("rejects a call with the wrong API key", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders({ "x-internal-api-key": "not-the-right-key" }),
      data: newDocumentPayload(),
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  test("does not create anything when auth fails", async ({ request }) => {
    const payload = newDocumentPayload();

    await request.post(GENERATE_PATH, { data: payload });

    // The rejected call must not have left a record behind.
    const lookup = await request.get(`/api/internal/qr/${payload.qrCodeId}`, {
      headers: authHeaders(),
    });
    expect(lookup.status()).toBe(404);
  });
});

test.describe("QR generation - validation", () => {
  test("reports every missing required field at once", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: { title: "Missing both identifiers" },
    });

    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_INVALID_INPUT");

    // One round trip should tell the caller about both problems, not just the
    // first one we happened to hit.
    const failedFields = body.error.details.fields.map((f) => f.field);
    expect(failedFields).toContain("documentId");
    expect(failedFields).toContain("qrCodeId");
  });

  test("rejects identifiers that are not UUIDs", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload({ documentId: "doc-42" }),
    });

    expect(response.status()).toBe(422);
    const fields = (await response.json()).error.details.fields;
    expect(fields).toContainEqual(
      expect.objectContaining({ field: "documentId" })
    );
  });

  test("rejects an expiry date in the past", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload({ expiryDate: "2020-01-01T00:00:00Z" }),
    });

    expect(response.status()).toBe(422);
    const fields = (await response.json()).error.details.fields;
    expect(fields).toContainEqual(
      expect.objectContaining({ field: "expiryDate" })
    );
  });

  test("rejects a malformed email address", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload({ recipientEmail: "not-an-email" }),
    });

    expect(response.status()).toBe(422);
  });

  test("rejects a body that is not valid JSON", async ({ request }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: "{ this is not json",
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_INVALID_INPUT");
  });

  test("ignores unknown fields instead of rejecting them", async ({
    request,
  }) => {
    // Squad A's document model is still moving; a new column on their side must
    // not start returning 422s on ours.
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload({ somethingSquadAAddedLater: "value" }),
    });

    expect(response.status()).toBe(201);
  });
});

test.describe("QR generation - success contract", () => {
  test("returns 201 and the full QR reference", async ({ request }) => {
    const payload = newDocumentPayload();
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    expect(response.status()).toBe(201);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.data).toMatchObject({
      documentId: payload.documentId,
      qrCodeId: payload.qrCodeId,
      status: "active",
    });

    // The QR must deep-link to Frontend Squad A's portal, not to our own API -
    // a person scanning a certificate has to land on a readable page.
    expect(body.data.verificationUrl).toBe(
      `${TEST_ENV.VERIFICATION_BASE_URL}/${payload.qrCodeId}`
    );

    // The image must be addressable remotely, not as a local filesystem path.
    expect(body.data.qrImageUrl).toBe(
      `${TEST_ENV.PUBLIC_BASE_URL}/api/qr/image/${payload.qrCodeId}.png`
    );

    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(
      new Date(body.data.issuedAt).getTime()
    );
  });

  test("honours Squad A's expiry date over our default", async ({ request }) => {
    const expiryDate = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload({ expiryDate: expiryDate.toISOString() }),
    });

    expect(response.status()).toBe(201);
    expect((await response.json()).data.expiresAt).toBe(
      expiryDate.toISOString()
    );
  });

  test("never exposes the verification hash or the local file path", async ({
    request,
  }) => {
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: newDocumentPayload(),
    });

    const raw = await response.text();
    expect(raw).not.toContain("verificationHash");
    expect(raw).not.toContain("qrCodePath");
  });

  test("returns 404 in the shared error envelope for an unknown route", async ({
    request,
  }) => {
    const response = await request.get(`/api/internal/qr/nope/${randomUUID()}`, {
      headers: authHeaders(),
    });

    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toHaveProperty("timestamp");
    expect(body.error).toHaveProperty("path");
  });
});
