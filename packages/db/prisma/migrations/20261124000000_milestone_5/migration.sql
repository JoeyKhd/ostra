-- Milestone 5 (ticket 04, spec section 5.3): the fleet. Pools' token lifetimes, join tokens' uses
-- and revokers, what a runner reports and its drain, the organization's three box sizes, a
-- project's ordered pools, a profile's runner labels, the queue's priority, time and labels, a
-- box's size, image and wait, the organization's registry, and a snapshot's registry and builder.
-- Additive only: new enums and enum values, tables, nullable columns or columns with defaults,
-- checks and indexes. Nothing is renamed or dropped.
--
-- `runner.processContainment` (milestone 2) is the containment the spec lists, so it isn't added
-- again; `snapshot.runnerId` is milestone 3's. The `resume` command kind is protocol minor 4's
-- own migration (`20261123000000_command_resume`, ticket 01).
--
-- Backfills: the three default box sizes for every organization, each project's pools numbered
-- by their pools' creation, and for queued tasks `queuedAt` from `createdAt` and `queuePriority`
-- from the ticket's priority (Linear's scale: 1 urgent to 4 low; none, or no ticket, is 3).
-- The new enum values are used by no statement here: Postgres refuses a value added in the same
-- transaction.

-- CreateEnum
CREATE TYPE "RunnerInstall" AS ENUM ('npm', 'image', 'source');

-- CreateEnum
CREATE TYPE "BoxWaitingReason" AS ENUM ('node', 'image_pull');

-- CreateEnum
CREATE TYPE "RegistryAuth" AS ENUM ('basic', 'node');

-- CreateEnum
CREATE TYPE "SnapshotBuilder" AS ENUM ('docker', 'buildkit');

-- AlterEnum
ALTER TYPE "NeedsYouReason" ADD VALUE 'runner_awaiting_approval';

-- AlterEnum
ALTER TYPE "TaskStopReason" ADD VALUE 'cancelled';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'runner_joined';
ALTER TYPE "NotificationKind" ADD VALUE 'runner_awaiting_approval';

-- AlterTable
ALTER TABLE "runner_pool" ADD COLUMN     "joinTokenDays" INTEGER,
ADD COLUMN     "updatedByMemberId" TEXT;

-- AlterTable
ALTER TABLE "join_token" ADD COLUMN     "revokedByMemberId" TEXT,
ADD COLUMN     "useCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "runner" ADD COLUMN     "capabilities" JSONB,
ADD COLUMN     "cpuMillis" INTEGER,
ADD COLUMN     "drainedAt" TIMESTAMP(3),
ADD COLUMN     "drainedByMemberId" TEXT,
ADD COLUMN     "install" "RunnerInstall",
ADD COLUMN     "joinTokenId" TEXT,
ADD COLUMN     "lastOfferedAt" TIMESTAMP(3),
ADD COLUMN     "memoryMiB" INTEGER,
ADD COLUMN     "minor" INTEGER,
ADD COLUMN     "slots" INTEGER;

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "runnerLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "project_pool" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "snapshot" ADD COLUMN     "builder" "SnapshotBuilder",
ADD COLUMN     "pushedAt" TIMESTAMP(3),
ADD COLUMN     "registryId" TEXT;

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "cancelledByMemberId" TEXT,
ADD COLUMN     "queuePriority" SMALLINT NOT NULL DEFAULT 3,
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "requiredLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "box" ADD COLUMN     "cpuMillis" INTEGER,
ADD COLUMN     "imageDigest" TEXT,
ADD COLUMN     "imageRef" TEXT,
ADD COLUMN     "memoryMiB" INTEGER,
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "size" TEXT,
ADD COLUMN     "waitingReason" "BoxWaitingReason",
ADD COLUMN     "waitingSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "box_size" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cpuMillis" INTEGER NOT NULL,
    "memoryMiB" INTEGER NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "box_size_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "repositoryPrefix" TEXT NOT NULL,
    "auth" "RegistryAuth" NOT NULL,
    "pushSecretId" TEXT,
    "pullSecretId" TEXT,
    "checkedAt" TIMESTAMP(3),
    "checkResult" JSONB,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "box_size_organizationId_name_key" ON "box_size"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "box_size_id_organizationId_key" ON "box_size"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "registry_organizationId_key" ON "registry"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "registry_id_organizationId_key" ON "registry"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "join_token_id_organizationId_key" ON "join_token"("id", "organizationId");

