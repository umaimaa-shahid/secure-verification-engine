# QR Payload & Signing Specification

**Module:** Squad Voyager (Backend Squad B) — Cryptographic QR Generation
**Task:** 5.1 QR Code Generation & Cryptographic Signing
**Version:** 1.2 · signing scheme `v1`
**Status:** Implemented. Sections marked **OPEN** need sign-off from Backend Squad A or Frontend Squad A.

This is the document Tasks 5.2–5.4 and Frontend Squad A build against. If you change
anything here, bump the version and tell both squads — the whole point of the document
is that nobody has to read our source to integrate.

---

## 1. Identifier ownership (read this first)

**Backend Squad A mints the identifiers. We sign theirs. We never invent our own.**

Their `documentService.js` already generates a `qrCodeId` on every document creation
and stores it as a unique column on their `documents` table. Any identifier we minted
independently would be a second, competing name for the same thing — which is exactly
the collision that surfaced when the two repos were first compared.

| Identifier | Owner | Type | Role here |
|---|---|---|---|
| `documentId` | Squad A (`Document.id`) | UUID | **Idempotency key.** One QR per document, enforced by a unique index. |
| `qrCodeId` | Squad A (`Document.qrCodeId`) | UUID | **Public token.** Appears in the verification URL and the image URL. |
| `verificationHash` | Voyager | SHA-256 hex | **Internal signature.** Never leaves the service. Not a token. |

The `verificationHash` is deliberately *not* an identifier. Nothing looks a document up
by it. It exists so that a stored record can be proven untampered.

---

## 2. Request payload

`POST /api/internal/qr/generate`

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

| Field | Type | Required | Rule |
|---|---|---|---|
| `documentId` | string | **yes** | RFC 4122 UUID |
| `qrCodeId` | string | **yes** | RFC 4122 UUID |
| `documentType` | string | no | ≤ 512 chars |
| `title` | string | no | ≤ 512 chars |
| `referenceNumber` | string | no | ≤ 512 chars |
| `recipientName` | string | no | ≤ 512 chars |
| `recipientEmail` | string | no | must contain `@` and a dot in the domain |
| `issuanceDate` | string | no | ISO 8601. Defaults to now. Becomes `issuedAt` |
| `expiryDate` | string | no | ISO 8601, **must be in the future** |
| `metadata` | object | no | JSON object, ≤ 8 KB serialised |

**Unknown fields are ignored, not rejected.** Squad A's document model is still moving;
a new column on their side must not start returning 422s on ours.

**Validation runs before anything is signed.** Signing an incomplete payload produces a
token that looks authentic and is not — so a partial payload is refused outright rather
than signed on a best-effort basis. Every problem in the payload is reported in one
response, not one per round trip.

### Minimum viable payload

Squad A's spec §6.1.1 currently sends only `{ documentId, qrCodeId, timestamp }`. That
is accepted — everything else is optional. The extra fields are a convenience for
Task 5.2 (email composition) so the mailer does not have to call back for a title and a
recipient name.

---

## 3. Signing

### Algorithm

```
message = "v1" : documentId : qrCodeId : issuedAt(ISO) : expiresAt(ISO)
hash    = HMAC-SHA256(message, QR_HASH_SECRET)   // hex, 64 chars
```

The `v1` prefix is a scheme version. If the construction ever changes, old hashes stop
validating under the new scheme instead of silently appearing valid.

### What this protects

Every component of the message is stored on the record, so the hash is **recomputable** —
which is what makes it a signature rather than an opaque random string. Editing the
stored `documentId`, `qrCodeId`, `issuedAt` or `expiresAt` invalidates the record, and
`verifyVerificationHash()` detects it. Extending an expiry by hand is the concrete attack
this closes.

### What this does *not* protect

The hash is **not** in the QR code and **not** in the verification URL. A scanned token
is resolved by database lookup, not by signature verification, so this is not a
self-contained JWT-style credential — an attacker who can write directly to our
`voyager.qr_assets` table *and* knows `QR_HASH_SECRET` could forge a valid record. That is the accepted design:
Squad A's Postgres row remains authoritative for whether a document is real.

### Secret handling

- `QR_HASH_SECRET`, minimum 32 characters, environment only.
- **No default, no fallback.** The service refuses to boot without it. An earlier
  version shipped a hardcoded development fallback; that made every token forgeable by
  anyone who could read the repository.
- Generate with `openssl rand -hex 32`.
- Rotating the secret invalidates verification of all existing records. Rotation needs a
  re-sign migration — **OPEN**, not yet built.

---

## 4. Expiry policy

```
expiresAt = payload.expiryDate                          (when Squad A supplies one)
          = issuedAt + QR_EXPIRY_HOURS                  (when they do not)
```

**Squad A's document expiry always wins.** A certificate valid until 2027 must not carry
a QR that dies in 24 hours — that was the flaw in treating expiry as a fixed service-wide
constant.

Their `Document.expiryDate` column is nullable. When it is null we fall back to
`QR_EXPIRY_HOURS`, defaulting to **8760 hours (365 days)**. The fallback exists so a null
never becomes a token valid forever; the brief requires tokens not be replayable
indefinitely.

> **OPEN — Squad A:** is 365 days the right fallback for a document with no expiry, or
> should a null `expiryDate` mean "never expires" and be represented as such?

`expiresAt` is enforced on read, not by a sweeper job: `status` is the stored lifecycle
flag and expiry is derived from the clock at request time. A revoked document stays
`revoked` even after expiry, because revocation is the more important fact to report.

