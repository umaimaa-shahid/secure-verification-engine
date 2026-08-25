# QR Generation API

**Module:** Squad Voyager (Backend Squad B)
**Task:** 5.4 / "Expose QR Generation API"
**Companion:** [qr-payload-spec.md](qr-payload-spec.md) — payload schema, signing, expiry, idempotency

Endpoint reference for Backend Squad A (trigger side) and Frontend Squad A (display side).

---

## Base URLs

| Environment | Origin |
|---|---|
| Local | `http://localhost:4000` |
| Staging / production | set via `PUBLIC_BASE_URL` — **not yet assigned** |

## Authentication

Routes under `/api/internal/` require a shared secret:

```
x-internal-api-key: <INTERNAL_API_KEY>
```

Service-to-service only — the caller is another backend, so there is no JWT and no
session. The comparison is constant-time, and both sides are hashed first so that the
check cannot leak the configured key's length.

`/api/qr/image/*` and `/health` are public.

---

## `POST /api/internal/qr/generate`

Generate the QR for a document. **Idempotent on `documentId`** — safe to retry.

Called after Squad A creates a document (their spec §6.1.1).

**Auth:** required · **Payload:** [spec §2](qr-payload-spec.md#2-request-payload)

| Status | Meaning |
|---|---|
| `201` | QR generated |
| `200` | Already issued — stored record returned, `idempotent: true` |
| `401` | Missing or invalid API key |
| `409` | Identifier pairing contradicts a stored record |
| `422` | Payload validation failed |

```bash
curl -X POST http://localhost:4000/api/internal/qr/generate \
  -H "Content-Type: application/json" \
  -H "x-internal-api-key: $INTERNAL_API_KEY" \
  -d '{
    "documentId": "3f2b8c10-1c4e-4f8a-9d21-6b5a0c9e7f11",
    "qrCodeId": "9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872",
    "title": "Internship Offer Letter",
    "recipientEmail": "jane@example.com"
  }'
```

```json
{
  "success": true,
  "idempotent": false,
  "message": "QR code generated successfully.",
  "data": {
    "documentId": "3f2b8c10-1c4e-4f8a-9d21-6b5a0c9e7f11",
    "qrCodeId": "9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872",
    "verificationUrl": "http://localhost:3000/verify/9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872",
    "qrImageUrl": "http://localhost:4000/api/qr/image/9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872.png",
    "issuedAt": "2026-08-20T10:00:00.000Z",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "status": "active"
  }
}
```

---

## `GET /api/internal/qr/:qrCodeId`

Look up an already-issued QR without re-triggering generation. Used by Squad A and by our
own email module, which needs the image URL and expiry when composing a delivery message.

**Auth:** required

| Status | Meaning |
|---|---|
| `200` | Found — same `data` shape as above |
| `401` | Missing or invalid API key |
| `404` | No QR issued for this `qrCodeId` |

```bash
curl http://localhost:4000/api/internal/qr/9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872 \
  -H "x-internal-api-key: $INTERNAL_API_KEY"
```

> **Public token resolution is Squad A's, not ours.** They own the document record, so
> only they can answer what a token resolves to — that is their
> `POST /verify/qr-code` (their spec §4.5.1). This endpoint returns QR metadata, never
> document contents.

---

## `GET /api/qr/image/:qrCodeId.png`

The rendered QR image. **Public** — the portal renders it in an `<img>` tag and cannot
attach a secret.

| Status | Meaning |
|---|---|
| `200` | `image/png`, `Cache-Control: public, max-age=86400, immutable` |
| `404` | Unknown `qrCodeId`, malformed id, or non-`.png` extension |

```html
<img src="http://localhost:4000/api/qr/image/9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872.png"
     alt="Verification QR code" width="300" height="300">
```

**Why public is safe here:** `qrCodeId` is an unguessable v4 UUID, and the image encodes
only the verification URL — the same information a person gets by pointing a phone at the
printed code. No signature, document field, or internal identifier is reachable through
this route.

**Cache behaviour:** rendering is deterministic for a given `qrCodeId`, so the response is
cached hard. Revocation is reflected on the verification page, never by changing the
image. If the disk cache is wiped — fresh deploy, ephemeral container — the image is
re-rendered on demand from the stored verification URL, so the URL never breaks.

---

## `GET /health`

Liveness probe. No auth, no database round trip: it answers "is this process up", which is
what an orchestrator needs.

```json
{ "success": true, "service": "qr-generation" }
```

---

## Errors

All errors use Squad A's envelope (§8.1). Full code table in
[the spec](qr-payload-spec.md#7-errors).

```json
{
  "success": false,
  "error": {
    "code": "QR_CODE_ID_CONFLICT",
    "message": "This documentId was already issued a QR code with a different qrCodeId.",
    "details": { "field": "qrCodeId", "issuedQrCodeId": "…", "requestedQrCodeId": "…" },
    "timestamp": "2026-08-20T10:00:00.000Z",
    "path": "/api/internal/qr/generate"
  }
}
```

**Retry only `500`.** Every 4xx is terminal — a retry fails identically.

---

## Integration notes for Squad A

Your `triggerQRCodeGenerationHook()` in `core-backend/src/services/qrCodeService.js`
currently builds a payload and returns it without sending anything. To wire it up, POST
that payload to `/api/internal/qr/generate` with the API key header.

Because the endpoint is idempotent on `documentId`, you do not need delivery-exactly-once
on your side — fire it, and retry freely on network failure or `500`.

The fields you already have (`title`, `recipientName`, `recipientEmail`,
`referenceNumber`, `expiryDate`) are all optional but worth sending: they let the email
module compose a message without calling back to you.
