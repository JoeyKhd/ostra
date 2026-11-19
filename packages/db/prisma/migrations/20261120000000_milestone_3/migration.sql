-- Milestone 3 (ticket 06, spec section 5.3): agent profiles' rules, skills and MCP servers, task
-- rules, plan first, diff comments and their cache, every PR a task repo has had, check runs,
-- usage per turn, snapshots on a runner, notifications and their deliveries and choices, the
-- install's email, CLI sessions and the verified GitHub link. Additive only: new enums, tables,
-- columns with defaults or nullable, and indexes. Nothing is renamed or dropped. The command kinds
-- of protocol minor 2 came with ticket 01 (`20261119230000_command_minor_2`).

-- CreateEnum
CREATE TYPE "ProfileAccess" AS ENUM ('everyone', 'listed');

-- CreateEnum
CREATE TYPE "PlanState" AS ENUM ('none', 'proposed', 'approved');

-- CreateEnum
CREATE TYPE "ApprovalTool" AS ENUM ('edit', 'execute', 'fetch', 'mcp');

-- CreateEnum
CREATE TYPE "ApprovalRuleSource" AS ENUM ('profile', 'task');

-- CreateEnum
CREATE TYPE "ApprovalSubjectKind" AS ENUM ('path', 'command', 'url', 'tool');

-- CreateEnum
CREATE TYPE "DiffSide" AS ENUM ('old', 'new');

-- CreateEnum
CREATE TYPE "DiffCommentState" AS ENUM ('draft', 'sent', 'deleted');

-- CreateEnum
CREATE TYPE "CheckRunStatus" AS ENUM ('running', 'passed', 'failed', 'timed_out', 'error');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('open', 'merged', 'closed_unmerged');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('approval', 'question', 'plan', 'pr_ready', 'no_changes', 'stalled', 'spend_cap', 'crashed', 'setup_failed', 'ticket_closed', 'test');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('panel', 'tracker', 'email');

