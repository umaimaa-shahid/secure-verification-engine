CREATE TABLE "public"."email_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "message_id" TEXT,
    "error" TEXT,
    "document_id" TEXT,
    "qr_code_id" TEXT,
    "reference_number" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_logs_status_created_at_idx" ON "public"."email_logs"("status", "created_at");
CREATE INDEX "email_logs_message_id_idx" ON "public"."email_logs"("message_id");

CREATE TABLE "public"."imap_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL DEFAULT 'bounce-listener',
    "last_uid" INTEGER NOT NULL DEFAULT 0,
    "uid_validity" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "imap_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "imap_states_key_key" ON "public"."imap_states"("key");