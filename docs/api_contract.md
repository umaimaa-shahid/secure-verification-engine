# API Contract - QR Generation & Verification

**Squad:** Voyager (Backend Squad B - Communications & Generation)
**Task:** 5.4 Finalize and Publish API Contract
**Status:** Final - ready for integration
**Consumers:** Backend Squad A (trigger side), Frontend Squad A / Nova (consumption side)
**Companion documents:** `docs/qr-payload-spec.md` (signing/expiry/idempotency detail), `docs/qr-api.md` (curl examples)

This document is the single source of truth for how the three squads connect:
Squad A creates a document → Voyager signs it and generates a QR → Nova's portal
resolves the scanned/linked token.

---

## 1. System boundary

| Direction | Caller                                       | Callee          | Purpose                                                                                                       |
| --------- | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Trigger   | Backend Squad A                              | Voyager         | "This document is ready - generate its QR."                                                                   |
| Lookup    | Backend Squad A / Voyager's own email module | Voyager         | Fetch an already-issued QR's metadata.                                                                        |
| Image     | Frontend Squad A (Nova)                      | Voyager         | Render the QR as`<img src="...">`.                                                                          |
| Resolve   | Frontend Squad A (Nova)                      | Backend Squad A | "What does this scanned token mean?" (Nova calls **Squad A**, not Voyager, for this - see Section 5.) |

---

## 2. Trigger endpoint - `POST /api/internal/qr/generate`

Called by Backend Squad A immediately after a document is created (their spec Section 6.1.1).
**Idempotent on `documentId`** - safe to retry on timeout or a duplicate webhook delivery.

**Auth:** `x-internal-api-key: <INTERNAL_API_KEY>` header, service-to-service shared secret.

### Request schema

```json
{
  "documentId": "3f2b8c10-1c4e-4f8a-9d21-6b5a0c9e7f11",
  "qrCodeId": "9a7d1e44-2f60-4c8b-8e35-11c9d0a4b872",
  "documentType": "Internship Offer",
  "title": "Internship Offer Letter",
  "referenceNumber": "DL-2026-001",
  "recipientName": "Jane Smith",
  "recipientEmail": "jane@example.com",
  "issuanceDate": "2026-08-20T10:00:00Z",
  "expiryDate": "2026-12-31T23:59:59Z",
  "metadata": { "position": "Software Engineer" }
}
```

### Required fields

| Field               | Type   | Required      | Rule                                                                           |
| ------------------- | ------ | ------------- | ------------------------------------------------------------------------------ |
| `documentId`      | string | **yes** | RFC 4122 UUID. Squad A's`Document.id` - the idempotency key.                 |
| `qrCodeId`        | string | **yes** | RFC 4122 UUID. Squad A's`Document.qrCodeId` - becomes the public token.      |
| `documentType`    | string | no            | ≤ 512 chars                                                                   |
| `title`           | string | no            | ≤ 512 chars                                                                   |
| `referenceNumber` | string | no            | ≤ 512 chars                                                                   |
| `recipientName`   | string | no            | ≤ 512 chars                                                                   |
| `recipientEmail`  | string | no            | must be a syntactically valid email                                            |
| `issuanceDate`    | string | no            | ISO 8601. Defaults to now. Becomes`issuedAt`.                                |
| `expiryDate`      | string | no            | ISO 8601, must be in the future. Falls back to`issuedAt + 8760h` if omitted. |
| `metadata`        | object | no            | JSON object, ≤ 8 KB serialised                                                |

Unrecognized fields are **ignored, not rejected** - Squad A's document model can add
columns without those calls starting to fail on our side. Minimum viable payload is
just `{ documentId, qrCodeId }`.

**Identifier ownership:** Squad A mints both `documentId` and `qrCodeId`. Voyager
never generates its own competing identifier - it only signs theirs.

### Response schema

| Status  | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| `201` | New QR generated                                                                     |
| `200` | Already issued for this`documentId` - stored record returned, `idempotent: true` |
| `401` | Missing/invalid API key                                                              |
| `409` | Identifier pairing contradicts a stored record (see Section 4)                       |
| `422` | Payload validation failed (see Section 4)                                            |

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

`idempotent` is returned explicitly rather than left implicit in the status code, so
a caller that only checks `response.ok` can still tell a fresh issue from a replay.

**Never returned, on any route:** the HMAC signature (`verificationHash`) and the local
filesystem path (`qrCodePath`). `recipientEmail` is stored for the email module but is
not part of this contract's response shape.

---

## 3. Lookup & image endpoints

### `GET /api/internal/qr/:qrCodeId`

Fetches an already-issued QR's metadata without re-triggering generation. Same `data`
shape as Section 2. Requires the API key. `404 DOCUMENT_QR_NOT_FOUND` if nothing was ever
issued for that id.

### `GET /api/qr/image/:qrCodeId.png`

The rendered PNG, public (no auth) so Nova's portal can render it directly with
`<img src="...">`. Returns `image/png` with `Cache-Control: public, max-age=86400, immutable`. `404` for an unknown, malformed, or non-UUID id.

### `GET /health`

Liveness only - no auth, no DB round trip. `{ "success": true, "service": "qr-generation" }`

---

## 4. Error categories

