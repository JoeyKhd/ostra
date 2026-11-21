-- Milestone 9 (ticket 04, spec section 5.3, ADR 0070): files for the agent. A message's files and
-- a ticket's (`message_file`), each read of a ticket for its task (`task_ticket_read`), a model's
-- image input, and a ticket update's turn origin. Additive: new enums, tables and nullable columns,
-- and one enum value. Nothing is seeded: the catalog's next sync fills `catalogInputModalities`.

-- CreateEnum
CREATE TYPE "MessageFileOrigin" AS ENUM ('member', 'ticket');

-- CreateEnum
CREATE TYPE "MessageFileState" AS ENUM ('uploaded', 'sent', 'expired', 'left_out', 'failed');

-- CreateEnum
CREATE TYPE "MessageFileKind" AS ENUM ('image', 'document', 'text', 'file');

-- CreateEnum
CREATE TYPE "FileTextState" AS ENUM ('none', 'ready', 'failed', 'off');

-- CreateEnum
CREATE TYPE "TicketReadReason" AS ENUM ('start', 'reopen', 'member', 'retry');

-- AlterEnum
ALTER TYPE "HeldTurnOrigin" ADD VALUE 'ticket_update';

-- AlterTable
ALTER TABLE "model" ADD COLUMN     "adminImageInput" BOOLEAN,
ADD COLUMN     "catalogInputModalities" JSONB;

-- CreateTable
CREATE TABLE "message_file" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "memberId" TEXT,
    "origin" "MessageFileOrigin" NOT NULL,
    "state" "MessageFileState" NOT NULL DEFAULT 'uploaded',
    "reason" TEXT,
    "sessionId" TEXT,
    "clientMessageId" TEXT,
    "eventSeq" INTEGER,
    "position" INTEGER,
    "name" TEXT NOT NULL,
    "kind" "MessageFileKind" NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT,
    "blobId" TEXT,
    "boxPath" TEXT,
    "asImage" BOOLEAN NOT NULL DEFAULT false,
    "textState" "FileTextState" NOT NULL DEFAULT 'none',
    "textReason" TEXT,
    "textBlobId" TEXT,
    "textWords" INTEGER,
    "textTruncated" BOOLEAN NOT NULL DEFAULT false,
    "ticketWhere" TEXT,
    "ticketCommentId" TEXT,
    "ticketSourceKey" TEXT,
    "retryOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "message_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_ticket_read" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "reason" "TicketReadReason" NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "descriptionSha256" TEXT NOT NULL,
    "comments" JSONB NOT NULL DEFAULT '[]',
    "fileKeys" JSONB NOT NULL DEFAULT '[]',
    "eventSeq" INTEGER,

    CONSTRAINT "task_ticket_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_file_taskId_eventSeq_position_idx" ON "message_file"("taskId", "eventSeq", "position");

-- CreateIndex
CREATE INDEX "message_file_state_createdAt_idx" ON "message_file"("state", "createdAt");

