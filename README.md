# Email Engine

Email Engine is Squad B's communications service for the Secure Delivery & Verification System. It receives notification requests from Squad A, renders HTML email templates, queues and sends emails through SMTP, stores delivery state in Supabase PostgreSQL through Prisma, and detects Gmail bounce messages through IMAP.

The root project in this folder is the Prisma/Supabase version. The nested `secure-verification-engine` folder is a separate deployment and remains MongoDB-based.

## Responsibilities

### This service provides

- HTML email rendering
- Direct email sending through SMTP
- Notification email queueing
- Duplicate notification protection
- Automatic retries with exponential backoff
- Email status logging in Supabase PostgreSQL
- Delivery, failure, and bounce status updates
- IMAP bounce detection and Message-ID matching
- A health-check endpoint

### This service does not provide

- Document creation or document CRUD
- User authentication or JWT authorization
- QR-code generation
- Public document verification
- The `/api/documents` or `/api/verify` endpoints

Those features belong to Squad A.

## Technology

- Node.js
- Express 5
- Prisma 6.19.3
- Supabase PostgreSQL
- Nodemailer for SMTP
- ImapFlow for IMAP
- Mailparser for bounce-message parsing
- Nodemon for local development

## Architecture

```text
Squad A
  |
  | POST /api/email/notify
  v
Express API
  |
  +--> Validate payload and check duplicate notification
  |
  +--> Render templates/assetdelivery.html
  |
  +--> Store queued email in Supabase via Prisma
  |
  v
Email Worker (every 5 seconds)
  |
  +--> Send email through SMTP
  +--> Retry failed sends up to 3 attempts
  +--> Store sent or failed status
  |
  v
Recipient mailbox
  |
  v
IMAP Bounce Listener
  |
  +--> Read bounce message headers
  +--> Match original Message-ID
  +--> Update EmailLog status to bounced
```

## Project Structure

```text
config/email.js                 SMTP and IMAP configuration
controllers/emailcontroller.js  HTTP request handlers
lib/prisma.js                   Shared PrismaClient instance
lib/prisma-model.js             Compatibility model wrapper
models/emaillog.js              EmailLog data access
models/imapstate.js             IMAP state data access
prisma/schema.prisma            Prisma models and Supabase mappings
routes/emailroutes.js            Email API routes
services/emailservices.js       SMTP sending and template rendering
services/emailworker.js         Queue polling and retry processing
services/imapservices.js        Bounce listener and stale-email sweep
templates/assetdelivery.html    Notification email template
server.js                       Application startup
```

## Requirements

Install these before running the service:

- Node.js 18 or newer
- A Supabase project
- A Supabase PostgreSQL connection string
- An SMTP account, such as Gmail SMTP
- An IMAP mailbox for bounce monitoring

## Installation

From the root `Email Engine` directory:

```powershell
npm install
```

Create a root `.env` file. Do not commit this file.

```env
PORT=5000

# Supabase PostgreSQL connection string from Supabase Connect
DATABASE_URL="postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres"

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password

ENABLE_IMAP=true
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your-email@gmail.com
IMAP_PASS=your-gmail-app-password
```

Use the **shared session-mode pooler** connection string for Prisma migrations and use port `5432`. Do not use the transaction pooler on port `6543` for `db push` or migrations.

For Gmail, use a Google App Password rather than your normal account password. If a password contains URL-reserved characters, URL-encode those characters in `DATABASE_URL`.

## Database Setup

The Prisma schema defines two tables:

### `email_logs`

Stores each email, its recipient, subject, HTML body, Message-ID, document metadata, retry state, timestamps, and delivery status.

Possible statuses:

- `queued`
- `sent`
- `failed`
- `delivered`
- `bounced`
- `unknown`

### `imap_states`

Stores the last processed IMAP UID and UID validity for the bounce listener. This allows the listener to resume after a restart.

Create or update the Supabase tables with:

```powershell
npx prisma db push
npx prisma generate
```

Validate the schema with:

```powershell
npx prisma validate
```

Enable Supabase Row Level Security for the backend-owned tables by running
[supabase-security.sql](supabase-security.sql) once in the Supabase SQL Editor.
No public policies are created, so anonymous clients cannot read or modify email
logs or IMAP state. The server-side Prisma database connection continues to
operate normally.

## Running the Service

Development mode:

```powershell
npm run dev
```

Production-style start:

```powershell
npm start
```

Expected startup messages include:

```text
Prisma configured for Supabase PostgreSQL
Server running on http://localhost:5000
Email queue worker started
IMAP bounce listener connected and watching INBOX (read-only)
```

Health check:

```text
GET http://localhost:5000/
```

Expected response:

```json
{
  "status": "ok",
  "message": "Email Engine is running"
}
```

## API Endpoints

### Queue a Squad A notification

```http
POST /api/email/notify
Content-Type: application/json
```

Request body:

```json
{
  "recipientEmail": "jane@example.com",
  "document": {
    "id": "856093a0-1e5a-435a-8586-180dfa4c7f37",
    "title": "Internship Offer Letter",
    "referenceNumber": "DL-2026-001",
    "qrCodeUrl": "https://api.example.com/qr/qr-id"
  },
  "timestamp": "2026-08-20T12:00:00.000Z"
}
```

Successful response:

```json
{
  "success": true,
  "duplicate": false,
  "message": "Notification email queued successfully",
  "queueId": "email-log-id"
}
```

Required fields:

- `recipientEmail`
- `document.id`
- `document.title`
- `document.referenceNumber`
- `document.qrCodeUrl`
- `timestamp`

The service treats an email for the same `document.id` and recipient as a duplicate when an earlier record is `queued`, `sent`, or `delivered`.

### Send an email immediately

```http
POST /api/email/send
Content-Type: application/json
```

Request body:

```json
{
  "to": "jane@example.com",
  "name": "Jane Smith",
  "assetName": "Internship Offer Letter",
  "assetUrl": "https://api.example.com/document/document-id"
}
```

This sends immediately through SMTP and writes a `sent` or `failed` log record.

### Update delivery status by webhook

```http
POST /api/email/webhook
Content-Type: application/json
```

Request body:

```json
{
  "messageId": "<message-id@example.com>",
  "event": "delivered"
}
```

Supported events:

- `delivered`
- `bounced`
- `failed`

This endpoint currently has no authentication. Protect it at the gateway or add shared-secret/JWT validation before exposing it publicly.

## Queue Workflow

1. Squad A calls `POST /api/email/notify` after creating a document.
2. The controller validates the payload.
3. The service checks for an existing queued, sent, or delivered notification.
4. The HTML template is rendered with the document title, reference number, and QR URL.
5. A `queued` row is inserted into `email_logs`.
6. The worker checks for ready emails every five seconds.
7. SMTP sends the email.
8. Successful sends become `sent` and store the SMTP Message-ID.
9. Failed sends are retried up to three total attempts.
10. Retry delays are 10 seconds after the first failure and 30 seconds after the second failure.
11. After the final failure, the record becomes `failed`.

## Bounce Workflow

When `ENABLE_IMAP=true`, the service connects to the configured IMAP inbox in read-only mode.

1. The listener remembers the last processed UID in `imap_states`.
2. It reads new message headers first.
3. It identifies common bounce senders, subjects, and delivery-status content types.
4. It extracts the original Message-ID from `In-Reply-To`, `References`, or the message body.
5. It finds the matching `email_logs.message_id`.
6. It changes the matching email status to `bounced`.
7. It continues polling from the next UID.

A stale sent-email sweep changes sent messages older than 48 hours to `unknown`.

## Squad A Integration

After document creation, Squad A should call this service using the deployed Email Engine URL:

```js
await fetch("https://YOUR-EMAIL-ENGINE-DOMAIN/api/email/notify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    recipientEmail,
    document: {
      id: document.id,
      title: document.title,
      referenceNumber: document.referenceNumber,
      qrCodeUrl,
    },
    timestamp: new Date().toISOString(),
  }),
});
```

The call should happen after the document and QR URL are available. Squad A owns the document and verification endpoints; this service owns the email notification workflow.

## Deployment Workflow

1. Provision a Supabase project.
2. Copy the Prisma PostgreSQL connection string into the deployment environment as `DATABASE_URL`.
3. Configure SMTP and IMAP secrets in the deployment environment.
4. Install dependencies with `npm ci`.
5. Generate Prisma Client with `npx prisma generate`.
6. Apply the schema with `npx prisma db push` for the initial setup, or use Prisma migrations for controlled production changes.
7. Start the service with `npm start`.
8. Confirm `GET /` returns the health response.
9. Send a test request to `/api/email/notify`.
10. Confirm the row appears in Supabase and the email is delivered.
11. Send a controlled bounce test and confirm the row changes to `bounced`.
12. Give Squad A the deployed `/api/email/notify` URL.

Never commit `.env`, SMTP passwords, Gmail app passwords, or database credentials. The root `.gitignore` already excludes `.env`.

## Testing and Validation

The project currently has no automated test suite and no `npm test` script. Available checks are:

```powershell
node --check server.js
npx prisma validate
npx prisma generate
npx prisma db push
npm start
```

Manual smoke test for the notification endpoint:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:5000/api/email/notify `
  -ContentType "application/json" `
  -Body '{"recipientEmail":"test@example.com","document":{"id":"test-document-id","title":"Test Document","referenceNumber":"TEST-001","qrCodeUrl":"https://example.com/qr/test"},"timestamp":"2026-08-25T12:00:00.000Z"}'
```

Use a real test mailbox when validating SMTP delivery. Check the `email_logs` table for the final status and Message-ID.

## Troubleshooting

### `DATABASE_URL must be set`

Add `DATABASE_URL` to the root `.env` and restart the service.

### `P1001: Can't reach database server`

Copy a fresh connection string from Supabase. Confirm the hostname, password, port, and network. For Prisma migrations, use the shared session-mode pooler on port `5432`.

### Prisma generation returns Windows `EPERM`

Stop any running `npm run dev` or `node server.js` process, then run:

```powershell
npx prisma generate
```

### Email worker cannot send

Check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`. For Gmail, confirm that the app password is active.

### IMAP repeatedly reconnects

Check IMAP credentials and confirm that the mailbox supports IMAP. A single malformed or unusually large bounce message may time out; the listener retries and eventually advances past a repeatedly failing UID.

## Security Notes

- Keep `DATABASE_URL` server-side only.
- Keep SMTP and IMAP credentials server-side only.
- Use HTTPS for deployed API calls.
- Add authentication or a shared secret to `/api/email/webhook` before public deployment.
- Add authentication, rate limiting, and request logging appropriate for the deployment environment.
- Validate and sanitize template values if untrusted users can control them.
- Rotate any credential that has been exposed in logs, screenshots, or chat.