Every error uses one shared envelope so a client that handles one endpoint's errors
handles all of them:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_INVALID_INPUT",
    "message": "The request payload failed validation.",
    "details": { "fields": [{ "field": "documentId", "message": "documentId is required." }] },
    "timestamp": "2026-08-20T10:00:00.000Z",
    "path": "/api/internal/qr/generate"
  }
}
```

As required by the brief, errors fall into three explicit categories:

| Category                                                       | Codes                                                                               | HTTP                  | Meaning                                                                                                                                                                                  | Retry?               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **1. Invalid/expired token** (user-facing)               | `DOCUMENT_QR_NOT_FOUND`                                                           | 404                   | No QR issued for that id, or the resolved token doesn't correspond to a real document. Surfaced to the end user via Nova's UI, not a raw error page.                                     | No                   |
| **2. Malformed request from Squad A** (developer-facing) | `VALIDATION_INVALID_INPUT`, `AUTH_INVALID_CREDENTIALS`, `QR_CODE_ID_CONFLICT` | 400 / 401 / 422 / 409 | Caller-fixable: bad payload shape, missing/wrong API key, or an identifier pairing that contradicts a stored record.`details.fields` lists every validation problem in one round trip. | No - fix the request |
| **3. Internal generation/send failure**                  | `INTERNAL_ERROR`                                                                  | 500                   | Unexpected failure (rendering, DB, etc). Message is deliberately generic - no stack traces or driver errors cross the wire; those go to the server log only.                             | Yes, with backoff    |

`409 QR_CODE_ID_CONFLICT` is worth calling out specifically: it fires when the same
`documentId` arrives with a *different* `qrCodeId` than what's already on file (or
vice versa). Voyager refuses to silently return the stored QR in that case, because
that would hand Squad A a code that no longer matches their own database.

---

## 5. Verification token & deep-link format

Two distinct URLs exist and are **not interchangeable**:

| URL                 | Built by | Points at                                                                                              | Purpose                                                                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `verificationUrl` | Voyager  | `VERIFICATION_BASE_URL/<qrCodeId>` - Nova's portal, e.g. `http://localhost:3000/verify/<qrCodeId>` | Encoded **inside the QR image itself**. A person scanning a printed certificate lands on a readable result page, not a JSON API. |
| `qrImageUrl`      | Voyager  | `PUBLIC_BASE_URL/api/qr/image/<qrCodeId>.png`                                                        | The rendered PNG, for Nova to embed with`<img src>`.                                                                                  |

The token in both is Squad A's `qrCodeId` - an unguessable RFC 4122 UUID. Voyager
never mints its own token; the HMAC signature it computes internally never appears in
either URL, is never logged, and is never returned in any API response (see Section 2).

**Route on Nova's side:** : `/verify/[token]`, where `token === qrCodeId`. This is the format Voyager's `VERIFICATION_BASE_URL`  is built against today (`http://localhost:3000/verify/<qrCodeId></qrcodeid>`), consistent with Squad A's own setup docs - but it has not been formally signed off by Frontend Squad A.

> **OPEN - needs Frontend Squad A sign-off:** confirm the route is exactly
> `/verify/[token]`with`token === qrCodeId`, and confirm the production origin that
> will replace `localhost:3000` once Nova is deployed. Every QR generated before that
> swap encodes whatever `VERIFICATION_BASE_URL` is set to at generation time - so this
> needs to be locked down before any QR is issued for real use.

---

## 6. Frontend token-resolution response shape

When Nova's portal resolves a scanned/linked token, it calls **Backend Squad A's**
`POST /api/verify/qr-code` (not a Voyager endpoint - Squad A owns the document record
and is the only service that can authoritatively answer what a token resolves to).
Documented here for completeness so Nova has the full picture in one place.

**Request:** `{ "qrCodeId": "<token>" }`

**Response - valid document:**

```json
{
  "success": true,
  "verificationStatus": "valid",
  "data": {
    "document": {
      "documentType": "Internship Offer Letter",
      "title": "Software Engineer Internship",
      "issuer": {
        "name": "DevLogix",
        "logoUrl": "https://devlogix.online/logo.png"
      },
      "recipient": {
        "name": "John Doe",
        "email": "john@example.com"
      },
      "issuanceDate": "2026-08-15T00:00:00Z",
      "referenceNumber": "DL-2026-001",
      "status": "active",
      "metadata": { "position": "Software Engineer", "department": "Engineering" }
    },
    "verifiedAt": "2026-08-18T13:30:00Z"
  }
}
```

**Other states**, same envelope, `success: false`:

| `verificationStatus` | Meaning                             |
| ---------------------- | ----------------------------------- |
| `invalid`            | QR code not found or malformed      |
| `expired`            | Document's`expiryDate` has passed |
| `revoked`            | Issuer revoked the document         |

**Fields deliberately excluded** - consistent with Nova's no-raw-internal-identifiers
rule: `document.id`, `qrCodeId` itself, `verificationHash`, any database primary/foreign
keys, and any field not needed to render the result page. Only display-safe data
reaches the client.

---

## 7. End-to-end flow

```
Squad A: document created
   │  POST /api/internal/qr/generate  (this contract, Section 2)
   ▼
Voyager: validate → sign (HMAC-SHA256) → render PNG → persist (idempotent on documentId)
   │
   ├─ verificationUrl  ──▶  encoded inside the QR image → Nova's portal, /verify/<qrCodeId>
   └─ qrImageUrl       ──▶  GET /api/qr/image/<qrCodeId>.png  (public, this contract, Section 3)

Recipient scans / clicks the deep link
   ▼
Nova: POST /api/verify/qr-code  →  Squad A  (this contract, Section 6)
   ▼
Nova renders the resolved verification result
```

---

## 8. Change log

| Version | Date       | Change                                                                                                                                                                     |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-08-25 | Initial publication. Consolidates the trigger/lookup/image contract (Voyager) with the token-resolution contract (Squad A) into one handoff document for Nova and Squad A. |