-- CreateIndex
CREATE INDEX "task_organizationId_state_queuePriority_queuedAt_idx" ON "task"("organizationId", "state", "queuePriority", "queuedAt");

-- CreateIndex
CREATE INDEX "box_runnerId_state_idx" ON "box"("runnerId", "state");

-- CreateIndex
CREATE INDEX "box_projectId_state_idx" ON "box"("projectId", "state");

-- AddForeignKey
ALTER TABLE "runner" ADD CONSTRAINT "runner_joinTokenId_organizationId_fkey" FOREIGN KEY ("joinTokenId", "organizationId") REFERENCES "join_token"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_registryId_organizationId_fkey" FOREIGN KEY ("registryId", "organizationId") REFERENCES "registry"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "box_size" ADD CONSTRAINT "box_size_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry" ADD CONSTRAINT "registry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Checks
ALTER TABLE "box_size" ADD CONSTRAINT "box_size_name_known" CHECK (name IN ('small', 'medium', 'large'));
ALTER TABLE "box_size" ADD CONSTRAINT "box_size_limits_positive" CHECK ("cpuMillis" > 0 AND "memoryMiB" > 0);
ALTER TABLE "project" ADD CONSTRAINT "project_default_box_size_known" CHECK ("defaultBoxSize" IS NULL OR "defaultBoxSize" IN ('small', 'medium', 'large'));
ALTER TABLE "box" ADD CONSTRAINT "box_size_known" CHECK (size IS NULL OR size IN ('small', 'medium', 'large'));
ALTER TABLE "box" ADD CONSTRAINT "box_waiting_has_time" CHECK (("waitingReason" IS NULL) = ("waitingSince" IS NULL));
ALTER TABLE "task" ADD CONSTRAINT "task_queue_priority_range" CHECK ("queuePriority" BETWEEN 1 AND 4);
ALTER TABLE "join_token" ADD CONSTRAINT "join_token_use_count_nonnegative" CHECK ("useCount" >= 0);
ALTER TABLE "runner_pool" ADD CONSTRAINT "runner_pool_join_token_days_nonnegative" CHECK ("joinTokenDays" IS NULL OR "joinTokenDays" >= 0);
ALTER TABLE "project_pool" ADD CONSTRAINT "project_pool_position_nonnegative" CHECK (position >= 0);
ALTER TABLE "runner" ADD CONSTRAINT "runner_resources_nonnegative" CHECK (
  (slots IS NULL OR slots >= 0) AND ("cpuMillis" IS NULL OR "cpuMillis" >= 0) AND ("memoryMiB" IS NULL OR "memoryMiB" >= 0)
);

-- Backfill: the three default box sizes (ADR 0029's working values) for every organization.
INSERT INTO "box_size" ("id", "organizationId", "name", "cpuMillis", "memoryMiB", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", s.name, s.cpu_millis, s.memory_mib, now(), now()
FROM "organization" AS o
CROSS JOIN (VALUES ('small', 2000, 4096), ('medium', 4000, 8192), ('large', 8000, 16384)) AS s(name, cpu_millis, memory_mib)
ON CONFLICT ("organizationId", "name") DO NOTHING;

-- Backfill: each project's pools in the order the pools were made, from 0.
UPDATE "project_pool" AS pp
SET "position" = numbered.n
FROM (
  SELECT p."projectId", p."poolId", (row_number() OVER (PARTITION BY p."projectId" ORDER BY rp."createdAt", p."poolId") - 1)::int AS n
  FROM "project_pool" AS p
  JOIN "runner_pool" AS rp ON rp."id" = p."poolId"
) AS numbered
WHERE pp."projectId" = numbered."projectId" AND pp."poolId" = numbered."poolId";

-- Backfill: queued tasks' place in the queue.
UPDATE "task" SET "queuedAt" = "createdAt" WHERE "state" = 'queued' AND "queuedAt" IS NULL;
UPDATE "task" AS t
SET "queuePriority" = CASE WHEN tk."priority" BETWEEN 1 AND 4 THEN tk."priority" ELSE 3 END
FROM "ticket" AS tk
WHERE t."state" = 'queued' AND t."ticketId" = tk."id" AND t."projectId" = tk."projectId";
