-- The profile's provider (F-135, F-021, ADR 0065 amended 2026-11-20): the maintainer's "you should
-- first select the provider and then you get to see which models are available under that
-- provider". A profile names the provider whose key and base URL its tasks use, and no other; a
-- project's list decides which profiles can run there. Additive only: a nullable column, so a
-- rollback to the previous release reads the same profiles.
--
-- The backfill gives each existing profile the provider that serves its model today, when exactly
-- one does: on every list ostra resolves on (the organization's default list, which new projects
-- follow, and each project's own list), by F-135's rule (the list's choice for the model when its
-- row is listed and on the list, else the only provider on the list that lists it). Where several
-- serve it, or none does, it stays `null`: the project's own choice serves the model by name, as
-- before, until an organization admin picks a provider for the profile.

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN "providerId" TEXT;

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "model_provider"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- backfill: the profile's provider (begin)
WITH profile_model AS (
  -- Each profile's model by name: its two columns, else (saved before milestone 4) its model row's.
  SELECT ap."id" AS profile_id, ap."organizationId",
         CASE WHEN ap."modelCatalogId" IS NOT NULL THEN 'catalog:' || ap."modelCatalogId"
              WHEN ap."modelCustomName" IS NOT NULL THEN 'custom:' || ap."modelCustomName"
              WHEN m."catalogId" IS NOT NULL THEN 'catalog:' || m."catalogId"
              WHEN m."id" IS NOT NULL THEN 'custom:' || m."endpointModelId" END AS model_key
  FROM "agent_profile" AS ap
  LEFT JOIN "model" AS m ON m."id" = ap."modelId" AND m."organizationId" = ap."organizationId"
  WHERE ap."providerId" IS NULL
), lists AS (
  -- The lists ostra resolves on: each organization's default list, and each project's own.
  SELECT o."id" AS "organizationId", NULL::text AS list_project_id FROM "organization" AS o
  UNION ALL
  SELECT p."organizationId", p."id" FROM "project" AS p WHERE p."ownProviders"
), on_list AS (
  -- Every listed model row whose provider is on a list.
  SELECT l."organizationId", l.list_project_id, m."id" AS model_id, m."providerId",
         CASE WHEN m."catalogId" IS NOT NULL THEN 'catalog:' || m."catalogId" ELSE 'custom:' || m."endpointModelId" END AS model_key
  FROM lists AS l
  JOIN "provider_list_entry" AS e ON e."organizationId" = l."organizationId" AND e."projectId" IS NOT DISTINCT FROM l.list_project_id
  JOIN "model" AS m ON m."organizationId" = e."organizationId" AND m."providerId" = e."providerId" AND m."listed"
), served AS (
  -- A list's choice serves the model when its row is listed and on the list.
  SELECT ol."organizationId", ol.list_project_id, ol.model_key, ol."providerId"
  FROM "model_choice" AS c
  JOIN on_list AS ol ON ol."organizationId" = c."organizationId" AND ol.list_project_id IS NOT DISTINCT FROM c."projectId"
                    AND ol.model_id = c."modelId" AND ol.model_key = c."modelKey"
  UNION ALL
  -- Without a choice, the only provider on the list that lists it.
  SELECT ol."organizationId", ol.list_project_id, ol.model_key, min(ol."providerId")
  FROM on_list AS ol
  WHERE NOT EXISTS (
    SELECT 1 FROM "model_choice" AS c
    WHERE c."organizationId" = ol."organizationId" AND c."projectId" IS NOT DISTINCT FROM ol.list_project_id AND c."modelKey" = ol.model_key
  )
  GROUP BY ol."organizationId", ol.list_project_id, ol.model_key
  HAVING count(DISTINCT ol."providerId") = 1
), serving AS (
  SELECT pm.profile_id, min(s."providerId") AS provider_id, count(DISTINCT s."providerId") AS providers
  FROM profile_model AS pm
  JOIN served AS s ON s."organizationId" = pm."organizationId" AND s.model_key = pm.model_key
  GROUP BY pm.profile_id
)
UPDATE "agent_profile" AS ap
SET "providerId" = sv.provider_id
FROM serving AS sv
WHERE ap."id" = sv.profile_id AND sv.providers = 1 AND ap."providerId" IS NULL;
-- backfill: the profile's provider (end)
