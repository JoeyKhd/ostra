-- Milestone 6 (ticket 05, spec section 5.3): the whole team. Automations' schedules, pauses and
-- runs, bulk starts, Linear agent sessions and their outbox of activities, outside tasks'
-- approval, refine drafts and their images, CI results per head, fixing rounds, AI review runs and
-- their findings, PR reviewers, environment proposals, the built-in profiles' kind, and the enum
-- values milestone 6's notifications, needs-you items, memory proposals and held turns need.
-- Additive only: new enums and enum values, tables, nullable columns or columns with defaults,
-- checks, comments and indexes. Nothing is renamed or dropped, and nothing is backfilled: the
-- built-in Refine and Review profiles are seeded by the domain (ticket 06), not here.
--
-- `HeldTurnOrigin` gains `changes_requested` and `linear_follow_up`, the budget gate's two new
-- origins (ticket 06). The new enum values are used by no statement here: Postgres refuses a value
-- added in the same transaction.

-- CreateEnum
CREATE TYPE "TaskOrigin" AS ENUM ('member', 'automation', 'tracker', 'pr_review', 'onboarding');

-- CreateEnum
CREATE TYPE "AutomationRunKind" AS ENUM ('occurrence', 'ticket_match', 'start_all');

-- CreateEnum
CREATE TYPE "AutomationRunState" AS ENUM ('started', 'skipped', 'missed');

-- CreateEnum
CREATE TYPE "AutomationSkipReason" AS ENUM ('last_open', 'has_task', 'paused', 'hourly_limit', 'over_limit', 'budget');

-- CreateEnum
CREATE TYPE "AutomationPauseReason" AS ENUM ('member', 'hourly_limit');

-- CreateEnum
CREATE TYPE "BulkStartSource" AS ENUM ('inbox', 'dry_run');

