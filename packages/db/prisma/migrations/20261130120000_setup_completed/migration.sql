-- F-076 (2026-11-21, the maintainer's "all yes"): when an organization's setup was first complete, so
-- Home's checklist stays done once it was, even while no runner is online. Additive only: a nullable
-- column, and its value for an organization that finished setup before the column existed.

-- AlterTable
ALTER TABLE "organization_setting" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3);

-- An organization with a model provider, a GitHub App, a project, a runner that was ever seen and a
-- task did every required step before this release: its checklist doesn't come back after the upgrade.
INSERT INTO "organization_setting" ("organizationId", "setupCompletedAt", "createdAt", "updatedAt")
SELECT o."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organization" o
WHERE EXISTS (SELECT 1 FROM "model_provider" p WHERE p."organizationId" = o."id")
  AND EXISTS (SELECT 1 FROM "connection" c WHERE c."organizationId" = o."id" AND c."kind" = 'github')
  AND EXISTS (SELECT 1 FROM "project" j WHERE j."organizationId" = o."id")
  AND EXISTS (SELECT 1 FROM "runner" r WHERE r."organizationId" = o."id" AND r."lastSeenAt" IS NOT NULL)
  AND EXISTS (SELECT 1 FROM "task" t WHERE t."organizationId" = o."id")
ON CONFLICT ("organizationId") DO UPDATE SET "setupCompletedAt" = EXCLUDED."setupCompletedAt"
WHERE "organization_setting"."setupCompletedAt" IS NULL;
