const { randomUUID } = require("crypto");
const path = require("path");
const fsp = require("fs/promises");
const { test, expect } = require("@playwright/test");

const {
  GENERATE_PATH,
  authHeaders,
  newDocumentPayload,
  isPng,
} = require("../../support/fixtures");
const { QR_OUTPUT_DIR } = require("../../support/testEnv");

/**
 * GET /api/qr/image/:qrCodeId.png
 *
 * The requirement this covers: Frontend Squad A must be able to render the QR
 * from a URL, because a filesystem path inside our container is useless to them.
 */

async function issueQr(request, overrides = {}) {
  const payload = newDocumentPayload(overrides);
  const response = await request.post(GENERATE_PATH, {
    headers: authHeaders(),
    data: payload,
  });
  expect(response.status()).toBe(201);
  return { payload, reference: (await response.json()).data };
}

test.describe("QR image delivery", () => {
  test("serves a real PNG at the advertised URL", async ({ request }) => {
    const { reference } = await issueQr(request);

    // Fetch the absolute URL exactly as we handed it to Squad A, rather than a
    // path we rebuild here - that is the thing that has to work.
    const response = await request.get(reference.qrImageUrl);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    const body = await response.body();
    expect(isPng(body)).toBe(true);
    expect(body.length).toBeGreaterThan(100);
  });

  test("is publicly readable, with no API key", async ({ request }) => {
    const { reference } = await issueQr(request);

    // The portal renders this in an <img> tag; it cannot attach a secret.
    const response = await request.get(reference.qrImageUrl, { headers: {} });
    expect(response.status()).toBe(200);
  });

  test("re-renders when the disk cache has been wiped", async ({ request }) => {
    const { payload, reference } = await issueQr(request);

    const before = await (await request.get(reference.qrImageUrl)).body();

    // Simulates a fresh deploy, an ephemeral container, or someone clearing
    // generated/ - the image must survive losing its cache file.
    await fsp.rm(path.join(QR_OUTPUT_DIR, `${payload.qrCodeId}.png`), {
      force: true,
    });

    const response = await request.get(reference.qrImageUrl);
    expect(response.status()).toBe(200);

    const after = await response.body();
    expect(isPng(after)).toBe(true);

    // Rendering is deterministic, so the bytes must match what was served
    // before the cache was cleared.
    expect(after.equals(before)).toBe(true);
  });

  test("returns 404 for a qrCodeId that was never issued", async ({
    request,
  }) => {
    const response = await request.get(`/api/qr/image/${randomUUID()}.png`);

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe("DOCUMENT_QR_NOT_FOUND");
  });

  test("returns 404 for an identifier that is not a UUID", async ({
    request,
  }) => {
    const response = await request.get("/api/qr/image/not-a-uuid.png");
    expect(response.status()).toBe(404);
  });

  test("refuses a non-png extension", async ({ request }) => {
    const { payload } = await issueQr(request);

    const response = await request.get(`/api/qr/image/${payload.qrCodeId}.svg`);
    expect(response.status()).toBe(404);
  });

  test("does not serve files outside the QR cache directory", async ({
    request,
  }) => {
    // The id is validated against the UUID pattern before it is ever joined
    // onto a path, so traversal attempts cannot reach the filesystem at all.
    for (const attempt of [
      "..%2F..%2Fpackage.json.png",
      "....%2F%2Fconfig%2Fqr.js.png",
      "%2Fetc%2Fpasswd.png",
    ]) {
      const response = await request.get(`/api/qr/image/${attempt}`);
      expect(response.status()).toBe(404);
      expect(response.headers()["content-type"]).not.toBe("image/png");
    }
  });

  test("caches hard, since the render is deterministic", async ({ request }) => {
    const { reference } = await issueQr(request);

    const response = await request.get(reference.qrImageUrl);
    expect(response.headers()["cache-control"]).toContain("max-age=86400");
  });
});
