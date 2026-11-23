-- 2026-11-23 (F-112/c1, Q345 option (b)): a repo added to a project whose environment is saved gets
-- its own draft, held beside the saved setup for a project admin to apply, edit first or dismiss.
-- Additive (AGENTS.md: add first): one new table, nothing seeded.

-- CreateTable
CREATE TABLE "environment_repo_draft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "detection" JSONB NOT NULL,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByMemberId" TEXT,

    CONSTRAINT "environment_repo_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environment_repo_draft_repoId_key" ON "environment_repo_draft"("repoId");

-- CreateIndex
CREATE INDEX "environment_repo_draft_projectId_idx" ON "environment_repo_draft"("projectId");

-- AddForeignKey
ALTER TABLE "environment_repo_draft" ADD CONSTRAINT "environment_repo_draft_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_repo_draft" ADD CONSTRAINT "environment_repo_draft_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_repo_draft" ADD CONSTRAINT "environment_repo_draft_repoId_projectId_fkey" FOREIGN KEY ("repoId", "projectId") REFERENCES "repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