---

## 5. Idempotency

**Rule: one QR per `documentId`, forever.**

Guaranteed by a `UNIQUE` constraint on `document_id` in Postgres — not by an
application-level "check then insert", which two concurrent requests both pass.

| Situation | Result |
|---|---|
| First call for a `documentId` | `201`, `idempotent: false`, QR generated |
| Same `documentId` + same `qrCodeId` again | `200`, `idempotent: true`, stored record returned unchanged |
| Concurrent identical calls | Exactly one `201`; all others `200`. Same `qrCodeId`, same `issuedAt` |
| Same `documentId`, **different** `qrCodeId` | `409 QR_CODE_ID_CONFLICT` |
| Same `qrCodeId`, **different** `documentId` | `409 QR_CODE_ID_CONFLICT` |

The two conflict cases are refused rather than absorbed. Returning the stored QR when
Squad A asks with a different `qrCodeId` would hand them a code that no longer matches
their own database — a silent divergence is worse than a loud error.

`issuedAt` being identical across a replay is the observable proof that the stored record
was returned rather than quietly regenerated. It is asserted in
`tests/e2e/qr-idempotency.spec.js`.

---

## 6. Response

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

`idempotent` is returned explicitly rather than inferred from `200` vs `201`, so a caller
that only checks `response.ok` can still distinguish a fresh issue from a replay.

### The two URLs are different things

- **`verificationUrl`** — encoded *inside* the QR image. Points at **Frontend Squad A's
  portal** (`/verify/<qrCodeId>`), because a person scanning a printed certificate must
  land on a readable result page, not on our JSON API.
- **`qrImageUrl`** — the PNG itself, served by us over HTTP so the portal can render it
  with a plain `<img src>`. A filesystem path inside our container is useless to them.

> **OPEN — Frontend Squad A:** we build `VERIFICATION_BASE_URL/<qrCodeId>` and default to
> `http://localhost:3000/verify`. Confirm the production origin and that your route is
> `/verify/[token]` with `token === qrCodeId`.

### Never returned

`verificationHash` and `qrCodePath` are excluded from every response on every route,
including the authenticated ones. `recipientEmail` is stored for Task 5.2 but is not part
of the reference contract and does not appear in a lookup response.

---

## 7. Errors

Envelope matches Squad A's Technical Specification §8.1, so a client that already handles
their errors handles ours with no second code path.

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

| Code | HTTP | Meaning | Retry? |
|---|---|---|---|
| `VALIDATION_INVALID_INPUT` | 422 | Payload failed validation. `details.fields` lists every problem | No — fix the payload |
| `VALIDATION_INVALID_INPUT` | 400 | Body was not valid JSON | No |
| `AUTH_INVALID_CREDENTIALS` | 401 | Missing or wrong `x-internal-api-key` | No |
| `QR_CODE_ID_CONFLICT` | 409 | Identifier pairing contradicts a stored record | No — reconcile first |
| `DOCUMENT_QR_NOT_FOUND` | 404 | No QR issued for this `qrCodeId` | No |
| `INTERNAL_ERROR` | 500 | Unexpected failure | Yes, with backoff |

Only `500` is worth retrying. Everything else is terminal and a retry will fail
identically. Stack traces and driver messages never cross the wire.

---

## 8. Logging

Logs are treated as an untrusted boundary. Never written in the clear:

- `verificationHash`
- `qrCodeId` (it is the public token — a log line containing it is a usable credential)
- `QR_HASH_SECRET`, `INTERNAL_API_KEY`
- full verification URLs
- `DATABASE_URL` (it carries credentials for a database shared with Squad A)

`documentId` **is** logged: it is an internal identifier, useless without a `qrCodeId`,
and correlating a request without it is impractical. Sensitive values enter a log line
only through `logger.fingerprint()`, a one-way SHA-256 truncated to 12 hex characters —
stable enough to correlate across lines, useless as a token.

---

## 9. Open questions

| # | Question | For |
|---|---|---|
| 1 | Fallback expiry when `Document.expiryDate` is null — 365 days, or "never"? | Squad A |
| 2 | Production origin for the verification portal; confirm `/verify/[token]` with `token === qrCodeId` | Frontend Squad A |
| 3 | Who calls `POST /api/internal/qr/generate` — Squad A directly, or a queue between us? Their hooks are currently stubs that build a payload and return it | Squad A |
| 4 | Secret rotation procedure for `QR_HASH_SECRET` (needs a re-sign migration) | Both backends |
| 5 | PNG cache is local disk; ephemeral on most hosting. Move to object storage before production? | Squad lead |

---

## 10. Change log

| Version | Date | Change |
|---|---|---|
| 1.2 | 2026-08-22 | Added `qrImageUrl` to the response shape, served by the new public image route. No change to the payload, the signing construction or the idempotency rules. |
| 1.1 | 2026-08-22 | Storage moved from MongoDB to the shared Supabase Postgres, in a dedicated `voyager` schema. **No change to the payload, the signing construction, the expiry policy or the idempotency rules** — the contract in this document is unchanged and nothing built against v1.0 needs to move. |
| 1.0 | 2026-08-20 | First specification. Realigned onto Squad A's identifiers: `documentId` is now the idempotency key and `qrCodeId` the public token, replacing the previously self-minted HMAC identifier. Signing changed to bind their identifiers plus the validity window. Expiry now honours the document's own date. |
