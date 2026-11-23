-- Milestone 11 (ticket 01, spec section 5.1, ADR 0071): several tracker connections per
-- organization, of any kind, and Jira Cloud. Additive: two enum values and nullable columns, a new
-- per-site index and a new board key. It relaxes two constraints, the exception ADR 0071 records
-- (constraints, no data): the one-Linear-per-organization index, and the board's `(projectId,
-- externalId)` key, each dropped after its replacement exists. Linear's existing connection becomes
-- the first named one; nothing is lost.

-- AlterEnum
ALTER TYPE "ConnectionKind" ADD VALUE 'jira';

-- AlterEnum
ALTER TYPE "ConnectionCredential" ADD VALUE 'service_account_token';

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "accessCheck" JSONB,
ADD COLUMN     "accessCheckedAt" TIMESTAMP(3),
ADD COLUMN     "accountEmail" TEXT,
ADD COLUMN     "badSignatureAt" TIMESTAMP(3),
ADD COLUMN     "firstDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "resumedIntoId" TEXT,
ADD COLUMN     "tokenExpiresOn" DATE;

-- AlterTable
ALTER TABLE "organization_setting" ADD COLUMN     "trackerSkippedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ticket_write" ADD COLUMN     "via" JSONB;

-- Every Linear row is named from its workspace (`Acme Linear`), or `Linear` when the workspace was
-- never read. GitHub rows have no name.
UPDATE "connection"
SET "name" = COALESCE(NULLIF(btrim("externalWorkspaceName"), '') || ' Linear', 'Linear')
WHERE "kind" = 'linear' AND "name" IS NULL;

-- A pending Linear row's placeholder names its row, so several can be pending at once under the
-- `(organizationId, kind, appId)` key. The domain reads both forms (`isPendingAppId`).
UPDATE "connection"
SET "appId" = 'pending:' || "id"
WHERE "kind" = 'linear' AND "appId" = 'pending';

-- Home's skipped tracker step, copied from the Linear step it replaces. `linearSkippedAt` stays,
-- still written, until the release after this one.
UPDATE "organization_setting"
SET "trackerSkippedAt" = "linearSkippedAt"
WHERE "linearSkippedAt" IS NOT NULL AND "trackerSkippedAt" IS NULL;

-- CreateIndex: one tracker connection per site or workspace in an organization, among those not
-- revoked. Milestone 2's index allowed at most one Linear row not revoked, so none collide.
CREATE UNIQUE INDEX "connection_one_site_per_organization" ON "connection"("organizationId", "kind", "externalWorkspaceId") WHERE (kind <> 'github' AND state <> 'revoked' AND "externalWorkspaceId" IS NOT NULL);

-- DropIndex: the one Linear per organization (ADR 0071).
DROP INDEX "connection_one_linear_per_organization";

-- CreateIndex: a board per team or project of a connection in a project. Every existing board is
-- unique under it, since it was unique under the narrower key it replaces.
CREATE UNIQUE INDEX "board_one_per_connection_board_per_project" ON "board"("projectId", "connectionId", "externalId");

-- DropIndex: the board's `(projectId, externalId)` key, which the new one replaces (ADR 0071).
DROP INDEX "board_projectId_externalId_key";
