-- F-139 (2026-11-21, the maintainer's "yes"; ADR 0056 amended): webhook automations. A third kind of
-- automation, started by a request to its own URL; the request's run in the history with its
-- idempotency key's hash; and the skip reasons a request can have. Additive only: new enum values, a
-- new enum, nullable columns, checks and indexes. Nothing is renamed, dropped or backfilled.
--
-- The new enum values are used by no statement here: Postgres refuses a value added in the same
-- transaction, so the checks name the columns, never `kind = 'webhook'`.

-- AlterEnum
ALTER TYPE "AutomationKind" ADD VALUE 'webhook';

-- AlterEnum
ALTER TYPE "AutomationRunKind" ADD VALUE 'request';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomationSkipReason" ADD VALUE 'filtered';
ALTER TYPE "AutomationSkipReason" ADD VALUE 'duplicate';
ALTER TYPE "AutomationSkipReason" ADD VALUE 'setup';

-- CreateEnum
CREATE TYPE "AutomationWebhookAuth" AS ENUM ('signature', 'bearer');

-- AlterTable
ALTER TABLE "automation" ADD COLUMN     "idempotencyField" TEXT,
ADD COLUMN     "payloadFilter" JSONB,
ADD COLUMN     "webhookAuth" "AutomationWebhookAuth",
ADD COLUMN     "webhookId" TEXT,
ADD COLUMN     "webhookSecretRef" TEXT;

-- AlterTable
ALTER TABLE "automation_run" ADD COLUMN     "idempotencyKeyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "automation_webhookId_key" ON "automation"("webhookId");

-- CreateIndex
CREATE INDEX "automation_run_idempotency_key" ON "automation_run"("automationId", "idempotencyKeyHash", "createdAt") WHERE ("idempotencyKeyHash" IS NOT NULL);

-- A webhook's address, secret and verification come together, or not at all.
ALTER TABLE "automation" ADD CONSTRAINT "automation_webhook_parts_together" CHECK (("webhookId" IS NULL) = ("webhookSecretRef" IS NULL) AND ("webhookId" IS NULL) = ("webhookAuth" IS NULL));

-- Only the key's SHA-256, in hex, is ever stored: never the key itself.
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_key_is_a_hash" CHECK ("idempotencyKeyHash" IS NULL OR "idempotencyKeyHash" ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN "automation"."webhookSecretRef" IS 'ostra: a reference to the secret store, never the secret.';
COMMENT ON COLUMN "automation_run"."idempotencyKeyHash" IS 'ostra: the SHA-256 of a webhook request''s idempotency key, never the key.';
