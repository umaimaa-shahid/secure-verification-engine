# QR Generation Library & SMTP/IMAP Flow

**Epic 2 - Communications & Generation | Sprint 1 - Secure Verification Engine**

## 1. Scope

This document covers the two assigned Sprint 1 tasks:

1. Select and document the QR generation library.
2. Map the SMTP/IMAP flow for the email engine.

The document intentionally does not define the final API contract, database schema, or module-wide error-handling conventions, as those are outside the scope of these subtasks.

---

## 2. QR Generation Library Choice

### Selected library: `qrcode` (npm)

The `qrcode` package will be used to generate QR codes in the Node.js backend.

It supports generating QR codes in formats such as:

- PNG
- Data URLs / base64
- SVG

For the verification flow, the generated QR should encode a **verification payload/token**, rather than sensitive user information directly.

### Why `qrcode`?

- Designed specifically for QR code generation.
- Provides a simple Node.js API.
- Supports output formats suitable for embedding in emails.
- Allows the QR generation logic to remain separate from the email-sending logic.
- Suitable for generating a QR image server-side without requiring a separate QR-generation service.

### Cryptographic payload

Because the QR is intended for verification, the QR should not contain an easily forgeable value such as a raw user ID.

The proposed approach is:

`Verification data → signed token → QR code`

For example, the signed token may contain:

- user/session identifier
- issued-at timestamp
- expiration timestamp
- issuer or purpose, if required

The QR generator itself is responsible only for converting the token into a QR image. Token signing/verification should remain a separate security concern.

**Important:** The exact token/signing library should be confirmed with the team before implementation. If the existing backend already uses JWT, that existing implementation should be reused rather than introducing another authentication/token mechanism.

---

## 3. SMTP/IMAP Flow

### SMTP - Sending Email

SMTP will be used for outgoing verification emails.

**Flow:**

1. The verification process generates the verification token.
2. The token is converted into a QR image.
3. The email engine creates the verification email using the QR image.
4. Nodemailer sends the email through the configured SMTP server.
5. The SMTP server returns the result of the submission attempt.
6. The application records/logs the result as required by the final implementation.

```text
Verification Data
       ↓
Signed Verification Token
       ↓
QR Generation
       ↓
QR Image
       ↓
Email Template
       ↓
Nodemailer
       ↓
SMTP Server
       ↓
Recipient Mail Server
       ↓
Recipient Inbox
```

### IMAP - Receiving/Reading Mail

IMAP is different from SMTP:

- **SMTP:** used to send outgoing email.
- **IMAP:** used to access and read messages from a mailbox.

IMAP should therefore only be introduced if the system needs to inspect an inbox, such as a dedicated mailbox used for processing incoming messages or bounce notifications.

For the current verification-email flow, **SMTP is the required protocol for sending**. IMAP requirements should be confirmed before implementation rather than assuming that IMAP is required for every email.

Potential future flow:

```text
External Mail Server
       ↓
Dedicated Mailbox
       ↓
IMAP
       ↓
Application
       ↓
Process Incoming/Bounce Messages
```

---

## 4. SMTP vs IMAP

| Protocol | Purpose                             | Required for Sprint 1?                            |
| -------- | ----------------------------------- | ------------------------------------------------- |
| SMTP     | Send verification emails            | Yes                                               |
| IMAP     | Access/read messages from a mailbox | Only if an incoming-mail requirement is confirmed |

SMTP acceptance of an email should not automatically be treated as confirmation that the recipient has received or read the message. Delivery/bounce tracking would require additional mechanisms depending on the selected email provider.

---

## 5. Proposed Node.js Libraries

### QR generation

`qrcode`

Used to convert the verification token into a QR image.

### Email sending

`nodemailer`

Used to construct and send email through the configured SMTP server.

### IMAP

An IMAP library should only be selected if the team confirms that Sprint 1 actually requires mailbox access. The specific library should then be chosen based on the project's Node.js version and existing dependencies.

---

## 6. Items Requiring Team Confirmation

- Does the existing backend already have a JWT/token-signing mechanism that should be reused?
- What should the verification token's expiry duration be?
- Does the QR need to be embedded directly in the email, or should it be provided as an attachment/link?
