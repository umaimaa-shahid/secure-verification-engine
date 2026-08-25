const { randomUUID } = require("crypto");
const { test, expect } = require("@playwright/test");

const {
  GENERATE_PATH,
  authHeaders,
  newDocumentPayload,
} = require("../../support/fixtures");

/**
 * The duplicate-trigger tests the standards checklist asks for.
 *
 * The scenario being defended against is concrete: Squad A's webhook fires, the
 * call times out on their side after we already committed, and their retry
 * arrives. Without a guard that produces a second QR code and - once task 5.2
 * is wired up - a second email to the recipient.
 */

test.describe("QR generation - idempotency", () => {
  test("a repeated trigger returns the original QR, not a new one", async ({
    request,
  }) => {
    const payload = newDocumentPayload();

    const first = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });
    expect(first.status()).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.idempotent).toBe(false);

    const second = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    // 200 rather than 201: nothing was created this time.
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.idempotent).toBe(true);

    // Byte-identical reference, including the issue timestamp - proof we
    // returned the stored record rather than quietly regenerating one.
    expect(secondBody.data).toEqual(firstBody.data);
  });

  test("survives a burst of concurrent identical triggers", async ({
    request,
  }) => {
    const payload = newDocumentPayload();

    // A read-then-write check would let several of these through; the guarantee
    // has to come from the unique index.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request.post(GENERATE_PATH, { headers: authHeaders(), data: payload })
      )
    );

    const statuses = responses.map((r) => r.status());
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);

    const bodies = await Promise.all(responses.map((r) => r.json()));
    const distinctQrCodeIds = new Set(bodies.map((b) => b.data.qrCodeId));
    expect(distinctQrCodeIds.size).toBe(1);

    const distinctIssuedAt = new Set(bodies.map((b) => b.data.issuedAt));
    expect(distinctIssuedAt.size).toBe(1);
  });

  test("the idempotent replay is still fetchable and identical", async ({
    request,
  }) => {
    const payload = newDocumentPayload();

    await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });
    const replay = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    const lookup = await request.get(`/api/internal/qr/${payload.qrCodeId}`, {
      headers: authHeaders(),
    });

    expect(lookup.status()).toBe(200);
    expect((await lookup.json()).data).toEqual((await replay.json()).data);
  });
});

test.describe("QR generation - conflicts we refuse to absorb", () => {
  test("rejects the same documentId carrying a different qrCodeId", async ({
    request,
  }) => {
    const payload = newDocumentPayload();
    await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    // Returning the stored QR here would hand Squad A a code that no longer
    // matches what their database says.
    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: { ...payload, qrCodeId: randomUUID() },
    });

    expect(response.status()).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("QR_CODE_ID_CONFLICT");
    expect(body.error.details.issuedQrCodeId).toBe(payload.qrCodeId);
  });

  test("rejects a qrCodeId already bound to another document", async ({
    request,
  }) => {
    const payload = newDocumentPayload();
    await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: payload,
    });

    const response = await request.post(GENERATE_PATH, {
      headers: authHeaders(),
      data: { ...payload, documentId: randomUUID() },
    });

    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("QR_CODE_ID_CONFLICT");
  });
});