-- CreateIndex
CREATE INDEX "message_file_organizationId_projectId_memberId_state_idx" ON "message_file"("organizationId", "projectId", "memberId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "message_file_one_per_place" ON "message_file"("taskId", "boxPath") WHERE ("boxPath" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "task_ticket_read_taskId_round_key" ON "task_ticket_read"("taskId", "round");

-- AddForeignKey
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- ostra: a blob's deletion unsets the file's blob and keeps the row (and its organization): Prisma
-- writes `SET NULL` over both columns of the composite key, which would null `organizationId`, so
-- the action names its one column (Postgres 15 and later).
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_blobId_organizationId_fkey" FOREIGN KEY ("blobId", "organizationId") REFERENCES "blob"("id", "organizationId") ON DELETE SET NULL ("blobId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_textBlobId_organizationId_fkey" FOREIGN KEY ("textBlobId", "organizationId") REFERENCES "blob"("id", "organizationId") ON DELETE SET NULL ("textBlobId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ticket_read" ADD CONSTRAINT "task_ticket_read_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_ticket_read" ADD CONSTRAINT "task_ticket_read_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ostra: checks Prisma can't declare.
-- A member's file names its uploader; a ticket's has none.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_member_has_uploader" CHECK (("memberId" IS NOT NULL) = ("origin" = 'member'));
-- An upload is a member's and belongs to no task until a message takes it.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_upload_unsent" CHECK ("state" <> 'uploaded' OR ("origin" = 'member' AND "taskId" IS NULL AND "eventSeq" IS NULL AND "boxPath" IS NULL));
-- A sent file is its message's: its task, its event, its place in the message and in the box.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_sent_placed" CHECK ("state" <> 'sent' OR ("taskId" IS NOT NULL AND "eventSeq" IS NOT NULL AND "position" IS NOT NULL AND "boxPath" IS NOT NULL AND "sentAt" IS NOT NULL));
-- A ticket's file is a task's whatever became of it, and a left-out or failed one names its reason.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_ticket_has_task" CHECK ("origin" <> 'ticket' OR "taskId" IS NOT NULL);
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_out_has_reason" CHECK ("state" NOT IN ('left_out', 'failed') OR "reason" IS NOT NULL);
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_failed_text_has_reason" CHECK ("textState" <> 'failed' OR "textReason" IS NOT NULL);
-- Where on the ticket a file was: a ticket's only.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_ticket_where" CHECK (("ticketWhere" IS NULL OR "ticketWhere" IN ('description', 'comment', 'attachment')) AND ("origin" = 'ticket' OR ("ticketWhere" IS NULL AND "ticketCommentId" IS NULL AND "ticketSourceKey" IS NULL)));
-- Digests are lower-case hex SHA-256s; a source key is one, never a URL.
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_digests" CHECK (("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$') AND ("ticketSourceKey" IS NULL OR "ticketSourceKey" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_counts" CHECK ("size" >= 0 AND ("position" IS NULL OR "position" >= 0) AND ("eventSeq" IS NULL OR "eventSeq" >= 1) AND ("textWords" IS NULL OR "textWords" >= 0));
-- A read's round counts from 1, its digest is a SHA-256, and its lists are JSON arrays.
ALTER TABLE "task_ticket_read" ADD CONSTRAINT "task_ticket_read_round_positive" CHECK ("round" >= 1 AND ("eventSeq" IS NULL OR "eventSeq" >= 1));
ALTER TABLE "task_ticket_read" ADD CONSTRAINT "task_ticket_read_digest" CHECK ("descriptionSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "task_ticket_read" ADD CONSTRAINT "task_ticket_read_arrays" CHECK (jsonb_typeof("comments") = 'array' AND jsonb_typeof("fileKeys") = 'array');
-- A model's inputs, from the catalog, are a JSON array of words.
ALTER TABLE "model" ADD CONSTRAINT "model_catalog_input_modalities_array" CHECK ("catalogInputModalities" IS NULL OR jsonb_typeof("catalogInputModalities") = 'array');

-- ostra: the text that is untrusted or private, and what a log never carries.
COMMENT ON COLUMN "message_file"."name" IS 'ostra: a file''s safe name, the member''s or the ticket''s. Never logged.';
COMMENT ON COLUMN "message_file"."boxPath" IS 'ostra: a file''s place under .ostra/, which holds its name. Never logged.';
COMMENT ON COLUMN "message_file"."textBlobId" IS 'ostra: the blob of a document''s text. The text is never logged.';
COMMENT ON COLUMN "message_file"."ticketSourceKey" IS 'ostra: the SHA-256 of a ticket file''s URL on the tracker; the URL itself is never stored.';
COMMENT ON COLUMN "task_ticket_read"."descriptionSha256" IS 'ostra: the SHA-256 of the ticket''s description as the agent got it; the ticket''s text is never stored here, nor logged.';
