-- Milestone 8 (ticket 04, spec section 5.3, ADR 0068, ADR 0069): previews and the library. An
-- environment's app processes and its after-turn screenshots, a service's preview label, the
-- task's preview ID, its screenshots and recordings, the ports its agent announced, who may open a
-- preview, its links, its views and their presence, the one-time codes and the CLI's tickets, a
-- watched box, a lease that starts only the app, the organization's two switches, and the skills
-- and MCP library: its items, their versions, their profiles, the sources it may install from and
-- the members' suggestions. Every row carries `organizationId`; every project record carries
-- `projectId` with the composite key to its project.
-- Additive only: new enums, tables, nullable columns or columns with defaults, checks, comments
-- and indexes. Nothing is renamed or dropped, and nothing is backfilled: every environment has no
-- app process, every task no preview ID, every lease the purpose `turn`, both switches are off,
-- and the registry source is seeded by ticket 06's job, not here.

-- CreateEnum
CREATE TYPE "AppReadyKind" AS ENUM ('http', 'command', 'port');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('screenshot', 'recording');

-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('agent', 'after_turn', 'member');

-- CreateEnum
CREATE TYPE "PreviewTargetKind" AS ENUM ('process', 'port', 'service');

-- CreateEnum
CREATE TYPE "PreviewLevel" AS ENUM ('members', 'named');

-- CreateEnum
CREATE TYPE "PreviewLinkKind" AS ENUM ('expiring', 'public');

-- CreateEnum
CREATE TYPE "PreviewViewMode" AS ENUM ('stream', 'tunnel', 'native', 'cli');

-- CreateEnum
CREATE TYPE "PreviewViewState" AS ENUM ('opening', 'open', 'closed');

-- CreateEnum
CREATE TYPE "PreviewCodeKind" AS ENUM ('enter', 'cli_ticket');

-- CreateEnum
CREATE TYPE "LeasePurpose" AS ENUM ('turn', 'app');

-- CreateEnum
CREATE TYPE "LibraryItemKind" AS ENUM ('skill', 'mcp_server');

-- CreateEnum
CREATE TYPE "LibraryItemSourceKind" AS ENUM ('github', 'well_known', 'registry');

-- CreateEnum
CREATE TYPE "LibrarySourceKind" AS ENUM ('github_owner', 'github_repo', 'well_known_host', 'registry');

-- CreateEnum
CREATE TYPE "LibraryVersionState" AS ENUM ('current', 'available', 'superseded', 'dismissed');

-- CreateEnum
CREATE TYPE "LibrarySuggestionState" AS ENUM ('open', 'installed', 'dismissed');

-- AlterTable
ALTER TABLE "organization_setting" ADD COLUMN     "marketplaceSearch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicPreviewLinks" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "environment" ADD COLUMN     "screenshotRoutes" JSONB NOT NULL DEFAULT '["/"]',
ADD COLUMN     "screenshotWidths" JSONB NOT NULL DEFAULT '["desktop"]',
ADD COLUMN     "screenshotsAfterTurn" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "service" ADD COLUMN     "previewLabel" TEXT;

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "previewId" VARCHAR(26);

-- AlterTable
ALTER TABLE "box" ADD COLUMN     "previewWatchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "lease" ADD COLUMN     "appStartedByMemberId" TEXT,
ADD COLUMN     "purpose" "LeasePurpose" NOT NULL DEFAULT 'turn';

