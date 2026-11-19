-- Milestone 2's schema (ticket 05, spec section 5.3): tickets and their writes, the idempotency and
-- rate-budget stores, blobs, Linear's OAuth state, and the new columns. Additive only: new tables,
-- nullable columns or columns with a default, new enum values and indexes. Nothing is renamed or
-- dropped, because other teams' installs upgrade on their own schedule (AGENTS.md). The `release`
-- command kind came first, in 20261119200000_command_release (ticket 02).

-- CreateEnum
CREATE TYPE "ConnectionState" AS ENUM ('pending', 'active', 'failed', 'revoked');

-- CreateEnum
CREATE TYPE "WebhookMode" AS ENUM ('webhooks', 'polling');

-- CreateEnum
CREATE TYPE "ConnectionCredential" AS ENUM ('app_oauth', 'app_client_credentials', 'api_key');

-- CreateEnum
CREATE TYPE "TicketStatusCategory" AS ENUM ('open', 'started', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "TicketWriteKind" AS ENUM ('move', 'comment', 'comment_update', 'link_pr', 'link_task', 'create');

-- CreateEnum
CREATE TYPE "TicketWriteState" AS ENUM ('pending', 'done', 'failed');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('pending', 'done');

-- CreateEnum
CREATE TYPE "BlobStoreKind" AS ENUM ('postgres', 's3');

-- CreateEnum
CREATE TYPE "SessionLimit" AS ENUM ('max_duration', 'stall', 'spend_cap');

-- CreateEnum
CREATE TYPE "BoxReleaseReason" AS ENUM ('prs_closed', 'idle_expired', 'task_deleted', 'requested');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NeedsYouReason" ADD VALUE 'restore_conflict';
ALTER TYPE "NeedsYouReason" ADD VALUE 'unstorable_event';

-- AlterEnum
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'ignored';

-- AlterTable
ALTER TABLE "instance_setting" ADD COLUMN     "retentionDays" INTEGER,
ADD COLUMN     "retentionSetAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accessTokenSecretRef" TEXT,
ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "appUserId" TEXT,
ADD COLUMN     "appUserName" TEXT,
ADD COLUMN     "createdByMemberId" TEXT,
ADD COLUMN     "credentialKind" "ConnectionCredential",
ADD COLUMN     "externalWorkspaceId" TEXT,
ADD COLUMN     "externalWorkspaceKey" TEXT,
ADD COLUMN     "externalWorkspaceName" TEXT,
ADD COLUMN     "failedReason" TEXT,
ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "refreshTokenSecretRef" TEXT,
ADD COLUMN     "state" "ConnectionState" NOT NULL DEFAULT 'active',
ADD COLUMN     "webhookMode" "WebhookMode" NOT NULL DEFAULT 'webhooks';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "ticketTemplate" TEXT;

-- AlterTable
ALTER TABLE "repo" ADD COLUMN     "branchRules" JSONB,
ADD COLUMN     "branchRulesCheckedAt" TIMESTAMP(3),
ADD COLUMN     "private" BOOLEAN;

-- AlterTable
ALTER TABLE "board" ADD COLUMN     "integrationDetected" BOOLEAN,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "pollCursor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "boardId" TEXT,
ADD COLUMN     "progressCommentId" TEXT,
ADD COLUMN     "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "task_repo" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "hiddenRefBaseSha" TEXT,
ADD COLUMN     "hiddenRefSha" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "box" ADD COLUMN     "idleSince" TIMESTAMP(3),
ADD COLUMN     "releaseReason" "BoxReleaseReason",
ADD COLUMN     "stoppedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "archiveBlobId" TEXT,
ADD COLUMN     "archiveTurnOrdinal" INTEGER,
ADD COLUMN     "limitReached" "SessionLimit",
ADD COLUMN     "spentMicroUsd" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "webhook_delivery" ADD COLUMN     "error" TEXT,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "signatureHash" TEXT,
ADD COLUMN     "ticketKey" TEXT,
ADD COLUMN     "transitMs" INTEGER;

-- CreateTable
CREATE TABLE "organization_setting" (
    "organizationId" TEXT NOT NULL,
    "linearSkippedAt" TIMESTAMP(3),
    "linearSkippedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_setting_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "ticket" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "statusId" TEXT,
    "statusName" TEXT,
    "statusCategory" "TicketStatusCategory",
    "priority" INTEGER,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "parentExternalId" TEXT,
    "url" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "trackerUpdatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_write" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "ticketId" TEXT,
    "kind" "TicketWriteKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" "TicketWriteState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "ticket_write_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL,
    "result" JSONB,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_budget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL,
    "limit" INTEGER,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "store" "BlobStoreKind" NOT NULL,
    "key" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blob_upload" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "store" "BlobStoreKind" NOT NULL,
    "purpose" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "expectedSha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "storeUploadId" TEXT,
    "storeParts" JSONB,
    "blobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blob_upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blob_chunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadId" TEXT,
    "blobId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "offset" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "blob_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_state" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierSecretRef" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_projectId_open_trackerUpdatedAt_idx" ON "ticket"("projectId", "open", "trackerUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_boardId_externalId_key" ON "ticket"("boardId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_id_projectId_key" ON "ticket"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_write_idempotencyKey_key" ON "ticket_write"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ticket_write_taskId_idx" ON "ticket_write"("taskId");

-- CreateIndex
CREATE INDEX "ticket_write_state_createdAt_idx" ON "ticket_write"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_organizationId_key_key" ON "idempotency_record"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "rate_budget_organizationId_key_key" ON "rate_budget"("organizationId", "key");

-- CreateIndex
CREATE INDEX "blob_taskId_idx" ON "blob"("taskId");

-- CreateIndex
CREATE INDEX "blob_organizationId_createdAt_idx" ON "blob"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "blob_store_key_key" ON "blob"("store", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blob_id_organizationId_key" ON "blob"("id", "organizationId");

-- CreateIndex
CREATE INDEX "blob_upload_organizationId_purpose_expectedSha256_idx" ON "blob_upload"("organizationId", "purpose", "expectedSha256");

-- CreateIndex
CREATE UNIQUE INDEX "blob_upload_id_organizationId_key" ON "blob_upload"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "blob_chunk_uploadId_ordinal_key" ON "blob_chunk"("uploadId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "blob_chunk_blobId_ordinal_key" ON "blob_chunk"("blobId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_state_stateHash_key" ON "oauth_state"("stateHash");

-- CreateIndex
CREATE INDEX "oauth_state_connectionId_idx" ON "oauth_state"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "connection_one_linear_per_organization" ON "connection"("organizationId") WHERE (kind = 'linear' AND state <> 'revoked');

-- CreateIndex
CREATE UNIQUE INDEX "board_id_projectId_key" ON "board"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "task_one_active_code_task_per_ticket" ON "task"("projectId", "ticketId") WHERE (kind = 'code' AND "ticketId" IS NOT NULL AND state NOT IN ('stopped', 'merged', 'done'));

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_connectionId_signatureHash_key" ON "webhook_delivery"("connectionId", "signatureHash");

-- AddForeignKey
ALTER TABLE "organization_setting" ADD CONSTRAINT "organization_setting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_boardId_projectId_fkey" FOREIGN KEY ("boardId", "projectId") REFERENCES "board"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_connectionId_organizationId_fkey" FOREIGN KEY ("connectionId", "organizationId") REFERENCES "connection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_boardId_projectId_fkey" FOREIGN KEY ("boardId", "projectId") REFERENCES "board"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_ticketId_projectId_fkey" FOREIGN KEY ("ticketId", "projectId") REFERENCES "ticket"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_ticketId_projectId_fkey" FOREIGN KEY ("ticketId", "projectId") REFERENCES "ticket"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_boardId_projectId_fkey" FOREIGN KEY ("boardId", "projectId") REFERENCES "board"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_budget" ADD CONSTRAINT "rate_budget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob" ADD CONSTRAINT "blob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob" ADD CONSTRAINT "blob_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob" ADD CONSTRAINT "blob_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_chunk" ADD CONSTRAINT "blob_chunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_chunk" ADD CONSTRAINT "blob_chunk_uploadId_organizationId_fkey" FOREIGN KEY ("uploadId", "organizationId") REFERENCES "blob_upload"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blob_chunk" ADD CONSTRAINT "blob_chunk_blobId_organizationId_fkey" FOREIGN KEY ("blobId", "organizationId") REFERENCES "blob"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_connectionId_organizationId_fkey" FOREIGN KEY ("connectionId", "organizationId") REFERENCES "connection"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ostra: checks Prisma can't declare.

-- A chunk belongs to its upload while that's in flight, or to its blob after: exactly one.
ALTER TABLE "blob_chunk" ADD CONSTRAINT "blob_chunk_one_owner" CHECK (num_nonnulls("uploadId", "blobId") = 1);
-- At most 1 MiB a row (ADR 0043), from offset 0.
ALTER TABLE "blob_chunk" ADD CONSTRAINT "blob_chunk_size" CHECK (octet_length("bytes") BETWEEN 1 AND 1048576 AND "ordinal" >= 0 AND "offset" >= 0);
ALTER TABLE "blob" ADD CONSTRAINT "blob_size_and_digest" CHECK ("size" >= 0 AND "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_progress" CHECK ("size" >= 0 AND "receivedBytes" BETWEEN 0 AND "size" AND "expectedSha256" ~ '^[0-9a-f]{64}$');
-- Only `create` waits for its ticket.
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_ticket_set" CHECK ("kind" = 'create' OR "ticketId" IS NOT NULL);
ALTER TABLE "ticket_write" ADD CONSTRAINT "ticket_write_attempts" CHECK ("attempts" >= 0);
-- A task's ticket is always on one of its project's boards.
ALTER TABLE "task" ADD CONSTRAINT "task_ticket_has_board" CHECK ("ticketId" IS NULL OR "boardId" IS NOT NULL);
ALTER TABLE "task" ADD CONSTRAINT "task_spent" CHECK ("spentMicroUsd" >= 0);
ALTER TABLE "session" ADD CONSTRAINT "session_spent" CHECK ("spentMicroUsd" >= 0);
-- Retention is a positive number of days, or null for "keep".
ALTER TABLE "instance_setting" ADD CONSTRAINT "instance_setting_retention_days" CHECK ("retentionDays" IS NULL OR "retentionDays" > 0);
-- Linear's priority scale.
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_priority" CHECK ("priority" IS NULL OR "priority" BETWEEN 0 AND 4);