-- CreateEnum
CREATE TYPE "NotificationState" AS ENUM ('open', 'answered', 'dismissed');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('pending', 'sent', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('off', 'resend', 'smtp');

-- CreateEnum
CREATE TYPE "SmtpSecurity" AS ENUM ('starttls', 'tls', 'none');

-- CreateEnum
CREATE TYPE "SnapshotSecretScan" AS ENUM ('passed', 'failed');

-- CreateEnum
CREATE TYPE "DeviceCodePurpose" AS ENUM ('runner', 'cli');

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "access" "ProfileAccess" NOT NULL DEFAULT 'everyone',
ADD COLUMN     "approvalRules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "mcpServers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "planFirst" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "approval" ADD COLUMN     "denyReason" TEXT,
ADD COLUMN     "ruleSource" "ApprovalRuleSource",
ADD COLUMN     "subjectKind" "ApprovalSubjectKind",
ADD COLUMN     "subjectValue" TEXT;

-- AlterTable
ALTER TABLE "check" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timeoutSeconds" INTEGER NOT NULL DEFAULT 600;

-- AlterTable
ALTER TABLE "deviceCode" ADD COLUMN     "machineName" TEXT,
ADD COLUMN     "purpose" "DeviceCodePurpose" NOT NULL DEFAULT 'runner';

-- AlterTable
ALTER TABLE "instance_setting" ADD COLUMN     "emailDelaySeconds" INTEGER;

-- AlterTable
ALTER TABLE "needs_you_item" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "planTurnId" TEXT,
ADD COLUMN     "questionId" TEXT;

-- AlterTable
ALTER TABLE "snapshot" ADD COLUMN     "buildDurationMs" INTEGER,
ADD COLUMN     "buildInputsHash" TEXT,
ADD COLUMN     "runnerId" TEXT,
ADD COLUMN     "secretScan" "SnapshotSecretScan";

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "agentProfileId" TEXT,
ADD COLUMN     "planState" "PlanState" NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "task_repo" ADD COLUMN     "behindBy" INTEGER,
ADD COLUMN     "behindCheckedAt" TIMESTAMP(3),
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "turn" ADD COLUMN     "agentMs" INTEGER,
ADD COLUMN     "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "estimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "spentMicroUsd" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "githubLinkedAt" TIMESTAMP(3),
ADD COLUMN     "githubLogin" TEXT,
ADD COLUMN     "githubUserId" TEXT;

-- CreateTable
CREATE TABLE "email_settings" (
    "id" TEXT NOT NULL DEFAULT 'instance',
    "provider" "EmailProvider" NOT NULL DEFAULT 'off',
    "fromAddress" TEXT,
    "fromName" TEXT,
    "resendApiKeySecretRef" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" "SmtpSecurity",
    "smtpUser" TEXT,
    "smtpPasswordSecretRef" TEXT,
    "lockedBySettings" BOOLEAN NOT NULL DEFAULT false,
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profile_member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profile_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profile_skill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profile_skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_approval_rule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tool" "ApprovalTool" NOT NULL,
    "pattern" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_approval_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diff_comment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskRepoId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "side" "DiffSide" NOT NULL,
    "line" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" "DiffCommentState" NOT NULL DEFAULT 'draft',
    "sentInSeq" INTEGER,
    "outdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diff_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diff_cache" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diff_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_pull_request" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskRepoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "state" "PullRequestState" NOT NULL DEFAULT 'open',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "draftByOstra" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pull_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnOrdinal" INTEGER NOT NULL,
    "checkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoId" TEXT,
    "status" "CheckRunStatus" NOT NULL DEFAULT 'running',
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "outputBlobId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "check_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "needsYouItemId" TEXT,
    "kind" "NotificationKind" NOT NULL,
    "readAt" TIMESTAMP(3),
    "state" "NotificationState" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "adapter" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cli_session" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "cli_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_profile_member_memberId_idx" ON "agent_profile_member"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_member_profileId_memberId_key" ON "agent_profile_member"("profileId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_skill_profileId_name_key" ON "agent_profile_skill"("profileId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "task_approval_rule_taskId_tool_pattern_key" ON "task_approval_rule"("taskId", "tool", "pattern");

-- CreateIndex
CREATE INDEX "diff_comment_taskId_state_idx" ON "diff_comment"("taskId", "state");

-- CreateIndex
CREATE INDEX "diff_comment_taskId_memberId_state_idx" ON "diff_comment"("taskId", "memberId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "diff_cache_repoId_baseSha_headSha_key" ON "diff_cache"("repoId", "baseSha", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "task_pull_request_taskRepoId_number_key" ON "task_pull_request"("taskRepoId", "number");

-- CreateIndex
CREATE INDEX "check_run_taskId_idx" ON "check_run"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "check_run_sessionId_turnOrdinal_checkId_key" ON "check_run"("sessionId", "turnOrdinal", "checkId");

-- CreateIndex
CREATE INDEX "notification_memberId_state_idx" ON "notification"("memberId", "state");

-- CreateIndex
CREATE INDEX "notification_memberId_readAt_idx" ON "notification"("memberId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_id_organizationId_key" ON "notification"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_one_per_member_and_item" ON "notification"("memberId", "needsYouItemId") WHERE ("needsYouItemId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_idempotencyKey_key" ON "notification_delivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "notification_delivery_state_dueAt_idx" ON "notification_delivery"("state", "dueAt");

-- CreateIndex
CREATE INDEX "notification_delivery_notificationId_idx" ON "notification_delivery"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_memberId_kind_channel_key" ON "notification_preference"("memberId", "kind", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "cli_session_tokenHash_key" ON "cli_session"("tokenHash");

-- CreateIndex
CREATE INDEX "cli_session_memberId_idx" ON "cli_session"("memberId");

-- CreateIndex
CREATE INDEX "cli_session_userId_idx" ON "cli_session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "needs_you_item_id_projectId_key" ON "needs_you_item"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "task_repo_id_projectId_key" ON "task_repo"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "user_github_user_id_unique" ON "user"("githubUserId") WHERE ("githubUserId" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "agent_profile_member" ADD CONSTRAINT "agent_profile_member_profileId_organizationId_fkey" FOREIGN KEY ("profileId", "organizationId") REFERENCES "agent_profile"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_member" ADD CONSTRAINT "agent_profile_member_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_skill" ADD CONSTRAINT "agent_profile_skill_profileId_organizationId_fkey" FOREIGN KEY ("profileId", "organizationId") REFERENCES "agent_profile"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_runnerId_organizationId_fkey" FOREIGN KEY ("runnerId", "organizationId") REFERENCES "runner"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_agentProfileId_organizationId_fkey" FOREIGN KEY ("agentProfileId", "organizationId") REFERENCES "agent_profile"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_approval_rule" ADD CONSTRAINT "task_approval_rule_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_approval_rule" ADD CONSTRAINT "task_approval_rule_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_approval_rule" ADD CONSTRAINT "task_approval_rule_approvalId_taskId_fkey" FOREIGN KEY ("approvalId", "taskId") REFERENCES "approval"("id", "taskId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diff_comment" ADD CONSTRAINT "diff_comment_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diff_comment" ADD CONSTRAINT "diff_comment_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diff_comment" ADD CONSTRAINT "diff_comment_taskRepoId_projectId_fkey" FOREIGN KEY ("taskRepoId", "projectId") REFERENCES "task_repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diff_cache" ADD CONSTRAINT "diff_cache_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diff_cache" ADD CONSTRAINT "diff_cache_repoId_projectId_fkey" FOREIGN KEY ("repoId", "projectId") REFERENCES "repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_taskRepoId_projectId_fkey" FOREIGN KEY ("taskRepoId", "projectId") REFERENCES "task_repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_sessionId_taskId_fkey" FOREIGN KEY ("sessionId", "taskId") REFERENCES "session"("id", "taskId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_needsYouItemId_projectId_fkey" FOREIGN KEY ("needsYouItemId", "projectId") REFERENCES "needs_you_item"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notificationId_organizationId_fkey" FOREIGN KEY ("notificationId", "organizationId") REFERENCES "notification"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cli_session" ADD CONSTRAINT "cli_session_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cli_session" ADD CONSTRAINT "cli_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- F-086 (ADR 0026): a notification may sit outside a project (a test mail), so its projectId is
-- nullable; one that names a task or a needs-you item names its project too, since Postgres checks
-- a composite key only when every column is set (MATCH SIMPLE).
ALTER TABLE "notification" ADD CONSTRAINT "notification_task_carries_project" CHECK ("taskId" IS NULL OR "projectId" IS NOT NULL);
ALTER TABLE "notification" ADD CONSTRAINT "notification_item_carries_project" CHECK ("needsYouItemId" IS NULL OR "projectId" IS NOT NULL);

-- Values a column's type can't refuse on its own.
ALTER TABLE "diff_comment" ADD CONSTRAINT "diff_comment_line" CHECK ("line" > 0);
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_numbers" CHECK ("turnOrdinal" > 0 AND ("durationMs" IS NULL OR "durationMs" >= 0));
ALTER TABLE "check" ADD CONSTRAINT "check_timeout" CHECK ("timeoutSeconds" > 0 AND "position" >= 0);
ALTER TABLE "task_repo" ADD CONSTRAINT "task_repo_behind_and_generation" CHECK (("behindBy" IS NULL OR "behindBy" >= 0) AND "generation" >= 1);
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_number" CHECK ("number" > 0);
ALTER TABLE "turn" ADD CONSTRAINT "turn_usage" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0 AND "cacheReadTokens" >= 0 AND "cacheWriteTokens" >= 0 AND "spentMicroUsd" >= 0 AND ("agentMs" IS NULL OR "agentMs" >= 0));
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_one_row" CHECK ("id" = 'instance');
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_smtp_port" CHECK ("smtpPort" IS NULL OR "smtpPort" BETWEEN 1 AND 65535);
ALTER TABLE "instance_setting" ADD CONSTRAINT "instance_setting_email_delay" CHECK ("emailDelaySeconds" IS NULL OR "emailDelaySeconds" >= 0);
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_build_duration" CHECK ("buildDurationMs" IS NULL OR "buildDurationMs" >= 0);

-- The install's email: one row, off until an admin or a setting chooses a provider (ADR 0050).
INSERT INTO "email_settings" ("id", "updatedAt") VALUES ('instance', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;

-- backfill: task_pull_request (begin)
-- One TaskPullRequest per task repo that already has a PR (F-066). Idempotent: a second run
-- inserts nothing, by the (taskRepoId, number) key.
INSERT INTO "task_pull_request" ("id", "organizationId", "projectId", "taskRepoId", "number", "url", "branchName", "state", "draft", "draftByOstra", "openedAt", "closedAt", "createdAt", "updatedAt")
SELECT
  'tpr-' || tr."id",
  tr."organizationId",
  tr."projectId",
  tr."id",
  tr."prNumber",
  tr."prUrl",
  tr."branchName",
  (CASE
    WHEN tr."mergedAt" IS NOT NULL OR tr."state" = 'merged' THEN 'merged'
    WHEN tr."closedAt" IS NOT NULL OR tr."state" = 'closed_unmerged' THEN 'closed_unmerged'
    ELSE 'open'
  END)::"PullRequestState",
  false,
  false,
  tr."createdAt",
  COALESCE(tr."mergedAt", tr."closedAt"),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "task_repo" tr
WHERE tr."prNumber" IS NOT NULL AND tr."prUrl" IS NOT NULL
ON CONFLICT ("taskRepoId", "number") DO NOTHING;
-- backfill: task_pull_request (end)