-- CreateTable
CREATE TABLE "app_process" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT '.',
    "command" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "readyKind" "AppReadyKind" NOT NULL,
    "readyValue" TEXT,
    "label" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "hostRewrite" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_process_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "blobId" TEXT NOT NULL,
    "source" "AttachmentSource" NOT NULL,
    "targetKind" "PreviewTargetKind" NOT NULL,
    "targetName" TEXT,
    "port" INTEGER,
    "path" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "frameCount" INTEGER,
    "caption" TEXT,
    "browserName" TEXT NOT NULL,
    "browserVersion" TEXT NOT NULL,
    "turnId" TEXT,
    "memberId" TEXT,
    "draftImageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_preview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '/',
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "announcedInTurnId" TEXT,
    "keptProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_preview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_access" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "level" "PreviewLevel" NOT NULL DEFAULT 'members',
    "setByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_access_member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "previewAccessId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_access_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_link" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "PreviewLinkKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "allowInput" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdByMemberId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByMemberId" TEXT,
    "firstUsedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_view" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "PreviewViewMode" NOT NULL,
    "openedByMemberId" TEXT,
    "linkId" TEXT,
    "leaseId" TEXT,
    "leaseEpoch" INTEGER NOT NULL,
    "replicaUrl" TEXT,
    "state" "PreviewViewState" NOT NULL DEFAULT 'opening',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "preview_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_code" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "PreviewCodeKind" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "memberId" TEXT,
    "linkId" TEXT,
    "leaseEpoch" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "LibraryItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKind" "LibraryItemSourceKind" NOT NULL,
    "source" JSONB NOT NULL,
    "everyProfile" BOOLEAN NOT NULL DEFAULT false,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "installedByMemberId" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_item_version" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "LibraryVersionState" NOT NULL,
    "ref" TEXT,
    "commitSha" TEXT,
    "computedHash" TEXT,
    "files" JSONB NOT NULL DEFAULT '[]',
    "registryVersion" TEXT,
    "serverEntry" JSONB,
    "serverInputs" JSONB,
    "toolNames" JSONB NOT NULL DEFAULT '[]',
    "needsOAuth" BOOLEAN NOT NULL DEFAULT false,
    "diff" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByMemberId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_item_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profile_library_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "attachedByMemberId" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profile_library_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_source" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "LibrarySourceKind" NOT NULL,
    "value" TEXT NOT NULL,
    "namespace" TEXT,
    "addedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_suggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "state" "LibrarySuggestionState" NOT NULL DEFAULT 'open',
    "decidedByMemberId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "itemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_process_environmentId_name_key" ON "app_process"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "app_process_environmentId_port_key" ON "app_process"("environmentId", "port");

-- CreateIndex
CREATE UNIQUE INDEX "app_process_one_primary" ON "app_process"("environmentId") WHERE ("primary");

