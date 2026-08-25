-- CreateEnum
CREATE TYPE "qr_asset_status" AS ENUM ('active', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "qr_assets" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "qr_code_id" UUID NOT NULL,
    "verification_hash" TEXT NOT NULL,
    "document_type" TEXT,
    "title" TEXT,
    "reference_number" TEXT,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "qr_code_path" TEXT,
    "verification_url" TEXT NOT NULL,
    "status" "qr_asset_status" NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qr_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qr_assets_document_id_key" ON "qr_assets"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "qr_assets_qr_code_id_key" ON "qr_assets"("qr_code_id");

-- CreateIndex
CREATE INDEX "qr_assets_expires_at_idx" ON "qr_assets"("expires_at");

