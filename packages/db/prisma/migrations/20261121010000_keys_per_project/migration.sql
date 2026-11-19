-- Milestone 4, keys per project (ticket 45, spec section 5.5, ADR 0065): provider lists (the
-- organization's default and a project's own), the model choice per list and model name, the
-- profile's model by name, and the provider and model row each session resolved. Additive only:
-- `AgentProfile.modelId` stays and is still written, so a rollback works; a later release drops it.
--
-- The backfill keeps every task on the provider it used: every provider joins its organization's
-- default list, which every project follows; each profile names its model from its model row; each
-- model name's default choice is the oldest profile's, marked for an admin where profiles named it
-- on different providers; and each session records its profile's model row.

-- CreateEnum
CREATE TYPE "ModelChoiceReason" AS ENUM ('admin', 'kept', 'upgrade');

-- AlterEnum
ALTER TYPE "NeedsYouAudience" ADD VALUE 'organization_admins';

-- AlterEnum
ALTER TYPE "NeedsYouReason" ADD VALUE 'no_provider_for_model';

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "modelCatalogId" TEXT,
ADD COLUMN     "modelCustomName" TEXT;

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "ownProviders" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "providerId" TEXT;

-- CreateTable
CREATE TABLE "provider_list_entry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "providerId" TEXT NOT NULL,
    "addedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_list_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_choice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "modelKey" TEXT NOT NULL,
    "modelCatalogId" TEXT,
    "modelCustomName" TEXT,
    "modelId" TEXT NOT NULL,
    "chosenByMemberId" TEXT,
    "reason" "ModelChoiceReason" NOT NULL,
    "needsConfirm" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_choice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_list_entry_providerId_idx" ON "provider_list_entry"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_list_entry_organizationId_projectId_providerId_key" ON "provider_list_entry"("organizationId", "projectId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_list_entry_one_per_default_list" ON "provider_list_entry"("organizationId", "providerId") WHERE ("projectId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "model_choice_organizationId_projectId_modelKey_key" ON "model_choice"("organizationId", "projectId", "modelKey");

-- CreateIndex
CREATE UNIQUE INDEX "model_choice_one_per_default_list" ON "model_choice"("organizationId", "modelKey") WHERE ("projectId" IS NULL);

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "model_provider"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_modelId_organizationId_fkey" FOREIGN KEY ("modelId", "organizationId") REFERENCES "model"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_list_entry" ADD CONSTRAINT "provider_list_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_list_entry" ADD CONSTRAINT "provider_list_entry_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_list_entry" ADD CONSTRAINT "provider_list_entry_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "model_provider"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_choice" ADD CONSTRAINT "model_choice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_choice" ADD CONSTRAINT "model_choice_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_choice" ADD CONSTRAINT "model_choice_modelId_organizationId_fkey" FOREIGN KEY ("modelId", "organizationId") REFERENCES "model"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ostra: checks Prisma can't declare.

-- A profile names its model one way at most.
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_model_name_one_kind"
  CHECK ("modelCatalogId" IS NULL OR "modelCustomName" IS NULL);
-- A choice names its model one way, and its key says which (the domain's `modelNameKey`).
ALTER TABLE "model_choice" ADD CONSTRAINT "model_choice_model_name"
  CHECK (("modelCatalogId" IS NOT NULL AND "modelCustomName" IS NULL AND "modelKey" = 'catalog:' || "modelCatalogId")
      OR ("modelCatalogId" IS NULL AND "modelCustomName" IS NOT NULL AND "modelKey" = 'custom:' || "modelCustomName"));

-- backfill: keys per project (begin)
-- Every provider on its organization's default list.
INSERT INTO "provider_list_entry" ("id", "organizationId", "projectId", "providerId", "createdAt")
SELECT gen_random_uuid()::text, p."organizationId", NULL, p."id", now() FROM "model_provider" AS p
ON CONFLICT DO NOTHING;

-- Each profile's model by name, from its model row.
UPDATE "agent_profile" AS ap
SET "modelCatalogId" = m."catalogId",
    "modelCustomName" = CASE WHEN m."catalogId" IS NULL THEN m."endpointModelId" END
FROM "model" AS m
WHERE m."id" = ap."modelId" AND m."organizationId" = ap."organizationId"
  AND ap."modelCatalogId" IS NULL AND ap."modelCustomName" IS NULL;

-- Each model name's default choice: the oldest profile's model row, marked where profiles named
-- the same model on different providers.
WITH named AS (
  SELECT ap."organizationId", ap."createdAt", ap."id" AS profile_id, m."id" AS model_id, m."providerId",
         CASE WHEN m."catalogId" IS NOT NULL THEN 'catalog:' || m."catalogId" ELSE 'custom:' || m."endpointModelId" END AS model_key,
         m."catalogId" AS catalog_id,
         CASE WHEN m."catalogId" IS NULL THEN m."endpointModelId" END AS custom_name
  FROM "agent_profile" AS ap
  JOIN "model" AS m ON m."id" = ap."modelId" AND m."organizationId" = ap."organizationId"
), oldest AS (
  SELECT DISTINCT ON ("organizationId", model_key) * FROM named ORDER BY "organizationId", model_key, "createdAt", profile_id
), spread AS (
  SELECT "organizationId", model_key, count(DISTINCT "providerId") AS providers FROM named GROUP BY "organizationId", model_key
)
INSERT INTO "model_choice" ("id", "organizationId", "projectId", "modelKey", "modelCatalogId", "modelCustomName", "modelId", "chosenByMemberId", "reason", "needsConfirm", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."organizationId", NULL, o.model_key, o.catalog_id, o.custom_name, o.model_id, NULL, 'upgrade', s.providers > 1, now(), now()
FROM oldest AS o JOIN spread AS s ON s."organizationId" = o."organizationId" AND s.model_key = o.model_key
ON CONFLICT DO NOTHING;

-- Each session's provider and model row, from its profile's model.
UPDATE "session" AS se
SET "providerId" = m."providerId", "modelId" = m."id"
FROM "agent_profile" AS ap
JOIN "model" AS m ON m."id" = ap."modelId" AND m."organizationId" = ap."organizationId"
WHERE se."agentProfileId" = ap."id" AND se."organizationId" = ap."organizationId" AND se."providerId" IS NULL;
-- backfill: keys per project (end)