-- CreateIndex
CREATE INDEX "task_attachment_taskId_createdAt_idx" ON "task_attachment"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_attachment_taskId_attachmentId_key" ON "task_attachment"("taskId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "task_preview_taskId_key_key" ON "task_preview"("taskId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "preview_access_taskId_key_key" ON "preview_access"("taskId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "preview_access_id_projectId_key" ON "preview_access"("id", "projectId");

-- CreateIndex
CREATE INDEX "preview_access_member_memberId_idx" ON "preview_access_member"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_access_member_previewAccessId_memberId_key" ON "preview_access_member"("previewAccessId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_link_tokenHash_key" ON "preview_link"("tokenHash");

-- CreateIndex
CREATE INDEX "preview_link_taskId_key_idx" ON "preview_link"("taskId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "preview_link_id_projectId_key" ON "preview_link"("id", "projectId");

-- CreateIndex
CREATE INDEX "preview_view_state_lastHeartbeatAt_idx" ON "preview_view"("state", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "preview_view_taskId_key_idx" ON "preview_view"("taskId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "preview_code_codeHash_key" ON "preview_code"("codeHash");

-- CreateIndex
CREATE INDEX "preview_code_expiresAt_idx" ON "preview_code"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "library_item_currentVersionId_key" ON "library_item"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "library_item_id_organizationId_key" ON "library_item"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "library_item_one_name" ON "library_item"("organizationId", "kind", "name") WHERE ("removedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "library_item_version_itemId_number_key" ON "library_item_version"("itemId", "number");

-- CreateIndex
CREATE INDEX "agent_profile_library_item_itemId_idx" ON "agent_profile_library_item"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_library_item_profileId_itemId_key" ON "agent_profile_library_item"("profileId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "library_source_organizationId_kind_value_namespace_key" ON "library_source"("organizationId", "kind", "value", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "library_source_one_without_namespace" ON "library_source"("organizationId", "kind", "value") WHERE (namespace IS NULL);

-- CreateIndex
CREATE INDEX "library_suggestion_organizationId_state_idx" ON "library_suggestion"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "task_previewId_key" ON "task"("previewId");

-- AddForeignKey
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_repoId_projectId_fkey" FOREIGN KEY ("repoId", "projectId") REFERENCES "repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_blobId_organizationId_fkey" FOREIGN KEY ("blobId", "organizationId") REFERENCES "blob"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_preview" ADD CONSTRAINT "task_preview_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_preview" ADD CONSTRAINT "task_preview_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_access" ADD CONSTRAINT "preview_access_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_access" ADD CONSTRAINT "preview_access_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_access_member" ADD CONSTRAINT "preview_access_member_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_access_member" ADD CONSTRAINT "preview_access_member_previewAccessId_projectId_fkey" FOREIGN KEY ("previewAccessId", "projectId") REFERENCES "preview_access"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_access_member" ADD CONSTRAINT "preview_access_member_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link" ADD CONSTRAINT "preview_link_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link" ADD CONSTRAINT "preview_link_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_linkId_projectId_fkey" FOREIGN KEY ("linkId", "projectId") REFERENCES "preview_link"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_linkId_projectId_fkey" FOREIGN KEY ("linkId", "projectId") REFERENCES "preview_link"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_item" ADD CONSTRAINT "library_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_item" ADD CONSTRAINT "library_item_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "library_item_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_item_version" ADD CONSTRAINT "library_item_version_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "library_item"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_library_item" ADD CONSTRAINT "agent_profile_library_item_profileId_organizationId_fkey" FOREIGN KEY ("profileId", "organizationId") REFERENCES "agent_profile"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_library_item" ADD CONSTRAINT "agent_profile_library_item_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "library_item"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source" ADD CONSTRAINT "library_source_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_suggestion" ADD CONSTRAINT "library_suggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_suggestion" ADD CONSTRAINT "library_suggestion_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "library_item"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ostra: checks Prisma can't declare.
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_port_allowed" CHECK ("port" BETWEEN 1024 AND 65535);
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_ready_value_unless_port" CHECK (("readyValue" IS NULL) = ("readyKind" = 'port'));
ALTER TABLE "app_process" ADD CONSTRAINT "app_process_position_nonnegative" CHECK ("position" >= 0);
ALTER TABLE "task" ADD CONSTRAINT "task_preview_id_base32" CHECK ("previewId" IS NULL OR "previewId" ~ '^[a-z2-7]{26}$');
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_name_unless_port" CHECK (("targetName" IS NULL) = ("targetKind" = 'port'));
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_recording_has_length" CHECK (("durationMs" IS NOT NULL AND "frameCount" IS NOT NULL) = ("kind" = 'recording'));
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_size_positive" CHECK ("width" > 0 AND "height" > 0);
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_member_for_member" CHECK ("memberId" IS NOT NULL OR "source" <> 'member');
ALTER TABLE "task_preview" ADD CONSTRAINT "task_preview_port_allowed" CHECK ("port" BETWEEN 1024 AND 65535);
ALTER TABLE "preview_link" ADD CONSTRAINT "preview_link_expires_unless_public" CHECK (("expiresAt" IS NULL) = ("kind" = 'public'));
ALTER TABLE "preview_link" ADD CONSTRAINT "preview_link_revoked_has_member" CHECK ("revokedAt" IS NULL OR "revokedByMemberId" IS NOT NULL);
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_closed_has_time" CHECK (("closedAt" IS NOT NULL) = ("state" = 'closed'));
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_member_or_link" CHECK (("openedByMemberId" IS NULL) <> ("linkId" IS NULL));
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_member_or_link" CHECK (("memberId" IS NULL) <> ("linkId" IS NULL));
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_ticket_is_a_member_s" CHECK ("kind" <> 'cli_ticket' OR "memberId" IS NOT NULL);
ALTER TABLE "lease" ADD CONSTRAINT "lease_app_starter_only_for_app" CHECK ("appStartedByMemberId" IS NULL OR "purpose" = 'app');
ALTER TABLE "library_item_version" ADD CONSTRAINT "library_item_version_number_positive" CHECK ("number" > 0);
ALTER TABLE "library_item_version" ADD CONSTRAINT "library_item_version_decided_has_member" CHECK ("decidedAt" IS NULL OR "decidedByMemberId" IS NOT NULL);
ALTER TABLE "library_item" ADD CONSTRAINT "library_item_removed_has_member" CHECK ("removedAt" IS NULL OR "removedByMemberId" IS NOT NULL);
ALTER TABLE "library_suggestion" ADD CONSTRAINT "library_suggestion_decided_unless_open" CHECK (("decidedAt" IS NULL) = ("state" = 'open'));

-- ostra: the text that is untrusted or private, and what a log never carries.
COMMENT ON COLUMN "app_process"."command" IS 'ostra: an app process''s command, run through the init''s argument array. Never logged.';
COMMENT ON COLUMN "app_process"."readyValue" IS 'ostra: a ready check''s path or command. A command is never logged.';
COMMENT ON COLUMN "task_attachment"."caption" IS 'ostra: the agent''s caption. Untrusted text: never logged.';
COMMENT ON COLUMN "preview_link"."tokenHash" IS 'ostra: the SHA-256 of a link''s bearer token. Neither it nor the token is logged.';
COMMENT ON COLUMN "preview_code"."codeHash" IS 'ostra: the SHA-256 of a one-time code or a CLI ticket. Neither it nor the code is logged.';
COMMENT ON COLUMN "library_item_version"."serverInputs" IS 'ostra: a server''s plain inputs and secret references, never a secret''s value. Never logged.';
COMMENT ON COLUMN "library_item_version"."files" IS 'ostra: a skill''s files by blob. Their content is never logged.';
COMMENT ON COLUMN "library_suggestion"."note" IS 'ostra: a member''s note. Never logged.';