-- CreateEnum
CREATE TYPE "BulkStartItemState" AS ENUM ('pending', 'started', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "AgentSessionState" AS ENUM ('active', 'awaiting_approval', 'ended');

-- CreateEnum
CREATE TYPE "AgentActivityKind" AS ENUM ('thought', 'action', 'elicitation', 'response', 'error');

-- CreateEnum
CREATE TYPE "AgentActivityState" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('agent', 'member');

-- CreateEnum
CREATE TYPE "CiRunState" AS ENUM ('pending', 'passed', 'failed', 'none', 'timed_out');

-- CreateEnum
CREATE TYPE "RoundKind" AS ENUM ('ci', 'findings', 'changes_requested');

-- CreateEnum
CREATE TYPE "RoundState" AS ENUM ('started', 'held', 'capped');

-- CreateEnum
CREATE TYPE "ReviewRunState" AS ENUM ('running', 'submitted', 'posted', 'failed');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('blocking', 'nit');

-- CreateEnum
CREATE TYPE "FindingPostedAs" AS ENUM ('line_comment', 'review_body');

-- CreateEnum
CREATE TYPE "FindingState" AS ENUM ('open', 'resolved', 'outdated');

-- CreateEnum
CREATE TYPE "ReviewerSource" AS ENUM ('requested', 'codeowners', 'team');

-- CreateEnum
CREATE TYPE "EnvironmentProposalState" AS ENUM ('proposed', 'accepted', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "BuiltInProfileKind" AS ENUM ('refine', 'review');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HeldTurnOrigin" ADD VALUE 'changes_requested';
ALTER TYPE "HeldTurnOrigin" ADD VALUE 'linear_follow_up';

-- AlterEnum
ALTER TYPE "MemorySourceKind" ADD VALUE 'ai_finding';

-- AlterEnum
ALTER TYPE "NeedsYouReason" ADD VALUE 'awaiting_approval';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'draft_ready';
ALTER TYPE "NotificationKind" ADD VALUE 'review_requested';
ALTER TYPE "NotificationKind" ADD VALUE 'task_approval';
ALTER TYPE "NotificationKind" ADD VALUE 'round_cap';
ALTER TYPE "NotificationKind" ADD VALUE 'automation_paused';

-- AlterEnum
ALTER TYPE "ProposalSourceKind" ADD VALUE 'ai_finding';

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "builtInKind" "BuiltInProfileKind";

-- AlterTable
ALTER TABLE "automation" ADD COLUMN     "createdByMemberId" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lastOccurrenceAt" TIMESTAMP(3),
ADD COLUMN     "nextOccurrenceAt" TIMESTAMP(3),
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" "AutomationPauseReason",
ADD COLUMN     "prompt" TEXT,
ADD COLUMN     "requireApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "skipWhileOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "title" TEXT,
ADD COLUMN     "updatedByMemberId" TEXT;

-- AlterTable
ALTER TABLE "board" ADD COLUMN     "agentMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "agentModeAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "aiReview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "outsideApproval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "outsideApprovalChangedByMemberId" TEXT;

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByMemberId" TEXT,
ADD COLUMN     "automaticTurns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "automationId" TEXT,
ADD COLUMN     "bulkStartId" TEXT,
ADD COLUMN     "ciRounds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastPersonActionAt" TIMESTAMP(3),
ADD COLUMN     "onboarding" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin" "TaskOrigin" NOT NULL DEFAULT 'member',
ADD COLUMN     "parentTicketId" TEXT,
ADD COLUMN     "poolOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "reviewRounds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackerActorId" TEXT,
ADD COLUMN     "trackerActorName" TEXT;

-- CreateTable
CREATE TABLE "automation_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "kind" "AutomationRunKind" NOT NULL,
    "occurrenceAt" TIMESTAMP(3),
    "ticketId" TEXT,
    "state" "AutomationRunState" NOT NULL,
    "skipReason" "AutomationSkipReason",
    "taskId" TEXT,
    "bulkStartId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_start" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "source" "BulkStartSource" NOT NULL,
    "automationId" TEXT,
    "requestKey" TEXT NOT NULL,
    "taskKind" "TaskKind" NOT NULL,
    "agentProfileId" TEXT,
    "requested" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_start_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_start_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bulkStartId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "state" "BulkStartItemState" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_start_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalSessionId" TEXT NOT NULL,
    "projectId" TEXT,
    "ticketId" TEXT,
    "taskId" TEXT,
    "boardId" TEXT,
    "state" "AgentSessionState" NOT NULL DEFAULT 'active',
    "creatorExternalId" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "matchedMemberId" TEXT,
    "lastPostAt" TIMESTAMP(3),
    "heartbeatDueAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_activity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "kind" "AgentActivityKind" NOT NULL,
    "ephemeral" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" "AgentActivityState" NOT NULL DEFAULT 'pending',
    "externalActivityId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refine_draft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" JSONB NOT NULL DEFAULT '[]',
    "edgeCases" JSONB NOT NULL DEFAULT '[]',
    "openQuestions" JSONB NOT NULL DEFAULT '[]',
    "subTickets" JSONB NOT NULL DEFAULT '[]',
    "source" "DraftSource" NOT NULL,
    "editedByMemberId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedByMemberId" TEXT,
    "readyAt" TIMESTAMP(3),
    "createdTicketKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refine_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refine_draft_image" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refine_draft_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ci_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskRepoId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "state" "CiRunState" NOT NULL DEFAULT 'pending',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "logBlobIds" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_round" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" "RoundKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "automatic" BOOLEAN NOT NULL,
    "causeRef" TEXT NOT NULL,
    "turnId" TEXT,
    "state" "RoundState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeTaskId" TEXT NOT NULL,
    "reviewTaskId" TEXT,
    "round" INTEGER NOT NULL,
    "heads" JSONB NOT NULL DEFAULT '[]',
    "state" "ReviewRunState" NOT NULL DEFAULT 'running',
    "summary" TEXT,
    "blocking" INTEGER NOT NULL DEFAULT 0,
    "nits" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "taskRepoId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "side" "DiffSide" NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "suggestion" TEXT,
    "postedAs" "FindingPostedAs",
    "externalCommentId" TEXT,
    "state" "FindingState" NOT NULL DEFAULT 'open',
    "resolvedInRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_reviewer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskRepoId" TEXT NOT NULL,
    "githubUserId" TEXT,
    "login" TEXT,
    "teamSlug" TEXT,
    "memberId" TEXT,
    "source" "ReviewerSource" NOT NULL,
    "lastReviewState" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_reviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_proposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "notes" TEXT,
    "state" "EnvironmentProposalState" NOT NULL DEFAULT 'proposed',
    "decidedByMemberId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resultVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_run_automationId_createdAt_idx" ON "automation_run"("automationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_one_per_occurrence" ON "automation_run"("automationId", "occurrenceAt") WHERE (kind = 'occurrence');

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_one_match_per_ticket" ON "automation_run"("automationId", "ticketId") WHERE (kind = 'ticket_match');

-- CreateIndex
CREATE UNIQUE INDEX "bulk_start_memberId_requestKey_key" ON "bulk_start"("memberId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_start_id_projectId_key" ON "bulk_start"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_start_item_bulkStartId_ticketId_key" ON "bulk_start_item"("bulkStartId", "ticketId");

-- CreateIndex
CREATE INDEX "agent_session_heartbeat_due" ON "agent_session"("heartbeatDueAt") WHERE (state <> 'ended');

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_connectionId_externalSessionId_key" ON "agent_session"("connectionId", "externalSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_id_organizationId_key" ON "agent_session"("id", "organizationId");

-- CreateIndex
CREATE INDEX "agent_activity_state_createdAt_idx" ON "agent_activity"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_activity_organizationId_idempotencyKey_key" ON "agent_activity"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "refine_draft_taskId_version_key" ON "refine_draft"("taskId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "refine_draft_id_projectId_key" ON "refine_draft"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ci_run_taskRepoId_headSha_key" ON "ci_run"("taskRepoId", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "task_round_taskId_kind_causeRef_key" ON "task_round"("taskId", "kind", "causeRef");

-- CreateIndex
CREATE UNIQUE INDEX "review_run_codeTaskId_round_key" ON "review_run"("codeTaskId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "review_run_id_projectId_key" ON "review_run"("id", "projectId");

-- CreateIndex
CREATE INDEX "finding_reviewRunId_idx" ON "finding"("reviewRunId");

-- CreateIndex
CREATE UNIQUE INDEX "task_reviewer_taskRepoId_githubUserId_key" ON "task_reviewer"("taskRepoId", "githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "task_reviewer_taskRepoId_teamSlug_key" ON "task_reviewer"("taskRepoId", "teamSlug");

-- CreateIndex
CREATE INDEX "automation_due_schedules" ON "automation"("enabled", "nextOccurrenceAt") WHERE (schedule IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "automation_id_projectId_key" ON "automation"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "board_one_agent_mode_board_per_team" ON "board"("organizationId", "connectionId", "externalId") WHERE ("agentMode");

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_automationId_projectId_fkey" FOREIGN KEY ("automationId", "projectId") REFERENCES "automation"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_ticketId_projectId_fkey" FOREIGN KEY ("ticketId", "projectId") REFERENCES "ticket"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_bulkStartId_projectId_fkey" FOREIGN KEY ("bulkStartId", "projectId") REFERENCES "bulk_start"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start" ADD CONSTRAINT "bulk_start_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start" ADD CONSTRAINT "bulk_start_automationId_projectId_fkey" FOREIGN KEY ("automationId", "projectId") REFERENCES "automation"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start_item" ADD CONSTRAINT "bulk_start_item_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start_item" ADD CONSTRAINT "bulk_start_item_bulkStartId_projectId_fkey" FOREIGN KEY ("bulkStartId", "projectId") REFERENCES "bulk_start"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start_item" ADD CONSTRAINT "bulk_start_item_ticketId_projectId_fkey" FOREIGN KEY ("ticketId", "projectId") REFERENCES "ticket"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_start_item" ADD CONSTRAINT "bulk_start_item_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_connectionId_organizationId_fkey" FOREIGN KEY ("connectionId", "organizationId") REFERENCES "connection"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_ticketId_projectId_fkey" FOREIGN KEY ("ticketId", "projectId") REFERENCES "ticket"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_boardId_projectId_fkey" FOREIGN KEY ("boardId", "projectId") REFERENCES "board"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_agentSessionId_organizationId_fkey" FOREIGN KEY ("agentSessionId", "organizationId") REFERENCES "agent_session"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refine_draft" ADD CONSTRAINT "refine_draft_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refine_draft" ADD CONSTRAINT "refine_draft_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refine_draft_image" ADD CONSTRAINT "refine_draft_image_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refine_draft_image" ADD CONSTRAINT "refine_draft_image_draftId_projectId_fkey" FOREIGN KEY ("draftId", "projectId") REFERENCES "refine_draft"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refine_draft_image" ADD CONSTRAINT "refine_draft_image_blobId_organizationId_fkey" FOREIGN KEY ("blobId", "organizationId") REFERENCES "blob"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_run" ADD CONSTRAINT "ci_run_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_run" ADD CONSTRAINT "ci_run_taskRepoId_projectId_fkey" FOREIGN KEY ("taskRepoId", "projectId") REFERENCES "task_repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_round" ADD CONSTRAINT "task_round_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_round" ADD CONSTRAINT "task_round_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_run" ADD CONSTRAINT "review_run_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_run" ADD CONSTRAINT "review_run_codeTaskId_projectId_fkey" FOREIGN KEY ("codeTaskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_run" ADD CONSTRAINT "review_run_reviewTaskId_projectId_fkey" FOREIGN KEY ("reviewTaskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_reviewRunId_projectId_fkey" FOREIGN KEY ("reviewRunId", "projectId") REFERENCES "review_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_taskRepoId_projectId_fkey" FOREIGN KEY ("taskRepoId", "projectId") REFERENCES "task_repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reviewer" ADD CONSTRAINT "task_reviewer_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reviewer" ADD CONSTRAINT "task_reviewer_taskRepoId_projectId_fkey" FOREIGN KEY ("taskRepoId", "projectId") REFERENCES "task_repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_proposal" ADD CONSTRAINT "environment_proposal_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_proposal" ADD CONSTRAINT "environment_proposal_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_proposal" ADD CONSTRAINT "environment_proposal_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_automationId_projectId_fkey" FOREIGN KEY ("automationId", "projectId") REFERENCES "automation"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ostra: checks Prisma can't declare.
ALTER TABLE "automation" ADD CONSTRAINT "automation_paused_has_reason" CHECK (("pausedAt" IS NULL) = ("pausedReason" IS NULL));
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_occurrence_only_for_occurrences" CHECK (("occurrenceAt" IS NOT NULL) = (kind = 'occurrence'));
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_ticket_only_for_matches" CHECK (("ticketId" IS NOT NULL) = (kind = 'ticket_match'));
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_skip_reason_when_skipped" CHECK (("skipReason" IS NOT NULL) = (state = 'skipped'));
ALTER TABLE "bulk_start" ADD CONSTRAINT "bulk_start_requested_positive" CHECK (requested > 0);
ALTER TABLE "task" ADD CONSTRAINT "task_approved_has_member" CHECK ("approvedAt" IS NULL OR "approvedByMemberId" IS NOT NULL);
ALTER TABLE "task" ADD CONSTRAINT "task_rounds_nonnegative" CHECK ("ciRounds" >= 0 AND "reviewRounds" >= 0 AND "automaticTurns" >= 0);
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_attempts_nonnegative" CHECK (attempts >= 0);
ALTER TABLE "refine_draft" ADD CONSTRAINT "refine_draft_version_positive" CHECK (version > 0);
ALTER TABLE "refine_draft_image" ADD CONSTRAINT "refine_draft_image_size_nonnegative" CHECK (size >= 0);
ALTER TABLE "task_round" ADD CONSTRAINT "task_round_number_positive" CHECK (number > 0);
ALTER TABLE "review_run" ADD CONSTRAINT "review_run_counts_valid" CHECK (round > 0 AND blocking >= 0 AND nits >= 0);
ALTER TABLE "finding" ADD CONSTRAINT "finding_line_positive" CHECK (line > 0);
ALTER TABLE "task_reviewer" ADD CONSTRAINT "task_reviewer_user_or_team" CHECK (("githubUserId" IS NULL) <> ("teamSlug" IS NULL));
-- An agent session may arrive before ostra knows its project (F-012): its ticket, task and board
-- links carry the project, so none is set while projectId is empty (MATCH SIMPLE skips the key).
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_ticket_carries_project" CHECK ("ticketId" IS NULL OR "projectId" IS NOT NULL);
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_task_carries_project" CHECK ("taskId" IS NULL OR "projectId" IS NOT NULL);
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_board_carries_project" CHECK ("boardId" IS NULL OR "projectId" IS NOT NULL);

-- ostra: the text that is untrusted or private, and what a log never carries.
COMMENT ON COLUMN "automation"."prompt" IS 'ostra: a prompt schedule''s prompt. Private: never logged.';
COMMENT ON COLUMN "task"."rejectedReason" IS 'ostra: a member''s reason, shown to the project''s members. Never logged.';
COMMENT ON COLUMN "agent_activity"."body" IS 'ostra: only ostra''s own words, from its templates: never agent output, a tool''s input, a plan or a draft.';
COMMENT ON COLUMN "refine_draft"."description" IS 'ostra: untrusted agent or member text. Never logged.';
COMMENT ON COLUMN "refine_draft"."acceptanceCriteria" IS 'ostra: untrusted agent or member text. Never logged.';
COMMENT ON COLUMN "refine_draft"."edgeCases" IS 'ostra: untrusted agent or member text. Never logged.';
COMMENT ON COLUMN "refine_draft"."openQuestions" IS 'ostra: untrusted agent or member text. Never logged.';
COMMENT ON COLUMN "refine_draft"."subTickets" IS 'ostra: untrusted agent or member text. Never logged.';
COMMENT ON COLUMN "review_run"."summary" IS 'ostra: untrusted agent text. Never logged.';
COMMENT ON COLUMN "finding"."body" IS 'ostra: untrusted agent text. Never logged.';
COMMENT ON COLUMN "finding"."suggestion" IS 'ostra: untrusted agent text. Never logged.';
COMMENT ON COLUMN "ci_run"."checks" IS 'ostra: check names and conclusions only, never a log''s text.';
COMMENT ON COLUMN "environment_proposal"."body" IS 'ostra: untrusted agent text: the proposal''s scripts. Never logged.';
COMMENT ON COLUMN "environment_proposal"."notes" IS 'ostra: untrusted agent text. Never logged.';
